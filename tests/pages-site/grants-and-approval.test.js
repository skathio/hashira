// The user's rules for the two security fixes of the Pages release, checked through the files a
// caller and a maintainer read: the reusable workflows, pages-upload's header, the permission
// docs, the static-webapp caller template with its fixture and README copy, docs/flows/pages.md
// and CHANGELOG.md.
//
// 1. A job that runs the caller's code (checks the caller's tree out, or runs a command input)
//    holds neither `id-token` nor `pages`; static-webapp-ci's build-and-upload drops both, and
//    every text that said it needs them now agrees.
// 2. pages-site.yml's `check` job (permissions {}) refuses `released: true` unless this run has
//    an approved `production` review, read from the run's approvals endpoint, through a lib with
//    node:test tests run by _self-ci.yml; when `check` fails, nothing builds or deploys.
//
// Run with:
//   node --test tests/pages-site/grants-and-approval.test.js
//
// Left to the builder, so not tested here: the lib's file name, exports and argument shape,
// whether the approvals endpoint is read with the job's token or unauthenticated, the error
// wording, and the CHANGELOG entry's date and sections.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const rel = (...parts) => path.join(REPO, ...parts);
const read = (...parts) => fs.readFileSync(rel(...parts), 'utf8');

const CONSUMER_WORKFLOWS = ['npm-package-ci.yml', 'nuget-package-ci.yml', 'static-webapp-ci.yml', 'pages-site.yml'];
const PRIVILEGED = ['id-token', 'pages'];

// ---------- YAML through PyYAML, the shape lints' own parser ----------

function parseYaml(text, label) {
  const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))';
  const run = spawnSync('python3', ['-c', py], { input: text, encoding: 'utf8' });
  assert.equal(run.status, 0, `could not read ${label}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

// A doc block that is not YAML on its own (a fragment) is skipped, not a failure.
function tryYaml(text) {
  const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))';
  const run = spawnSync('python3', ['-c', py], { input: text, encoding: 'utf8' });
  return run.status === 0 ? JSON.parse(run.stdout) : null;
}

const cache = new Map();
function workflow(file) {
  if (!cache.has(file)) cache.set(file, parseYaml(read('.github', 'workflows', file), file));
  return cache.get(file);
}

// A job's effective grants: its own block, or the workflow's when it has none.
function grants(spec, jobName) {
  const own = spec.jobs[jobName].permissions;
  const perms = own === undefined ? spec.permissions : own;
  if (perms === 'write-all') return Object.fromEntries(PRIVILEGED.map((p) => [p, 'write']));
  if (perms === 'read-all') return Object.fromEntries(PRIVILEGED.map((p) => [p, 'read']));
  return perms ?? {};
}

const holdsPrivileged = (perms) => PRIVILEGED.filter((p) => perms[p] !== undefined && perms[p] !== 'none');

const isCallerCheckout = (step) => /^actions\/checkout@/i.test(String(step.uses ?? ''))
  && !/^skathio\/hashira$/i.test(String(step.with?.repository ?? '').trim());

// A job runs the caller's code when it checks the caller's tree out or hands a command input
// (build_command, test_command, site_build_command, ...) to a step.
function runsCallerCode(jobDef) {
  const steps = jobDef.steps ?? [];
  if (steps.some(isCallerCheckout)) return true;
  return /inputs\.[a-z_]*command\b/.test(JSON.stringify(steps));
}

// ---------- prose ----------

const NEGATION = /\b(no|not|never|neither|nor|without|drops?|dropped|no longer)\b|n't\b/i;

// Sentences of a text (comment markers and line breaks folded) that say a non-deploy job holds
// id-token or pages.
function privilegedClaims(text, subject) {
  const flat = text.replace(/^\s*#\s?/gm, '').replace(/\s+/g, ' ');
  return flat.split(/(?<=[.;])\s+|\|/).filter((s) => subject.test(s)
    && /\b(holds?|holding)\b/i.test(s)
    && /id-token|pages:\s*write/i.test(s)
    && !NEGATION.test(s));
}

// The comment block before the first non-comment line of a workflow.
const header = (text) => text.split('\n').filter((_, i, all) => all.slice(0, i + 1).every((l) => /^\s*(#|$)/.test(l))).join('\n');

function section(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  assert.ok(start >= 0, `no heading matching ${heading}`);
  const level = /^#+/.exec(lines[start])[0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

const yamlBlocks = (markdown) => [...markdown.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((m) => m[1]);

// ---------- static-webapp-ci: what its jobs still need from the caller ----------

function staticWebappNeeds() {
  const spec = workflow('static-webapp-ci.yml');
  return new Set(Object.keys(spec.jobs).flatMap((j) => holdsPrivileged(grants(spec, j))));
}

// ---------- rule 1: no caller-code job holds id-token or pages ----------

test('static-webapp-ci build-and-upload holds neither id-token nor pages, and keeps contents: read', () => {
  const perms = grants(workflow('static-webapp-ci.yml'), 'build-and-upload');
  assert.deepEqual(holdsPrivileged(perms), []);
  assert.equal(perms.contents, 'read');
});

test('the caller-code detection sees static-webapp-ci build-and-upload and pages-site build', () => {
  assert.ok(runsCallerCode(workflow('static-webapp-ci.yml').jobs['build-and-upload']));
  assert.ok(runsCallerCode(workflow('pages-site.yml').jobs.build));
});

for (const file of CONSUMER_WORKFLOWS) {
  test(`${file}: no job that runs the caller's code holds id-token or pages`, () => {
    const spec = workflow(file);
    const offenders = Object.keys(spec.jobs)
      .filter((j) => runsCallerCode(spec.jobs[j]))
      .map((j) => [j, holdsPrivileged(grants(spec, j))])
      .filter(([, held]) => held.length > 0);
    assert.deepEqual(offenders, []);
  });
}

