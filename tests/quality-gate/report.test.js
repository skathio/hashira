// Unit tests for quality-gate/lib/report.js: reading SoMi's report, the
// verdict for each way a run can end, the summary table and the annotations.
//
// Run locally with:  node --test tests/quality-gate/report.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  escapeCell, escapeProperty, parseReport, interpret, renderSummary, annotations,
} = require(path.join(__dirname, '..', '..', '.github', 'actions', 'quality-gate', 'lib', 'report.js'));

const VIOLATION = { rule: 'cognitive', file: 'src/a.js', line: 12, value: 21, limit: 15 };
const report = (over = {}) => JSON.stringify({ ok: true, violations: [], unanalyzed: [], ...over });
const run = (over = {}) => ({ status: 0, signal: null, error: undefined, stdout: report(), stderr: '', timeoutSeconds: 300, ...over });
const OPTS = { level: 'strict', base: 'a'.repeat(40) };

test('a clean report passes', () => {
  const v = interpret(run());
  assert.equal(v.passed, true);
  assert.equal(v.cause, 'no violations');
});

test('a reported violation fails and is counted', () => {
  const v = interpret(run({ status: 1, stdout: report({ ok: false, violations: [VIOLATION] }) }));
  assert.equal(v.passed, false);
  assert.equal(v.cause, 'SoMi reported 1 violation');
  assert.deepEqual(v.report.violations, [VIOLATION]);
});

test('exit 0 with a failing report still fails closed', () => {
  const v = interpret(run({ status: 0, stdout: report({ ok: false, violations: [VIOLATION] }) }));
  assert.equal(v.passed, false);
  assert.match(v.cause, /^SoMi crashed/);
});

test('a crash with an unreadable report fails with its exit code and stderr', () => {
  const v = interpret(run({ status: 70, stdout: '', stderr: 'TypeError: boom' }));
  assert.equal(v.passed, false);
  assert.equal(v.cause, 'SoMi crashed: it exited with code 70 without a readable report');
  assert.match(renderSummary(v, OPTS), /TypeError: boom/);
});

test('a run killed by a signal fails', () => {
  const v = interpret(run({ status: null, signal: 'SIGSEGV' }));
  assert.equal(v.cause, 'SoMi crashed: it was killed by SIGSEGV');
});

test('a timeout fails and names the time allowed', () => {
  const error = Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const v = interpret(run({ status: null, signal: 'SIGKILL', error, timeoutSeconds: 300 }));
  assert.equal(v.passed, false);
  assert.equal(v.cause, 'SoMi timed out: it did not finish within 300 s');
});

test('a spawn error fails', () => {
  const v = interpret(run({ status: null, error: new Error('spawn ENOENT') }));
  assert.equal(v.cause, 'SoMi could not run: spawn ENOENT');
});

test('parseReport rejects non-JSON and the wrong shape', () => {
  assert.equal(parseReport('not json'), null);
  assert.equal(parseReport('{"ok":"yes","violations":[]}'), null);
  assert.equal(parseReport('{"ok":true}'), null);
  assert.deepEqual(parseReport('{"ok":true,"violations":[]}').unanalyzed, []);
});

test('the summary has a violations table with rule, file, line, value and limit', () => {
  const v = interpret(run({ status: 1, stdout: report({ ok: false, violations: [VIOLATION] }) }));
  const md = renderSummary(v, OPTS);
  assert.match(md, /\*\*Failed:\*\* SoMi reported 1 violation/);
  assert.match(md, /\| Rule \| File \| Line \| Value \| Limit \|/);
  assert.match(md, /\| cognitive \| src\/a\.js \| 12 \| 21 \| 15 \|/);
});

test('unanalyzed files are listed and do not fail the gate', () => {
  const v = interpret(run({ stdout: report({ unanalyzed: [{ file: 'src/deep.js', reason: 'nested too deeply' }] }) }));
  assert.equal(v.passed, true);
  const md = renderSummary(v, OPTS);
  assert.match(md, /### Unanalyzed files/);
  assert.match(md, /- src\/deep\.js: nested too deeply/);
});

test('the table is bounded and says how many rows it left out', () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ ...VIOLATION, line: i + 1 }));
  const md = renderSummary(interpret(run({ status: 1, stdout: report({ ok: false, violations: many }) })), OPTS);
  assert.equal(md.split('\n').filter((l) => l.startsWith('| cognitive')).length, 100);
  assert.match(md, /50 more not shown\./);
});

test('cells from the pull request are escaped', () => {
  assert.equal(escapeCell('a|b<script>`x`\n'), 'a&#124;b&lt;script&gt;&#96;x&#96; ');
  assert.equal(escapeCell('x'.repeat(250)).length, 203);
});

test('annotations point at the file and line of each violation', () => {
  assert.deepEqual(annotations({ violations: [VIOLATION] }), [
    '::error file=src/a.js,line=12,title=SoMi cognitive::cognitive: 21 is over the limit of 15',
  ]);
});

