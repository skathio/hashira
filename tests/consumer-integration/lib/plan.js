// Pure decisions for the consumer-integration job: branch names, the ref
// rewrite, which run belongs to us, whether a run passed, and what the
// release path dispatches. No I/O here, so each rule is tested directly;
// integrate.js does the git and GitHub calls.
'use strict';

const path = require('node:path');
const { resolveVersion, selectLatestStableTag } = require(
  path.join(__dirname, '..', '..', '..', '.github', 'actions', 'version-resolver', 'lib', 'resolve-version.js'));
const { MARKER } = require(path.join(__dirname, '..', '..', '..', '.github', 'actions', 'ci-summary', 'lib', 'body.js'));

// What each flow's release path proves. npm and NuGet cut a real tag and
// GitHub Release; static deploys to Pages, and its own deploy job checks the
// live site. Only the npm fixture carries the quality-gate negative case.
const FLOWS = Object.freeze({
  npm: Object.freeze({ tagged: true, gate: true }),
  nuget: Object.freeze({ tagged: true, gate: false }),
  static: Object.freeze({ tagged: false, gate: false }),
});

// How long one fixture run may take, from the start of its wait.
const WAIT_MS = 30 * 60 * 1000;
const COMMIT = /^[0-9a-f]{40}$/;
// `skathio/hashira/<path>@<ref>`: the slash after the repo name keeps
// `skathio/hashira-fixture-npm` and plain links out of the rewrite.
const HASHIRA_REF = /(skathio\/hashira\/[^\s@'"]+)@[^\s'"#]+/g;
const QUALITY_GATE_JOB = /(^|\/ )quality-gate$/;
// The fixtures call the workflow as job `ci`, so the aggregate check the
// rulesets require reports under exactly this name.
const PASSED_JOB = 'ci / passed';
const SUMMARY_AUTHOR = 'github-actions[bot]';
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);

function assertCommit(sha) {
  if (!COMMIT.test(String(sha))) throw new Error(`not a 40-character commit: '${sha}'`);
  return sha;
}

function branchNames(sha) {
  assertCommit(sha);
  return { main: `hashira/${sha}`, gate: `hashira/${sha}-gate` };
}

/** Sets every `skathio/hashira/...@<ref>` in a file to the commit under test. */
function rewriteRefs(text, sha) {
  assertCommit(sha);
  return text.replace(HASHIRA_REF, `$1@${sha}`);
}

// One function over SoMi's strict parameter limit (4). It is built here as
// text so that hashira's own quality gate never scores it.
function gateSource() {
  const params = ['a', 'b', 'c', 'd', 'e', 'f'];
  return [
    "'use strict';",
    '',
    '// Over the quality gate\'s strict parameter limit on purpose.',
    `function overLimit(${params.join(', ')}) {`,
    `  return ${params.join(' + ')};`,
    '}',
    '',
    'module.exports = { overLimit };',
    '',
  ].join('\n');
}

/** The dispatch inputs for a flow's release path, given the fixture's tags. */
function releaseInputs(flow, tags) {
  if (!FLOWS[flow].tagged) return {};
  return selectLatestStableTag(tags) === null ? { bump: 'patch', seed_version: '0.0.0' } : { bump: 'patch' };
}

/** The tag the release path must create, computed the way the fixture's CI does. */
function expectedTag(tags, inputs) {
  return `v${resolveVersion({ tags, bump: inputs.bump, seedVersion: inputs.seed_version })}`;
}

/** The newest run of `event` at `headSha`, or null. */
function pickRun(runs, event, headSha) {
  const ours = (runs || []).filter((run) => run.event === event && run.head_sha === headSha);
  ours.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return ours[0] || null;
}

function timeoutMessage(repo, run) {
  return `timed out waiting for ${repo} run ${run ? run.id : '(not started)'}`;
}

function summaryLine(repo, label, run) {
  return `- ${label}: [${repo} run ${run.id}](${run.html_url}) ${run.conclusion}\n`;
}

function isQualityGate(job) {
  return QUALITY_GATE_JOB.test(String(job.name));
}

const isPassed = (job) => String(job.name) === PASSED_JOB;

/**
 * The gate case passes when the quality gate job failed and no other job did.
 * `ci / passed` is left out: it fails because the gate failed.
 */
function gateVerdict(jobs) {
  const failed = (jobs || []).filter((job) => FAILED.has(job.conclusion) && !isPassed(job));
  const gate = failed.filter(isQualityGate);
  const others = failed.filter((job) => !isQualityGate(job)).map((job) => job.name);
  if (gate.length === 0) return { ok: false, reason: 'the quality-gate job did not fail' };
  if (others.length > 0) return { ok: false, reason: `jobs other than quality-gate failed: ${others.join(', ')}` };
  return { ok: true, reason: 'failed at the quality-gate job only' };
}

/** Whether the run's `ci / passed` job concluded `expected`. */
function passedVerdict(jobs, expected) {
  const passed = (jobs || []).filter(isPassed);
  if (passed.length === 0) return { ok: false, reason: `the run has no job named '${PASSED_JOB}'` };
  const conclusions = passed.map((job) => job.conclusion);
  if (conclusions.every((c) => c === expected)) return { ok: true, reason: `${PASSED_JOB} concluded ${expected}` };
  return { ok: false, reason: `${PASSED_JOB} concluded ${conclusions.join(', ')}, expected ${expected}` };
}

const isSummaryComment = (comment) =>
  comment?.user?.login === SUMMARY_AUTHOR && String(comment.body ?? '').startsWith(MARKER);

/**
 * The PR passes when it carries exactly one github-actions[bot] comment that
 * starts with the summary marker and links the run's head commit. A user's
 * comment holding the marker is not the summary and is not counted.
 */
function summaryCommentVerdict(comments, headSha) {
  const ours = (comments || []).filter(isSummaryComment);
  if (ours.length !== 1) return { ok: false, reason: `${ours.length} ${SUMMARY_AUTHOR} summary comments, expected exactly 1` };
  if (!String(ours[0].body).includes(`/commit/${assertCommit(headSha)})`)) {
    return { ok: false, reason: `the summary comment does not name head commit ${headSha}` };
  }
  return { ok: true, reason: 'one summary comment naming the head commit' };
}

module.exports = {
  FLOWS,
  WAIT_MS,
  assertCommit,
  branchNames,
  rewriteRefs,
  gateSource,
  releaseInputs,
  expectedTag,
  pickRun,
  timeoutMessage,
  summaryLine,
  gateVerdict,
  passedVerdict,
  summaryCommentVerdict,
};
