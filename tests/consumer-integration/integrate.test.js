// Unit tests for tests/consumer-integration/lib/integrate.js: each command
// run against a local bare git repo standing in for the fixture repo and a
// fake `gh` that answers from a table, with a fake clock.
//
// Run locally with:  node --test tests/consumer-integration/integrate.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const integrate = require('./lib/integrate.js');
const { MARKER } = require('../../.github/actions/ci-summary/lib/body.js');

const S = 'c'.repeat(40);
const REPO = 'skathio/hashira-fixture-npm';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-integration-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A bare "fixture repo" with a main branch, and a source tree to push.
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
  fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(source, '.github', 'workflows', 'ci.yml'),
    'jobs:\n  ci:\n    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@v3\n');
  fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(source, 'node_modules', 'junk.js'), '\n');
  return source;
}

function context(name, flow) {
  const workdir = path.join(tmp, `${name}-work`);
  fs.mkdirSync(workdir, { recursive: true });
  return {
    repo: REPO, flow, sha: S, source: sourceTree(name), remote: fixtureRemote(name), workdir,
    stateFile: path.join(workdir, 'state.json'), summaryFile: path.join(workdir, 'summary.md'),
  };
}

// A fake gh: `routes` maps a regex over the joined args to a reply (a value,
// or a function of the call count). Unmatched calls fail like a 404.
function fakeDeps(routes) {
  const calls = [];
  let clock = 0;
  const gh = (args) => {
    const line = args.join(' ');
    calls.push(line);
    const route = routes.find(([pattern]) => pattern.test(line));
    if (!route) throw Object.assign(new Error(`gh: no route for ${line}`), { stderr: 'gh: Not Found (HTTP 404)' });
    const reply = typeof route[1] === 'function' ? route[1](calls.filter((c) => route[0].test(c)).length) : route[1];
    if (reply instanceof Error) throw reply;
    return typeof reply === 'string' ? reply : JSON.stringify(reply);
  };
  return { calls, gh, git, sleep: (ms) => { clock += ms; }, now: () => clock };
}

const run = (id, extra) => ({ id, html_url: `https://github.com/${REPO}/actions/runs/${id}`, status: 'completed',
  conclusion: 'success', event: 'pull_request', created_at: '2026-01-01T00:00:00Z', ...extra });
const readState = (ctx) => JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8'));
const summaryOf = (ctx) => fs.readFileSync(ctx.summaryFile, 'utf8');

test('open pushes hashira/<S> with refs rewritten, the -gate branch for npm, and opens both PRs', () => {
  const ctx = context('open-npm', 'npm');
  const deps = fakeDeps([
    [/pulls\?head=/, []],
    [/-X POST repos\/\S+\/pulls /, (n) => ({ number: n, html_url: `https://github.com/${REPO}/pull/${n}` })],
  ]);
  const pushes = [];
  deps.git = (cwd, args) => {
    if (args[0] === 'push') pushes.push(args);
    return git(cwd, args);
  };
  integrate.open(ctx, deps);
  const { heads } = readState(ctx);
  // Both branches go up in one atomic push, so the -gate commit never
  // depends on a commit the remote received in an earlier push.
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0].includes('--atomic'));
  assert.deepEqual(pushes[0].slice(-2), [`${heads.main}:refs/heads/hashira/${S}`, `${heads.gate}:refs/heads/hashira/${S}-gate`]);
  const show = (ref, file) => git(tmp, ['--git-dir', ctx.remote, 'show', `${ref}:${file}`]);
  assert.equal(git(tmp, ['--git-dir', ctx.remote, 'rev-parse', `hashira/${S}`]).trim(), heads.main);
  assert.equal(git(tmp, ['--git-dir', ctx.remote, 'rev-parse', `hashira/${S}-gate`]).trim(), heads.gate);
  assert.match(show(heads.main, '.github/workflows/ci.yml'), new RegExp(`npm-package-ci\\.yml@${S}\\n`));
  assert.throws(() => show(heads.main, 'old.txt'));
  assert.throws(() => show(heads.main, 'node_modules/junk.js'));
  assert.throws(() => show(heads.main, 'gate.js'));
  assert.match(show(heads.gate, 'gate.js'), /function overLimit/);
  assert.equal(deps.calls.filter((c) => c.includes('-X POST')).length, 2);
  assert.match(summaryOf(ctx), /fixture PR: \[skathio\/hashira-fixture-npm#2\]/);
});

