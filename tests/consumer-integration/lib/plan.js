// Pure decisions for the consumer-integration job: branch names, the ref
// rewrite, which run belongs to us, whether a run passed, and what the
// release path dispatches. No I/O here, so each rule is tested directly;
// integrate.js does the git and GitHub calls.
'use strict';

const path = require('node:path');
const { resolveVersion, selectLatestStableTag } = require(
  path.join(__dirname, '..', '..', '..', '.github', 'actions', 'version-resolver', 'lib', 'resolve-version.js'));

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

/** The gate case passes when the quality gate job failed and no other job did. */
function gateVerdict(jobs) {
  const failed = (jobs || []).filter((job) => FAILED.has(job.conclusion));
  const gate = failed.filter(isQualityGate);
  const others = failed.filter((job) => !isQualityGate(job)).map((job) => job.name);
  if (gate.length === 0) return { ok: false, reason: 'the quality-gate job did not fail' };
  if (others.length > 0) return { ok: false, reason: `jobs other than quality-gate failed: ${others.join(', ')}` };
  return { ok: true, reason: 'failed at the quality-gate job only' };
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
};
