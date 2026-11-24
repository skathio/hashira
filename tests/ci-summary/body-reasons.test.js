// Unit tests for ci-summary/lib/body.js: why a scanner was skipped or failed,
// a coverage report that measured no file, and the failing-jobs header.
//
// Run locally with:  node --test tests/ci-summary/body-reasons.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { renderBody } = require(path.join(__dirname, '..', '..', '.github', 'actions', 'ci-summary', 'lib', 'body.js'));

const EVENT = { pull_request: { head: { sha: 'a'.repeat(40) } }, repository: { html_url: 'https://github.com/o/r' } };
const VERDICTS = 'codeql\tskipped\nosv\tfail\ngitleaks\tpass\ndependency-review\tskipped\nactionlint\tskipped';
const SUMMARY = [
  'codeql\tskipped\tconsumer disabled',
  'osv\tran\tvulnerabilities found (see job log)',
  'gitleaks\tran\tno leaks found',
  'dependency-review\tskipped\tdependency-review requires GHAS on private repos',
  'actionlint\tskipped\tconsumer disabled',
].join('\n');

function needs({ scan = {}, test: testOutputs = { lines_pct: '80.0', branches_pct: '75.0' }, gate = 'success' } = {}) {
  return {
    setup: { result: 'success', outputs: {} },
    'quality-gate': { result: gate, outputs: { result: gate === 'success' ? 'pass' : 'fail', violations: gate === 'success' ? '0' : '2' } },
    'scan-suite': { result: 'success', outputs: { verdicts: VERDICTS, scan_summary: SUMMARY, ...scan } },
    test: { result: 'success', outputs: testOutputs },
  };
}

const body = (n) => renderBody({ needs: n, inputs: { quality_gate: true }, event: EVENT, runUrl: 'https://github.com/o/r/actions/runs/1' });
const row = (text, name) => text.split('\n').find((l) => l.includes(`| **${name}** |`));
const skippedLine = (text) => text.split('\n').find((l) => l.startsWith('⏭️ **Skipped:**'));

test('scanners skipped by scan_disable are grouped on the skipped line', () => {
  assert.ok(skippedLine(body(needs())).includes('CodeQL, actionlint (disabled by `scan_disable`)'), body(needs()));
});

test('a scanner skipped for another reason gives that reason', () => {
  assert.ok(skippedLine(body(needs())).includes('Dependency review (dependency-review requires GHAS on private repos)'));
});

test('a skipped scanner has no table row', () => {
  assert.equal(row(body(needs()), 'CodeQL'), undefined);
});

test('a failed scanner gives its details', () => {
  assert.equal(row(body(needs()), 'OSV'), '| ❌ | **OSV** | Failed · vulnerabilities found (see job log) |');
});

test('a passing scanner shows only Passed', () => {
  assert.equal(row(body(needs()), 'gitleaks'), '| ✅ | **gitleaks** | Passed |');
});

test('without scan_summary the status stands alone', () => {
  const text = body(needs({ scan: { scan_summary: '' } }));
  assert.ok(skippedLine(text).includes('CodeQL, Dependency review, actionlint'), text);
  assert.ok(!skippedLine(text).includes('('), text);
  assert.equal(row(text, 'OSV'), '| ❌ | **OSV** | Failed |');
});

test('a reason is stripped of control characters, escaped and cut at 100 characters', () => {
  const hostile = `osv\tran\t<img src=x>|\`x\`\u0007${'y'.repeat(200)}`;
  const text = row(body(needs({ scan: { scan_summary: hostile } })), 'OSV');
  const detail = text.replace('| ❌ | **OSV** | Failed · ', '').replace(/ \|$/, '');
  assert.ok(!/[<>|`\u0007]/.test(detail), text);
  assert.ok(detail.includes('&lt;img src=x&gt;&#124;&#96;x&#96;'), text);
  assert.ok(detail.endsWith('...'), text);
});

test('a reason exactly 100 characters long is not cut', () => {
  const reason = 'r'.repeat(100);
  assert.equal(row(body(needs({ scan: { scan_summary: `osv\tran\t${reason}` } })), 'OSV'), `| ❌ | **OSV** | Failed · ${reason} |`);
});

test('a reason 101 characters long is cut', () => {
  assert.equal(row(body(needs({ scan: { scan_summary: `osv\tran\t${'r'.repeat(101)}` } })), 'OSV'),
    `| ❌ | **OSV** | Failed · ${'r'.repeat(100)}... |`);
});

test('an unknown scanner name in scan_summary is ignored', () => {
  assert.ok(!body(needs({ scan: { scan_summary: 'evil\tran\tinjected' } })).includes('injected'));
});

test('a coverage report that measured no file says no coverage data', () => {
  const text = body(needs({ test: { lines_pct: '0.0', branches_pct: '0.0', coverage_files: '0' } }));
  assert.equal(row(text, 'Tests'), '| ✅ | **Tests** | Passed · no coverage data |');
  assert.ok(!text.includes('0.0%'), text);
});

test('a coverage report that measured files shows the percentages', () => {
  const text = body(needs({ test: { lines_pct: '0.0', branches_pct: '0.0', coverage_files: '3' } }));
  assert.equal(row(text, 'Tests'), '| ✅ | **Tests** | Passed · 0.0% lines · 0.0% branches |');
});

test('without coverage_files the percentages still show', () => {
  assert.equal(row(body(needs()), 'Tests'), '| ✅ | **Tests** | Passed · 80.0% lines · 75.0% branches |');
});

test('the failing header names only the jobs, not their results', () => {
  const text = body(needs({ gate: 'failure' }));
  assert.ok(text.includes('### ❌ hashira CI failed\n\n**Failing:** `quality-gate`\n'), text);
});

test('several failing jobs are listed comma-separated', () => {
  const n = needs({ gate: 'failure' });
  n.test = { result: 'failure', outputs: {} };
  assert.ok(body(n).includes('**Failing:** `quality-gate`, `test`\n'));
});

test('failed rows come before passed rows', () => {
  const lines = body(needs({ gate: 'failure' })).split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| |'));
  const firstPass = lines.findIndex((l) => l.startsWith('| ✅'));
  const lastFail = lines.map((l) => l.startsWith('| ❌')).lastIndexOf(true);
  assert.ok(lastFail < firstPass, lines.join('\n'));
});

test('a passing run has the passed headline and no failing line', () => {
  const text = body(needs());
  assert.ok(text.includes('### ✅ hashira CI passed\n'), text);
  assert.ok(!text.includes('**Failing:**'), text);
});
