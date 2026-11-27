// The user's rules for pages-site.yml's new features in the Pages release: the read-only `scan`
// job before `gate`, build-only runs (`deploy: false`), `artifact_name` and the `prebuilt` mode,
// the build's check of the site's kit references, the npm cache for docs-build's lockfile,
// `install_command`, `test_command` and `coverage_path`, the opt-in build secret, `approval`,
// `source`, the "deploying <ref>@<sha>, N commits after <tag>" summary line, OSV over the
// VitePress lockfile in hashira's own CI and release check, docs-build's summary of the VitePress
// version and lockfile hash, and the template for the own-build pattern. Also the project
// conventions the new code keeps: every input in the YAML, pages.md and catalog.md; inputs reach a
// shell only through `env:`; SHA pins with version comments; a comment on each grant.
//
// The behaviour tests run the workflow the way a runner would: each job in its own empty
// workspace, in the needs order, `if:` conditions and `${{ }}` evaluated, run steps through bash.
// actions/checkout fetches from a local git repo standing in for github.com (the caller has
// releases v1.2.0 and v1.10.0, then a pre-release and a non-semver tag, then main's head two
// commits after v1.10.0); hashira's own composite actions run their real steps, except
// docs-build (writes a stub docs page), pages-upload (checks the folder and keeps its index.html),
// pages-deploy, coverage-report (recorded), scan-suite (reports findings when the world has
// some) and run-tests-js (runs its command). Every gate is treated as approved. Network fetches
// from a node step are refused.
//
// Run with:
//   node --test tests/pages-site/pages-site-features.test.js
//
// Left to the builder, so not tested here: the build secret's name and its env var name, the
// defaults of scan_disable, artifact_name and prebuilt, prebuilt's exact type, which jobs hold
// each new step, what coverage_path '' does, the `<ref>` spelling in the summary line, what an
// unknown event does under `approval: merge` beyond never deploying ungated, the template's file
// name, and the wording of errors and docs. A live run, the production approval and the real
// Pages deploy need GitHub and the maintainer.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const WORKFLOWS = path.join(REPO, '.github', 'workflows');
const LOCKFILE = path.join(REPO, '.github', 'actions', 'docs-build', 'vitepress', 'package-lock.json');
const THIS_FILE = 'tests/pages-site/pages-site-features.test.js';
const readRepo = (...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf8');

const scratch = [];
test.after(() => scratch.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const freshDir = (label) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `psf-${label}-`));
  scratch.push(d);
  return d;
};

// ==================== reading the YAML ====================

const yamlCache = new Map();
function yamlOf(file) {
  if (!yamlCache.has(file)) {
    const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))';
    const r = spawnSync('python3', ['-c', py, file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `PyYAML could not read ${file}: ${r.stderr}`);
    yamlCache.set(file, JSON.parse(r.stdout));
  }
  return yamlCache.get(file);
}

const flow = (name = 'pages-site.yml') => yamlOf(path.join(WORKFLOWS, name));
const callOf = (wf) => (wf.on ?? wf.true ?? {}).workflow_call ?? {};
const inputsDef = () => callOf(flow()).inputs ?? {};
const secretsDef = () => callOf(flow()).secrets ?? {};
const jobsOf = (wf = flow()) => wf.jobs ?? {};
const needList = (wf, name) => [].concat(jobsOf(wf)[name]?.needs ?? []);
const upstream = (wf, name) => needList(wf, name).flatMap((n) => [n, ...upstream(wf, n)]);
const stepsOf = (jobDef) => (jobDef.steps ?? []).filter(Boolean);
const allSteps = (wf) => Object.entries(jobsOf(wf)).flatMap(([job, def]) => stepsOf(def).map((step) => ({ job, step })));
const failInput = () => ['fail_on_findings', 'scan_fail_on_findings'].find((n) => n in inputsDef());
const prebuiltValue = () => (inputsDef().prebuilt?.type === 'boolean' ? true : 'true');

// ==================== GitHub expressions ====================
//
// Each piece of an expression maps to JavaScript: a quoted string to a JSON string, a function
// name to the stand-in below, a context path to a lookup that never throws, anything else
// (operators, parentheses, numbers) as it is. JavaScript's loose == matches GitHub's coercion
// closely enough for these conditions.

const asText = (v) => ([null, undefined].includes(v) ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const folded = (v) => asText(v).toLowerCase();
const PIECES = [
  [/^'((?:[^']|'')*)'/, (m) => JSON.stringify(m[1].replace(/''/g, "'"))],
  [/^(?:true|false|null)\b/, (m) => m[0]],
  [/^[A-Za-z_]\w*(?=\s*\()/, (m) => `fn.${m[0]}`],
  [/^[A-Za-z_][\w-]*(?:\.[\w*-]+)*/, (m) => `look(${JSON.stringify(m[0])})`],
  [/^[\s\S]/, (m) => m[0]],
];

function toScript(expr) {
  let rest = expr;
  let out = '';
  while (rest) {
    const [re, emit] = PIECES.find(([r]) => r.test(rest));
    const m = rest.match(re);
    out += emit(m);
    rest = rest.slice(m[0].length);
  }
  return out;
}