test('open pushes no gate branch for nuget and reuses an open PR', () => {
  const ctx = context('open-nuget', 'nuget');
  const deps = fakeDeps([[/pulls\?head=/, [{ number: 9, html_url: 'https://x/9' }]]]);
  integrate.open(ctx, deps);
  assert.equal(readState(ctx).heads.gate, undefined);
  assert.throws(() => git(tmp, ['--git-dir', ctx.remote, 'rev-parse', '--verify', `hashira/${S}-gate`]));
  assert.ok(!deps.calls.some((c) => c.includes('-X POST')));
});

function prRunsContext(name, heads) {
  const ctx = context(name, 'npm');
  fs.writeFileSync(ctx.stateFile, JSON.stringify({ heads }));
  return ctx;
}

const MAIN = 'd'.repeat(40);
const GATE = 'e'.repeat(40);
const gateJobs = { jobs: [{ name: 'ci / setup', conclusion: 'success' }, { name: 'ci / quality-gate', conclusion: 'failure' },
  { name: 'ci / passed', conclusion: 'failure' }] };

const BOT = 'github-actions[bot]';
const summaryComment = (sha, login = BOT) =>
  ({ id: 1, user: { login }, body: `${MARKER}\n### hashira CI: pass\n\nHead commit [x](https://github.com/${REPO}/commit/${sha}).\n` });
const passedJobs = (conclusion) => ({ jobs: [{ name: 'ci / test', conclusion: 'success' }, { name: 'ci / passed', conclusion }] });

// The PR run's routes: the run, its jobs, the open PR from hashira/<S> (#7)
// and that PR's comments.
function prRunRoutes({ jobs = passedJobs('success'), comments = [summaryComment(MAIN)] } = {}) {
  return [
    [new RegExp(`head_sha=${MAIN}`), (n) => ({ workflow_runs: n < 3 ? [] : [run(1, { head_sha: MAIN })] })],
    [/runs\/1\/jobs/, jobs],
    [new RegExp(`pulls\\?head=skathio:hashira/${S}&`), [{ number: 7, html_url: `https://github.com/${REPO}/pull/7` }]],
    [/issues\/7\/comments/, comments],
  ];
}

test('pr-run waits for the PR run and passes it with ci / passed green and one summary comment', () => {
  const ctx = prRunsContext('pr-ok', { main: MAIN, gate: GATE });
  const deps = fakeDeps(prRunRoutes());
  integrate.prRun(ctx, deps);
  assert.match(summaryOf(ctx), /fixture CI: \[skathio\/hashira-fixture-npm run 1\]\(https:\/\/github.com\/\S+\/runs\/1\) success/);
  assert.match(summaryOf(ctx), /ci \/ passed succeeded, one summary comment names d{40}/);
  assert.ok(!deps.calls.some((c) => c.includes(GATE)), 'pr-run must not wait for the gate run');
});

test('pr-run fails when ci / passed is missing or did not succeed', () => {
  const missing = fakeDeps(prRunRoutes({ jobs: { jobs: [{ name: 'ci / test', conclusion: 'success' }] } }));
  assert.throws(() => integrate.prRun(prRunsContext('pr-nopassed', { main: MAIN }), missing),
    /run 1: the run has no job named 'ci \/ passed'/);
  const red = fakeDeps(prRunRoutes({ jobs: passedJobs('failure') }));
  assert.throws(() => integrate.prRun(prRunsContext('pr-redpassed', { main: MAIN }), red),
    /run 1: ci \/ passed concluded failure, expected success/);
});

test('pr-run fails unless exactly one bot summary comment names the head', () => {
  const cases = [
    ['pr-nocomment', [], /0 github-actions\[bot\] summary comments, expected exactly 1/],
    ['pr-twocomments', [summaryComment(MAIN), summaryComment(MAIN)], /2 github-actions\[bot\] summary comments/],
    ['pr-usercomment', [summaryComment(MAIN, 'someone')], /0 github-actions\[bot\] summary comments/],
    ['pr-stalecomment', [summaryComment(GATE)], /does not name head commit d{40}/],
  ];
  for (const [name, comments, message] of cases) {
    assert.throws(() => integrate.prRun(prRunsContext(name, { main: MAIN }), fakeDeps(prRunRoutes({ comments }))), message, name);
  }
});

test('pr-run fails when no PR is open from hashira/<S>', () => {
  const routes = prRunRoutes().map(([re, reply]) => [re, re.source.includes('pulls') ? [] : reply]);
  assert.throws(() => integrate.prRun(prRunsContext('pr-nopull', { main: MAIN }), fakeDeps(routes)),
    /has no open PR from hashira\/c{40}$/);
});

