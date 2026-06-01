// .releaserc builder for the `npm-release` composite action.
//
// The composite action hides `.releaserc` from the consumer; we synthesize
// the config at action-runtime from inputs into ${RUNNER_TEMP}/.releaserc
// and pass it to `semantic-release --extends <path>`.
//
// This module is a genuinely pure function — no I/O, no env access — so it can
// be unit-tested in isolation. The action.yml shell wrapper reads inputs from
// env, calls `buildReleaserc(inputs)`, and writes the JSON to disk.
//
// Self-contained on purpose: it duplicates the small parse/merge helpers from
// the (to-be-retired) `semantic-release-publish` lib rather than importing
// across the action boundary. Phase 3 of the npm-publish-redesign work item
// deletes that sibling action; `npm-release` must not depend on it.
//
// Public API:
//   buildReleaserc({
//     target, prerelease_branches, maintenance_branches, x_releaserc_overrides,
//   }) -> object suitable for JSON.stringify
//
// Inputs:
//   - target: registry URL string (e.g. https://registry.npmjs.org)
//   - prerelease_branches: comma-separated string; empty/whitespace ignored
//   - maintenance_branches: comma-separated string; same
//   - x_releaserc_overrides: JSON string of partial .releaserc; empty → no
//     overrides. Deep-merges on top of the generated base. Arrays in the
//     overrides (notably `branches` and `plugins`) REPLACE the base; we do not
//     merge plugin tuples by name — that's a footgun for callers who think they
//     are "adding" but are actually shadowing.

'use strict';

const DEFAULT_TARGET = 'https://registry.npmjs.org';

function parseCsv(input) {
  if (input === undefined || input === null) return [];
  const s = String(input);
  if (s.trim() === '') return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function buildBranches({ prerelease, maintenance }) {
  // semantic-release's `branches` is an ordered list. Conventions:
  //   - maintenance branches first (so they match before generic patterns)
  //   - then `main` (the release branch)
  //   - then prerelease branches with `prerelease: true`
  const out = [];
  for (const m of maintenance) {
    out.push({ name: m, channel: m, range: `${m}.x` });
  }
  out.push('main');
  for (const p of prerelease) {
    out.push({ name: p, prerelease: true });
  }
  return out;
}

function buildPlugins({ target }) {
  // Tag-driven, native-OIDC plugin set (D2 + D3). Order matters:
  //   commit-analyzer → release-notes-generator → npm → github
  //
  // NO @semantic-release/changelog and NO @semantic-release/git: versioning is
  // tag-driven (D3). The version bump and CHANGELOG are NOT committed back to
  // the branch — the GitHub Actions bot can't push to a protected `main`
  // without a GitHub App/PAT. semantic-release core still pushes the version
  // TAG (not gated by branch protection) and @semantic-release/github creates
  // the Release; the npm plugin publishes.
  //
  // npmPublish:true (D2): @semantic-release/npm@13 performs the publish itself.
  // On the official registry with `id-token: write`, it authenticates via the
  // npm CLI's native OIDC trusted publishing — no NPM_TOKEN required. If
  // NPM_TOKEN is present (custom registry, or OIDC unavailable), the same
  // plugin falls back to token auth. That OIDC-vs-token decision is made by the
  // plugin at runtime from env + registry, so the .releaserc shape is constant
  // and this builder stays pure (unlike the old env-sniffing builder).
  // Provenance is enabled via NPM_CONFIG_PROVENANCE in action.yml, not here.
  return [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    ['@semantic-release/npm', { npmPublish: true, registry: target }],
    '@semantic-release/github',
  ];
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  // Arrays REPLACE (see header). Plain objects merge key-by-key. Scalars
  // and arrays from override win.
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const k of Object.keys(override)) {
    const b = base[k];
    const o = override[k];
    if (isPlainObject(b) && isPlainObject(o)) {
      out[k] = deepMerge(b, o);
    } else {
      out[k] = o;
    }
  }
  return out;
}

function buildReleaserc(rawInputs) {
  const inputs = rawInputs || {};
  const target = inputs.target && String(inputs.target).trim() !== ''
    ? String(inputs.target).trim()
    : DEFAULT_TARGET;
  const prerelease = parseCsv(inputs.prerelease_branches);
  const maintenance = parseCsv(inputs.maintenance_branches);

  const base = {
    branches: buildBranches({ prerelease, maintenance }),
    plugins: buildPlugins({ target }),
  };

  const overridesRaw = inputs.x_releaserc_overrides;
  if (overridesRaw === undefined || overridesRaw === null
      || String(overridesRaw).trim() === '') {
    return base;
  }

  let overrides;
  try {
    overrides = JSON.parse(String(overridesRaw));
  } catch (err) {
    throw new Error(
      `npm-release: x_releaserc_overrides is not valid JSON: ${err.message}`,
    );
  }
  if (!isPlainObject(overrides)) {
    throw new Error(
      'npm-release: x_releaserc_overrides must be a JSON object at the top level',
    );
  }
  return deepMerge(base, overrides);
}

module.exports = {
  buildReleaserc,
  parseCsv,
  deepMerge,
  DEFAULT_TARGET,
};