function standIns(status) {
  return {
    success: () => status.ok,
    failure: () => !status.ok,
    always: () => true,
    cancelled: () => false,
    contains: (a, b) => (Array.isArray(a) ? a.map(folded).includes(folded(b)) : folded(a).includes(folded(b))),
    startsWith: (a, b) => folded(a).startsWith(folded(b)),
    endsWith: (a, b) => folded(a).endsWith(folded(b)),
    format: (f, ...xs) => asText(f).replace(/\{(\d+)\}/g, (_, i) => asText(xs[i])),
    join: (a, s = ',') => [].concat(a).map(asText).join(s),
    toJSON: (v) => JSON.stringify(v),
    fromJSON: (v) => JSON.parse(v),
    hashFiles: () => '',
  };
}

function evaluate(expr, scope) {
  const look = (chain) => chain.split('.').reduce((v, k) => v?.[k], scope.data);
  return vm.runInNewContext(toScript(expr), { look, fn: standIns(scope.status) });
}

const fill = (text, scope) => asText(text).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => asText(evaluate(e, scope)));
const fillAll = (obj, scope) => Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [k, fill(v, scope)]));

// An `if:` with no status function holds only after success, as on GitHub.
function holds(cond, scope) {
  const src = asText(cond ?? 'success()').trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const guarded = /\b(?:success|failure|always|cancelled)\s*\(/.test(src) ? src : `success() && (${src})`;
  return Boolean(evaluate(guarded, scope));
}

// ==================== git fixtures ====================

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  return { ok: r.status === 0, out: r.stdout.trim(), log: r.stderr };
}
const mustGit = (cwd, ...args) => {
  const r = git(cwd, ...args);
  assert.ok(r.ok, `git ${args.join(' ')}: ${r.log}`);
  return r.out;
};

function writeTree(root, files) {
  Object.entries(files).forEach(([rel, body]) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  });
}

function snapshot(dir, files, message) {
  writeTree(dir, files);
  mustGit(dir, 'add', '-A');
  mustGit(dir, 'commit', '-q', '-m', message);
  return mustGit(dir, 'rev-parse', 'HEAD');
}

const KIT_LINKS = '<link rel="stylesheet" href="_kit/tokens.css"><script src="_kit/theme.js"></script><script type="module" src="_kit/site-nav.js"></script>';
const pageAt = (label) => ({ 'site/index.html': `<h1>tree ${label}</h1>${KIT_LINKS}` });
const HEAD_FILES = {
  ...pageAt('head'),
  'site/guide/index.html': '<h1>guide</h1><link rel="stylesheet" href="../_kit/tokens.css">',
};
const HISTORY = [['c1', ['v1.2.0']], ['c2', ['v1.10.0']], ['c3', ['v2.0.0-rc.1', 'v10']]];

// hashira at its current files, committed once: the `.hashira` checkout and the bare repo a
// `check` step may fetch from.
let libraryCache;
function library() {
  libraryCache ??= (() => {
    const root = freshDir('lib');
    const dir = path.join(root, 'tree');
    fs.cpSync(path.join(REPO, '.github'), path.join(dir, '.github'), { recursive: true, filter: (s) => !s.includes('node_modules') });
    mustGit(root, 'init', '-q', dir);
    const sha = snapshot(dir, {}, 'library');
    mustGit(root, 'clone', '-q', '--bare', dir, path.join(root, 'hashira.git'));
    return { dir, sha, bare: path.join(root, 'hashira.git') };
  })();
  return libraryCache;
}