test('pr-run fails when the fixture CI fails', () => {
  const ctx = prRunsContext('pr-fail', { main: MAIN, gate: GATE });
  const deps = fakeDeps([[new RegExp(`head_sha=${MAIN}`), { workflow_runs: [run(1, { head_sha: MAIN, conclusion: 'failure' })] }]]);
  assert.throws(() => integrate.prRun(ctx, deps), /run 1 concluded failure/);
});

test('gate-run passes when the gate run failed at quality-gate only', () => {
  const ctx = prRunsContext('gate-ok', { main: MAIN, gate: GATE });
  const deps = fakeDeps([
    [new RegExp(`head_sha=${GATE}`), { workflow_runs: [run(2, { head_sha: GATE, conclusion: 'failure' })] }],
    [/runs\/2\/jobs/, gateJobs],
  ]);
  integrate.gateRun(ctx, deps);
  assert.match(summaryOf(ctx), /quality gate negative case \(failed at the quality-gate job only\)/);
});

test('gate-run fails when the quality-gate job passed', () => {
  const ctx = prRunsContext('gate-fail', { main: MAIN, gate: GATE });
  const deps = fakeDeps([
    [new RegExp(`head_sha=${GATE}`), { workflow_runs: [run(2, { head_sha: GATE, conclusion: 'success' })] }],
    [/runs\/2\/jobs/, { jobs: [{ name: 'ci / quality-gate', conclusion: 'success' }] }],
  ]);
  assert.throws(() => integrate.gateRun(ctx, deps), /run 2: the quality-gate job did not fail/);
});

test('gate-run fails when ci / passed did not fail or is missing', () => {
  const gateRoutes = (jobs) => [
    [new RegExp(`head_sha=${GATE}`), { workflow_runs: [run(2, { head_sha: GATE, conclusion: 'failure' })] }],
    [/runs\/2\/jobs/, { jobs }],
  ];
  const [setup, gate] = gateJobs.jobs;
  const green = fakeDeps(gateRoutes([setup, gate, { name: 'ci / passed', conclusion: 'success' }]));
  assert.throws(() => integrate.gateRun(prRunsContext('gate-greenpassed', { main: MAIN, gate: GATE }), green),
    /run 2: ci \/ passed concluded success, expected failure/);
  const missing = fakeDeps(gateRoutes([setup, gate]));
  assert.throws(() => integrate.gateRun(prRunsContext('gate-nopassed', { main: MAIN, gate: GATE }), missing),
    /run 2: the run has no job named 'ci \/ passed'/);
});

test('gate-run refuses a fixture with no gate branch', () => {
  assert.throws(() => integrate.gateRun(prRunsContext('gate-none', { main: MAIN }), fakeDeps([])), /no quality gate branch/);
});

test('pr-run times out after 30 minutes naming the repo and run', () => {
  const ctx = prRunsContext('pr-timeout', { main: MAIN });
  const deps = fakeDeps([[/head_sha=/, { workflow_runs: [run(5, { head_sha: MAIN, status: 'in_progress', conclusion: null })] }]]);
  assert.throws(() => integrate.prRun(ctx, deps), /^Error: timed out waiting for skathio\/hashira-fixture-npm run 5$/);
  const polls = deps.calls.length;
  assert.ok(polls > 100 && polls <= 30 * 4 + 1, `polled ${polls} times`);
});

test('pr-run refuses to run before open', () => {
  assert.throws(() => integrate.prRun(context('pr-none', 'npm'), fakeDeps([])), /no fixture branches/);
});

function releaseRoutes(tags, conclusion) {
  return [
    [/matching-refs\/tags/, tags.map((t) => `refs/tags/${t}`).join('\n')],
    [/dispatches/, ''],
    [/event=workflow_dispatch/, { workflow_runs: [run(8, { head_sha: MAIN, event: 'workflow_dispatch', conclusion })] }],
    [/git\/ref\/tags\/v0\.0\.1/, { ref: 'refs/tags/v0.0.1' }],
    [/releases\/tags\/v0\.0\.1/, { tag_name: 'v0.0.1' }],
  ];
}

