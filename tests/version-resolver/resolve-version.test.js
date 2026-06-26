// Unit tests for the resolve-version shim used by `version-resolver`.
// Uses node:test (stdlib; zero-install).
//
// Run locally with:
//   node --test tests/version-resolver/resolve-version.test.js
//
// Coverage map (matches phases/02-version-resolver.md iteration 2.1's
// acceptance criteria + exit criteria verbatim):
//   - patch/minor from a tag
//   - major from a tag
//   - major with no prior tag + seed
//   - patch/minor with no prior tag (fails)
//   - prerelease tags ignored
//   - malformed baseline tag (fails validation before arithmetic)
//   - malformed computed output (fails validation, via a crafted test double)
//   - major-from-main edge cases: no prior tag at all; multiple major lines;
//     prerelease-only tag history
//   - the two semver-validation checkpoints, independently testable

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveVersion,
  selectLatestStableTag,
  assertStrictSemver,
  isPrerelease,
  VersionResolverError,
} = require('../../.github/actions/version-resolver/lib/resolve-version');

// ---------- resolveVersion: happy paths -------------------------------

test('resolveVersion: patch from a stable tag', () => {
  assert.equal(resolveVersion({ tags: ['v1.2.3'], bump: 'patch' }), '1.2.4');
});

test('resolveVersion: minor from a stable tag (resets patch)', () => {
  assert.equal(resolveVersion({ tags: ['v1.2.3'], bump: 'minor' }), '1.3.0');
});

test('resolveVersion: major from a stable tag (resets minor + patch)', () => {
  assert.equal(resolveVersion({ tags: ['v1.2.3'], bump: 'major' }), '2.0.0');
});

test('resolveVersion: picks the highest-precedence stable tag among several', () => {
  assert.equal(
    resolveVersion({ tags: ['v1.0.0', 'v1.4.2', 'v1.3.9'], bump: 'patch' }),
    '1.4.3'
  );
});

test('resolveVersion: accepts tags without a leading v', () => {
  assert.equal(resolveVersion({ tags: ['1.2.3'], bump: 'patch' }), '1.2.4');
});

// ---------- resolveVersion: no-prior-tag handling ---------------------

test('resolveVersion: patch with no prior tag fails fast', () => {
  assert.throws(
    () => resolveVersion({ tags: [], bump: 'patch' }),
    (err) => {
      assert.ok(err instanceof VersionResolverError);
      assert.match(err.message, /no prior stable tag found/);
      assert.match(err.message, /unsatisfiable/);
      return true;
    }
  );
});

test('resolveVersion: minor with no prior tag fails fast', () => {
  assert.throws(
    () => resolveVersion({ tags: [], bump: 'minor' }),
    /no prior stable tag found/
  );
});

test('resolveVersion: major with no prior tag and no seed fails fast', () => {
  assert.throws(
    () => resolveVersion({ tags: [], bump: 'major' }),
    (err) => {
      assert.ok(err instanceof VersionResolverError);
      assert.match(err.message, /no prior stable tag found/);
      assert.match(err.message, /seed version/);
      return true;
    }
  );
});

test('resolveVersion: major with no prior tag + explicit seed bumps from the seed', () => {
  // Seed plays the baseline's role (see file header rationale); major bump
  // still applies on top of it, so seed=2.0.0 -> 3.0.0, not a 2.0.0 passthrough.
  assert.equal(
    resolveVersion({ tags: [], bump: 'major', seedVersion: '2.0.0' }),
    '3.0.0'
  );
});

test('resolveVersion: initial release via seed=0.0.0 + major produces 1.0.0', () => {
  assert.equal(
    resolveVersion({ tags: [], bump: 'major', seedVersion: '0.0.0' }),
    '1.0.0'
  );
});

test('resolveVersion: seed is ignored when a stable tag already exists', () => {
  assert.equal(
    resolveVersion({ tags: ['v1.0.0'], bump: 'major', seedVersion: '99.0.0' }),
    '2.0.0'
  );
});

// ---------- resolveVersion: prerelease tags ignored --------------------

test('resolveVersion: prerelease tags are ignored when picking the latest stable base', () => {
  assert.equal(
    resolveVersion({
      tags: ['v1.0.0', 'v2.0.0-rc.1', 'v2.0.0-beta.3'],
      bump: 'patch',
    }),
    '1.0.1'
  );
});

