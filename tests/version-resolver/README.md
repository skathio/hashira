# tests/version-resolver

Unit tests for the `version-resolver` composite action's pure logic core
(D1/D8, FR-3, `security.md` B7). This iteration (phase 2.1) covers only the
standalone logic — no CI-workflow wiring yet (that's 2.2/2.3), so there is no
self-CI smoke-test fixture here yet either; those land once the action is
wired into a real workflow.

## Files

- `resolve-version.test.js` — `node:test` cases for
  `.github/actions/version-resolver/lib/resolve-version.js`. Run locally:
  ```
  node --test tests/version-resolver/resolve-version.test.js
  ```

## What's covered

- Bump arithmetic (`patch`/`minor`/`major`) from a stable tag.
- No-prior-tag handling: `patch`/`minor` fail fast; `major`/initial release
  requires an explicit seed version, and the seed plays the baseline's role
  (bump arithmetic still applies on top of it — see the shim's file header
  for the literal-vs-bumped-seed rationale).
- Prerelease tags (`-rc`, `-beta`, build metadata) are ignored when picking
  the latest stable base.
- The **major-from-main detection mechanism** (this iteration's pick, since
  `sdd.md §8` left the mechanism open while the semantics were already
  settled): highest-(major,minor,patch)-precedence stable tag wins, computed
  purely from tag strings (no commit-graph/timestamp lookups, for
  determinism). Named edge cases, each its own test: no prior tag at all;
  multiple stable major lines coexisting (e.g. `v1.x` and `v2.x` both
  present); prerelease-only tag history (no stable tag yet).
- The **two semver-validation checkpoints** (B7), tested independently:
  checkpoint 1 (the parsed baseline tag/seed, before arithmetic) and
  checkpoint 2 (the computed output, before return) each have dedicated test
  cases, including a checkpoint-2-only failure exercised via the shim's
  test-only `_formatComputed` seam (a correct implementation never produces
  a malformed computed value on its own, so this is the only way to reach
  that branch).

## Scope constraint: single advancing release line

This resolver assumes a single advancing release line of stable tags per
repository — it has no ref-reachability awareness, so a repo with
concurrently-maintained LTS branches tagging independently-advancing release
lines (e.g. a `v9.x` LTS branch still receiving patches alongside a
`main`-line `v3.x`) is out of scope and would silently get the
numerically-highest tag regardless of which branch it lives on. Confirmed
not exploitable for hashira's current consumers (somi and rogue are both
single-release-line packages). See the "scope assumption" section of
`resolve-version.js`'s file header for the full rationale.

## Why no fixtures directory (yet)

Unlike `tests/dotnet-pack-version/fixtures/`, this iteration's logic takes
its tag list as a plain array of strings (no real git repo, no `.csproj`) —
the shim is a pure function, so inline string arrays in the test file are
the fixtures. A real-git-tag smoke test (exercising `git tag --list` wiring)
is part of 2.2/2.3's integration-level self-CI dry-run, once the action is
wired into a workflow.
