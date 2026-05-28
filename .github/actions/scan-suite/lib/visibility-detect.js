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
//   - Public repos: GHAS features are effectively unlimited for public repos
//     (CodeQL, dependency-review run for free). If the field is missing on a
//     public repo, return `hasGHAS: true`.
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

  const repo = (ghContext && ghContext.payload && ghContext.payload.repository) || {};
  const visibility = repo.visibility === 'public' ? 'public' : 'private';

  let hasGHAS;
  const saa = repo.security_and_analysis;
  if (visibility === 'public') {
    // GHAS-gated features are free on public repos; missing field = enabled.
    if (saa && saa.advanced_security && typeof saa.advanced_security.status === 'string') {
      hasGHAS = saa.advanced_security.status === 'enabled';
    } else {
      hasGHAS = true;
    }
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