test('resolveVersion: prerelease-only tag history (no stable tag yet) fails like no-tags for patch/minor', () => {
  // Edge case 3c (phase file, exit criteria + iteration 2.1 acceptance):
  // only -rc/-beta tags exist, no stable tag. Must behave identically to
  // "no prior tag at all" for patch/minor, not silently pick a prerelease
  // as if it were stable.
  assert.throws(
    () =>
      resolveVersion({
        tags: ['v1.0.0-rc.1', 'v1.0.0-beta.2'],
        bump: 'minor',
      }),
    /no prior stable tag found/
  );
});

test('resolveVersion: prerelease-only tag history + major + seed succeeds (treated as no-prior-tag)', () => {
  assert.equal(
    resolveVersion({
      tags: ['v1.0.0-rc.1'],
      bump: 'major',
      seedVersion: '0.0.0',
    }),
    '1.0.0'
  );
});

// ---------- major-from-main edge cases (named, exit-criteria-level) ----

test('major-from-main edge case (a): no prior tag at all -> patch/minor unsatisfiable, major needs seed', () => {
  assert.throws(() => resolveVersion({ tags: [], bump: 'patch' }), /no prior stable tag found/);
  assert.throws(() => resolveVersion({ tags: [], bump: 'minor' }), /no prior stable tag found/);
  assert.throws(() => resolveVersion({ tags: [], bump: 'major' }), /seed version/);
  assert.equal(resolveVersion({ tags: [], bump: 'major', seedVersion: '0.0.0' }), '1.0.0');
});

test('major-from-main edge case (b): multiple major lines present simultaneously -> highest-precedence stable tag wins', () => {
  // Both a v1.x and v2.x stable line exist (e.g. a maintained-LTS scenario).
  // Detection mechanism (documented in lib/resolve-version.js's file header):
  // pick the globally highest (major, minor, patch) stable tag, regardless
  // of how many major lines coexist. v2.3.0 wins over v1.9.0.
  const tags = ['v1.0.0', 'v1.9.0', 'v2.0.0', 'v2.3.0'];
  assert.equal(selectLatestStableTag(tags), 'v2.3.0');
  assert.equal(resolveVersion({ tags, bump: 'patch' }), '2.3.1');
  assert.equal(resolveVersion({ tags, bump: 'minor' }), '2.4.0');
  assert.equal(resolveVersion({ tags, bump: 'major' }), '3.0.0');
});

test('major-from-main edge case (b) variant: an in-flight v2 prerelease does not pre-empt the stable v1 line', () => {
  // A "v2" line has started but not shipped stable yet (only a -rc tag) —
  // the stable baseline must still be the latest *stable* v1.x tag, not the
  // prerelease v2 tag. This is the deliberate behavior documented in the
  // file header, not an oversight.
  const tags = ['v1.4.2', 'v2.0.0-rc.1'];
  assert.equal(selectLatestStableTag(tags), 'v1.4.2');
  assert.equal(resolveVersion({ tags, bump: 'major' }), '2.0.0');
});

test('major-from-main edge case (c): prerelease-only tag history (no stable tag yet)', () => {
  const tags = ['v1.0.0-rc.1', 'v1.0.0-rc.2', 'v0.9.0-beta.1'];
  assert.equal(selectLatestStableTag(tags), null);
  assert.throws(() => resolveVersion({ tags, bump: 'patch' }), /no prior stable tag found/);
  assert.throws(() => resolveVersion({ tags, bump: 'major' }), /seed version/);
});

// ---------- Checkpoint 1: malformed baseline tag fails before arithmetic --

test('checkpoint 1: malformed baseline tag fails validation before arithmetic (garbage selected somehow is rejected)', () => {
  // selectLatestStableTag only ever returns a tag that already passed the
  // strict-semver shape (or null) — so to exercise checkpoint 1 rejecting a
  // bad *baseline* in resolveVersion directly, we go through the seed path,
  // which feeds straight into the same assertStrictSemver call site as a
  // selected tag would.
  assert.throws(
    () => resolveVersion({ tags: [], bump: 'major', seedVersion: 'not-a-version' }),
    (err) => {
      assert.ok(err instanceof VersionResolverError);
      assert.match(err.message, /seed version/);
      assert.match(err.message, /not a strict major\.minor\.patch semver string/);
      return true;
    }
  );
});