// The caller's repo on "github.com", at <remotes>/octo/site.git.
function callerRepo(remotes, { headFiles, tags }) {
  const work = path.join(remotes, 'work');
  mustGit(remotes, 'init', '-q', work);
  const shas = {};
  for (const [label, names] of HISTORY) {
    shas[label] = snapshot(work, pageAt(label), label);
    names.filter(() => tags).forEach((n) => mustGit(work, 'tag', '-a', '-m', n, n));
  }
  shas.head = snapshot(work, headFiles, 'head');
  const bare = path.join(remotes, 'octo', 'site.git');
  mustGit(remotes, 'clone', '-q', '--bare', work, bare);
  mustGit(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  fs.mkdirSync(path.join(remotes, 'skathio'));
  fs.symlinkSync(library().bare, path.join(remotes, 'skathio', 'hashira.git'));
  return shas;
}

// Refuses every fetch() from a node step, so no test reaches the network.
let offlineStub;
function offline() {
  offlineStub ??= (() => {
    const file = path.join(freshDir('stub'), 'offline.cjs');
    fs.writeFileSync(file, "globalThis.fetch = async () => { throw new Error('network is off in this test'); };\n");
    return file;
  })();
  return offlineStub;
}

// ==================== running steps ====================

function readPairs(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = /^([^=\n<]+)<<(\S+)\n(?:([\s\S]*?)\n)?\2$|^([^=\n]+)=(.*)$/gm;
  return Object.fromEntries([...text.matchAll(re)].map((m) => [m[1] ?? m[4], m[3] ?? m[5] ?? '']));
}

function shellStep(step, ctx) {
  const dir = fs.mkdtempSync(path.join(ctx.job.temp, 'step-'));
  const files = Object.fromEntries(['OUTPUT', 'ENV', 'STEP_SUMMARY', 'PATH'].map((n) => [`GITHUB_${n}`, path.join(dir, n)]));
  const script = path.join(dir, 'step.sh');
  fs.writeFileSync(script, fill(step.run, ctx.scope));
  const flags = step.shell === 'bash' ? ['--noprofile', '--norc', '-eo', 'pipefail'] : ['-e'];
  const env = { ...ctx.job.env, ...ctx.env, ...fillAll(step.env, ctx.scope), ...files };
  const cwd = path.join(ctx.job.ws, fill(step['working-directory'] ?? '', ctx.scope));
  const r = spawnSync('bash', [...flags, script], { cwd, env, encoding: 'utf8' });
  Object.assign(ctx.job.env, readPairs(files.GITHUB_ENV));
  ctx.job.world.summary += fs.existsSync(files.GITHUB_STEP_SUMMARY) ? fs.readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8') : '';
  return { ok: r.status === 0, log: `${r.stdout}${r.stderr}`, outputs: readPairs(files.GITHUB_OUTPUT) };
}

function fetchInto(dest, withs, world) {
  const full = asText(withs['fetch-depth']) === '0';
  const depth = full ? ['--tags'] : ['--no-tags', '--depth', asText(withs['fetch-depth'] || '1')];
  const steps = [['init', '-q'], ['remote', 'add', 'origin', world.callerUrl], ['fetch', '-q', ...depth, 'origin', withs.ref || world.github.sha], ['checkout', '-q', 'FETCH_HEAD']];
  if (full) steps.splice(2, 0, ['fetch', '-q', '--tags', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
  const failed = steps.map((args) => git(dest, ...args)).find((r) => !r.ok);
  return failed ? { ok: false, log: failed.log, outputs: {} } : { ok: true, log: '', outputs: {}, head: mustGit(dest, 'rev-parse', 'HEAD') };
}

function checkoutAction(withs, ctx) {
  const dest = path.join(ctx.job.ws, withs.path || '');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (/^skathio\/hashira$/i.test(withs.repository ?? '')) {
    fs.symlinkSync(library().dir, dest);
    return { ok: true, log: '', outputs: {} };
  }
  fs.mkdirSync(dest, { recursive: true });
  return fetchInto(dest, withs, ctx.job.world);
}

function docsBuildAction(withs, ctx) {
  const out = path.join(ctx.job.ws, withs.output_dir || 'artifacts/pages/docs');
  const exists = fs.existsSync(out);
  writeTree(exists ? ctx.job.temp : out, { 'index.html': '<h1>docs</h1>' });
  return { ok: !exists, log: exists ? 'docs-build: output_dir exists\n' : '', outputs: { output_dir: withs.output_dir } };
}

function uploadAction(withs, ctx) {
  const index = path.join(ctx.job.ws, withs.path || '.', 'index.html');
  const ok = Boolean(withs.path) && fs.existsSync(index);
  return { ok, log: ok ? '' : `pages-upload: no site at '${withs.path}'\n`, outputs: {}, index: ok ? fs.readFileSync(index, 'utf8') : null };
}

function scanAction(withs, ctx) {
  const disabled = asText(withs.scan_disable).split(',').map((s) => s.trim());
  const found = ctx.job.world.findings && !disabled.includes('osv');
  const ok = !(found && withs.fail_on_findings === 'true');
  return { ok, log: found ? 'osv: findings\n' : '', outputs: { summary: found ? 'osv\tfail\t1 finding' : 'osv\tran\tnone' } };
}

function testsAction(withs, ctx) {
  const r = spawnSync('bash', ['-eo', 'pipefail', '-c', withs.command || 'npm test'], { cwd: ctx.job.ws, env: { ...ctx.job.env, ...ctx.env }, encoding: 'utf8' });
  return { ok: r.status === 0, log: `${r.stdout}${r.stderr}`, outputs: {} };
}

// One of hashira's composite actions, run step by step with its own inputs and steps context.
function compositeAction(withs, ctx, name) {
  const dir = path.join(REPO, '.github', 'actions', name);
  const action = yamlOf(path.join(dir, 'action.yml'));
  const defaults = Object.entries(action.inputs ?? {}).map(([k, d]) => [k, asText(d.default)]);
  const data = { ...ctx.scope.data, inputs: { ...Object.fromEntries(defaults), ...withs }, steps: {}, github: { ...ctx.scope.data.github, action_path: dir } };
  const inner = { ...ctx, env: { ...ctx.env, GITHUB_ACTION_PATH: dir }, scope: { data, status: { ok: true } } };
  const ok = runSteps(action.runs.steps, inner);
  const outputs = Object.fromEntries(Object.entries(action.outputs ?? {}).map(([k, o]) => [k, fill(o.value, inner.scope)]));
  return { ok, log: '', outputs };
}

const done = () => ({ ok: true, log: '', outputs: {} });
const ACTIONS = [
  [/^actions\/checkout@/, checkoutAction],
  [/\.github\/actions\/docs-build(?:@|$)/, docsBuildAction],
  [/\.github\/actions\/pages-upload(?:@|$)/, uploadAction],
  [/\.github\/actions\/scan-suite(?:@|$)/, scanAction],
  [/\.github\/actions\/run-tests-js(?:@|$)/, testsAction],
  [/\.github\/actions\/(?:pages-deploy|coverage-report)(?:@|$)/, done],
  [/^(?:\.\/\.hashira\/|skathio\/hashira\/)\.github\/actions\/[\w-]+(?:@|$)/, compositeAction],
  [/[\s\S]/, done],
];

function usesStep(step, ctx) {
  const withs = fillAll(step.with, ctx.scope);
  const name = step.uses.match(/actions\/([\w-]+)(?:@|$)/)?.[1] ?? step.uses;
  const result = ACTIONS.find(([re]) => re.test(step.uses))[1](withs, ctx, name);
  ctx.job.records.push({ action: name, with: withs, ok: result.ok, head: result.head, index: result.index });
  return result;
}

function runSteps(steps, ctx) {
  for (const step of (steps ?? []).filter((s) => holds(s.if, ctx.scope))) {
    const result = step.uses ? usesStep(step, ctx) : shellStep(step, ctx);
    ctx.job.world.log += result.log;
    const outcome = result.ok ? 'success' : 'failure';
    if (step.id) ctx.scope.data.steps[step.id] = { outputs: result.outputs, outcome, conclusion: outcome };
    ctx.scope.status.ok &&= result.ok || Boolean(step['continue-on-error']);
  }
  return ctx.scope.status.ok;
}

// ==================== running the workflow ====================

const ENV_BASE = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:GITHUB_|RUNNER_|NODE_TEST|NODE_OPTIONS$)/.test(k)));

