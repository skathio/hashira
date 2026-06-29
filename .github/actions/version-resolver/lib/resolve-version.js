// Pure logic core for the `version-resolver` composite action (D1/D8, FR-3, security.md B7).
//
// Given the repo's tag history and a maintainer-dispatched `bump`, computes the
// next release version. Zero env access, zero I/O — every branch is reachable
// from a plain JS call so the two-checkpoint semver validation and the
// major-from-main edge cases can be unit-tested directly, without spinning up
// a real git repo or a GitHub Actions runtime.
//
// ## The two checkpoints (B7 — both required, independently testable)
//
//   Checkpoint 1 (`assertStrictSemver`, baseline side): every candidate stable
//   tag is validated against STRICT_SEMVER_RE *before* it is used as an
//   arithmetic input (selecting the baseline, then bumping it). A tag that
//   fails this check is excluded from "stable tag" consideration — never fed
//   into arithmetic. An explicit `seedVersion` is validated the same way,
//   since it plays the baseline's role when no prior tag exists.
//
//   Checkpoint 2 (`assertStrictSemver`, output side): the *computed* version
//   string is validated again, immediately before `resolveVersion` returns it.
//   This is deliberately a second, independent call against the same baseline
//   regex/function — not skipped because "we just built it arithmetically so
//   it must be fine." A future bug in the arithmetic (or a malicious/buggy
//   caller swapping in a crafted `_unsafeOutputOverride` — see tests) must
//   still be caught here before the value can reach a privileged sink
//   (`git tag`, `gh release create`, the artifact stamp write) in the
//   composite action / CI workflow that calls this shim.
//
// Both checkpoints call the *same* `assertStrictSemver` function — that's
// intentional and matches B7's text ("two checkpoints... (1) validate the
// parsed baseline tag... (2) validate the computed output version again");
// the requirement is that the two call SITES are distinct and independently
// reachable/testable, not that the regex itself differs. Tests below exercise
// each call site directly so a regression that deletes one checkpoint (but
// leaves the other) shows up as a failing test, not as silently-passing
// coverage.
//
// ## major-from-main detection mechanism (sdd.md §8 — semantics settled,
// mechanism is this iteration's pick, recorded here per the phase file)
//
// "Latest stable tag" is defined as: among all tags that pass strict semver
// validation as a *stable* release (`vX.Y.Z`, no prerelease/build metadata —
// prerelease tags like `v1.2.0-rc.1` are filtered out before comparison),
// the one with the numerically highest (major, minor, patch) precedence
// ordering. This is a pure function of the tag *strings* — it does not
// consult commit timestamps, tag-creation order, or `git log` ordering.
//
// Why this mechanism, not "most recent major line" or "tag reachable from
// HEAD with the highest commit count": determinism (spec.md §7 requires the
// resolver be deterministic for a given (tags, bump, ref) triple, with no
// reliance on wall-clock time or commit-graph shape) and because it is the
// only ordering that gives one unambiguous answer when multiple major lines
// coexist (e.g. both `v1.4.2` and `v2.0.0-rc.1` tags exist: `v2.0.0-rc.1` is
// prerelease so it's filtered out for `patch`/`minor` purposes, leaving
// `v1.4.2` as the stable baseline even though a "v2" line has started — this
// is the deliberate behavior, not an oversight: a `major`/`minor`/`patch`
// release while a v2 prerelease is in flight should still bump off the latest
// *stable* line, since the v2 line hasn't shipped a stable release yet). If
// two *stable* major lines coexist (e.g. both `v1.9.0` and `v2.3.0` are
// stable tags — a maintained-LTS-branch scenario), the highest-precedence tag
// (`v2.3.0`) wins, on the theory that `main`'s next release continues the
// newest line; the older stable line existing simultaneously does not change
// what `main`'s next dispatch should produce. This is documented behavior,
// not an unexamined default — see the "multiple major lines" test cases.
//
// ## scope assumption: single advancing release line (no ref-reachability awareness)
//
// This resolver assumes a single advancing release line of stable tags per
// repository. A repo with concurrently-maintained LTS branches tagging
// independently-advancing release lines (e.g. a `v9.x` LTS branch still
// receiving patches alongside a `main`-line `v3.x`) is out of scope — this
// mechanism has no ref-reachability awareness (it never inspects which
// branch a tag is reachable from) and will silently select the
// numerically-highest tag regardless of which branch it lives on. The
// "multiple major lines coexist" case described above is about a *single*
// repository transitioning between major versions on one line (the old
// line not yet retired, the new line not yet stable) — not two
// independently-maintained, concurrently-advancing lines. Confirmed
// out-of-scope for hashira's current consumers: somi and rogue are both
// single-release-line packages today. If a future consumer needs
// multi-line support, this is a real structural gap requiring new design
// (ref-reachability lookups), not a parameter tweak.
//
// ## seed-version semantics (no-prior-tag + major/initial release)
//
// FR-3 / FRD F1-A1 state the initial-release seed "plays the baseline's
// role... not a guessed baseline" — read literally, the seed substitutes for
// "the latest stable tag" when none exists, and the normal bump arithmetic
// still applies on top of it. So `bump=major` with no prior tag and
// `seedVersion=2.0.0` produces `3.0.0` (major-bump from the seed), not a
// literal `2.0.0` passthrough. This keeps one arithmetic code path instead of
// a second "use the seed directly" branch, and composes predictably: a
// maintainer who wants the literal seed as the first release should dispatch
// with a seed one bump-step below their intended first version (e.g.
// seed=`0.0.0` + `bump=major` -> `1.0.0`), matching how every other bump call
// already behaves.