test('checkpoint 1: malformed seed with prerelease suffix is rejected (seed must be strictly stable)', () => {
  assert.throws(
    () => resolveVersion({ tags: [], bump: 'major', seedVersion: '1.0.0-rc.1' }),
    /not a strict major\.minor\.patch semver string/
  );
});

test('checkpoint 1 directly: assertStrictSemver rejects non-semver strings', () => {
  assert.throws(() => assertStrictSemver('not-a-version', 'ctx'), VersionResolverError);
  assert.throws(() => assertStrictSemver('1.2', 'ctx'), VersionResolverError);
  assert.throws(() => assertStrictSemver('1.2.3.4', 'ctx'), VersionResolverError);
  assert.throws(() => assertStrictSemver('v1.02.3', 'ctx'), VersionResolverError); // leading zero
  assert.throws(() => assertStrictSemver('1.2.3-rc.1', 'ctx'), VersionResolverError); // prerelease not allowed here
  assert.throws(() => assertStrictSemver('', 'ctx'), VersionResolverError);
  assert.throws(() => assertStrictSemver(null, 'ctx'), VersionResolverError);
  assert.throws(() => assertStrictSemver(undefined, 'ctx'), VersionResolverError);
});

test('checkpoint 1 directly: assertStrictSemver accepts strict major.minor.patch, with or without v prefix', () => {
  assert.deepEqual(assertStrictSemver('1.2.3', 'ctx'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(assertStrictSemver('v1.2.3', 'ctx'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(assertStrictSemver('0.0.0', 'ctx'), { major: 0, minor: 0, patch: 0 });
});

test('checkpoint 1: an absurdly-large-digit-count component is rejected, by name, not "fails somehow"', () => {
  // 28 nines — far beyond the 9-digit cap (`\d{0,8}` after the first
  // digit). The regex's digit-run cap rejects this shape outright, with
  // the same named VersionResolverError every other malformed-shape input
  // gets — this is a stated invariant (the cap exists specifically so no
  // regex-accepted value can ever approach Number.MAX_SAFE_INTEGER), not an
  // accidental side effect of Number() producing exponential notation that
  // happens to no longer match downstream.
  const hugeMajor = '9'.repeat(28);
  assert.throws(
    () => assertStrictSemver(`${hugeMajor}.0.0`, 'ctx'),
    (err) => {
      assert.ok(err instanceof VersionResolverError);
      assert.match(err.message, /not a strict major\.minor\.patch semver string/);
      return true;
    }
  );
});

test('checkpoint 1: the largest digit-cap-admissible component (9 nines) stays within Number.isSafeInteger', () => {
  // Sanity-checks the invariant the digit cap is built to guarantee: the
  // largest value the regex's `\d{0,8}` cap can ever admit (9 digits) is
  // still far inside Number.MAX_SAFE_INTEGER's 16-digit range, so the
  // explicit Number.isSafeInteger guard in assertStrictSemver never fires
  // through this call path today — it is deliberate defense-in-depth for
  // if the cap is ever loosened, not dead code.
  const parsed = assertStrictSemver('999999999.999999999.999999999', 'ctx');
  assert.ok(Number.isSafeInteger(parsed.major));
  assert.ok(Number.isSafeInteger(parsed.minor));
  assert.ok(Number.isSafeInteger(parsed.patch));
});

// ---------- Checkpoint 2: malformed computed output fails validation -----

test('checkpoint 2: malformed computed output is rejected via a crafted test double, independent of checkpoint 1', () => {
  // A correct implementation never produces a malformed computed version on
  // its own (the arithmetic only ever does integer addition over an
  // already-validated baseline) — so to exercise checkpoint 2's own
  // independent enforcement we inject a deliberately broken formatter via
  // the test-only `_formatComputed` seam. Checkpoint 1 (the baseline,
  // 'v1.0.0') passes cleanly here; only checkpoint 2 is under test.
  assert.throws(
    () =>
      resolveVersion({
        tags: ['v1.0.0'],
        bump: 'patch',
        _formatComputed: () => 'not-a-version',
      }),
    (err) => {
      assert.ok(err instanceof VersionResolverError);
      assert.match(err.message, /computed output version/);
      assert.match(err.message, /not a strict major\.minor\.patch semver string/);
      return true;
    }
  );
});

test('checkpoint 2: rejects a computed value with an injected prerelease suffix', () => {
  assert.throws(
    () =>
      resolveVersion({
        tags: ['v1.0.0'],
        bump: 'minor',
        _formatComputed: (next) => `${next.major}.${next.minor}.${next.patch}-rc.1`,
      }),
    /computed output version/
  );
});

test('checkpoint 2: rejects a computed value with injected command-injection-shaped payload', () => {
  // Demonstrates checkpoint 2 closes B7/AP6 even if a future bug fed
  // attacker-shaped data into the formatting stage — the regex has no
  // shell-metacharacter allowance.
  assert.throws(
    () =>
      resolveVersion({
        tags: ['v1.0.0'],
        bump: 'patch',
        _formatComputed: () => '1.0.1; rm -rf /',
      }),
    /computed output version/
  );
});

test('checkpoint 2: independently catches a bad value even when checkpoint 1 input was perfectly valid', () => {
  // Confirms the two checkpoints are not the same call collapsed into one:
  // checkpoint 1 (baseline 'v9.9.9') succeeds, arithmetic proceeds, and only
  // checkpoint 2 (on the formatter-injected garbage) fails.
  assert.doesNotThrow(() => assertStrictSemver('v9.9.9', 'checkpoint-1-sanity'));
  assert.throws(
    () =>
      resolveVersion({
        tags: ['v9.9.9'],
        bump: 'major',
        _formatComputed: () => '',
      }),
    /computed output version/
  );
});

// ---------- bump validation ---------------------------------------------

test('resolveVersion: rejects an invalid bump value', () => {
  assert.throws(
    () => resolveVersion({ tags: ['v1.0.0'], bump: 'sideways' }),
    (err) => {
      assert.ok(err instanceof VersionResolverError);
      assert.match(err.message, /bump must be one of/);
      return true;
    }
  );
});

test('resolveVersion: rejects a missing bump value', () => {
  assert.throws(() => resolveVersion({ tags: ['v1.0.0'] }), /bump must be one of/);
});

// ---------- selectLatestStableTag / isPrerelease (direct unit coverage) --

test('selectLatestStableTag: returns null for an empty or non-array input', () => {
  assert.equal(selectLatestStableTag([]), null);
  assert.equal(selectLatestStableTag(undefined), null);
  assert.equal(selectLatestStableTag(null), null);
});

test('selectLatestStableTag: skips garbage/non-version tags mixed into history', () => {
  assert.equal(
    selectLatestStableTag(['release-train', 'v1.0.0', 'nightly-build']),
    'v1.0.0'
  );
});

test('selectLatestStableTag: trims whitespace-padded tags itself, independent of any caller-side normalization', () => {
  // Before this fix, selectLatestStableTag([' v1.0.0 ']) returned null —
  // correct only because action.yml's caller happens to .trim() each tag
  // line first. This function must be correct standalone: a future caller
  // (or a platform that leaves CRLF/trailing whitespace in `git tag
  // --list` output) must not silently lose a valid stable tag.
  assert.equal(selectLatestStableTag([' v1.0.0 ']), 'v1.0.0');
  assert.equal(selectLatestStableTag(['\tv2.3.0\r\n']), 'v2.3.0');
  assert.equal(
    selectLatestStableTag([' v1.0.0 ', '  v1.4.2  ', 'v1.3.9']),
    'v1.4.2'
  );
});

test('resolveVersion: end-to-end with whitespace-padded tags resolves correctly without caller-side trimming', () => {
  assert.equal(
    resolveVersion({ tags: [' v1.2.3 \r\n'], bump: 'patch' }),
    '1.2.4'
  );
});

test('isPrerelease: detects -rc/-beta and build-metadata suffixes; stable tags are not prerelease', () => {
  assert.equal(isPrerelease('v1.0.0-rc.1'), true);
  assert.equal(isPrerelease('v1.0.0-beta.3'), true);
  assert.equal(isPrerelease('1.0.0+build.7'), true);
  assert.equal(isPrerelease('v1.0.0'), false);
  assert.equal(isPrerelease('not-a-version'), false);
});