test('release dispatches bump patch with seed 0.0.0 on a repo with no stable tag, and checks tag and Release', () => {
  const ctx = prRunsContext('release-seed', { main: MAIN });
  const deps = fakeDeps(releaseRoutes([], 'success'));
  integrate.release(ctx, deps);
  const dispatch = deps.calls.find((c) => c.includes('dispatches'));
  assert.match(dispatch, new RegExp(`-f ref=hashira/${S} -f inputs\\[bump\\]=patch -f inputs\\[seed_version\\]=0\\.0\\.0$`));
  assert.equal(readState(ctx).tag, 'v0.0.1');
  assert.match(summaryOf(ctx), /release path: \[\S+ run 8\]/);
  assert.match(summaryOf(ctx), /tag and Release v0\.0\.1 exist/);
});

test('release sends no seed once a stable tag exists, and fails when the tag is missing', () => {
  const ctx = prRunsContext('release-tagged', { main: MAIN });
  const deps = fakeDeps(releaseRoutes(['v0.0.0'], 'success').filter(([p]) => !/git\\\/ref/.test(p.source)));
  assert.throws(() => integrate.release(ctx, deps), /Not Found|no route/);
  assert.ok(!deps.calls.find((c) => c.includes('dispatches')).includes('seed_version'));
  assert.equal(readState(ctx).tag, 'v0.0.1');
});

test('release fails when the release run fails, after recording the tag for cleanup', () => {
  const ctx = prRunsContext('release-fail', { main: MAIN });
  assert.throws(() => integrate.release(ctx, fakeDeps(releaseRoutes([], 'failure'))), /run 8 concluded failure/);
  assert.equal(readState(ctx).tag, 'v0.0.1');
});

test('release for static dispatches no inputs and checks no tag', () => {
  const ctx = prRunsContext('release-static', { main: MAIN });
  ctx.flow = 'static';
  const deps = fakeDeps(releaseRoutes([], 'success'));
  integrate.release(ctx, deps);
  assert.match(deps.calls.find((c) => c.includes('dispatches')), new RegExp(`ref=hashira/${S}$`));
  assert.ok(!deps.calls.some((c) => c.includes('git/ref/tags')));
  assert.equal(readState(ctx).tag, undefined);
});

test('cleanup cancels live runs, deletes the Release and tag, closes PRs and deletes both branches', () => {
  const ctx = prRunsContext('cleanup', { main: MAIN });
  fs.writeFileSync(ctx.stateFile, JSON.stringify({ heads: { main: MAIN }, tag: 'v0.0.1', lock: 'f'.repeat(40) }));
  const deps = fakeDeps([
    [/actions\/runs\?branch=/, { workflow_runs: [run(3, { status: 'in_progress' }), run(4)] }],
    [/runs\/3\/cancel/, ''],
    [/^api repos\/\S+\/releases\/tags\/v0\.0\.1$/, { id: 77 }],
    [/-X DELETE/, ''],
    [/pulls\?head=/, [{ number: 5 }]],
    [/-X PATCH/, '{}'],
  ]);
  integrate.cleanup(ctx, deps);
  const did = deps.calls.join('\n');
  assert.match(did, /runs\/3\/cancel/);
  assert.doesNotMatch(did, /runs\/4\/cancel/);
  assert.match(did, /-X DELETE repos\/\S+\/releases\/77/);
  assert.match(did, /-X DELETE repos\/\S+\/git\/refs\/tags\/v0\.0\.1/);
  assert.match(did, /-X PATCH repos\/\S+\/pulls\/5 -f state=closed/);
  assert.match(did, new RegExp(`-X DELETE repos/\\S+/git/refs/heads/hashira/${S}\\n`));
  assert.match(did, new RegExp(`-X DELETE repos/\\S+/git/refs/heads/hashira/${S}-gate`));
  assert.match(summaryOf(ctx), /cleanup: tag, Release, PRs and branches removed/);
});

test('cleanup with the lock but nothing else tolerates what is already gone', () => {
  const ctx = context('cleanup-empty', 'npm');
  fs.writeFileSync(ctx.stateFile, JSON.stringify({ lock: 'f'.repeat(40) }));
  const deps = fakeDeps([[/pulls\?head=/, []], [/actions\/runs\?/, { workflow_runs: [] }], [/-X DELETE/, '']]);
  integrate.cleanup(ctx, deps);
  assert.ok(!deps.calls.some((c) => c.includes('releases')));
});

test('cleanup of a run that never took the lock touches nothing in the fixture repo', () => {
  const ctx = context('cleanup-unlocked', 'npm');
  fs.writeFileSync(ctx.stateFile, JSON.stringify({ heads: { main: MAIN }, tag: 'v0.0.1' }));
  const deps = fakeDeps([]);
  integrate.cleanup(ctx, deps);
  assert.deepEqual(deps.calls, []);
  assert.match(summaryOf(ctx), /nothing to clean, this run never took the integration lock/);
});