function jobEnv(world, ws, temp) {
  const g = world.github;
  return {
    ...ENV_BASE, CI: 'true', NODE_OPTIONS: `--require ${offline()}`, RUNNER_TEMP: temp, GITHUB_WORKSPACE: ws,
    GITHUB_REF: g.ref, GITHUB_SHA: g.sha, GITHUB_EVENT_NAME: g.event_name, GITHUB_REPOSITORY: g.repository,
    GITHUB_SERVER_URL: g.server_url, GITHUB_RUN_ID: g.run_id, GITHUB_REF_NAME: g.ref_name,
  };
}

function runJob(name, world, needs) {
  const def = jobsOf()[name];
  const ws = path.join(fs.mkdtempSync(path.join(world.base, `${name}-`)), 'ws');
  const temp = path.join(path.dirname(ws), 'tmp');
  [ws, temp].forEach((d) => fs.mkdirSync(d));
  const data = { ...world.data, needs, steps: {}, github: { ...world.github, workspace: ws }, job: { workflow_sha: library().sha }, runner: { temp, os: 'Linux' } };
  const scope = { data, status: { ok: true } };
  const job = { ws, temp, world, records: [], env: jobEnv(world, ws, temp) };
  Object.assign(job.env, fillAll({ ...flow().env, ...def.env }, scope));
  const ok = runSteps(def.steps, { job, scope, env: {} });
  return { result: ok ? 'success' : 'failure', outputs: fillAll(def.outputs, scope), records: job.records };
}

function jobOrder() {
  const order = [];
  const left = Object.keys(jobsOf());
  while (left.length) {
    const i = left.findIndex((n) => needList(flow(), n).every((d) => order.includes(d)));
    assert.ok(i >= 0, 'the jobs\' needs form a cycle');
    order.push(...left.splice(i, 1));
  }
  return order;
}

function withDefaults(given) {
  const defaults = Object.entries(inputsDef()).map(([k, d]) => [k, d.default ?? (d.type === 'boolean' ? false : '')]);
  return { ...Object.fromEntries(defaults), ...given };
}

