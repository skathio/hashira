// Edge cases of ci-summary/lib/verdict.js: how a documented skip is
// recognised when an input is missing, empty, null or a string, and how the
// summary lines treat unexpected job data. Missing or unclear values fail
// closed: a skip passes only when the input that explains it is clearly set
// that way, mirroring the `if:` that skips the job in the CI workflows.
//
// Run locally with:  node --test tests/ci-summary/verdict-edges.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { evaluate } = require(path.join(__dirname, '..', '..', '.github', 'actions', 'ci-summary', 'lib', 'verdict.js'));

function skipped(job) {
  return { [job]: { result: 'skipped', outputs: {} } };
}

// --- quality-gate: only an explicit false explains the skip ------------------

test("quality_gate as the string 'false' is a documented skip", () => {
  const out = evaluate({ needs: skipped('quality-gate'), inputs: { quality_gate: 'false' }, event: {} });
  assert.equal(out.conclusion, 'success');
});

for (const [label, value] of [['left out', undefined], ['null', null], ['empty', ''], ["the string 'true'", 'true'], ['0', 0]]) {
  test(`quality_gate ${label}: a skipped quality-gate fails`, () => {
    const inputs = value === undefined ? {} : { quality_gate: value };
    const out = evaluate({ needs: skipped('quality-gate'), inputs, event: {} });
    assert.equal(out.conclusion, 'failure');
  });
}

// --- version: bump counts as set when it is a non-empty value ----------------

for (const [label, inputs, event] of [
  ['both left out', {}, {}],
  ['event without inputs', { bump: '' }, { inputs: null }],
  ['null values', { bump: null }, { inputs: { bump: null } }],
  ['no inputs or event at all', undefined, undefined],
]) {
  test(`bump ${label}: a skipped version is documented`, () => {
    const out = evaluate({ needs: skipped('version'), inputs, event });
    assert.equal(out.conclusion, 'success');
  });
}

test("bump of only whitespace counts as set, as the workflow's != '' does", () => {
  const out = evaluate({ needs: skipped('version'), inputs: { bump: ' ' }, event: {} });
  assert.equal(out.conclusion, 'failure');
});

// --- unexpected job data fails closed ----------------------------------------

for (const [label, data] of [['no result', { outputs: {} }], ['null job', null], ['unknown result', { result: 'neutral' }]]) {
  test(`a job with ${label} fails passed and still gets a line`, () => {
    const out = evaluate({ needs: { setup: data }, inputs: {}, event: {} });
    assert.equal(out.conclusion, 'failure');
    assert.equal(out.lines.length, 1);
    assert.match(out.lines[0], /setup/);
  });
}

test('control characters in a job id or result never reach a summary line', () => {
  const out = evaluate({ needs: { 'a\nb': { result: 'success\r\n::error::x' } }, inputs: {}, event: {} });
  assert.equal(out.lines.length, 1);
  assert.doesNotMatch(out.lines[0], /[\r\n]/);
  assert.equal(out.conclusion, 'failure');
});

test('missing needs gives success with no lines', () => {
  assert.deepEqual(evaluate({}), { conclusion: 'success', lines: [] });
});