test('cleanup reports a failure that is not a missing thing, after trying everything', () => {
  const ctx = context('cleanup-denied', 'npm');
  fs.writeFileSync(ctx.stateFile, JSON.stringify({ lock: 'f'.repeat(40) }));
  const denied = Object.assign(new Error('denied'), { stderr: 'gh: Resource not accessible by integration (HTTP 403)' });
  const deps = fakeDeps([[/-X DELETE/, denied], [/pulls\?head=/, []], [/actions\/runs\?/, { workflow_runs: [] }]]);
  assert.throws(() => integrate.cleanup(ctx, deps), /delete branch hashira\/c+: .*HTTP 403.*delete branch hashira\/c+-gate/);
});

test('the context comes from the environment and refuses bad values', () => {
  const env = { FIXTURE_REPO: 'hashira-fixture-npm', FIXTURE_FLOW: 'npm', FIXTURE_SOURCE: 'tests/consumers/npm',
    HASHIRA_SHA: S, RUNNER_TEMP: tmp, GITHUB_STEP_SUMMARY: '/s', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
  const ctx = integrate.contextFromEnv(env);
  assert.equal(ctx.repo, REPO);
  assert.equal(ctx.run, '123');
  assert.equal(ctx.attempt, '2');
  assert.throws(() => integrate.contextFromEnv({ ...env, GITHUB_RUN_ID: '' }), /bad GITHUB_RUN_ID/);
  assert.throws(() => integrate.contextFromEnv({ ...env, GITHUB_RUN_ID: '12;x' }), /bad GITHUB_RUN_ID/);
  assert.throws(() => integrate.contextFromEnv({ ...env, GITHUB_RUN_ATTEMPT: undefined }), /bad GITHUB_RUN_ATTEMPT/);
  assert.equal(ctx.remote, `https://github.com/${REPO}.git`);
  assert.equal(ctx.stateFile, path.join(tmp, 'consumer-integration.json'));
  assert.throws(() => integrate.contextFromEnv({ ...env, FIXTURE_REPO: 'other/repo' }), /bad FIXTURE_REPO/);
  assert.throws(() => integrate.contextFromEnv({ ...env, FIXTURE_FLOW: 'toString' }), /bad FIXTURE_FLOW/);
  assert.throws(() => integrate.contextFromEnv({ ...env, HASHIRA_SHA: 'main' }), /not a 40-character commit/);
});

test('git gets the token as an extra header in its environment only', () => {
  const env = integrate.gitEnv({ GH_TOKEN: 'tok', PATH: '/bin' });
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}`);
  assert.equal(env.PATH, '/bin');
});

test('without a token git gets no auth header and never prompts', () => {
  const env = integrate.gitEnv({ PATH: '/bin' });
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('cleanup releases the integration lock this run took, after the rest', () => {
  const ctx = { ...context('cleanup-lock', 'npm'), run: '11', attempt: '1' };
  const lockDeps = { ...fakeDeps([]), hashiraGh: () => { throw new Error('404'); } };
  integrate.lockTake(ctx, lockDeps);
  const deps = fakeDeps([[/pulls\?head=/, []], [/actions\/runs\?/, { workflow_runs: [] }], [/-X DELETE/, '']]);
  integrate.cleanup(ctx, deps);
  assert.equal(git(tmp, ['--git-dir', ctx.remote, 'for-each-ref', 'refs/heads/integration-lock']), '');
  assert.match(summaryOf(ctx), /integration lock in \S+: taken\n[\s\S]*integration lock in \S+: released\n- cleanup:/);
});

test('cleanup of a run that never took the lock leaves another run\'s lock alone', () => {
  const holder = { ...context('cleanup-other', 'npm'), run: '12', attempt: '1' };
  integrate.lockTake(holder, { ...fakeDeps([]), hashiraGh: () => { throw new Error('404'); } });
  const ctx = { ...holder, run: '13', stateFile: path.join(holder.workdir, 'other-state.json') };
  integrate.cleanup(ctx, fakeDeps([[/pulls\?head=/, []], [/actions\/runs\?/, { workflow_runs: [] }], [/-X DELETE/, '']]));
  assert.notEqual(git(tmp, ['--git-dir', ctx.remote, 'for-each-ref', 'refs/heads/integration-lock']), '');
});