test('pages-site deploy keeps pages: write and id-token: write', () => {
  const perms = grants(workflow('pages-site.yml'), 'deploy');
  assert.equal(perms.pages, 'write');
  assert.equal(perms['id-token'], 'write');
});

test('every grant in static-webapp-ci build-and-upload says in a comment why', () => {
  const text = read('.github', 'workflows', 'static-webapp-ci.yml').split('\n');
  const start = text.findIndex((l) => /^ {2}build-and-upload:/.test(l));
  const block = text.findIndex((l, i) => i > start && /^ {4}permissions:/.test(l));
  assert.ok(start >= 0 && block > start, 'build-and-upload has no permissions block');
  for (let i = block + 1; i < text.length && /^ {6}\S|^\s*$|^ {6,}#/.test(text[i]); i++) {
    if (!/^ {6}[a-z-]+:\s*\w/.test(text[i])) continue;
    const commented = text[i].includes('#') || /^\s*#/.test(text[i - 1]);
    assert.ok(commented, `grant without a comment: ${text[i].trim()}`);
  }
});

// ---------- rule 1: the texts agree ----------

test('static-webapp-ci header no longer says build-and-upload or build_command holds id-token or pages', () => {
  const text = header(read('.github', 'workflows', 'static-webapp-ci.yml'));
  const baseline = text.split('\n').filter((l, i, all) => {
    const at = all.findIndex((x) => /^#\s+- build-and-upload\s*:/.test(x));
    if (at < 0 || i < at) return false;
    return all.slice(at + 1, i + 1).every((x) => !/^#\s+- \S|^#\s*$/.test(x));
  });
  assert.ok(baseline.length > 0, 'the permissions baseline lists no build-and-upload line');
  assert.doesNotMatch(baseline.join(' '), /id-token|pages:\s*write/);
  assert.deepEqual(privilegedClaims(text, /build-and-upload|build_command|this job|same job/i), []);
});

test('pages-upload\'s "Required caller permissions" header no longer requires id-token or pages', () => {
  const action = read('.github', 'actions', 'pages-upload', 'action.yml');
  const lines = header(action).split('\n');
  const start = lines.findIndex((l) => /^#\s*## Required caller permissions/.test(l));
  assert.ok(start >= 0, 'the "Required caller permissions" header is missing');
  const end = lines.findIndex((l, i) => i > start && /^#\s*## /.test(l));
  const block = lines.slice(start, end < 0 ? undefined : end).join('\n');
  assert.doesNotMatch(block, /^#\s+(id-token|pages):\s*write/m);
  assert.doesNotMatch(block, /MUST be granted/);
});

test('docs/usage.md\'s permission table lists for static-webapp-ci.yml only what its jobs hold', () => {
  const needs = staticWebappNeeds();
  const row = read('docs', 'usage.md').split('\n').find((l) => /^\|\s*`static-webapp-ci\.yml`/.test(l));
  assert.ok(row, 'no static-webapp-ci.yml row in the docs/usage.md permission table');
  for (const p of PRIVILEGED) {
    if (!needs.has(p)) assert.doesNotMatch(row, new RegExp(`\`${p}: write\``));
  }
});

test('docs/flows/static-webapp.md\'s permission table asks the ci job only for what static-webapp-ci holds', () => {
  const needs = staticWebappNeeds();
  const lines = read('docs', 'flows', 'static-webapp.md').split('\n');
  const head = lines.findIndex((l) => /^\|\s*Caller job calls/.test(l));
  assert.ok(head >= 0, 'the permission table is missing');
  const cols = lines[head].split('|').map((c) => c.trim().replace(/`/g, ''));
  const ci = lines.slice(head + 2).find((l) => /static-webapp-ci\.yml/.test(l));
  const deploy = lines.slice(head + 2).find((l) => /pages-deploy/.test(l));
  assert.ok(ci && deploy, 'the table needs a ci row and a deploy row');
  const cell = (row, name) => row.split('|').map((c) => c.trim())[cols.indexOf(name)] ?? '';
  for (const p of PRIVILEGED) {
    assert.ok(cols.includes(p), `the table has no ${p} column`);
    if (!needs.has(p)) assert.doesNotMatch(cell(ci, p), /write/);
    assert.match(cell(deploy, p), /write/, `the deploy row must keep ${p}: write`);
  }
});

test('the docs no longer say static-webapp-ci needs id-token at the caller\'s ci job or runs build_command in a job holding it', () => {
  const needs = staticWebappNeeds();
  if (needs.size > 0) return;
  for (const doc of [['docs', 'usage.md'], ['docs', 'flows', 'static-webapp.md'], ['docs', 'catalog.md'], ['README.md']]) {
    const flat = read(...doc).replace(/\s+/g, ' ');
    assert.doesNotMatch(flat, /only CI-half workflow[^.]*requires `id-token: write`/, doc.join('/'));
    assert.doesNotMatch(flat, /same job that holds `id-token/, doc.join('/'));
    assert.deepEqual(privilegedClaims(read(...doc), /build-and-upload/), [], doc.join('/'));
  }
});

// The caller's ci job drops the grants once no job of static-webapp-ci holds them; its deploy
// job keeps both.
function checkCaller(spec, label) {
  const needs = staticWebappNeeds();
  const ci = Object.values(spec.jobs).find((j) => /static-webapp-ci\.yml@/.test(String(j.uses ?? '')));
  const deploy = Object.values(spec.jobs).find((j) => (j.steps ?? []).some((s) => /pages-deploy@/.test(String(s.uses ?? ''))));
  assert.ok(ci && deploy, `${label}: needs a ci job calling static-webapp-ci.yml and a deploy job`);
  for (const p of PRIVILEGED) {
    if (!needs.has(p)) assert.equal(ci.permissions?.[p], undefined, `${label}: the ci job still grants ${p}`);
    assert.equal(deploy.permissions?.[p], 'write', `${label}: the deploy job must keep ${p}: write`);
  }
}

test('templates/static-webapp/ci.yml: ci job drops id-token and pages, deploy keeps them', () => {
  checkCaller(parseYaml(read('templates', 'static-webapp', 'ci.yml'), 'template'), 'template');
});

test('the static-webapp fixture caller matches: ci job drops id-token and pages, deploy keeps them', () => {
  const file = ['tests', 'consumers', 'static-webapp', '.github', 'workflows', 'ci.yml'];
  checkCaller(parseYaml(read(...file), 'fixture'), 'fixture');
});

test('the README\'s static-webapp caller matches: ci job drops id-token and pages, deploy keeps them', () => {
  const block = yamlBlocks(read('README.md')).find((b) => /static-webapp-ci\.yml@/.test(b));
  assert.ok(block, 'README.md has no static-webapp caller block');
  checkCaller(parseYaml(block, 'README block'), 'README');
});

// ---------- rule 2: pages-site check enforces the production approval ----------

const pagesSite = () => workflow('pages-site.yml');
const pagesSiteText = () => read('.github', 'workflows', 'pages-site.yml');

// Repo files the check job's steps reference, such as .hashira/.github/actions/x/lib/y.js.
function checkLibs() {
  const steps = JSON.stringify(pagesSite().jobs.check.steps ?? []);
  const refs = [...steps.matchAll(/[\w./-]*\/lib\/[\w.-]+\.(?:c?js|mjs)/g)].map((m) => m[0]);
  return [...new Set(refs.map((r) => r.replace(/^(\.\/)?(\.hashira\/)?/, '')))]
    .filter((r) => fs.existsSync(rel(r)));
}

test('pages-site check still holds no grant (permissions {})', () => {
  assert.deepEqual(pagesSite().jobs.check.permissions, {});
});

test('pages-site check reads this run\'s approvals for the production environment when released is true', () => {
  const check = pagesSite().jobs.check;
  const steps = check.steps ?? [];
  const libText = checkLibs().map((f) => read(f)).join('\n');
  const stepText = (s) => JSON.stringify(s);
  const approval = steps.find((s) => /approvals/.test(stepText(s)) || (libText.includes('/approvals') && checkLibs().some((f) => stepText(s).includes(path.basename(f)))));
  assert.ok(approval, 'no step of check reads the run approvals');
  const both = `${stepText(approval)}\n${libText}`;
  assert.match(both, /actions\/runs\//);
  assert.match(both, /\/approvals/);
  assert.match(both, /github\.run_id|GITHUB_RUN_ID/);
  assert.match(both, /production/);
  assert.match(`${approval.if ?? ''} ${stepText(approval.env ?? {})} ${stepText(approval)}`, /inputs\.released/);
});

test('the approval check fails closed: neither its step nor check continues on error', () => {
  const check = pagesSite().jobs.check;
  assert.notEqual(check['continue-on-error'], true);
  for (const s of check.steps ?? []) assert.notEqual(s['continue-on-error'], true, `step ${s.name ?? s.uses}`);
});

test('the approval decision lives in a lib that a node:test file covers and _self-ci.yml runs', () => {
  const libs = checkLibs();
  assert.ok(libs.length > 0, 'check references no lib/*.js file in the repo');
  const selfCi = read('.github', 'workflows', '_self-ci.yml');
  const testFiles = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'tests'], { cwd: REPO, encoding: 'utf8' })
    .stdout.split('\n').filter((f) => /\.test\.(c?js|mjs)$/.test(f));
  const runBySelfCi = (f) => selfCi.includes(f) || selfCi.includes(`node --test ${path.dirname(f)}/`);
  const covered = libs.some((lib) => testFiles.some((f) => read(f).includes(path.basename(lib)) && /node:test/.test(read(f)) && runBySelfCi(f)));
  assert.ok(covered, `no node:test file run by _self-ci.yml covers ${libs.join(', ')}`);
});

test('pages-site deploy keeps the latest-release tag check for released runs', () => {
  const steps = pagesSite().jobs.deploy.steps ?? [];
  const tagCheck = steps.find((s) => /git ls-remote --tags/.test(String(s.run ?? '')));
  assert.ok(tagCheck, 'the latest-release check is gone from deploy');
  assert.match(String(tagCheck.if ?? ''), /inputs\.released/);
});

// GitHub's job graph: `needs` holds direct needs only; failure() and success() look at every
// ancestor; a job whose `if` names no status function is read as success() && (...).
function functions(status) {
  return { success: () => status.success, failure: () => status.failure, always: () => true, cancelled: () => false };
}

function evaluate(source, data, status) {
  const strings = [];
  const held = source.replace(/'((?:[^']|'')*)'/g, (_, s) => `\u0000${strings.push(s.replace(/''/g, "'")) - 1}\u0000`);
  const looked = held.replace(/(?<![\w.$])([A-Za-z_]\w*(?:\.[\w-]+)+)/g, (_, c) => `$get(${JSON.stringify(c)})`);
  const js = looked.replace(/\u0000(\d+)\u0000/g, (_, i) => JSON.stringify(strings[Number(i)]));
  const $get = (chain) => chain.split('.').reduce((v, k) => v?.[k], data);
  return vm.runInNewContext(js, { $get, ...functions(status) });
}

function runs(cond, data, status) {
  if (cond === undefined || cond === null) return status.success;
  const source = String(cond).trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const hasStatus = /\b(success|failure|always|cancelled)\s*\(/.test(source);
  return Boolean(hasStatus ? evaluate(source, data, status) : status.success && evaluate(source, data, status));
}

function jobResults(released, failing) {
  const jobs = pagesSite().jobs;
  const needsOf = (n) => [].concat(jobs[n].needs ?? []);
  const ancestors = (n) => needsOf(n).flatMap((m) => [m, ...ancestors(m)]);
  const results = {};
  const pending = Object.keys(jobs);
  while (pending.length) {
    const at = pending.findIndex((n) => needsOf(n).every((m) => m in results));
    assert.ok(at >= 0, 'the jobs\' needs form a cycle');
    const [name] = pending.splice(at, 1);
    const needs = Object.fromEntries(needsOf(name).map((m) => [m, { result: results[m], outputs: {} }]));
    const status = {
      success: needsOf(name).every((m) => results[m] === 'success') && !ancestors(name).some((m) => results[m] === 'failure'),
      failure: ancestors(name).some((m) => results[m] === 'failure'),
    };
    const data = { inputs: { released }, needs, github: { ref: 'refs/heads/main', event_name: 'workflow_dispatch' } };
    results[name] = !runs(jobs[name].if, data, status) ? 'skipped' : failing.includes(name) ? 'failure' : 'success';
  }
  return results;
}

for (const released of [true, false]) {
  test(`when check refuses, nothing builds or deploys (released: ${released})`, () => {
    const r = jobResults(released, ['check']);
    assert.notEqual(r.build, 'success');
    assert.notEqual(r.deploy, 'success');
    for (const [name, result] of Object.entries(r)) {
      if (name !== 'check' && pagesSite().jobs[name].environment) assert.notEqual(result, 'success', `${name} ran`);
    }
  });
}

test('an approved release run (check passes, gate skipped) still builds and deploys', () => {
  const r = jobResults(true, []);
  assert.equal(r.gate, 'skipped');
  assert.equal(r.build, 'success');
  assert.equal(r.deploy, 'success');
});

test('a hand run (released: false) still waits at gate, then builds and deploys', () => {
  const r = jobResults(false, []);
  assert.equal(r.gate, 'success');
  assert.equal(r.build, 'success');
  assert.equal(r.deploy, 'success');
  assert.equal(jobResults(false, ['gate']).deploy, 'skipped');
});

// ---------- rule 2: docs ----------

test('pages.md section 2 or 8 gives a combined workflow_dispatch + workflow_call caller with no workflow_ref guard', () => {
  const pages = read('docs', 'flows', 'pages.md');
  const text = `${section(pages, /^## 2\. /)}\n${section(pages, /^## 8\. /)}`;
  const combined = yamlBlocks(text).map(tryYaml).find((spec) => {
    const on = spec?.on ?? spec?.true;
    return on && typeof on === 'object' && 'workflow_dispatch' in on && 'workflow_call' in on
      && JSON.stringify(spec.jobs ?? {}).includes('pages-site.yml@');
  });
  assert.ok(combined, 'no caller with both workflow_dispatch and workflow_call that calls pages-site.yml');
  assert.match(JSON.stringify(combined.jobs), /released/);
  assert.doesNotMatch(JSON.stringify(combined), /workflow_ref/);
});

test('pages.md says callers no longer need their own released guard', () => {
  const pages = read('docs', 'flows', 'pages.md');
  const text = `${section(pages, /^## 2\. /)}\n${section(pages, /^## 8\. /)}`.replace(/\s+/g, ' ');
  const says = /(no longer|do not|don't|never) need[^.]*(own )?guard|guard[^.]*(no longer|not) needed/i;
  assert.ok(says.test(text), 'sections 2 and 8 do not say callers no longer need their own guard');
});

test('pages.md section 8 lists the released refusal when no production approval is found', () => {
  const errors = section(read('docs', 'flows', 'pages.md'), /^## 8\. /).split('\n');
  assert.ok(errors.some((l) => /released/.test(l) && /approv/i.test(l)), 'no section 8 line about released and the approval');
});

// ---------- changelog ----------

test('CHANGELOG.md exists in Keep a Changelog style with a 3.4.0 entry', () => {
  assert.ok(fs.existsSync(rel('CHANGELOG.md')), 'CHANGELOG.md is missing');
  const log = read('CHANGELOG.md');
  assert.match(log, /^# Changelog/m);
  assert.match(log, /keepachangelog\.com/i);
  assert.match(log, /^## \[v?3\.4\.0\]/m);
});

test('CHANGELOG.md carries no local planning ids or .somi pointers', () => {
  const log = read('CHANGELOG.md');
  assert.doesNotMatch(log, /\.somi\b/);
  assert.doesNotMatch(log, /\bS[12]\b|\bF-[a-z]+\b/);
  assert.doesNotMatch(log, /\b(rogue|somi|homepage|master) [A-Z]?\d+\b/);
});
