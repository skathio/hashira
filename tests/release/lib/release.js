// Pure decisions for release.yml: whether a release may go ahead, which
// version it cuts, and what is left to do for the tag, the GitHub Release and
// the major tag. No I/O here, so each rule is tested directly; the workflow
// collects the tags, the CI runs and the templates and acts on the answer.
// A refusal is a thrown error, so a caller that forgets to check fails closed.
'use strict';

const path = require('node:path');
const { resolveVersion, assertStrictSemver } = require(
  path.join(__dirname, '..', '..', '..', '.github', 'actions', 'version-resolver', 'lib', 'resolve-version.js'));

const BUMPS = new Set(['patch', 'minor', 'major']);
const COMMIT = /^[0-9a-f]{40}$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
// v1 and v2 are frozen: their consumers still pass `library_ref`, so a
// release of either major, or any move of their tags, would break them.
const FROZEN_MAJORS = new Set([1, 2]);
// `uses: skathio/hashira/<path>@<ref>`, with the key or the value quoted or
// not, in any letter case: GitHub matches a `uses:` owner and repo without
// regard to case. The slash after the repo name keeps
// `skathio/hashira-fixture-npm` out.
const HASHIRA_USES = /uses['"]?\s*:\s*['"]?skathio\/hashira\/[^\s@'"]+@([^\s'"#]+)/gi;
// A ref that names a major: `v3` or `v3.1.0`.
const MAJOR_REF = /^v(0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8}))?$/;

function refuse(message) {
  throw new Error(`release refused: ${message}`);
}

function assertCiPassed(ciConclusion) {
  if (ciConclusion === undefined || ciConclusion === null || ciConclusion === '') {
    refuse("no completed _self-ci.yml run for main's HEAD");
  }
  if (ciConclusion !== 'success') {
    refuse(`the latest completed _self-ci.yml run for main's HEAD is '${ciConclusion}', not 'success'`);
  }
}

function assertNotFrozen(major) {
  if (FROZEN_MAJORS.has(major)) refuse(`v${major} is frozen and never released or moved`);
}

/** Every `skathio/hashira/...@<ref>` ref in one template, as written. */
function hashiraRefs(text) {
  return [...String(text).matchAll(HASHIRA_USES)].map((m) => m[1]);
}

// A ref that names no major at all (a SHA, `main`) is refused too: the
// templates are what consumers copy, and they must pin the released major.
function namesMajor(ref, major) {
  const m = MAJOR_REF.exec(ref);
  return m !== null && Number(m[1]) === major;
}

function assertTemplatesName(templates, major) {
  if (templates === null || typeof templates !== 'object' || Array.isArray(templates)
      || Object.keys(templates).length === 0) {
    refuse('no caller templates to check');
  }
  for (const [file, text] of Object.entries(templates)) {
    // A template that could not be read must not pass as one with no refs.
    if (typeof text !== 'string') refuse(`${file} has no text to check`);
    const bad = hashiraRefs(text).find((ref) => !namesMajor(ref, major));
    if (bad !== undefined) refuse(`${file} pins skathio/hashira@${bad}, but this release is v${major}`);
  }
}

/**
 * The checks made before anything is approved or pushed. Returns the version
 * to release; throws on any refusal.
 *
 * @param {object} opts
 * @param {string} opts.bump - exactly 'patch', 'minor' or 'major'.
 * @param {string[]} opts.tags - the repo's tag names.
 * @param {string|null} opts.ciConclusion - the latest completed _self-ci.yml
 *   run's conclusion for main's HEAD, or null when there is none.
 * @param {Object<string, string>} opts.templates - templates/<flow>/ci.yml path to its text.
 * @returns {{ version: string, tag: string, majorTag: string }}
 */
function checkRelease({ bump, tags, ciConclusion, templates } = {}) {
  if (!BUMPS.has(bump)) refuse(`bump must be patch, minor or major, got ${JSON.stringify(bump)}`);
  assertCiPassed(ciConclusion);
  const version = resolveVersion({ tags, bump });
  const { major } = assertStrictSemver(version, 'checkRelease: resolved version');
  assertNotFrozen(major);
  assertTemplatesName(templates, major);
  return { version, tag: `v${version}`, majorTag: `v${major}` };
}

/** 'done' when `name` is already on `sha`, else whether it is created or moved. */
function tagStep(tags, name, sha) {
  if (!Object.prototype.hasOwnProperty.call(tags, name)) return 'create';
  return tags[name] === sha ? 'done' : 'move';
}

/** Refuses a malformed planPublish input; returns the version's major. */
function assertPlanInputs({ version, sha, tags, releaseExists }) {
  const { major } = assertStrictSemver(version, 'planPublish: version');
  if (version.startsWith('v')) refuse(`version must be bare, got '${version}'`);
  assertNotFrozen(major);
  if (typeof sha !== 'string' || !COMMIT.test(sha)) refuse(`not a 40-character commit: '${sha}'`);
  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) refuse('tags must map tag names to commits');
  if (typeof releaseExists !== 'boolean') refuse('releaseExists must be true or false');
  return major;
}

/**
 * What is left to do for a release, so a re-run after a partial failure
 * finishes it. The release tag on another commit is refused, never moved,
 * and so is a commit already released as another version.
 * Only the released version's own major tag is ever named.
 *
 * @param {object} opts
 * @param {string} opts.version - the bare version, e.g. '3.1.1'.
 * @param {string} opts.sha - the 40-character commit being released.
 * @param {Object<string, string>} opts.tags - tag name to the commit it points at
 *   (peeled, so an annotated tag maps to its commit, not the tag object).
 * @param {boolean} opts.releaseExists - whether the GitHub Release for the tag exists.
 * @returns {{ tag: string, release: string, majorTag: string, majorTagName: string }}
 */