'use strict';

// Stable release tag: optional `v` prefix, then strict major.minor.patch,
// digits only, no leading zeros beyond a bare "0", no prerelease/build
// metadata. This is intentionally narrower than full SemVer 2.0 (which
// allows prerelease/build suffixes) because this regex's job is to gate
// "stable tag" / "stable computed output" — prerelease tags are handled by
// the separate IS_PRERELEASE_RE filter below, and outputs from this resolver
// never carry a prerelease/build suffix.
//
// Each component's digit run is capped at 9 digits (`\d{0,8}` after the
// first digit). This is a stated invariant, not an accident: 9 digits is
// comfortably above any real version number, while staying well under
// `Number.MAX_SAFE_INTEGER`'s 16-digit range, so `Number()` on a matched
// component can never silently lose precision or flip into exponential
// notation. Without this cap, an absurd input (e.g. a 28-digit "major")
// would still happen to get rejected today, but only as a side effect of
// `Number()` producing a string that no longer round-trips through this
// same regex at Checkpoint 2 — an accidental property of float formatting,
// not a guarantee. With the cap in place, rejection of an oversized
// component happens right here, by name (the regex simply fails to match),
// which is also what makes the `Number.isSafeInteger` check in
// `assertStrictSemver` below unreachable through this call path today (no
// <=9-digit value can exceed MAX_SAFE_INTEGER) — that check is deliberate
// defense-in-depth for if this cap is ever loosened, not dead code.
const STRICT_SEMVER_RE = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

// Any tag carrying a prerelease (`-rc.1`) or build-metadata (`+build.5`)
// suffix per SemVer 2.0 grammar. Used only to recognize and skip prerelease
// tags when scanning tag history — never used to validate a value that's
// about to be used as a baseline or returned as output (those go through
// STRICT_SEMVER_RE, which rejects prerelease/build suffixes outright).
const IS_PRERELEASE_RE = /^v?\d+\.\d+\.\d+[-+]/;

/**
 * Checkpoint function. Throws `VersionResolverError` if `value` is not a
 * strict `(v)X.Y.Z` string. Returns the parsed `{ major, minor, patch }`
 * (numbers) on success. Called independently at both checkpoints (baseline
 * selection and final output) — see the file header.
 */
function assertStrictSemver(value, context) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new VersionResolverError(
      `${context}: expected a non-empty semver string, got ${JSON.stringify(value)}`
    );
  }
  const match = STRICT_SEMVER_RE.exec(value);
  if (!match) {
    throw new VersionResolverError(
      `${context}: '${value}' is not a strict major.minor.patch semver string (no prerelease/build metadata allowed)`
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  // Defense-in-depth, explicit invariant: every parsed component must be a
  // safe integer. Given the regex's 9-digit cap above, this can never
  // actually fire through this call path today (no <=9-digit value exceeds
  // Number.MAX_SAFE_INTEGER) — it exists so the failure mode stays a named,
  // intentional check rather than relying solely on the digit cap staying
  // exactly as tight as it is today.
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    throw new VersionResolverError(
      `${context}: '${value}' has a component exceeding safe integer range`
    );
  }
  return { major, minor, patch };
}

function isPrerelease(tag) {
  return typeof tag === 'string' && IS_PRERELEASE_RE.test(tag);
}

/**
 * Selects the latest *stable* tag from a list of tag names, per the
 * major-from-main detection mechanism documented in the file header:
 * highest (major, minor, patch) precedence among tags that pass strict
 * semver validation as a stable release. Prerelease tags (`-rc`, `-beta`,
 * build metadata) are filtered out before comparison — they never
 * participate in baseline selection, regardless of how recent they are.
 *
 * Returns `null` if no stable tag exists (covers: empty tag list, and
 * "prerelease-only tag history" per the phase file's 3c).
 *
 * Tags that are neither valid prerelease-shaped nor valid strict-semver
 * (garbage tags, e.g. a branch-name-shaped tag) are silently skipped here —
 * they're not candidates for "latest stable" either way. This function only
 * *selects*; it does not throw on garbage input, since a repo may
 * legitimately have non-version tags (release branches, CI markers) mixed
 * into its tag list. Checkpoint 1 enforcement happens on the one tag this
 * function ultimately selects, in `resolveVersion`.
 *
 * Each tag string is trimmed before matching, so this function is correct
 * standalone on whitespace-padded input (e.g. CRLF or trailing-space
 * artifacts some platforms can introduce into `git tag --list` output) —
 * correctness here does not depend on a caller normalizing first. The
 * returned tag string (when non-null) is the trimmed form.
 */
