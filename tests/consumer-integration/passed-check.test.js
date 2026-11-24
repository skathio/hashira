// Rules for the consumer-integration checks on the aggregate `ci / passed`
// job and the one hashira summary comment, through integrate.js's public
// commands. Each fixture is pushed with `open` against a local bare repo,
// then pr-run and gate-run answer from a fake `gh`.
//
// Run locally with:  node --test tests/consumer-integration/passed-check.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const integrate = require('./lib/integrate.js');
const { MARKER, renderBody } = require('../../.github/actions/ci-summary/lib/body.js');

const S = 'c'.repeat(40);
const OTHER_SHA = 'a'.repeat(40);
const MAIN_PR = 7;
const GATE_PR = 8;
const BOT = 'github-actions[bot]';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'passed-check-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const repoOf = (flow) => `skathio/hashira-fixture-${flow}`;

function fixtureRemote(name) {
  const remote = path.join(tmp, `${name}.git`);
  const seed = path.join(tmp, `${name}-seed`);
  git(tmp, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(tmp, ['init', '-q', '-b', 'main', seed]);
  fs.writeFileSync(path.join(seed, 'old.txt'), 'old\n');
  git(seed, ['add', '.']);
  git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed']);
  git(seed, ['push', '-q', remote, 'main']);
  return remote;
}

function sourceTree(name) {
  const source = path.join(tmp, `${name}-source`);
  fs.mkdirSync(path.join(source, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(source, '.github', 'workflows', 'ci.yml'),
    'jobs:\n  ci:\n    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@v3\n');
  fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = 1;\n');
  return source;
}

function context(name, flow) {
  const workdir = path.join(tmp, `${name}-work`);
  fs.mkdirSync(workdir, { recursive: true });
  return {
    repo: repoOf(flow), flow, sha: S, source: sourceTree(name), remote: fixtureRemote(name), workdir,
    stateFile: path.join(workdir, 'state.json'), summaryFile: path.join(workdir, 'summary.md'),
  };
}

// A fake gh: `routes` maps a regex over the joined args to a reply. An
// unmatched call fails like a 404.
function fakeDeps(routes) {
  const calls = [];
  let clock = 0;
  const gh = (args) => {
    const line = args.join(' ');
    calls.push(line);
    const route = routes.find(([pattern]) => pattern.test(line));
    if (!route) throw Object.assign(new Error(`gh: no route for ${line}`), { stderr: 'gh: Not Found (HTTP 404)' });
    return typeof route[1] === 'string' ? route[1] : JSON.stringify(route[1]);
  };
  return { calls, gh, git, sleep: (ms) => { clock += ms; }, now: () => clock };
}

// The PRs already exist, so `open` only pushes the branches and reuses them.
function pullRoutes(flow) {
  const pull = (number) => [{ number, html_url: `https://github.com/${repoOf(flow)}/pull/${number}` }];
  return [
    [new RegExp(`pulls\\?head=skathio:hashira/${S}-gate&`), pull(GATE_PR)],
    [new RegExp(`pulls\\?head=skathio:hashira/${S}&`), pull(MAIN_PR)],
  ];
}

function opened(name, flow) {
  const ctx = context(name, flow);
  integrate.open(ctx, fakeDeps(pullRoutes(flow)));
  return { ctx, heads: JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8')).heads };
}

function botComment(flow, sha) {
  const event = { pull_request: { head: { sha } }, repository: { html_url: `https://github.com/${repoOf(flow)}` } };
  const body = renderBody({ needs: {}, inputs: {}, event, runUrl: `https://github.com/${repoOf(flow)}/actions/runs/1` });
  return { id: 100, user: { login: BOT, type: 'Bot' }, body };
}

const userComment = (body) => ({ id: 200, user: { login: 'someone', type: 'User' }, body });

const job = (name, conclusion) => ({ name, status: 'completed', conclusion });

function makeRun({ flow, head, id, conclusion }) {
  return { id, html_url: `https://github.com/${repoOf(flow)}/actions/runs/${id}`, status: 'completed',
    conclusion, event: 'pull_request', head_sha: head, created_at: '2026-01-01T00:00:00Z' };
}

function runRoutes(flow, run, { jobs, comments, pr }) {
  return [
    [new RegExp(`head_sha=${run.head_sha}`), { workflow_runs: [run] }],
    [new RegExp(`runs/${run.id}/jobs`), { jobs }],
    [new RegExp(`issues/${pr}/comments`), comments],
    ...pullRoutes(flow),
  ];
}

function prDeps(flow, head, { jobs, comments, conclusion = 'success' }) {
  return fakeDeps(runRoutes(flow, makeRun({ flow, head, id: 1, conclusion }), { jobs, comments, pr: MAIN_PR }));
}

const greenJobs = [job('ci / setup', 'success'), job('ci / test', 'success'), job('ci / passed', 'success')];

// A failing case must fail on the rule under test, not on a missing route.
function assertRefused(call) {
  assert.throws(call, (err) => !/no route|Not Found/.test(`${err.message} ${err.stderr || ''}`));
}

for (const flow of ['npm', 'nuget', 'static']) {
  test(`pr-run passes ${flow} when ci / passed succeeded and one bot comment names the head`, () => {
    const { ctx, heads } = opened(`ok-${flow}`, flow);
    const deps = prDeps(flow, heads.main, { jobs: greenJobs, comments: [botComment(flow, heads.main)] });
    assert.doesNotThrow(() => integrate.prRun(ctx, deps));
  });

  test(`pr-run fails ${flow} when the run has no job named ci / passed`, () => {
    const { ctx, heads } = opened(`nojob-${flow}`, flow);
    const jobs = greenJobs.filter((j) => j.name !== 'ci / passed');
    assertRefused(() => integrate.prRun(ctx, prDeps(flow, heads.main, { jobs, comments: [botComment(flow, heads.main)] })));
  });

  test(`pr-run fails ${flow} when ci / passed did not conclude success`, () => {
    const { ctx, heads } = opened(`skip-${flow}`, flow);
    const jobs = [...greenJobs.slice(0, 2), job('ci / passed', 'skipped')];
    assertRefused(() => integrate.prRun(ctx, prDeps(flow, heads.main, { jobs, comments: [botComment(flow, heads.main)] })));
  });

  test(`pr-run fails ${flow} when the PR has no hashira summary comment`, () => {
    const { ctx, heads } = opened(`none-${flow}`, flow);
    assertRefused(() => integrate.prRun(ctx, prDeps(flow, heads.main, { jobs: greenJobs, comments: [] })));
  });

  test(`pr-run fails ${flow} when the PR has two bot summary comments`, () => {
    const { ctx, heads } = opened(`two-${flow}`, flow);
    const comments = [botComment(flow, heads.main), { ...botComment(flow, heads.main), id: 101 }];
    assertRefused(() => integrate.prRun(ctx, prDeps(flow, heads.main, { jobs: greenJobs, comments })));
  });

  test(`pr-run fails ${flow} when the one bot summary comment names another commit`, () => {
    const { ctx, heads } = opened(`stale-${flow}`, flow);
    const comments = [botComment(flow, OTHER_SHA)];
    assertRefused(() => integrate.prRun(ctx, prDeps(flow, heads.main, { jobs: greenJobs, comments })));
  });
}

test('pr-run counts only github-actions[bot] comments: a user comment with the marker is not one', () => {
  const { ctx, heads } = opened('user-extra', 'nuget');
  const comments = [userComment(`${MARKER}\nmine, naming ${heads.main}`), botComment('nuget', heads.main)];
  assert.doesNotThrow(() => integrate.prRun(ctx, prDeps('nuget', heads.main, { jobs: greenJobs, comments })));
});

test('pr-run fails when only a user-owned comment carries the marker', () => {
  const { ctx, heads } = opened('user-only', 'static');
  const comments = [userComment(botComment('static', heads.main).body)];
  assertRefused(() => integrate.prRun(ctx, prDeps('static', heads.main, { jobs: greenJobs, comments })));
});

test('pr-run fails when the bot comment carries the marker but does not start with it', () => {
  const { ctx, heads } = opened('marker-late', 'npm');
  const comment = botComment('npm', heads.main);
  const comments = [{ ...comment, body: `Some other note.\n${comment.body}` }];
  assertRefused(() => integrate.prRun(ctx, prDeps('npm', heads.main, { jobs: greenJobs, comments })));
});

function gateDeps(heads, passedConclusion) {
  const jobs = [job('ci / setup', 'success'), job('ci / quality-gate', 'failure')];
  if (passedConclusion) jobs.push(job('ci / passed', passedConclusion));
  const run = makeRun({ flow: 'npm', head: heads.gate, id: 2, conclusion: 'failure' });
  return fakeDeps(runRoutes('npm', run, { jobs, comments: [botComment('npm', heads.gate)], pr: GATE_PR }));
}

test('gate-run passes when quality-gate failed and ci / passed concluded failure', () => {
  const { ctx, heads } = opened('gate-ok', 'npm');
  assert.doesNotThrow(() => integrate.gateRun(ctx, gateDeps(heads, 'failure')));
});

test('gate-run fails when ci / passed concluded success in the gate case', () => {
  const { ctx, heads } = opened('gate-green', 'npm');
  assertRefused(() => integrate.gateRun(ctx, gateDeps(heads, 'success')));
});

test('gate-run fails when the gate run has no ci / passed job', () => {
  const { ctx, heads } = opened('gate-nojob', 'npm');
  assertRefused(() => integrate.gateRun(ctx, gateDeps(heads, null)));
});