function planPublish({ version, sha, tags, releaseExists } = {}) {
  const major = assertPlanInputs({ version, sha, tags, releaseExists });
  const tagName = `v${version}`;
  const tag = tagStep(tags, tagName, sha);
  if (tag === 'move') refuse(`${tagName} already exists on ${tags[tagName]}, not ${sha}`);
  // A commit is released once. A re-run of its release resolves the same
  // version and finishes it; a dispatch with another bump is refused.
  const other = Object.keys(tags).filter((n) => n !== tagName && RELEASE_TAG.test(n) && tags[n] === sha);
  if (other.length) refuse(`${sha} is already released as ${other.join(', ')}; re-run with the bump that cut it`);
  const majorTagName = `v${major}`;
  // A stale re-run, after a later release of the same major went out, must not pull the major
  // tag back: consumers on vN already have the newer commit.
  const superseded = Object.keys(tags).some((n) => {
    const p = releaseParts(n);
    return p !== null && p[0] === BigInt(major) && compareParts(p, releaseParts(tagName)) > 0 && tags[n] !== sha;
  });
  return {
    tag,
    release: releaseExists ? 'done' : 'create',
    majorTag: superseded ? 'done' : tagStep(tags, majorTagName, sha),
    majorTagName,
  };
}

/** [major, minor, patch] as BigInts for a `vX.Y.Z` tag name, else null. */
function releaseParts(name) {
  return RELEASE_TAG.test(name) ? name.slice(1).split('.').map(BigInt) : null;
}

function compareParts(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function hasTag(tags, name) {
  return tags !== null && typeof tags === 'object' && Object.prototype.hasOwnProperty.call(tags, name);
}

/**
 * Refuses a release of a commit that is no longer main's HEAD (a full re-run of an old run),
 * unless the commit already carries this release's tag: then the re-run finishes it.
 *
 * @param {object} opts
 * @param {string} opts.version - the bare version being released.
 * @param {string} opts.sha - the commit being released.
 * @param {string} opts.mainHead - the commit origin's main points at now.
 * @param {Object<string, string>} opts.tags - tag name to its peeled commit.
 */
function assertCurrentMain({ version, sha, mainHead, tags } = {}) {
  if (typeof sha !== 'string' || !COMMIT.test(sha)) refuse(`not a 40-character commit: '${sha}'`);
  if (sha === mainHead) return;
  const tagName = `v${version}`;
  if (hasTag(tags, tagName) && tags[tagName] === sha) return;
  refuse(`${sha} is not main's HEAD (${mainHead}) and carries no ${tagName}; dispatch a new release from main`);
}

/**
 * Refuses unless the highest vX.Y.Z tag points at `sha`, so a stale re-run of a release's site
 * deploy never puts an older commit's site over a newer release's.
 */
function assertLatestRelease({ tags, sha } = {}) {
  if (typeof sha !== 'string' || !COMMIT.test(sha)) refuse(`not a 40-character commit: '${sha}'`);
  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) refuse('tags must map tag names to commits');
  const latest = highestRelease(Object.keys(tags));
  if (latest === null) refuse('no vX.Y.Z release tag to deploy');
  if (tags[latest] !== sha) refuse(`the latest release ${latest} is on ${tags[latest]}, not ${sha}; this run is stale`);
}

/** The highest `vX.Y.Z` among `names`, compared as numbers, or null when there is none. */
function highestRelease(names) {
  let latest = null;
  for (const name of names.filter((n) => RELEASE_TAG.test(n))) {
    if (latest === null || compareParts(releaseParts(name), releaseParts(latest)) > 0) latest = name;
  }
  return latest;
}

/**
 * The conclusion of the newest completed run at `headSha`, or null when there
 * is none. `runs` is the GitHub API's workflow-runs list for _self-ci.yml.
 * A `headSha` that is not a commit matches no run, so a caller that leaves it
 * out gets a refusal instead of some run's success.
 */
function latestCiConclusion(runs, headSha) {
  if (typeof headSha !== 'string' || !COMMIT.test(headSha)) return null;
  const done = (Array.isArray(runs) ? runs : [])
    .filter((run) => run && run.head_sha === headSha && run.status === 'completed' && fromMainPush(run));
  done.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return done.length ? done[0].conclusion : null;
}

/**
 * Where main's own `_self-ci.yml` push run for `headSha` stands: 'pending' while one is queued or
 * running, 'missing' when there is none yet (a dispatch right after a merge), else 'done'.
 * release.yml waits on 'pending', and on 'missing' for a short grace, before it decides.
 */
function ciState(runs, headSha) {
  if (typeof headSha !== 'string' || !COMMIT.test(headSha)) return 'missing';
  const mine = (Array.isArray(runs) ? runs : []).filter((run) => run && run.head_sha === headSha && fromMainPush(run));
  if (mine.length === 0) return 'missing';
  return mine.some((run) => run.status !== 'completed') ? 'pending' : 'done';
}

// Only main's own push runs count: a pull_request run at the same commit (a PR whose head is
// main's HEAD) is a different check. The workflow's query asks for push runs on main too; a run
// without these fields is left to that query.
function fromMainPush(run) {
  return (!('event' in run) || run.event === 'push') && (!('head_branch' in run) || run.head_branch === 'main');
}

module.exports = {
  checkRelease, planPublish, latestCiConclusion, ciState, hashiraRefs, assertCurrentMain, assertLatestRelease,
};