function selectLatestStableTag(tags) {
  if (!Array.isArray(tags)) {
    return null;
  }
  let best = null;
  let bestParsed = null;
  for (const tag of tags) {
    if (typeof tag !== 'string') {
      continue;
    }
    // Defensive trim: this function's correctness must not depend on a
    // caller (e.g. action.yml's `.trim()` on each `git tag --list` line)
    // normalizing whitespace first. CRLF/trailing-whitespace-padded tags
    // are a real possibility on some platforms; trim here so this library
    // function is correct standalone, regardless of what any future caller
    // does or doesn't do upstream.
    const trimmed = tag.trim();
    if (isPrerelease(trimmed)) {
      continue;
    }
    const match = STRICT_SEMVER_RE.exec(trimmed);
    if (!match) {
      continue;
    }
    const parsed = {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
    };
    if (
      best === null ||
      parsed.major > bestParsed.major ||
      (parsed.major === bestParsed.major && parsed.minor > bestParsed.minor) ||
      (parsed.major === bestParsed.major &&
        parsed.minor === bestParsed.minor &&
        parsed.patch > bestParsed.patch)
    ) {
      best = trimmed;
      bestParsed = parsed;
    }
  }
  return best;
}

class VersionResolverError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VersionResolverError';
  }
}

/**
 * Computes the next release version.
 *
 * @param {object} opts
 * @param {string[]} [opts.tags] - all tags in the repo (any shape; filtered
 *   internally). May be omitted/empty to mean "no tags at all".
 * @param {'patch'|'minor'|'major'} opts.bump - the dispatch-chosen bump kind.
 * @param {string} [opts.seedVersion] - required only when no stable tag
 *   exists; plays the baseline's role (see file header).
 * @param {(next: {major: number, minor: number, patch: number}) => string} [opts._formatComputed] -
 *   TEST-ONLY seam. Overrides how the arithmetic result is formatted into a
 *   string, before Checkpoint 2 validates it. Production callers must never
 *   pass this — it exists solely so the test suite can simulate "the
 *   arithmetic stage produced a malformed string" and assert Checkpoint 2
 *   independently catches it, without that being reachable through any real
 *   (tags, bump, seedVersion) input (a correct implementation never produces
 *   a malformed computed value on its own).
 * @returns {string} the bare validated semver string, no `v` prefix
 *   (Checkpoint 2 already applied before return).
 * @throws {VersionResolverError} on any unsatisfiable/invalid input.
 */
function resolveVersion({ tags, bump, seedVersion, _formatComputed } = {}) {
  if (bump !== 'patch' && bump !== 'minor' && bump !== 'major') {
    throw new VersionResolverError(
      `resolveVersion: bump must be one of 'patch'|'minor'|'major', got ${JSON.stringify(bump)}`
    );
  }

  const latestStableTag = selectLatestStableTag(tags);
  let baseline;

  if (latestStableTag !== null) {
    // Checkpoint 1: validate the parsed baseline tag before using it as an
    // arithmetic input.
    baseline = assertStrictSemver(latestStableTag, 'resolveVersion: baseline tag');
  } else if (seedVersion !== undefined && seedVersion !== null && seedVersion !== '') {
    // No prior stable tag: the seed plays the baseline's role. It goes
    // through the same Checkpoint-1 call — a malformed seed is rejected
    // exactly like a malformed tag would be.
    baseline = assertStrictSemver(seedVersion, 'resolveVersion: seed version');
  } else {
    throw new VersionResolverError(
      bump === 'major'
        ? "resolveVersion: no prior stable tag found and no 'seedVersion' provided — an initial/major release requires an explicit seed version (FR-3)"
        : `resolveVersion: no prior stable tag found — '${bump}' is unsatisfiable without a baseline; pass bump=major with an explicit seedVersion for the first release (FR-3)`
    );
  }

  let next;
  if (bump === 'major') {
    next = { major: baseline.major + 1, minor: 0, patch: 0 };
  } else if (bump === 'minor') {
    next = { major: baseline.major, minor: baseline.minor + 1, patch: 0 };
  } else {
    next = { major: baseline.major, minor: baseline.minor, patch: baseline.patch + 1 };
  }

  const computed = _formatComputed
    ? _formatComputed(next)
    : `${next.major}.${next.minor}.${next.patch}`;

  // Checkpoint 2: validate the computed output version again, independently
  // of checkpoint 1, before it is returned to the caller (which will stamp
  // it into the artifact / hand it to the CD composite's tag + Release
  // step). A correct implementation always passes this — the test suite
  // exercises the failure path via a crafted double, not by trying to make
  // real arithmetic produce a malformed string.
  assertStrictSemver(computed, 'resolveVersion: computed output version');

  return computed;
}

module.exports = {
  resolveVersion,
  selectLatestStableTag,
  assertStrictSemver,
  isPrerelease,
  VersionResolverError,
  STRICT_SEMVER_RE,
  IS_PRERELEASE_RE,
};
