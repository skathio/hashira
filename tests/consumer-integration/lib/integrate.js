// The consumer-integration job's driver, one command per workflow step:
//   node integrate.js lock-wait wait, without a token, until the fixture
//                               repo's integration lock is free (lock.js)
//   node integrate.js lock      take that lock
//   node integrate.js open      push hashira/<S> (and, for npm, hashira/<S>-gate)
//                               to the fixture repo and open a PR for each
//   node integrate.js pr-run    wait for the hashira/<S> PR's fixture CI; check
//                               `ci / passed` succeeded and the PR has one
//                               hashira summary comment naming the head
//   node integrate.js gate-run  wait for the -gate PR's run and check it
//                               failed at the quality-gate job only and
//                               `ci / passed` failed
//   node integrate.js release   dispatch the release path on hashira/<S>,
//                               wait for it, and check the tag and Release
//   node integrate.js cleanup   if this run took the lock: cancel leftover
//                               runs, delete the tag and Release, close the
//                               PRs, delete the branches, release the lock
// It reads FIXTURE_REPO, FIXTURE_FLOW, FIXTURE_SOURCE, HASHIRA_SHA,
// GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, the App token in GH_TOKEN (every
// command but lock-wait) and this job's own token in HASHIRA_TOKEN. The token reaches git only through the environment
// and gh only through GH_TOKEN; it is never printed or written to disk.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const plan = require('./plan.js');
const lock = require('./lock.js');

