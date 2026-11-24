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
const line = (text, name) => text.split('\n').find((l) => l.startsWith(`  - ${name}:`));

test('a scanner skipped by scan_disable says so', () => {
  assert.equal(line(body(needs()), 'codeql'), '  - codeql: skipped — disabled by scan_disable');
});

test('a scanner skipped for another reason gives that reason', () => {
  assert.equal(line(body(needs()), 'dependency-review'),
    '  - dependency-review: skipped — dependency-review requires GHAS on private repos');
});

test('a failed scanner gives its details', () => {
  assert.equal(line(body(needs()), 'osv'), '  - osv: fail — vulnerabilities found (see job log)');
});

test('a passing scanner shows no details', () => {
  assert.equal(line(body(needs()), 'gitleaks'), '  - gitleaks: pass');
});

test('without scan_summary the status stands alone', () => {
  const text = body(needs({ scan: { scan_summary: '' } }));
  assert.equal(line(text, 'codeql'), '  - codeql: skipped');
  assert.equal(line(text, 'osv'), '  - osv: fail');
});

test('a reason is stripped of control characters, escaped and cut at 100 characters', () => {
  const hostile = `osv\tran\t<img src=x>|\`x\`\u0007${'y'.repeat(200)}`;
  const text = line(body(needs({ scan: { scan_summary: hostile } })), 'osv');
  assert.ok(!/[<>|`\u0007]/.test(text.replace('  - osv: fail — ', '')), text);
  assert.ok(text.includes('&lt;img src=x&gt;&#124;&#96;x&#96;'), text);
  assert.ok(text.endsWith('...'), text);
  const reason = '<img src=x>|`x` ' + 'y'.repeat(100 - 16);
  assert.ok(text.length < `  - osv: fail — ${reason}...`.length + 40, text);
});

test('a reason exactly 100 characters long is not cut', () => {
  const reason = 'r'.repeat(100);
  assert.equal(line(body(needs({ scan: { scan_summary: `osv\tran\t${reason}` } })), 'osv'), `  - osv: fail — ${reason}`);
});

test('a reason 101 characters long is cut', () => {
  const text = line(body(needs({ scan: { scan_summary: `osv\tran\t${'r'.repeat(101)}` } })), 'osv');
  assert.equal(text, `  - osv: fail — ${'r'.repeat(100)}...`);
});

test('an unknown scanner name in scan_summary is ignored', () => {
  const text = body(needs({ scan: { scan_summary: 'evil\tran\tinjected' } }));
  assert.ok(!text.includes('injected'));
});

test('a coverage report that measured no file says no coverage data', () => {
  const text = body(needs({ test: { lines_pct: '0.0', branches_pct: '0.0', coverage_files: '0' } }));
  assert.ok(text.includes('- test: pass, no coverage data'), text);
  assert.ok(!text.includes('0.0%'), text);
});

test('a coverage report that measured files shows the percentages', () => {
  const text = body(needs({ test: { lines_pct: '0.0', branches_pct: '0.0', coverage_files: '3' } }));
  assert.ok(text.includes('- test: pass, line coverage 0.0%, branch coverage 0.0%'), text);
});

test('without coverage_files the percentages still show', () => {
  assert.ok(body(needs()).includes('- test: pass, line coverage 80.0%, branch coverage 75.0%'));
});

test('the failing header names only the jobs, not their results', () => {
  const text = body(needs({ gate: 'failure' }));
  assert.ok(text.includes('\n\nFailing: quality-gate\n'), text);
  assert.ok(!text.includes('Failing: quality-gate: failure'), text);
});

test('several failing jobs are listed comma-separated', () => {
  const n = needs({ gate: 'failure' });
  n.test = { result: 'failure', outputs: {} };
  assert.ok(body(n).includes('\n\nFailing: quality-gate, test\n'));
});
