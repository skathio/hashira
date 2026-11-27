// The user's rules for the reusable Pages workflow, .github/workflows/pages-site.yml (brief
// requirements 18-21, the Boundaries lines for shell and deploy, and the catalog line of 24),
// plus the project conventions it must keep. Each test reads the workflow itself: its shape
// through PyYAML (the shape lints' own parser), and its behaviour by running its jobs the way a
// runner would. Run steps go to bash with their ${{ }} expressions evaluated; uses steps are
// recorded, and hashira's own actions stand in as follows: site-kit runs its real action.yml
// step, docs-build creates its output_dir and refuses one that exists (requirement 12),
// pages-upload and pages-deploy only record what they were given. The latest-release check
// reads tags from a local git repo standing in for github.com. check's released-approval step
// fetches hashira from a local bare repo standing in for github.com/skathio/hashira, and its
// node helper reads this run's approvals through a fetch stub preloaded with NODE_OPTIONS.
//
// Run with:
//   node --test tests/pages-site/pages-site-rules.test.js
//
// Left to the builder, so not tested here: how gate refuses a ref "before the approval" (the
// request leaves it open), any job besides gate, build and deploy, the error text of the ref
// check beyond its annotation and the workflow's name, how site_output falls back to site_dir,
// and how pages-deploy is referenced. A live run, the production approval and the real Pages
// deploy need GitHub and the maintainer, so they are not tested here either.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'pages-site.yml');
const SITE_KIT = path.join(REPO, '.github', 'actions', 'site-kit');
const KIT_FILES = ['tokens.css', 'theme.js', 'site-nav.js'];
const MAIN = 'refs/heads/main';
const OTHER_REF = 'refs/heads/feature';

const temps = [];
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

// ---------- reading YAML ----------