test('annotations escape workflow-command characters and skip unlocated findings', () => {
  const odd = { rule: 'clone', file: 'a,b:c%.js', line: 3, value: '1\n::stop', limit: 0 };
  const lines = annotations({ violations: [odd, { rule: 'file', file: 'x.js', line: 0 }, { rule: 'r', line: 4 }] });
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '::error file=a%2Cb%3Ac%25.js,line=3,title=SoMi clone::clone: 1%0A::stop is over the limit of 0');
  assert.equal(escapeProperty('a\r'), 'a%0D');
});

test('annotations are bounded and absent without a report', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ ...VIOLATION, line: i + 1 }));
  assert.equal(annotations({ violations: many }).length, 50);
  assert.deepEqual(annotations(null), []);
});

test('a skipped file is named in the cause and listed in the summary', () => {
  const v = interpret(run({ stdout: report({ skipped: [{ file: 'src/gen.js', reason: 'generated marker' }] }) }));
  assert.equal(v.passed, true);
  assert.equal(v.cause, 'no violations in scored files, 1 file not scored (listed below)');
  const md = renderSummary(v, OPTS);
  assert.match(md, /### Files not scored/);
  assert.match(md, /- src\/gen\.js: generated marker/);
});

test('a skipped file name is escaped in the summary', () => {
  const v = interpret(run({ stdout: report({ skipped: [{ file: 'a|<b>.js', reason: 'minified' }] }) }));
  assert.match(renderSummary(v, OPTS), /a&#124;&lt;b&gt;\.js/);
});

test('a report without skipped, or with a non-array skipped, lists none', () => {
  assert.deepEqual(parseReport('{"ok":true,"violations":[]}').skipped, []);
  assert.deepEqual(parseReport('{"ok":true,"violations":[],"skipped":"x"}').skipped, []);
  assert.doesNotMatch(renderSummary(interpret(run()), OPTS), /Files not scored/);
});

test('more than 100 skipped files are capped with a count', () => {
  const skipped = Array.from({ length: 101 }, (_, i) => ({ file: `g${i}.js`, reason: 'generated' }));
  const md = renderSummary(interpret(run({ stdout: report({ skipped }) })), OPTS);
  assert.match(md, /1 more not shown\./);
  assert.doesNotMatch(md, /g100\.js/);
});

const EXEMPTION = { rule: 'cognitive', file: 'src/b.js', line: 3, name: 'over', reason: 'reviewed elsewhere', expires: '2026-12-20' };

test('a waived limit is named in the cause and listed in the summary', () => {
  const v = interpret(run({ stdout: report({ exemptions: [EXEMPTION] }) }));
  assert.equal(v.passed, true);
  assert.equal(v.cause, 'no violations in scored files, 1 limit waived by an allow comment (listed below)');
  const md = renderSummary(v, OPTS);
  assert.match(md, /### Waived by an allow comment/);
  assert.match(md, /\| cognitive \| src\/b\.js \| 3 \| reviewed elsewhere \| 2026-12-20 \|/);
});

test('waived limits and skipped files are both named in the cause', () => {
  const v = interpret(run({ stdout: report({ exemptions: [EXEMPTION, EXEMPTION], skipped: [{ file: 'g.js', reason: 'generated' }] }) }));
  assert.equal(v.cause, 'no violations in scored files, 2 limits waived by an allow comment, 1 file not scored (listed below)');
});

test('a waived limit gets a warning annotation on its line, after the errors', () => {
  const r = parseReport(report({ ok: false, violations: [VIOLATION], exemptions: [EXEMPTION] }));
  const lines = annotations(r);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^::error file=src\/a\.js,line=12,/);
  assert.equal(lines[1], '::warning file=src/b.js,line=3,title=SoMi cognitive waived::cognitive waived until 2026-12-20: reviewed elsewhere');
});

test('an exemption reason cannot inject a workflow command or break the table', () => {
  const evil = { ...EXEMPTION, reason: 'ok\n::add-mask::x | <b>', file: 'a,b:c.js' };
  const r = parseReport(report({ exemptions: [evil] }));
  const [line] = annotations(r);
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /file=a%2Cb%3Ac\.js/);
  assert.match(line, /ok%0A::add-mask::x/);
  assert.match(renderSummary(interpret(run({ stdout: report({ exemptions: [evil] }) })), OPTS), /ok ::add-mask::x &#124; &lt;b&gt;/);
});

test('a report without exemptions, or with a non-array one, lists none', () => {
  assert.deepEqual(parseReport('{"ok":true,"violations":[]}').exemptions, []);
  assert.deepEqual(parseReport('{"ok":true,"violations":[],"exemptions":{}}').exemptions, []);
  assert.doesNotMatch(renderSummary(interpret(run()), OPTS), /Waived/);
});

test('annotations stop at 50 even with many waived limits', () => {
  const r = parseReport(report({ exemptions: Array.from({ length: 60 }, (_, i) => ({ ...EXEMPTION, line: i + 1 })) }));
  assert.equal(annotations(r).length, 50);
});
