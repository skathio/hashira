// Unit tests for quality-gate/lib/run-gate.js: the pull-request-only skip,
// and each way `check` ends, run against a throwaway git repo and a fake
// SoMi CLI that prints a canned report, crashes or hangs.
//
// Run locally with:  node --test tests/quality-gate/run-gate.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const gate = require(path.join(__dirname, '..', '..', '.github', 'actions', 'quality-gate', 'lib', 'run-gate.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gate-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const repo = path.join(tmp, 'repo');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
fs.mkdirSync(repo);
git('init', '-q');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'test');
fs.writeFileSync(path.join(repo, 'a.js'), 'module.exports = 1;\n');
git('add', '.');
git('commit', '-qm', 'base');
const BASE = git('rev-parse', 'HEAD');

// A fake SoMi: records how it was called, then does what its script says.
let fakes = 0;
function fakeCli(body) {
  const file = path.join(tmp, `fake-${fakes += 1}.js`);
  const record = path.join(tmp, `called-${fakes}.json`);
  fs.writeFileSync(file, `
    const fs = require('fs');
    const cfg = fs.readFileSync(process.env.XDG_CONFIG_HOME + '/somi/config.json', 'utf8');
    fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cfg: JSON.parse(cfg) }));
    ${body}`);
  return { cli: file, record };
}
const prints = (rep, code) => `process.stdout.write(${JSON.stringify(JSON.stringify(rep))}); process.exitCode = ${code};`;

function runCheck(cli, over = {}) {
  const summary = path.join(tmp, `summary-${fakes}-${Math.random().toString(36).slice(2)}.md`);
  const logged = [];
  const code = gate.check({ env: { GITHUB_STEP_SUMMARY: summary }, cli, cwd: repo, base: BASE, level: 'strict', log: (l) => logged.push(l), ...over });
  const text = fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '';
  return { code, summary: text, logged };
}

function eventEnv(name) {
  const summary = path.join(tmp, `event-${name}.md`);
  const output = path.join(tmp, `event-${name}.out`);
  gate.decideEvent({ GITHUB_EVENT_NAME: name, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return { summary: read(summary), output: read(output) };
}

for (const name of ['push', 'workflow_dispatch']) {
  test(`a ${name} run is skipped with the skip line in the summary`, () => {
    const r = eventEnv(name);
    assert.equal(r.summary, 'skipped: quality gate runs on pull requests\n');
    assert.equal(r.output, 'run=false\n');
  });
}

test('a pull_request run is gated and writes no skip line', () => {
  const r = eventEnv('pull_request');
  assert.equal(r.summary, '');
  assert.equal(r.output, 'run=true\n');
  assert.equal(gate.main(['event'], { GITHUB_EVENT_NAME: 'push' }), 0);
});

test('a clean change passes and SoMi runs at PR scope against the base with the level', () => {
  const { cli, record } = fakeCli(prints({ ok: true, violations: [], unanalyzed: [] }, 0));
  const r = runCheck(cli, { level: 'standard' });
  assert.equal(r.code, 0);
  assert.match(r.summary, /\*\*Passed:\*\* no violations/);
  const called = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.deepEqual(called.argv, ['quality', '--scope', 'pr', '--from', BASE]);
  assert.deepEqual(called.cfg, { quality: { level: 'standard' } });
});

test('a violation fails the job, fills the table and annotates the line', () => {
  const v = { rule: 'lines', file: 'a.js', line: 1, value: 70, limit: 60 };
  const { cli } = fakeCli(prints({ ok: false, violations: [v], unanalyzed: [] }, 1));
  const r = runCheck(cli);
  assert.equal(r.code, 1);
  assert.match(r.summary, /\| lines \| a\.js \| 1 \| 70 \| 60 \|/);
  assert.ok(r.logged.includes('::error file=a.js,line=1,title=SoMi lines::lines: 70 is over the limit of 60'));
});

test('unanalyzed files are listed and the gate still passes', () => {
  const { cli } = fakeCli(prints({ ok: true, violations: [], unanalyzed: [{ file: 'big.js', reason: 'parser timed out' }] }, 0));
  const r = runCheck(cli);
  assert.equal(r.code, 0);
  assert.match(r.summary, /- big\.js: parser timed out/);
});

test('a SoMi crash fails closed with the cause in the summary', () => {
  const { cli } = fakeCli("process.stderr.write('somi: boom'); process.exit(70);");
  const r = runCheck(cli);
  assert.equal(r.code, 1);
  assert.match(r.summary, /SoMi crashed: it exited with code 70/);
  assert.match(r.summary, /somi: boom/);
});

test('a missing CLI, as after a failed install, fails closed', () => {
  const r = runCheck(path.join(tmp, 'no-such-somi.mjs'));
  assert.equal(r.code, 1);
  assert.match(r.summary, /SoMi crashed: it exited with code 1/);
});

test('SoMi running past its time fails closed as a timeout', () => {
  const { cli } = fakeCli('setTimeout(() => {}, 60000);');
  const r = runCheck(cli, { timeoutSeconds: 1 });
  assert.equal(r.code, 1);
  assert.match(r.summary, /SoMi timed out: it did not finish within 1 s/);
});

test('a base commit that is not in the checkout and cannot be fetched fails closed', () => {
  const { cli, record } = fakeCli(prints({ ok: true, violations: [] }, 0));
  const r = runCheck(cli, { base: 'f'.repeat(40) });
  assert.equal(r.code, 1);
  assert.match(r.summary, /missing base ref/);
  assert.equal(fs.existsSync(record), false, 'SoMi must not run without its base');
});

for (const base of ['', 'main', `${BASE}; rm -rf /`]) {
  test(`a base of ${JSON.stringify(base)} is refused as missing`, () => {
    const r = runCheck(fakeCli(prints({ ok: true, violations: [] }, 0)).cli, { base });
    assert.equal(r.code, 1);
    assert.match(r.summary, /missing base ref/);
  });
}

for (const level of ['', 'loose', 'Strict', undefined]) {
  test(`a level of ${JSON.stringify(level)} fails naming the three allowed values`, () => {
    const r = runCheck(fakeCli(prints({ ok: true, violations: [] }, 0)).cli, { level });
    assert.equal(r.code, 1);
    assert.match(r.summary, /is not one of strict, standard, relaxed/);
  });
}

test('main refuses an unknown command', () => {
  assert.throws(() => gate.main(['nope'], {}), /takes event or check/);
});