function makeWorld({ event, ref, headFiles, tags, findings, secrets }) {
  const base = freshDir('run');
  const remotes = path.join(base, 'remotes');
  fs.mkdirSync(remotes);
  const shas = callerRepo(remotes, { headFiles, tags });
  const github = {
    event_name: event, ref, ref_name: ref.replace(/^refs\/(?:heads|tags)\//, ''), sha: shas.head, repository: 'octo/site',
    repository_owner: 'octo', server_url: remotes, run_id: '4242', token: 'job-token', event: {}, workflow_sha: shas.head,
  };
  return { base, shas, github, findings, summary: '', log: '', callerUrl: path.join(remotes, 'octo', 'site.git'), data: { secrets } };
}

function runWorkflow(opts = {}) {
  const { inputs = {}, event = 'workflow_dispatch', ref = 'refs/heads/main', headFiles = HEAD_FILES, tags = true, findings = false, secrets = {} } = opts;
  const world = makeWorld({ event, ref, headFiles, tags, findings, secrets });
  world.data.inputs = withDefaults(inputs);
  const jobs = {};
  for (const name of jobOrder()) {
    const list = needList(flow(), name);
    const needs = Object.fromEntries(list.map((n) => [n, { result: jobs[n].result, outputs: jobs[n].outputs }]));
    const scope = { data: { ...world.data, github: world.github, needs }, status: { ok: list.every((n) => jobs[n].result === 'success') } };
    jobs[name] = holds(jobsOf()[name].if, scope) ? runJob(name, world, needs) : { result: 'skipped', outputs: {}, records: [] };
  }
  return { jobs, world, result: (n) => jobs[n]?.result ?? 'absent' };
}

const records = (run, action) => Object.values(run.jobs).flatMap((j) => j.records).filter((r) => r.action === action && r.ok);
const jobUsing = (action) => Object.keys(jobsOf()).find((n) => stepsOf(jobsOf()[n]).some((s) => new RegExp(`actions/${action}(?:@|$)`).test(asText(s.uses))));
const scanJob = () => jobUsing('scan-suite');
const buildJob = () => jobUsing('pages-upload');
const deployJob = () => jobUsing('pages-deploy');
const callerHead = (run, job) => run.jobs[job].records.find((r) => r.action === 'checkout' && r.head)?.head;
const uploadedIndex = (run) => records(run, 'pages-upload')[0]?.index ?? '';
const story = (run) => `${JSON.stringify(Object.fromEntries(Object.entries(run.jobs).map(([n, j]) => [n, j.result])))}\n${run.world.log}`;

const deployed = (run) => run.result(deployJob()) === 'success';
const ungatedDeploy = (run) => deployed(run) && run.result('gate') !== 'success';

// ==================== inputs: YAML, pages.md, catalog.md ====================

const STATED = [
  ['deploy', 'boolean', true],
  ['install_command', 'string', ''],
  ['test_command', 'string', ''],
  ['coverage_path', 'string', ''],
  ['approval', 'string', 'environment'],
  ['source', 'string', 'main'],
  ['scan_disable', 'string', undefined],
  ['artifact_name', 'string', undefined],
];

for (const [name, type, def] of STATED) {
  test(`pages-site.yml has the ${type} input ${name}${def === undefined ? '' : `, default ${JSON.stringify(def)}`}`, () => {
    const spec = inputsDef()[name];
    assert.ok(spec, `no ${name} input`);
    assert.equal(spec.type, type);
    assert.ok(def === undefined || spec.default === def, `${name} defaults to ${JSON.stringify(spec.default)}`);
  });
}

test('pages-site.yml has a prebuilt input and a boolean fail_on_findings input that defaults to true', () => {
  assert.ok(inputsDef().prebuilt, 'no prebuilt input');
  assert.ok(failInput(), 'no fail_on_findings (or scan_fail_on_findings) input');
  assert.equal(inputsDef()[failInput()].type, 'boolean');
  assert.equal(inputsDef()[failInput()].default, true, 'the scan must fail closed by default');
});

test('install_command and test_command are documented as trusted raw-shell input (D10d)', () => {
  for (const name of ['install_command', 'test_command']) assert.match(asText(inputsDef()[name]?.description), /Trusted input[\s\S]*D10d/);
});

test('the build secret is opt-in: pages-site.yml declares at least one secret and requires none', () => {
  const secrets = Object.entries(secretsDef());
  assert.ok(secrets.length > 0, 'pages-site.yml declares no secrets');
  assert.deepEqual(secrets.filter(([, s]) => s?.required).map(([n]) => n), []);
});

function pagesMdInputRows() {
  const text = readRepo('docs', 'flows', 'pages.md');
  const start = text.indexOf('### `pages-site.yml` inputs');
  assert.ok(start >= 0, 'pages.md has no "### `pages-site.yml` inputs" section');
  const body = text.slice(start + 1).split(/\n#{2,3} /)[0].split('\n').filter((l) => /^\|\s*`/.test(l));
  return Object.fromEntries(body.map((l) => l.split('|').map((c) => c.trim())).map((c) => [c[1].replace(/`/g, ''), c]));
}

test('pages.md lists every pages-site.yml input, new ones included, with its YAML default', () => {
  const rows = pagesMdInputRows();
  for (const [name, spec] of Object.entries(inputsDef())) {
    assert.ok(rows[name], `pages.md's input table has no ${name} row`);
    assert.equal(rows[name][3].replace(/^`|`$/g, '').replace(/^''$/, ''), asText(spec.default), `pages.md shows the wrong default for ${name}`);
  }
});

test('the catalog matches pages-site.yml (tests/catalog/shape-validate.py passes)', () => {
  const r = spawnSync('python3', [path.join(REPO, 'tests', 'catalog', 'shape-validate.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('pages.md and the catalog name the build secret', () => {
  const catalog = readRepo('docs', 'catalog.md');
  const section = catalog.slice(catalog.indexOf('### pages-site.yml')).split('\n### ')[0];
  for (const name of Object.keys(secretsDef())) {
    assert.ok(readRepo('docs', 'flows', 'pages.md').includes(`\`${name}\``), `pages.md does not name the ${name} secret`);
    assert.ok(section.includes(`\`${name}\``), `the catalog's pages-site.yml section does not name the ${name} secret`);
  }
});

test('pages.md documents the approval: merge trust trade-off and how PR CI and release pre-checks reuse the workflow', () => {
  const text = readRepo('docs', 'flows', 'pages.md');
  const paras = text.split(/\n\s*\n/);
  assert.ok(paras.some((p) => /\bmerge\b/.test(p) && /approval/.test(p) && /workflow_dispatch/.test(p)), 'no paragraph on approval: merge and workflow_dispatch');
  assert.match(text, /deploy: false/);
  assert.match(text, /prebuilt/);
});

// ==================== conventions in the YAML ====================

test('every input reaches a shell through env:, never inside a run script', () => {
  const inline = allSteps(flow()).filter(({ step }) => /\$\{\{[^}]*\binputs\./.test(asText(step.run)));
  assert.deepEqual(inline.map(({ job, step }) => `${job}: ${step.name ?? step.run.slice(0, 40)}`), []);
});

test('the build secret is read only in the env of the step that runs site_build_command', () => {
  const raw = fs.readFileSync(path.join(WORKFLOWS, 'pages-site.yml'), 'utf8');
  for (const name of Object.keys(secretsDef())) {
    const ref = new RegExp(`secrets\\.${name}\\b`);
    const holders = allSteps(flow()).filter(({ step }) => ref.test(JSON.stringify(step)));
    assert.equal(holders.length, 1, `secrets.${name} is read by ${holders.length} steps`);
    assert.match(JSON.stringify(holders[0].step.env ?? {}), ref, `secrets.${name} is not in that step's env`);
    assert.match(JSON.stringify(holders[0].step), /inputs\.site_build_command/, `the step that reads secrets.${name} is not the site_build_command step`);
    assert.equal(raw.match(new RegExp(ref, 'g')).length, 1, `secrets.${name} appears more than once in pages-site.yml`);
  }
});

test('the scan job runs before gate and holds read grants only', () => {
  assert.ok(scanJob(), 'no job in pages-site.yml uses scan-suite');
  assert.ok(upstream(flow(), 'gate').includes(scanJob()), `gate does not need ${scanJob()}`);
  const perms = jobsOf()[scanJob()].permissions;
  assert.ok(perms !== undefined, 'the scan job sets no permissions of its own');
  assert.deepEqual(Object.entries(perms).filter(([, v]) => !['read', 'none'].includes(v)), []);
});

test('the build caches npm for docs-build\'s lockfile through setup-node', () => {
  const nodes = stepsOf(jobsOf()[buildJob()]).filter((s) => /^actions\/setup-node@/.test(asText(s.uses)));
  assert.ok(nodes.some((s) => s.with?.cache === 'npm' && /docs-build\/vitepress\/package-lock\.json/.test(asText(s.with?.['cache-dependency-path']))),
    'no setup-node step in the build with cache: npm and cache-dependency-path on docs-build/vitepress/package-lock.json');
});

test('every third-party action in pages-site.yml is pinned to a full commit SHA', () => {
  const thirdParty = allSteps(flow()).map(({ step }) => asText(step.uses)).filter((u) => u && !u.startsWith('./'));
  assert.deepEqual(thirdParty.filter((u) => !/@[0-9a-f]{40}$/.test(u)), []);
});

test('pin comments agree everywhere (pin-comments.py --offline passes)', () => {
  const r = spawnSync('python3', [path.join(REPO, 'tests', 'shape-lints', 'pin-comments.py'), '--offline'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

// The line numbers of each grant inside a `permissions:` block.
function grantLines(lines) {
  const found = [];
  let block = -1;
  lines.forEach((line, i) => {
    const indent = line.search(/\S/);
    const inBlock = block >= 0 && indent > block;
    if (inBlock && /^\s*[a-z-]+:\s*(?:read|write)\b/.test(line)) found.push(i);
    if (!inBlock && indent >= 0 && !/^\s*#/.test(line)) block = /^\s*permissions:\s*(?:#.*)?$/.test(line) ? indent : -1;
  });
  return found;
}

test('each permission grant in pages-site.yml has a comment saying why', () => {
  const lines = fs.readFileSync(path.join(WORKFLOWS, 'pages-site.yml'), 'utf8').split('\n');
  const bare = grantLines(lines).filter((i) => !lines[i].includes('#') && !lines.slice(Math.max(0, i - 4), i).some((x) => /^\s*#/.test(x)));
  assert.deepEqual(bare.map((i) => lines[i].trim()), []);
});

test('_self-ci.yml runs this test file', () => {
  assert.ok(readRepo('.github', 'workflows', '_self-ci.yml').includes(THIS_FILE), `_self-ci.yml does not run ${THIS_FILE}`);
});

// ==================== OSV over the VitePress lockfile ====================

function osvJobs(wf) {
  const osvStep = (s) => {
    const withs = JSON.stringify(s.with ?? {});
    const disabled = asText(s.with?.scan_disable).split(',').map((x) => x.trim());
    const suite = /actions\/scan-suite(?:@|$)/.test(asText(s.uses)) && s.with?.fail_on_findings === 'true' && !disabled.includes('osv');
    const direct = /osv-scanner/.test(asText(s.uses)) && !s['continue-on-error'];
    return /docs-build\/vitepress/.test(withs) && (suite || direct);
  };
  return Object.keys(jobsOf(wf)).filter((n) => stepsOf(jobsOf(wf)[n]).some(osvStep));
}

test('hashira\'s own CI runs OSV over docs-build\'s VitePress lockfile and fails on findings', () => {
  assert.ok(osvJobs(flow('_self-ci.yml')).length > 0, 'no _self-ci.yml job scans .github/actions/docs-build/vitepress with OSV, failing on findings');
});

test('the release runs OSV over the VitePress lockfile before publish', () => {
  const release = flow('release.yml');
  const before = upstream(release, 'publish');
  assert.ok(osvJobs(release).some((n) => before.includes(n)), 'no job that publish needs scans .github/actions/docs-build/vitepress with OSV');
});

// ==================== the own-build template ====================

function templateFiles(dir = path.join(REPO, 'templates')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? templateFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test('a template shows the own build + site-kit + pages-upload + pages-deploy pattern, pinned @v3, documented in pages.md', () => {
  const own = templateFiles().filter((f) => /\.ya?ml$/.test(f)).filter((f) => ['site-kit', 'pages-upload', 'pages-deploy'].every((a) => fs.readFileSync(f, 'utf8').includes(`.github/actions/${a}@v3`)));
  assert.equal(own.length, 1, 'expected one template using site-kit, pages-upload and pages-deploy @v3');
  const spec = yamlOf(own[0]);
  const deployer = Object.values(spec.jobs).find((j) => stepsOf(j).some((s) => /pages-deploy@/.test(asText(s.uses))));
  assert.ok(deployer.environment, 'the template\'s deploy job declares no environment');
  assert.ok(readRepo('docs', 'flows', 'pages.md').includes(path.relative(REPO, own[0])), 'pages.md does not link the template');
});

// ==================== scan: before the gate, fail closed ====================

test('by default the scan runs OSV and gitleaks, fails on findings, and the site deploys', () => {
  const run = runWorkflow();
  assert.ok(deployed(run), story(run));
  const scan = records(run, 'scan-suite')[0];
  assert.ok(scan, `no scan-suite step ran:\n${story(run)}`);
  const disabled = asText(scan.with.scan_disable).split(',').map((s) => s.trim());
  assert.ok(!disabled.includes('osv') && !disabled.includes('gitleaks'), `scan_disable passed was '${scan.with.scan_disable}'`);
  assert.equal(scan.with.fail_on_findings, 'true');
});

test('a scan with findings stops the run before gate: nothing is approved, built or deployed', () => {
  const run = runWorkflow({ findings: true });
  assert.equal(run.result(scanJob()), 'failure', story(run));
  assert.notEqual(run.result('gate'), 'success');
  assert.equal(records(run, 'pages-upload').length, 0);
  assert.ok(!deployed(run));
});

test('fail_on_findings false lets a scan with findings through', () => {
  const run = runWorkflow({ findings: true, inputs: { [failInput()]: false } });
  assert.ok(deployed(run), story(run));
});

test('scan_disable is forwarded to scan-suite', () => {
  const run = runWorkflow({ inputs: { scan_disable: 'gitleaks' } });
  const disabled = asText(records(run, 'scan-suite')[0]?.with.scan_disable).split(',').map((s) => s.trim());
  assert.ok(disabled.includes('gitleaks') && !disabled.includes('osv'), story(run));
});

// ==================== deploy: false, artifact_name, prebuilt ====================

const BUILD_ONLY_RUNS = [
  ['a pull request', 'pull_request', 'refs/pull/7/merge'],
  ['a push to another branch', 'push', 'refs/heads/feature'],
];

for (const [label, event, ref] of BUILD_ONLY_RUNS) {
  test(`deploy: false on ${label} builds and uploads, with no main-only refusal, no gate and no deploy`, () => {
    const run = runWorkflow({ event, ref, inputs: { deploy: false } });
    assert.equal(run.result('check'), 'success', story(run));
    assert.equal(run.result('gate'), 'skipped');
    assert.equal(run.result(buildJob()), 'success', story(run));
    assert.match(uploadedIndex(run), /tree head/);
    assert.equal(run.result(deployJob()), 'skipped');
  });
}

test('deploy: false leaves the build job with contents: read only', () => {
  assert.deepEqual(jobsOf()[buildJob()].permissions, { contents: 'read' });
});

test('with deploy left at true, a pull request run still builds and deploys nothing', () => {
  const run = runWorkflow({ event: 'pull_request', ref: 'refs/pull/7/merge' });
  assert.equal(records(run, 'pages-upload').length, 0, story(run));
  assert.ok(!deployed(run));
});

test('artifact_name names the uploaded artifact and the one deployed', () => {
  const run = runWorkflow({ inputs: { artifact_name: 'site-preview' } });
  assert.equal(records(run, 'pages-upload')[0]?.with.artifact_name, 'site-preview', story(run));
  assert.equal(records(run, 'pages-deploy')[0]?.with.artifact_name, 'site-preview');
});

test('with artifact_name left out, the build uploads the artifact the deploy deploys', () => {
  const run = runWorkflow();
  assert.equal(asText(records(run, 'pages-upload')[0]?.with.artifact_name) || 'github-pages', asText(records(run, 'pages-deploy')[0]?.with.artifact_name) || 'github-pages', story(run));
});

test('prebuilt deploys the named artifact from earlier in the run without building or uploading again', () => {
  const run = runWorkflow({ inputs: { prebuilt: prebuiltValue(), artifact_name: 'site-built' } });
  assert.ok(deployed(run), story(run));
  assert.equal(records(run, 'pages-deploy')[0].with.artifact_name, 'site-built');
  for (const action of ['site-kit', 'docs-build', 'pages-upload']) assert.equal(records(run, action).length, 0, `${action} ran in prebuilt mode`);
});

// ==================== the kit references ====================

const KIT_CASES = [
  ['root and sub-page references to existing kit files', HEAD_FILES, true],
  ['no kit references at all', { 'site/index.html': '<h1>tree head</h1>' }, true],
  ['a reference to a kit file that does not exist', { 'site/index.html': '<h1>x</h1><script src="_kit/nope.js"></script>' }, false],
  ['a sub-page reference to a missing kit file', { ...HEAD_FILES, 'site/guide/index.html': '<link rel="stylesheet" href="../_kit/gone.css">' }, false],
];

for (const [label, headFiles, passes] of KIT_CASES) {
  test(`the build ${passes ? 'accepts' : 'refuses'} a site with ${label}`, () => {
    const run = runWorkflow({ headFiles });
    assert.equal(run.result(buildJob()) === 'success', passes, story(run));
    assert.equal(deployed(run), passes);
  });
}

// ==================== install_command, test_command, coverage_path ====================

test('install_command runs in the build before site_build_command, and test_command runs there too', () => {
  const marks = freshDir('marks');
  const run = runWorkflow({ inputs: {
    install_command: 'touch installed.mark',
    site_build_command: 'test -f installed.mark',
    test_command: `touch "${marks}/tested"`,
  } });
  assert.equal(run.result(buildJob()), 'success', story(run));
  assert.ok(fs.existsSync(path.join(marks, 'tested')), 'test_command did not run');
  assert.ok(deployed(run));
});

for (const name of ['install_command', 'test_command']) {
  test(`a failing ${name} fails the build and deploys nothing`, () => {
    const run = runWorkflow({ inputs: { [name]: 'exit 3' } });
    assert.equal(run.result(buildJob()), 'failure', story(run));
    assert.ok(!deployed(run));
  });
}

test('coverage_path feeds coverage-report', () => {
  const run = runWorkflow({ inputs: { test_command: 'mkdir -p cov && echo "TN:" > cov/lcov.info', coverage_path: 'cov/lcov.info' } });
  assert.equal(records(run, 'coverage-report')[0]?.with.coverage_path, 'cov/lcov.info', story(run));
});

// ==================== the build secret ====================

test('the build secret reaches site_build_command as an env var and no other command', () => {
  const [name] = Object.keys(secretsDef());
  assert.ok(name, 'pages-site.yml declares no secrets');
  const dumps = freshDir('dumps');
  const run = runWorkflow({ secrets: { [name]: 'tok-5ec7e7' }, inputs: {
    install_command: `env > "${dumps}/install"`,
    site_build_command: `env > "${dumps}/build"`,
    test_command: `env > "${dumps}/test"`,
  } });
  assert.ok(deployed(run), story(run));
  assert.match(fs.readFileSync(path.join(dumps, 'build'), 'utf8'), /=tok-5ec7e7$/m);
  for (const other of ['install', 'test']) assert.doesNotMatch(fs.readFileSync(path.join(dumps, other), 'utf8'), /tok-5ec7e7/);
});

// ==================== approval ====================

test('the default approval waits at gate before a deploy', () => {
  const run = runWorkflow();
  assert.equal(run.result('gate'), 'success', story(run));
  assert.ok(deployed(run));
});

for (const event of ['push', 'schedule', 'repository_dispatch']) {
  test(`approval: merge deploys main on ${event} with no gate`, () => {
    const run = runWorkflow({ event, inputs: { approval: 'merge' } });
    assert.equal(run.result('gate'), 'skipped', story(run));
    assert.ok(deployed(run), story(run));
  });
}

const NEVER_UNGATED = [
  ['approval: merge on workflow_dispatch', { event: 'workflow_dispatch', inputs: { approval: 'merge' } }],
  ['approval: merge on a push to another branch', { event: 'push', ref: 'refs/heads/feature', inputs: { approval: 'merge' } }],
  ['approval: merge on workflow_run', { event: 'workflow_run', inputs: { approval: 'merge' } }],
  ['approval: merge on a pull request', { event: 'pull_request', ref: 'refs/pull/7/merge', inputs: { approval: 'merge' } }],
  ['an unknown approval value', { event: 'push', inputs: { approval: 'none' } }],
];

for (const [label, opts] of NEVER_UNGATED) {
  test(`${label} never deploys without the gate`, () => {
    const run = runWorkflow(opts);
    assert.ok(!ungatedDeploy(run), story(run));
  });
}

// ==================== source ====================

test('source: latest-release builds and scans the highest vX.Y.Z tag\'s tree, not main', () => {
  const run = runWorkflow({ inputs: { source: 'latest-release' } });
  assert.ok(deployed(run), story(run));
  assert.match(uploadedIndex(run), /tree c2/);
  assert.equal(callerHead(run, buildJob()), run.world.shas.c2);
  assert.equal(callerHead(run, scanJob()), run.world.shas.c2, 'the scan did not check out the commit being deployed');
});

test('source left at main builds main\'s tree', () => {
  const run = runWorkflow();
  assert.match(uploadedIndex(run), /tree head/, story(run));
});

const SUMMARY_CASES = [
  ['main', {}, 'head', 2],
  ['latest-release', { source: 'latest-release' }, 'c2', 0],
];

for (const [label, inputs, at, after] of SUMMARY_CASES) {
  test(`the step summary says what is deployed (source ${label})`, () => {
    const run = runWorkflow({ inputs });
    const line = run.world.summary.match(/deploying (\S+)@([0-9a-f]{40}), (\d+) commits? after (\S+)/);
    assert.ok(line, `no "deploying <ref>@<sha>, N commits after <tag>" line in:\n${run.world.summary}`);
    assert.deepEqual(line.slice(2, 5), [run.world.shas[at], String(after), 'v1.10.0']);
  });
}

const NO_SOURCE = [
  ['source: latest-release with no vX.Y.Z tag', { tags: false, inputs: { source: 'latest-release' } }],
  ['an unknown source value', { inputs: { source: 'tip' } }],
];

for (const [label, opts] of NO_SOURCE) {
  test(`${label} builds and deploys nothing rather than falling back to main`, () => {
    const run = runWorkflow(opts);
    assert.equal(records(run, 'pages-upload').length, 0, story(run));
    assert.ok(!deployed(run));
  });
}

// ==================== docs-build's step summary ====================

test('docs-build writes the VitePress version and the lockfile\'s sha256 to the step summary', { timeout: 600_000 }, () => {
  const root = freshDir('docs');
  const ws = path.join(root, 'site');
  writeTree(ws, { '.github/pages.json': '{ "name": "Octo Site" }\n', 'docs/getting-started.md': '# Welcome\n\nHello.\n' });
  mustGit(root, 'init', '-q', ws);
  const summary = path.join(root, 'summary.md');
  const env = { ...ENV_BASE, GITHUB_REPOSITORY: 'octo/site', GITHUB_STEP_SUMMARY: summary, TMPDIR: root };
  const r = spawnSync(process.execPath, [path.join(REPO, '.github', 'actions', 'docs-build', 'lib', 'cli.js'), '--out', 'out/docs'], { cwd: ws, env, encoding: 'utf8', timeout: 600_000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const text = fs.readFileSync(summary, 'utf8');
  const lock = fs.readFileSync(LOCKFILE);
  assert.ok(text.includes(JSON.parse(lock).packages['node_modules/vitepress'].version), `no VitePress version in:\n${text}`);
  assert.ok(text.includes(crypto.createHash('sha256').update(lock).digest('hex')), `no lockfile sha256 in:\n${text}`);
});