function loadYaml(file) {
  const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))';
  const run = spawnSync('python3', ['-c', py, file], { encoding: 'utf8' });
  assert.equal(run.status, 0, `could not read ${file}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

let cachedSpec;
const spec = () => (cachedSpec ??= loadYaml(WORKFLOW));
const triggers = () => spec().on ?? spec().true ?? {};
const callInputs = () => triggers().workflow_call?.inputs ?? {};
const jobs = () => spec().jobs ?? {};
const job = (name) => jobs()[name];
const needsOf = (j) => [].concat(j?.needs ?? []);
const rawWorkflow = () => fs.readFileSync(WORKFLOW, 'utf8');

// ---------- GitHub Actions expressions, read as JavaScript ----------
//
// An expression becomes a JavaScript one: 'quoted' strings become JSON strings, each context
// path (inputs.docs, steps.self.outputs.sha) becomes a lookup that gives undefined for a
// missing step or job instead of throwing, and the functions below stand in for GitHub's.

const toText = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const lower = (v) => toText(v).toLowerCase();

function functions(ctx) {
  return {
    success: () => ctx.status.success,
    failure: () => ctx.status.failure,
    always: () => true,
    cancelled: () => false,
    startsWith: (a, b) => lower(a).startsWith(lower(b)),
    endsWith: (a, b) => lower(a).endsWith(lower(b)),
    contains: (a, b) => lower(a).includes(lower(b)),
    format: (f, ...args) => toText(f).replace(/\{(\d+)\}/g, (_, i) => toText(args[Number(i)])),
    join: (a, sep = ',') => [].concat(a).map(toText).join(sep),
    toJSON: (v) => JSON.stringify(v),
    fromJSON: (v) => JSON.parse(v),
    hashFiles: () => '',
  };
}

function toJavaScript(source) {
  const strings = [];
  const held = source.replace(/'((?:[^']|'')*)'/g, (_, s) => `\u0000${strings.push(s.replace(/''/g, "'")) - 1}\u0000`);
  const looked = held.replace(/(?<![\w.$])([A-Za-z_]\w*(?:\.[\w-]+)+)/g, (_, chain) => `$get(${JSON.stringify(chain)})`);
  return looked.replace(/\u0000(\d+)\u0000/g, (_, i) => JSON.stringify(strings[Number(i)]));
}

function evaluate(source, ctx) {
  const $get = (chain) => chain.split('.').reduce((v, key) => v?.[key], ctx.data);
  return vm.runInNewContext(toJavaScript(source), { $get, ...functions(ctx) });
}

const interpolate = (text, ctx) => toText(text).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => toText(evaluate(e, ctx)));

// An `if:` with no status function is read as `success() && (...)`, as GitHub does.
function condition(cond, ctx) {
  if (cond === undefined || cond === null) return ctx.status.success;
  if (typeof cond !== 'string') return Boolean(cond);
  const source = cond.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const hasStatus = /\b(success|failure|always|cancelled)\s*\(/.test(source);
  return Boolean(hasStatus ? evaluate(source, ctx) : ctx.status.success && evaluate(source, ctx));
}

// ---------- job graph ----------

function jobOrder() {
  const order = [];
  const pending = Object.keys(jobs());
  while (pending.length) {
    const next = pending.findIndex((name) => needsOf(job(name)).every((n) => order.includes(n)));
    assert.ok(next >= 0, 'the jobs\' needs form a cycle');
    order.push(...pending.splice(next, 1));
  }
  return order;
}

function dependsOn(name, target) {
  const direct = needsOf(job(name));
  return direct.includes(target) || direct.some((n) => dependsOn(n, target));
}

function inputsWithDefaults(given) {
  const defaults = Object.entries(callInputs()).map(([name, def]) => [name, def.default ?? (def.type === 'boolean' ? false : '')]);
  return { ...Object.fromEntries(defaults), ...given };
}

function needsContext(name, results) {
  const list = needsOf(job(name));
  const needs = Object.fromEntries(list.map((n) => [n, { result: results[n].result, outputs: results[n].outputs }]));
  const status = {
    success: list.every((n) => results[n].result === 'success'),
    failure: list.some((n) => results[n].result === 'failure'),
  };
  return { needs, status };
}

// Which jobs run for these inputs, when the jobs named in `failing` fail (a rejected approval).
function jobResults(given, failing = []) {
  const inputs = inputsWithDefaults(given);
  const results = {};
  for (const name of jobOrder()) {
    const { needs, status } = needsContext(name, results);
    const ctx = { data: { inputs, needs, github: { ref: MAIN, event_name: 'workflow_dispatch' } }, status };
    const result = !condition(job(name).if, ctx) ? 'skipped' : failing.includes(name) ? 'failure' : 'success';
    results[name] = { result, outputs: {} };
  }
  return Object.fromEntries(Object.entries(results).map(([n, r]) => [n, r.result]));
}

// ---------- git fixtures ----------

function git(cwd, ...args) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const run = spawnSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

function commit(dir, message) {
  fs.writeFileSync(path.join(dir, 'f.txt'), message);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

// hashira's own tree, as a checkout into .hashira/ would leave it.
let libraryTemplate;
function library() {
  if (!libraryTemplate) {
    const dir = path.join(tempDir('pages-site-lib-'), '.hashira');
    fs.cpSync(path.join(REPO, '.github'), path.join(dir, '.github'), { recursive: true, filter: (src) => !src.includes('node_modules') });
    git(REPO, 'init', '-q', dir);
    const sha = commit(dir, 'library');
    libraryTemplate = { dir, sha };
  }
  return libraryTemplate;
}

// The caller's repo on "github.com": `head` is the commit the run is on, `other` another one.
// Each tag is [name, 'head' | 'other', annotated].
function remoteRepo(base, tags) {
  const dir = path.join(base, 'octo', 'site.git');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  const other = commit(dir, 'other');
  const head = commit(dir, 'head');
  for (const [name, where, annotated] of tags) {
    const target = where === 'head' ? head : other;
    git(dir, 'tag', ...(annotated ? ['-a', '-m', name] : []), name, target);
  }
  return { head, other };
}

// The approvals a run's released check reads: one approved `production` review by default.
const APPROVED = [{ state: 'approved', environments: [{ name: 'production' }], user: { login: 'owner' } }];

// Preloaded into each node step, so the approval helper's GET of the run's approvals answers
// with the world's approvals instead of reaching api.github.com.
let fetchStub;
function approvalsStub() {
  if (!fetchStub) {
    fetchStub = path.join(tempDir('pages-site-fetch-'), 'fetch-stub.cjs');
    fs.writeFileSync(fetchStub, [
      "'use strict';",
      'globalThis.fetch = async (url) => {',
      '  const ok = /\\/repos\\/octo\\/site\\/actions\\/runs\\/4242\\/approvals$/.test(String(url));',
      '  return { ok, status: ok ? 200 : 404, json: async () => JSON.parse(process.env.TEST_APPROVALS) };',
      '};',
      '',
    ].join('\n'));
  }
  return fetchStub;
}

// ---------- running a job's steps ----------

const LOCAL_ACTION = /\.github\/actions\/(site-kit|docs-build|pages-upload|pages-deploy)(?:@|$)/;

const usedAction = (uses) => uses.match(LOCAL_ACTION)?.[1] ?? uses.replace(/@.*$/, '');

// key=value lines of a GITHUB_OUTPUT or GITHUB_ENV file.
function parseOutputFile(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return Object.fromEntries([...text.matchAll(/^([^=\n<]+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
}

const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GITHUB_|RUNNER_|NODE_TEST)/.test(k)));

function stepEnv(step, run, files) {
  const ctx = run.ctx;
  const own = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, interpolate(v, ctx)]));
  return {
    ...BASE_ENV, ...run.env, ...own, ...files, CI: 'true',
    GITHUB_WORKSPACE: run.ws, GITHUB_REF: ctx.data.github.ref, GITHUB_SHA: ctx.data.github.sha,
    GITHUB_REPOSITORY: ctx.data.github.repository, GITHUB_SERVER_URL: ctx.data.github.server_url,
    RUNNER_TEMP: run.temp,
  };
}

// A run step's shell, as GitHub starts it: `shell: bash` adds pipefail, no shell is `bash -e`.
const SHELLS = {
  bash: (script) => ['bash', ['--noprofile', '--norc', '-eo', 'pipefail', script]],
  sh: (script) => ['sh', ['-e', script]],
};

function shellCommand(step, run, script) {
  const shell = SHELLS[step.shell ?? run.defaults.shell];
  return shell ? shell(script) : ['bash', ['-e', script]];
}

function runShell(step, run) {
  const dir = fs.mkdtempSync(path.join(run.temp, 'step-'));
  const files = { GITHUB_OUTPUT: path.join(dir, 'out'), GITHUB_ENV: path.join(dir, 'env'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), GITHUB_PATH: path.join(dir, 'path') };
  const script = path.join(dir, 'script.sh');
  fs.writeFileSync(script, interpolate(step.run, run.ctx));
  const [cmd, args] = shellCommand(step, run, script);
  const cwd = path.join(run.ws, step['working-directory'] ?? run.defaults.workdir ?? '.');
  const res = spawnSync(cmd, args, { cwd, env: stepEnv(step, run, files), encoding: 'utf8' });
  Object.assign(run.env, parseOutputFile(files.GITHUB_ENV));
  return { ok: res.status === 0, log: `${res.stdout}${res.stderr}`, outputs: parseOutputFile(files.GITHUB_OUTPUT) };
}

// site-kit: its real composite step, run against the workspace.
function siteKit(withs, run) {
  const action = loadYaml(path.join(SITE_KIT, 'action.yml'));
  const github = { ...run.ctx.data.github, action_path: SITE_KIT };
  const inner = { ...run, ctx: { data: { ...run.ctx.data, inputs: withs, github }, status: { success: true, failure: false } } };
  const results = action.runs.steps.map((s) => runShell(s, inner));
  return { ok: results.every((r) => r.ok), log: results.map((r) => r.log).join(''), outputs: {} };
}

// docs-build: requirement 12's refusal of an existing output_dir, then a built site.
function docsBuild(withs, run) {
  const out = withs.output_dir || 'artifacts/pages/docs';
  const full = path.join(run.ws, out);
  if (fs.existsSync(full)) {
    return { ok: false, log: `::error::docs-build: output_dir '${out}' already exists; docs-build never writes over it.\n`, outputs: {} };
  }
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, 'index.html'), '<h1>docs</h1>');
  return { ok: true, log: '', outputs: { output_dir: out } };
}

function pagesUpload(withs, run) {
  const full = path.join(run.ws, withs.path ?? '');
  const ok = Boolean(withs.path) && fs.existsSync(full) && fs.statSync(full).isDirectory();
  return { ok, log: ok ? '' : `::error::pages-upload: '${withs.path}' is not a directory\n`, outputs: {} };
}

const EMULATED = {
  'site-kit': siteKit,
  'docs-build': docsBuild,
  'pages-upload': pagesUpload,
  'pages-deploy': () => ({ ok: true, log: '', outputs: { page_url: 'https://octo.github.io/site/' } }),
};

function runUses(step, run) {
  const withs = Object.fromEntries(Object.entries(step.with ?? {}).map(([k, v]) => [k, interpolate(v, run.ctx)]));
  const name = usedAction(step.uses);
  const result = (EMULATED[name] ?? (() => ({ ok: true, log: '', outputs: {} })))(withs, run);
  return { ...result, record: { kind: 'uses', action: name, uses: step.uses, with: withs } };
}

function runStep(step, run) {
  if (step.uses) return runUses(step, run);
  const result = runShell(step, run);
  return { ...result, record: { kind: 'run', script: step.run, env: step.env ?? {} } };
}

function newRun(name, world, results) {
  const j = job(name);
  const data = {
    ...world.data, needs: needsContext(name, results).needs, steps: {}, env: {},
    job: { workflow_sha: world.librarySha }, runner: { temp: world.temp, os: 'Linux' },
  };
  const defaults = { ...(spec().defaults?.run ?? {}), ...(j.defaults?.run ?? {}) };
  const run = {
    ws: world.ws, temp: world.temp, env: {}, steps: [], log: '',
    defaults: { shell: defaults.shell, workdir: defaults['working-directory'] },
    ctx: { data, status: { success: true, failure: false } },
  };
  const env = Object.entries({ ...(spec().env ?? {}), ...(j.env ?? {}) });
  run.env = { ...world.env, ...Object.fromEntries(env.map(([k, v]) => [k, interpolate(v, run.ctx)])) };
  return run;
}

function record(step, result, run) {
  const outcome = result.ok ? 'success' : 'failure';
  run.steps.push({ ...result.record, ok: result.ok });
  run.log += result.log;
  if (step.id) run.ctx.data.steps[step.id] = { outputs: result.outputs, outcome, conclusion: outcome };
  if (!result.ok) run.ctx.status = { success: false, failure: true };
}

function runJob(name, world, results) {
  const run = newRun(name, world, results);
  const steps = (job(name).steps ?? []).filter(Boolean);
  steps.forEach((step) => condition(step.if, run.ctx) && record(step, runStep(step, run), run));
  const outputs = Object.fromEntries(Object.entries(job(name).outputs ?? {}).map(([k, v]) => [k, interpolate(v, run.ctx)]));
  return { result: run.ctx.status.success ? 'success' : 'failure', outputs, steps: run.steps, log: run.log };
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

const DEFAULT_FILES = { 'site/index.html': '<h1>site</h1>', 'site/css/site.css': 'body{}' };

function makeWorld({ ref, files, tags, approvals }) {
  const base = tempDir('pages-site-run-');
  const ws = path.join(base, 'ws');
  const temp = path.join(base, 'tmp');
  fs.mkdirSync(temp, { recursive: true });
  writeFiles(ws, files);
  fs.cpSync(library().dir, path.join(ws, '.hashira'), { recursive: true });
  const remote = remoteRepo(path.join(base, 'remote'), tags);
  git(base, 'clone', '-q', '--bare', library().dir, path.join(base, 'remote', 'skathio', 'hashira.git'));
  const env = { NODE_OPTIONS: `--require ${approvalsStub()}`, TEST_APPROVALS: JSON.stringify(approvals) };
  const github = {
    run_id: '4242', token: 'job-token',
    ref, sha: remote.head, workspace: ws, repository: 'octo/site', repository_owner: 'octo',
    server_url: path.join(base, 'remote'), event_name: 'workflow_dispatch', workflow_sha: remote.head, ref_name: ref.replace(/^refs\/heads\//, ''),
  };
  return { ws, temp, remote, env, librarySha: library().sha, data: { github } };
}

// Runs the whole workflow, every job as if approved, in the needs order.
function runWorkflow({ inputs = {}, ref = MAIN, files = DEFAULT_FILES, tags = [], approvals = APPROVED } = {}) {
  const world = makeWorld({ ref, files, tags, approvals });
  world.data.inputs = inputsWithDefaults(inputs);
  const results = {};
  for (const name of jobOrder()) {
    const { status } = needsContext(name, results);
    const ctx = { data: { ...world.data, needs: needsContext(name, results).needs }, status };
    results[name] = condition(job(name).if, ctx) ? runJob(name, world, results) : { result: 'skipped', outputs: {}, steps: [], log: '' };
  }
  return { results, world };
}

const usesOf = (jobRun, action) => jobRun.steps.filter((s) => s.kind === 'uses' && s.action === action);
const indexOf = (jobRun, action) => jobRun.steps.findIndex((s) => s.kind === 'uses' && s.action === action);
const norm = (p) => path.posix.normalize(String(p)).replace(/\/$/, '');
const uploadedPath = (jobRun) => norm(usesOf(jobRun, 'pages-upload')[0]?.with.path);

// ==================== the workflow's shape ====================

test('pages-site.yml exists and is a reusable workflow (workflow_call)', () => {
  assert.ok(fs.existsSync(WORKFLOW), '.github/workflows/pages-site.yml is missing');
  assert.ok('workflow_call' in triggers(), 'pages-site.yml has no workflow_call trigger');
});

test('pages-site.yml never uses pull_request_target', () => {
  assert.ok(!('pull_request_target' in triggers()));
});

const INPUTS = [
  ['released', 'boolean', false],
  ['site_dir', 'string', 'site'],
  ['site_build_command', 'string', ''],
  ['docs', 'boolean', true],
  ['docs_pre_build_command', 'string', ''],
  ['node_version', 'string', '24'],
  ['dotnet_version', 'string', ''],
];

for (const [name, type, def] of INPUTS) {
  test(`input ${name} is an optional ${type} with default ${JSON.stringify(def)}`, () => {
    const input = callInputs()[name];
    assert.ok(input, `input ${name} is missing`);
    assert.equal(input.type, type);
    assert.notEqual(input.required, true);
    assert.deepEqual(input.default ?? (type === 'string' ? '' : undefined), def);
  });
}

test('input site_output is an optional string', () => {
  const input = callInputs().site_output;
  assert.ok(input, 'input site_output is missing');
  assert.equal(input.type, 'string');
  assert.notEqual(input.required, true);
});

for (const name of ['site_build_command', 'docs_pre_build_command']) {
  test(`${name} is documented as trusted input`, () => {
    assert.match(callInputs()[name]?.description ?? '', /trusted input/i);
  });
}

test('the jobs gate, build and deploy run in that order', () => {
  for (const name of ['gate', 'build', 'deploy']) assert.ok(job(name), `job ${name} is missing`);
  assert.ok(dependsOn('build', 'gate'), 'build does not need gate');
  assert.ok(dependsOn('deploy', 'build'), 'deploy does not need build');
});

const envName = (j) => (typeof j?.environment === 'string' ? j.environment : j?.environment?.name);

test('gate waits for the production environment', () => {
  assert.equal(envName(job('gate')), 'production');
});

test('gate runs only when released is false', () => {
  assert.equal(jobResults({ released: false }).gate, 'success');
  assert.equal(jobResults({ released: true }).gate, 'skipped');
});

test('build and deploy run after an approved gate, and after a skipped gate when released', () => {
  const approved = jobResults({ released: false });
  assert.equal(approved.build, 'success');
  assert.equal(approved.deploy, 'success');
  const released = jobResults({ released: true });
  assert.equal(released.build, 'success');
  assert.equal(released.deploy, 'success');
});

test('nothing builds or deploys when gate fails (approval rejected or a wrong ref)', () => {
  const rejected = jobResults({ released: false }, ['gate']);
  assert.notEqual(rejected.build, 'success');
  assert.notEqual(rejected.deploy, 'success');
});

test('deploy does not run when build fails', () => {
  for (const released of [false, true]) {
    assert.notEqual(jobResults({ released }, ['build']).deploy, 'success');
  }
});

// ==================== permissions ====================

test('permissions are deny-all at the top', () => {
  assert.deepEqual(spec().permissions, {});
});

test('build holds only contents: read', () => {
  assert.deepEqual(job('build').permissions, { contents: 'read' });
});

test('deploy holds only pages: write and id-token: write', () => {
  assert.deepEqual(job('deploy').permissions, { pages: 'write', 'id-token': 'write' });
});

test('no job but deploy holds pages or id-token', () => {
  for (const [name, j] of Object.entries(jobs())) {
    if (name === 'deploy') continue;
    const grants = j.permissions ?? {};
    assert.ok(typeof grants !== 'string', `${name} has blanket permissions '${grants}'`);
    assert.equal(grants.pages, undefined, `${name} holds pages`);
    assert.equal(grants['id-token'], undefined, `${name} holds id-token`);
  }
});

const GRANT = /^\s+(?:actions|attestations|checks|contents|deployments|id-token|issues|packages|pages|pull-requests|statuses|security-events):\s*(?:read|write)\b/;

// A grant has its reason on its own line or in the comments just above its permissions block.
function grantExplained(lines, i) {
  if (lines[i].includes('#')) return true;
  for (let k = i - 1; k >= 0; k -= 1) {
    const line = lines[k].trim();
    if (line.startsWith('#')) return true;
    if (!(GRANT.test(lines[k]) || line === 'permissions:')) return false;
  }
  return false;
}

test('every permission grant says in a comment why it is needed', () => {
  const lines = rawWorkflow().split('\n');
  const unexplained = lines.map((l, i) => [l, i]).filter(([l, i]) => GRANT.test(l) && !grantExplained(lines, i));
  assert.deepEqual(unexplained.map(([l]) => l.trim()), []);
});

// ==================== deploy ====================

test('deploy runs in the github-pages environment', () => {
  assert.equal(envName(job('deploy')), 'github-pages');
});

test('deploy uses concurrency group pages with no cancelling', () => {
  const c = job('deploy').concurrency;
  assert.equal(typeof c === 'string' ? c : c?.group, 'pages');
  assert.notEqual(c?.['cancel-in-progress'], true);
});

// ==================== conventions ====================

test('every action outside this repo is pinned to a 40-character SHA with a version comment', () => {
  const lines = rawWorkflow().split('\n');
  const bad = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/);
    if (!m || m[1].startsWith('./')) return;
    const pinned = /@[0-9a-f]{40}$/.test(m[1]);
    const commented = /#\s*\S*\s*v\d+\.\d+\.\d+/.test(line) || /^\s*#.*\bv\d+\.\d+\.\d+/.test(lines[i - 1] ?? '');
    if (!pinned || !commented) bad.push(line.trim());
  });
  assert.deepEqual(bad, []);
});

test('no run: step interpolates an input with ${{ }}; inputs reach the shell through env', () => {
  const offenders = [];
  for (const [name, j] of Object.entries(jobs())) {
    for (const step of j.steps ?? []) {
      if (/\$\{\{[^}]*\binputs\./.test(step.run ?? '')) offenders.push(`${name}: ${step.name ?? step.run}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('site_build_command and docs_pre_build_command are used only in build, never in deploy', () => {
  for (const [name, j] of Object.entries(jobs())) {
    if (name === 'build') continue;
    const text = JSON.stringify(j);
    assert.ok(!/inputs\.(site_build_command|docs_pre_build_command)\b/.test(text), `${name} uses a shell input`);
  }
  assert.match(JSON.stringify(job('build')), /inputs\.site_build_command\b/);
  assert.match(JSON.stringify(job('build')), /inputs\.docs_pre_build_command\b/);
});

test('build uses hashira\'s actions from a checkout at the commit pages-site.yml was called at', () => {
  const steps = job('build').steps ?? [];
  for (const action of ['site-kit', 'docs-build', 'pages-upload']) {
    const uses = steps.filter((s) => s.uses && usedAction(s.uses) === action).map((s) => s.uses);
    assert.equal(uses.length, 1, `build has no single ${action} step`);
    assert.match(uses[0], /^\.\//, `${action} is not used from the local checkout`);
  }
  const library = steps.filter((s) => /^actions\/checkout@/.test(s.uses ?? '') && s.with?.repository === 'skathio/hashira');
  assert.equal(library.length, 1, 'build does not check skathio/hashira out');
  assert.doesNotMatch(String(library[0].with.ref), /github\.(sha|workflow_sha|ref)\b/);
  assert.match(rawWorkflow(), /job\.workflow_sha/);
});

function runLint(script, ...args) {
  const run = spawnSync('python3', [script, ...args], { cwd: REPO, encoding: 'utf8' });
  return { ok: run.status === 0, log: `${run.stdout}${run.stderr}` };
}

for (const [script, args] of [
  ['tests/shape-lints/gate-lints.py', []],
  ['tests/shape-lints/gate-lints.py', ['--self-test']],
  ['tests/shape-lints/no-nested-reusable-workflow.py', []],
  ['tests/shape-lints/no-nested-reusable-workflow.py', ['--self-test']],
  ['tests/catalog/shape-validate.py', []],
  ['tests/catalog/shape-validate.py', ['--self-test']],
]) {
  test(`${[script, ...args].join(' ')} passes`, () => {
    const { ok, log } = runLint(script, ...args);
    assert.ok(ok, log);
  });
}

test('docs/catalog.md has a section for pages-site.yml', () => {
  const catalog = fs.readFileSync(path.join(REPO, 'docs', 'catalog.md'), 'utf8');
  assert.match(catalog, /^### pages-site\.yml\s*$/m);
});

// ==================== gate's ref check ====================

const installStep = (s) => (s.kind === 'uses' && /setup-node|setup-dotnet|docs-build/.test(s.action)) || (s.kind === 'run' && /\bnpm\b/.test(s.script));

test('on a ref other than main, the gate path fails with a pages-site annotation before any install', () => {
  const { results } = runWorkflow({ ref: OTHER_REF });
  const chain = jobOrder().filter((n) => n === 'gate' || dependsOn('gate', n));
  const failed = chain.find((n) => results[n].result === 'failure');
  assert.ok(failed, 'no job up to gate refused refs/heads/feature');
  const run = results[failed];
  const at = run.steps.findIndex((s) => !s.ok);
  assert.deepEqual(run.steps.slice(0, at).filter(installStep), []);
  assert.match(run.log, /::error::.*pages-site/);
  assert.notEqual(results.build.result, 'success');
  assert.notEqual(results.deploy.result, 'success');
});

test('on main, the gate path passes', () => {
  const { results } = runWorkflow({ ref: MAIN });
  assert.equal(results.gate.result, 'success', results.gate.log);
});

// ==================== build ====================

for (const released of [false, true]) {
  test(`build refuses a ref other than main before the site build (released: ${released})`, () => {
    const { results, world } = runWorkflow({ ref: OTHER_REF, inputs: { released, site_build_command: 'touch built-marker && mkdir -p site' } });
    // check refuses first, so build is skipped; run it anyway to see its own ref check refuse.
    assert.notEqual(results.build.result, 'success');
    const build = runJob('build', world, results);
    assert.equal(build.result, 'failure');
    assert.ok(!fs.existsSync(path.join(world.ws, 'built-marker')), 'site_build_command ran on a non-main ref');
    for (const action of ['site-kit', 'docs-build', 'pages-upload']) assert.deepEqual(usesOf(build, action), []);
    assert.notEqual(results.deploy.result, 'success');
  });
}

test('defaults: site/ is uploaded as-is with the kit in site/_kit and the docs in site/docs', () => {
  const { results, world } = runWorkflow();
  const build = results.build;
  assert.equal(build.result, 'success', build.log);
  assert.equal(uploadedPath(build), 'site');
  for (const file of KIT_FILES) assert.ok(fs.existsSync(path.join(world.ws, 'site', '_kit', file)), `site/_kit/${file} is missing`);
  assert.equal(norm(usesOf(build, 'docs-build')[0].with.output_dir), 'site/docs');
  assert.equal(fs.readFileSync(path.join(world.ws, 'site', 'index.html'), 'utf8'), DEFAULT_FILES['site/index.html']);
  assert.equal(fs.readFileSync(path.join(world.ws, 'site', 'css', 'site.css'), 'utf8'), DEFAULT_FILES['site/css/site.css']);
});

test('build runs site-kit, then docs-build, then pages-upload', () => {
  const build = runWorkflow().results.build;
  const kit = indexOf(build, 'site-kit');
  const docs = indexOf(build, 'docs-build');
  const upload = indexOf(build, 'pages-upload');
  assert.ok(kit >= 0 && kit < docs && docs < upload, JSON.stringify(build.steps.map((s) => s.action ?? 'run')));
});

test('site_build_command runs before site-kit, and site_output is what gets the kit, the docs and the upload', () => {
  const command = 'mkdir -p out && cp site/index.html out/ && echo built > out/built.txt';
  const { results, world } = runWorkflow({ inputs: { site_build_command: command, site_output: 'out' } });
  const build = results.build;
  assert.equal(build.result, 'success', build.log);
  assert.equal(uploadedPath(build), 'out');
  assert.equal(norm(usesOf(build, 'docs-build')[0].with.output_dir), 'out/docs');
  assert.ok(fs.existsSync(path.join(world.ws, 'out', 'built.txt')));
  for (const file of KIT_FILES) assert.ok(fs.existsSync(path.join(world.ws, 'out', '_kit', file)));
});

test('site_build_command gets a non-zero exit as a failed build, with no upload', () => {
  const build = runWorkflow({ inputs: { site_build_command: 'exit 3' } }).results.build;
  assert.equal(build.result, 'failure');
  assert.deepEqual(usesOf(build, 'pages-upload'), []);
});

test('site_output defaults to site_dir', () => {
  const files = { 'web/index.html': '<h1>web</h1>' };
  const { results, world } = runWorkflow({ inputs: { site_dir: 'web' }, files });
  assert.equal(results.build.result, 'success', results.build.log);
  assert.equal(uploadedPath(results.build), 'web');
  assert.ok(fs.existsSync(path.join(world.ws, 'web', '_kit', 'theme.js')));
});

test('with no site_build_command, site_dir is copied as-is to site_output', () => {
  const files = { 'web/index.html': '<h1>web</h1>', 'web/a/b.txt': 'deep' };
  const { results, world } = runWorkflow({ inputs: { site_dir: 'web', site_output: 'public' }, files });
  assert.equal(results.build.result, 'success', results.build.log);
  assert.equal(uploadedPath(results.build), 'public');
  assert.equal(fs.readFileSync(path.join(world.ws, 'public', 'index.html'), 'utf8'), '<h1>web</h1>');
  assert.equal(fs.readFileSync(path.join(world.ws, 'public', 'a', 'b.txt'), 'utf8'), 'deep');
  assert.ok(fs.existsSync(path.join(world.ws, 'public', '_kit', 'site-nav.js')));
});

test('docs: false skips docs-build and leaves no <site_output>/docs', () => {
  const { results, world } = runWorkflow({ inputs: { docs: false } });
  assert.equal(results.build.result, 'success', results.build.log);
  assert.deepEqual(usesOf(results.build, 'docs-build'), []);
  assert.ok(!fs.existsSync(path.join(world.ws, 'site', 'docs')));
  assert.ok(fs.existsSync(path.join(world.ws, 'site', '_kit', 'tokens.css')));
});

test('docs_pre_build_command is passed to docs-build as its pre_build_command', () => {
  const command = 'echo "# API" > "$DOCS_STAGE/api.md"';
  const build = runWorkflow({ inputs: { docs_pre_build_command: command } }).results.build;
  assert.equal(usesOf(build, 'docs-build')[0]?.with.pre_build_command, command);
});

for (const [label, inputs, files, named] of [
  ['site_dir holds docs/', {}, { ...DEFAULT_FILES, 'site/docs/index.html': 'x' }, 'site/docs'],
  ['site_dir holds _kit/', {}, { ...DEFAULT_FILES, 'site/_kit/theme.js': 'x' }, 'site/_kit'],
  ['site_build_command writes docs/', { site_build_command: 'mkdir -p out/docs && touch out/index.html', site_output: 'out' }, DEFAULT_FILES, 'out/docs'],
  ['site_build_command writes _kit/', { site_build_command: 'mkdir -p out/_kit && touch out/index.html', site_output: 'out' }, DEFAULT_FILES, 'out/_kit'],
]) {
  test(`build fails naming ${named} when ${label}`, () => {
    const build = runWorkflow({ inputs, files }).results.build;
    assert.equal(build.result, 'failure');
    assert.ok(build.log.includes(named), build.log);
    assert.match(build.log, /::error::/);
    assert.deepEqual(usesOf(build, 'pages-upload'), []);
  });
}

test('node_version goes to setup-node, 24 by default', () => {
  for (const [given, want] of [[undefined, '24'], ['22', '22']]) {
    const build = runWorkflow({ inputs: given ? { node_version: given } : {} }).results.build;
    const setups = usesOf(build, 'actions/setup-node');
    assert.ok(setups.length >= 1, 'build does not set Node up');
    assert.ok(setups.every((s) => s.with['node-version'] === want), JSON.stringify(setups));
  }
});

test('dotnet_version empty means no .NET; set, it goes to setup-dotnet', () => {
  assert.deepEqual(usesOf(runWorkflow().results.build, 'actions/setup-dotnet'), []);
  const setups = usesOf(runWorkflow({ inputs: { dotnet_version: '10.0.x' } }).results.build, 'actions/setup-dotnet');
  assert.equal(setups.length, 1);
  assert.equal(setups[0].with['dotnet-version'], '10.0.x');
});

// ==================== deploy's latest-release check ====================

const STALE = (tag, on, sha) => `the latest release ${tag} is on ${on}, not ${sha}; this run is stale.`;
const NO_TAG = 'no vX.Y.Z release tag found; refusing to deploy a release site.';

function releasedDeploy(tags) {
  const { results, world } = runWorkflow({ inputs: { released: true }, tags });
  assert.equal(results.build.result, 'success', results.build.log);
  return { deploy: results.deploy, remote: world.remote };
}

test('a released run with no vX.Y.Z tag does not deploy, with site.yml\'s message', () => {
  const { deploy } = releasedDeploy([['v3', 'head', false], ['v2.0.0-rc.1', 'head', true]]);
  assert.equal(deploy.result, 'failure');
  assert.ok(deploy.log.includes(`::error::`) && deploy.log.includes(NO_TAG), deploy.log);
  assert.deepEqual(usesOf(deploy, 'pages-deploy'), []);
});

test('a released run whose commit is not the latest release does not deploy, with site.yml\'s message', () => {
  const { deploy, remote } = releasedDeploy([['v1.9.0', 'head', true], ['v1.10.0', 'other', true]]);
  assert.equal(deploy.result, 'failure');
  assert.ok(deploy.log.includes(STALE('v1.10.0', remote.other, remote.head)), deploy.log);
  assert.deepEqual(usesOf(deploy, 'pages-deploy'), []);
});

test('the stale check reads a lightweight tag on another commit too', () => {
  const { deploy, remote } = releasedDeploy([['v1.0.0', 'head', false], ['v1.0.1', 'other', false]]);
  assert.equal(deploy.result, 'failure');
  assert.ok(deploy.log.includes(STALE('v1.0.1', remote.other, remote.head)), deploy.log);
});

for (const [label, tags] of [
  ['an annotated tag', [['v1.0.0', 'other', true], ['v1.2.0', 'head', true]]],
  ['a lightweight tag', [['v1.0.0', 'other', false], ['v1.2.0', 'head', false]]],
  ['a tag that sorts by version, not as text', [['v1.9.0', 'other', true], ['v1.10.0', 'head', true]]],
  ['tags that are not vX.Y.Z on other commits', [['v2.0.0', 'head', true], ['v3', 'other', false], ['v9.0.0-rc.1', 'other', true], ['release-9', 'other', false]]],
]) {
  test(`a released run whose commit holds the latest release deploys (${label})`, () => {
    const { deploy } = releasedDeploy(tags);
    assert.equal(deploy.result, 'success', deploy.log);
    assert.equal(usesOf(deploy, 'pages-deploy').length, 1);
  });
}

test('a run that is not released deploys without the release check', () => {
  const { results } = runWorkflow({ inputs: { released: false }, tags: [['v9.9.9', 'other', true]] });
  assert.equal(results.deploy.result, 'success', results.deploy.log);
  assert.equal(usesOf(results.deploy, 'pages-deploy').length, 1);
});

// ==================== check's released approval ====================

const HEAD_TAG = [['v1.0.0', 'head', true]];
const approvalStep = (run) => run.steps.find((s) => s.kind === 'run' && /released-approval/.test(s.script));

for (const [label, approvals] of [
  ['no approval at all', []],
  ['only a rejected production review', [{ state: 'rejected', environments: [{ name: 'production' }] }]],
  ['an approval for another environment', [{ state: 'approved', environments: [{ name: 'staging' }] }]],
  ['an answer that is not a list', { message: 'Not Found' }],
]) {
  test(`released: true with ${label} fails at check, and nothing builds or deploys`, () => {
    const { results } = runWorkflow({ inputs: { released: true }, tags: HEAD_TAG, approvals });
    assert.equal(results.check.result, 'failure');
    assert.match(results.check.log, /::error::pages-site: released refused/);
    assert.equal(results.build.result, 'skipped');
    assert.equal(results.deploy.result, 'skipped');
  });
}

test('released: true with this run\'s production approval passes check and deploys', () => {
  const { results } = runWorkflow({ inputs: { released: true }, tags: HEAD_TAG });
  assert.equal(results.check.result, 'success', results.check.log);
  assert.ok(approvalStep(results.check), 'check did not run the approval helper');
  assert.equal(results.deploy.result, 'success', results.deploy.log);
});

test('released: false never reads the approvals, and waits at gate instead', () => {
  const { results } = runWorkflow({ inputs: { released: false }, approvals: [] });
  assert.equal(results.check.result, 'success', results.check.log);
  assert.equal(approvalStep(results.check), undefined);
  assert.equal(results.gate.result, 'success');
});

// ==================== review finding: a link into an unpublished folder ====================

const { rewriteLink } = require(path.join(REPO, '.github', 'actions', 'docs-build', 'lib', 'links.js'));
const GH = 'https://github.com/o/r';

for (const entry of ['internal', 'internal/']) {
  test(`a link into an unpublished folder '${entry}' opens the file on GitHub`, () => {
    const href = rewriteLink('a.md', 'internal/x.md#part', { repo: GH, unpublished: [entry] });
    assert.equal(href, `${GH}/blob/HEAD/docs/internal/x.md#part`);
  });
}

test('an unpublished folder entry does not cover a sibling whose name only starts the same', () => {
  assert.equal(rewriteLink('a.md', 'internalx/y.md', { repo: GH, unpublished: ['internal'] }), null);
});