const OWNER = 'skathio';
const WORKFLOW = 'ci.yml';
const POLL_MS = 15 * 1000;
const FIXTURE_REPO = /^hashira-fixture-[a-z]+$/;
// Left out of the copy: local build output that must not reach the fixture.
const SKIPPED = new Set(['node_modules', '__pycache__', 'bin', 'obj', 'dist', 'coverage']);
const IDENTITY = ['-c', 'user.name=hashira consumer-integration',
  '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];

// --- state shared between steps -------------------------------------------

function readState(ctx) {
  try {
    return JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function writeState(ctx, patch) {
  fs.writeFileSync(ctx.stateFile, JSON.stringify({ ...readState(ctx), ...patch }));
}

function summary(ctx, text) {
  if (ctx.summaryFile) fs.appendFileSync(ctx.summaryFile, text);
}

// --- the fixture branches --------------------------------------------------

function replaceTree(dir, source) {
  for (const entry of fs.readdirSync(dir)) {
    if (entry !== '.git') fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  fs.cpSync(source, dir, { recursive: true, filter: (from) => !SKIPPED.has(path.basename(from)) });
}

function rewriteWorkflows(dir, sha) {
  const workflows = path.join(dir, '.github', 'workflows');
  if (!fs.existsSync(workflows)) return;
  for (const name of fs.readdirSync(workflows).filter((n) => /\.ya?ml$/.test(n))) {
    const file = path.join(workflows, name);
    fs.writeFileSync(file, plan.rewriteRefs(fs.readFileSync(file, 'utf8'), sha));
  }
}

function commit(deps, dir, message) {
  deps.git(dir, [...IDENTITY, 'add', '-A']);
  deps.git(dir, [...IDENTITY, 'commit', '--quiet', '--allow-empty', '-m', message]);
  return deps.git(dir, ['rev-parse', 'HEAD']).trim();
}

/** Pushes the fixture branches; returns { main, gate? } head commits. */
function pushBranches(ctx, deps) {
  const dir = path.join(ctx.workdir, 'fixture');
  const branches = plan.branchNames(ctx.sha);
  fs.rmSync(dir, { recursive: true, force: true });
  deps.git(ctx.workdir, ['clone', '--quiet', '--depth', '1', '--branch', 'main', ctx.remote, dir]);
  replaceTree(dir, ctx.source);
  rewriteWorkflows(dir, ctx.sha);
  const heads = { main: commit(deps, dir, `test: hashira ${ctx.sha}`) };
  if (plan.FLOWS[ctx.flow].gate) {
    fs.writeFileSync(path.join(dir, 'gate.js'), plan.gateSource());
    heads.gate = commit(deps, dir, 'test: add a function over the quality limit');
  }
  // One atomic push carries every branch in a single pack. Pushed one after
  // the other, the -gate push sent only its own commit and leaned on the
  // hashira/<S> commit pushed a second earlier, and GitHub sometimes
  // rejected it with "missing necessary objects".
  const refspecs = Object.keys(heads).map((key) => `${heads[key]}:refs/heads/${branches[key]}`);
  deps.git(dir, ['push', '--quiet', '--force', '--atomic', 'origin', ...refspecs]);
  return heads;
}

// --- GitHub ----------------------------------------------------------------

function ghJson(deps, args) {
  const out = deps.gh(args).trim();
  return out ? JSON.parse(out) : null;
}

function openPulls(ctx, deps, branch) {
  return ghJson(deps, ['api', `repos/${ctx.repo}/pulls?head=${OWNER}:${branch}&state=open`]) || [];
}

function openPull(ctx, deps, branch) {
  const existing = openPulls(ctx, deps, branch)[0];
  if (existing) return existing;
  return ghJson(deps, ['api', '-X', 'POST', `repos/${ctx.repo}/pulls`, '-f', `title=hashira ${branch}`,
    '-f', `head=${branch}`, '-f', 'base=main',
    '-f', 'body=Opened by hashira\'s consumer-integration job. It closes this PR when it ends.']);
}

function findRun(ctx, deps, event, headSha) {
  const query = `event=${event}&head_sha=${headSha}&per_page=20`;
  const page = ghJson(deps, ['api', `repos/${ctx.repo}/actions/workflows/${WORKFLOW}/runs?${query}`]);
  return plan.pickRun(page && page.workflow_runs, event, headSha);
}

/** Polls until the run is completed; throws the timeout message after WAIT_MS. */
function waitForRun(ctx, deps, event, headSha) {
  const deadline = deps.now() + plan.WAIT_MS;
  let run = null;
  for (;;) {
    run = findRun(ctx, deps, event, headSha) || run;
    if (run && run.status === 'completed') return run;
    if (deps.now() >= deadline) throw new Error(plan.timeoutMessage(ctx.repo, run));
    deps.sleep(POLL_MS);
  }
}

function runJobs(ctx, deps, run) {
  const page = ghJson(deps, ['api', `repos/${ctx.repo}/actions/runs/${run.id}/jobs?per_page=100`]);
  return (page && page.jobs) || [];
}

// The issue comments of the open PR from `branch`. A fixture PR carries a
// handful, so one page of 100 holds them all.
function pullComments(ctx, deps, branch) {
  const pull = openPulls(ctx, deps, branch)[0];
  if (!pull) throw new Error(`${ctx.repo} has no open PR from ${branch}`);
  return ghJson(deps, ['api', `repos/${ctx.repo}/issues/${pull.number}/comments?per_page=100`]) || [];
}

function assertVerdict(ctx, run, verdict) {
  if (!verdict.ok) throw new Error(`${ctx.repo} run ${run.id}: ${verdict.reason}`);
}

// --- commands --------------------------------------------------------------

function open(ctx, deps) {
  const heads = pushBranches(ctx, deps);
  writeState(ctx, { heads });
  const branches = plan.branchNames(ctx.sha);
  for (const key of Object.keys(heads)) {
    const pull = openPull(ctx, deps, branches[key]);
    summary(ctx, `- fixture PR: [${ctx.repo}#${pull.number}](${pull.html_url})\n`);
  }
}

function pushedHeads(ctx) {
  const { heads } = readState(ctx);
  if (!heads) throw new Error('no fixture branches were pushed');
  return heads;
}

// Each wait is its own step with its own App token: one wait can take 30
// minutes and a token lasts an hour.
function prRun(ctx, deps) {
  const heads = pushedHeads(ctx);
  const run = waitForRun(ctx, deps, 'pull_request', heads.main);
  summary(ctx, plan.summaryLine(ctx.repo, 'fixture CI', run));
  if (run.conclusion !== 'success') throw new Error(`${ctx.repo} run ${run.id} concluded ${run.conclusion}`);
  assertVerdict(ctx, run, plan.passedVerdict(runJobs(ctx, deps, run), 'success'));
  const comments = pullComments(ctx, deps, plan.branchNames(ctx.sha).main);
  assertVerdict(ctx, run, plan.summaryCommentVerdict(comments, heads.main));
  summary(ctx, `- ${ctx.repo}: ci / passed succeeded, one summary comment names ${heads.main}\n`);
}

function gateRun(ctx, deps) {
  const heads = pushedHeads(ctx);
  if (!heads.gate) throw new Error(`${ctx.repo} has no quality gate branch: only the npm fixture runs the gate case`);
  const run = waitForRun(ctx, deps, 'pull_request', heads.gate);
  const jobs = runJobs(ctx, deps, run);
  const verdict = plan.gateVerdict(jobs);
  summary(ctx, plan.summaryLine(ctx.repo, `quality gate negative case (${verdict.reason})`, run));
  assertVerdict(ctx, run, verdict);
  assertVerdict(ctx, run, plan.passedVerdict(jobs, 'failure'));
}

function lockWait(ctx, deps) {
  const state = lock.wait(ctx, deps);
  summary(ctx, `- integration lock in ${ctx.repo}: ${state === 'free' ? 'free' : state}\n`);
}

function lockTake(ctx, deps) {
  const taken = lock.take(ctx, deps);
  // Recorded at once, so cleanup releases it whatever happens next.
  writeState(ctx, { lock: taken.commit });
  const note = taken.replaced ? `, replacing a stale lock (${taken.replaced})` : '';
  summary(ctx, `- integration lock in ${ctx.repo}: taken${note}\n`);
}

function listTags(ctx, deps) {
  const out = deps.gh(['api', '--paginate', `repos/${ctx.repo}/git/matching-refs/tags`, '--jq', '.[].ref']);
  return out.split('\n').filter(Boolean).map((ref) => ref.replace(/^refs\/tags\//, ''));
}

function dispatch(ctx, deps, inputs) {
  const fields = Object.entries(inputs).flatMap(([key, value]) => ['-f', `inputs[${key}]=${value}`]);
  deps.gh(['api', '-X', 'POST', `repos/${ctx.repo}/actions/workflows/${WORKFLOW}/dispatches`,
    '-f', `ref=${plan.branchNames(ctx.sha).main}`, ...fields]);
}

function assertTagged(ctx, deps, tag) {
  const ref = ghJson(deps, ['api', `repos/${ctx.repo}/git/ref/tags/${tag}`]);
  const release = ghJson(deps, ['api', `repos/${ctx.repo}/releases/tags/${tag}`]);
  if (!ref || ref.ref !== `refs/tags/${tag}`) throw new Error(`${ctx.repo} has no tag ${tag}`);
  if (!release || release.tag_name !== tag) throw new Error(`${ctx.repo} has no Release ${tag}`);
  summary(ctx, `- release path: tag and Release ${tag} exist in ${ctx.repo}\n`);
}

function release(ctx, deps) {
  const heads = pushedHeads(ctx);
  const tags = listTags(ctx, deps);
  const inputs = plan.releaseInputs(ctx.flow, tags);
  const tag = plan.FLOWS[ctx.flow].tagged ? plan.expectedTag(tags, inputs) : null;
  // Recorded before the dispatch, so cleanup deletes the tag even when the
  // wait below fails or the job is cancelled.
  if (tag) writeState(ctx, { tag });
  dispatch(ctx, deps, inputs);
  const run = waitForRun(ctx, deps, 'workflow_dispatch', heads.main);
  summary(ctx, plan.summaryLine(ctx.repo, 'release path', run));
  if (run.conclusion !== 'success') throw new Error(`${ctx.repo} run ${run.id} concluded ${run.conclusion}`);
  if (tag) assertTagged(ctx, deps, tag);
}

// --- cleanup ---------------------------------------------------------------

// 404 and 422 are a thing already deleted; 409 is a run that already ended.
function alreadyGone(err) {
  return /HTTP (404|409|422)\b|Reference does not exist/.test(String(err && (err.stderr || err.message)));
}

/** Runs one cleanup call; a thing already gone is fine, anything else is recorded. */
function attempt(errors, what, call) {
  try {
    call();
  } catch (err) {
    if (!alreadyGone(err)) errors.push(`${what}: ${String(err.stderr || err.message).trim()}`);
  }
}

// A run left going would tag or deploy after cleanup, so stop it first.
function cancelRuns(ctx, deps, branch, errors) {
  attempt(errors, `cancel runs on ${branch}`, () => {
    const page = ghJson(deps, ['api', `repos/${ctx.repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=50`]);
    const live = ((page && page.workflow_runs) || []).filter((run) => run.status !== 'completed');
    for (const run of live) deps.gh(['api', '-X', 'POST', `repos/${ctx.repo}/actions/runs/${run.id}/cancel`]);
  });
}

function deleteRelease(ctx, deps, tag, errors) {
  attempt(errors, `delete Release ${tag}`, () => {
    const found = ghJson(deps, ['api', `repos/${ctx.repo}/releases/tags/${tag}`]);
    deps.gh(['api', '-X', 'DELETE', `repos/${ctx.repo}/releases/${found.id}`]);
  });
  attempt(errors, `delete tag ${tag}`, () => deps.gh(['api', '-X', 'DELETE', `repos/${ctx.repo}/git/refs/tags/${tag}`]));
}

function deleteBranch(ctx, deps, branch, errors) {
  attempt(errors, `close PRs from ${branch}`, () => {
    for (const pull of openPulls(ctx, deps, branch)) {
      deps.gh(['api', '-X', 'PATCH', `repos/${ctx.repo}/pulls/${pull.number}`, '-f', 'state=closed']);
    }
  });
  attempt(errors, `delete branch ${branch}`, () => deps.gh(['api', '-X', 'DELETE', `repos/${ctx.repo}/git/refs/heads/${branch}`]));
}

function releaseLock(ctx, deps, commit, errors) {
  try {
    const released = lock.release(ctx, deps, commit);
    summary(ctx, `- integration lock in ${ctx.repo}: ${released ? 'released' : 'already replaced by another run, left alone'}\n`);
  } catch (err) {
    errors.push(`release the integration lock: ${String(err.stderr || err.message).trim()}`);
  }
}

function cleanup(ctx, deps) {
  const errors = [];
  const state = readState(ctx);
  // A run that never took the lock pushed nothing, and the branches named
  // after S may belong to another run at the same commit that holds it.
  if (!state.lock) {
    summary(ctx, '- cleanup: nothing to clean, this run never took the integration lock\n');
    return;
  }
  const branches = Object.values(plan.branchNames(ctx.sha));
  for (const branch of branches) cancelRuns(ctx, deps, branch, errors);
  if (state.tag) deleteRelease(ctx, deps, state.tag, errors);
  for (const branch of branches) deleteBranch(ctx, deps, branch, errors);
  // Last, so the next run starts only after this one's tag, Release and
  // branches are gone.
  if (state.lock) releaseLock(ctx, deps, state.lock, errors);
  summary(ctx, `- cleanup: ${errors.length ? `${errors.length} failed` : 'tag, Release, PRs and branches removed'}\n`);
  if (errors.length) throw new Error(`cleanup in ${ctx.repo} failed: ${errors.join('; ')}`);
}

// --- entry point -----------------------------------------------------------

const COMMANDS = { 'lock-wait': lockWait, lock: lockTake, open, 'pr-run': prRun, 'gate-run': gateRun, release, cleanup };
const DIGITS = /^[0-9]+$/;

function requireEnv(env, name, valid) {
  if (!valid(env[name] || '')) throw new Error(`bad ${name} '${env[name]}'`);
}

function contextFromEnv(env) {
  requireEnv(env, 'FIXTURE_REPO', (v) => FIXTURE_REPO.test(v));
  requireEnv(env, 'FIXTURE_FLOW', (v) => Object.hasOwn(plan.FLOWS, v));
  requireEnv(env, 'GITHUB_RUN_ID', (v) => DIGITS.test(v));
  requireEnv(env, 'GITHUB_RUN_ATTEMPT', (v) => DIGITS.test(v));
  const repo = `${OWNER}/${env.FIXTURE_REPO}`;
  return {
    repo,
    flow: env.FIXTURE_FLOW,
    sha: plan.assertCommit(env.HASHIRA_SHA),
    run: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    source: path.resolve(env.FIXTURE_SOURCE || ''),
    remote: `https://github.com/${repo}.git`,
    workdir: env.RUNNER_TEMP,
    stateFile: path.join(env.RUNNER_TEMP, 'consumer-integration.json'),
    summaryFile: env.GITHUB_STEP_SUMMARY,
  };
}

// git authenticates with the App token through an extra header set in the
// environment, so the token is in no URL, argument or config file. Without
// a token (lock-wait) git reads the public fixture repo anonymously.
function gitEnv(env) {
  if (!env.GH_TOKEN) return { ...env, GIT_TERMINAL_PROMPT: '0' };
  const basic = Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString('base64');
  return { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`, GIT_TERMINAL_PROMPT: '0' };
}

function realDeps(env) {
  const withGit = gitEnv(env);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  return {
    gh: (args) => execFileSync('gh', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }),
    // Reads hashira's own runs with this job's token, never the App token.
    hashiraGh: (args) => execFileSync('gh', args, { encoding: 'utf8', env: { ...env, GH_TOKEN: env.HASHIRA_TOKEN || '' }, stdio: ['ignore', 'pipe', 'pipe'] }),
    git: (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: withGit, stdio: ['ignore', 'pipe', 'pipe'] }),
    sleep: (ms) => Atomics.wait(pause, 0, 0, ms),
    now: () => Date.now(),
  };
}

function main(argv, env) {
  const command = COMMANDS[argv[0]];
  if (!command) throw new Error(`usage: integrate.js ${Object.keys(COMMANDS).join('|')}`);
  command(contextFromEnv(env), realDeps(env));
}

if (require.main === module) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (err) {
    const detail = String(err.stderr || '').trim();
    console.log(`::error::${err.message}${detail ? ` (${detail})` : ''}`);
    process.exitCode = 1;
  }
}

module.exports = { lockWait, lockTake, open, prRun, gateRun, release, cleanup, contextFromEnv, gitEnv, COMMANDS };
