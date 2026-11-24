// visibility-detect.js
//
// Detect repo visibility + whether GitHub Advanced Security (GHAS) is
// effectively enabled, for the purpose of skip-with-notice gating on
// GHAS-paywalled scans (CodeQL, dependency-review on free private tier).
//
// Per D7: scans that require GHAS on private repos without it must emit a
// `::notice::` and exit 0 rather than fail. This shim isolates the detection
// logic so it can be unit-tested off-runner (the surrounding action wraps it
// in a one-line `node` invocation against `${{ toJSON(github) }}` + env).
//
// Public API:
//   detect({ ghContext, env }) -> { visibility, hasGHAS, forced }
//
// Inputs:
//   ghContext   — object shaped like the GitHub Actions `github` context.
//                 We read `payload.repository.visibility` and
//                 `payload.repository.security_and_analysis.advanced_security.status`.
//                 Missing fields degrade gracefully (see below).
//   env         — process.env-shaped object. We read `HASHIRA_FORCE_PRIVATE_NO_GHAS`.
//
// Test override:
//   When `env.HASHIRA_FORCE_PRIVATE_NO_GHAS === '1'`, return
//   `{ visibility: 'private', hasGHAS: false, forced: true }` unconditionally.
//   This lets self-CI exercise the skip-with-notice path on hashira-ops itself
//   without actually toggling repo visibility. The `HASHIRA_` prefix is a
//   reserved namespace — consumer workflows must not set this env var.
//
// GHAS detection rules:
//   - Public repos: `hasGHAS: true`, always. GitHub runs CodeQL and
//     dependency review free on every public repo, whatever
//     `advanced_security.status` says: the event payload reports 'disabled'
//     for a public repo that never bought GHAS, and honoring it skipped both
//     scans on every public consumer.
//   - Private repos with `security_and_analysis.advanced_security.status ===
//     'enabled'`: `hasGHAS: true`.
//   - Private repos with the field missing or any value other than 'enabled':
//     `hasGHAS: false`.
//   - Missing `visibility` field: default to 'private' (the safer assumption —
//     a missing field shouldn't accidentally enable a paywalled scan that
//     then fails with a billing error).

'use strict';

function detect({ ghContext, env } = {}) {
  const e = env || {};
  if (e.HASHIRA_FORCE_PRIVATE_NO_GHAS === '1') {
    return { visibility: 'private', hasGHAS: false, forced: true };
  }

  // The scan actions pass `toJSON(github)`, where the event payload is
  // `event`; github-script's `context` names it `payload`. Reading only
  // `payload` found no repository under `toJSON(github)`, so every repo was
  // taken for private and dependency review never ran.
  const payload = (ghContext && (ghContext.event || ghContext.payload)) || {};
  const repo = payload.repository || {};
  const visibility = repo.visibility === 'public' ? 'public' : 'private';

  let hasGHAS;
  const saa = repo.security_and_analysis;
  if (visibility === 'public') {
    // Free on public repos; advanced_security.status does not gate them.
    hasGHAS = true;
  } else {
    // Private: require explicit 'enabled' marker.
    if (saa && saa.advanced_security && saa.advanced_security.status === 'enabled') {
      hasGHAS = true;
    } else {
      hasGHAS = false;
    }
  }

  return { visibility, hasGHAS, forced: false };
}

module.exports = { detect };
