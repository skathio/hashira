// Unit tests for ci-summary/lib/verdict.js: the verdict of the aggregate
// `passed` job and its one-line-per-job summary.
//
// The contract: `evaluate({ needs, inputs, event })` takes the `needs`,
// `inputs` and `github.event` contexts as the workflow sees them
// (`toJSON(needs)` is `{ <job-id>: { result, outputs } }`) and returns
// `{ conclusion, lines }`. `conclusion` is 'failure' when any needed job's
// result is failure or cancelled, or skipped other than by a documented skip,
// and 'success' otherwise. The documented skips are `version` when no bump is
// set (neither `inputs.bump` nor `github.event.inputs.bump`) and
// `quality-gate` when `inputs.quality_gate` is false. `lines` holds one line
// per needed job: its name, its result, and for a documented skip the input
// that caused it.
//
// Run locally with:  node --test tests/ci-summary/verdict.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const MODULE = path.join(REPO, '.github', 'actions', 'ci-summary', 'lib', 'verdict.js');

// Loaded per test so a missing module fails each test with its reason
// instead of stopping the file before any test runs.
function evaluate(args) {
  return require(MODULE).evaluate(args);
}

const NO_BUMP = { inputs: { bump: '', quality_gate: true }, event: {} };

function needsOf(results) {
  const needs = {};
  for (const [job, result] of Object.entries(results)) needs[job] = { result, outputs: {} };
  return needs;
}

function lineFor(lines, job) {
  // A job id can be a prefix of another (`test` in `run-tests`), so match the
  // name as a whole word.
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${job.replace(/-/g, '\\-')}([^A-Za-z0-9_-]|$)`);
  const found = lines.filter((line) => re.test(line));
  assert.equal(found.length, 1, `expected exactly one line naming ${job}, got ${JSON.stringify(lines)}`);
  return found[0];
}

const NPM_JOBS = ['setup', 'version', 'lint', 'test', 'scan-suite', 'quality-gate'];
const NUGET_JOBS = ['setup', 'version', 'restore-build', 'test', 'scan-suite', 'quality-gate'];
const STATIC_JOBS = ['setup', 'build-and-upload', 'test', 'scan-suite', 'quality-gate'];

function allSuccess(jobs) {
  return needsOf(Object.fromEntries(jobs.map((j) => [j, 'success'])));
}

// --- Otherwise `passed` succeeds ---------------------------------------------

for (const [flow, jobs] of [['npm', NPM_JOBS], ['nuget', NUGET_JOBS], ['static-webapp', STATIC_JOBS]]) {
  test(`${flow}: every needed job succeeding gives success`, () => {
    const out = evaluate({ needs: allSuccess(jobs), ...NO_BUMP });
    assert.equal(out.conclusion, 'success');
  });
}

test('no needed jobs at all gives success and no lines', () => {
  const out = evaluate({ needs: {}, ...NO_BUMP });
  assert.equal(out.conclusion, 'success');
  assert.deepEqual(out.lines, []);
});

test('a single successful job gives success and one line', () => {
  const out = evaluate({ needs: needsOf({ setup: 'success' }), ...NO_BUMP });
  assert.equal(out.conclusion, 'success');
  assert.equal(out.lines.length, 1);
});

// --- failure and cancelled fail ----------------------------------------------

for (const result of ['failure', 'cancelled']) {
  for (const job of NPM_JOBS) {
    test(`npm: ${job} ${result} fails passed`, () => {
      const needs = allSuccess(NPM_JOBS);
      needs[job].result = result;
      const out = evaluate({ needs, inputs: { bump: 'patch', quality_gate: true }, event: {} });
      assert.equal(out.conclusion, 'failure');
    });
  }

  test(`a single needed job that is ${result} fails passed`, () => {
    const out = evaluate({ needs: needsOf({ setup: result }), ...NO_BUMP });
    assert.equal(out.conclusion, 'failure');
  });
}

test('setup failing and everything after it skipped fails passed', () => {
  const needs = needsOf({
    setup: 'failure', version: 'skipped', lint: 'skipped', test: 'skipped',
    'scan-suite': 'skipped', 'quality-gate': 'skipped',
  });
  const out = evaluate({ needs, inputs: { bump: '', quality_gate: false }, event: {} });
  assert.equal(out.conclusion, 'failure');
});

test('a cancelled run (every job cancelled) fails passed', () => {
  const needs = needsOf(Object.fromEntries(STATIC_JOBS.map((j) => [j, 'cancelled'])));
  const out = evaluate({ needs, ...NO_BUMP });
  assert.equal(out.conclusion, 'failure');
});

test('a documented-skip job that failed still fails passed', () => {
  const needs = allSuccess(NPM_JOBS);
  needs['quality-gate'].result = 'failure';
  const out = evaluate({ needs, inputs: { bump: '', quality_gate: false }, event: {} });
  assert.equal(out.conclusion, 'failure');
});

test('version cancelled with no bump set still fails passed', () => {
  const needs = allSuccess(NUGET_JOBS);
  needs.version.result = 'cancelled';
  const out = evaluate({ needs, ...NO_BUMP });
  assert.equal(out.conclusion, 'failure');
});

// --- documented skips --------------------------------------------------------

test('version skipped with no bump set (neither input nor event) passes', () => {
  const needs = allSuccess(NPM_JOBS);
  needs.version.result = 'skipped';
  const out = evaluate({ needs, inputs: { bump: '', quality_gate: true }, event: { inputs: { bump: '' } } });
  assert.equal(out.conclusion, 'success');
});

test("version skipped with bump 'none' (the templates' no-release choice) passes", () => {
  for (const [inputs, event] of [[{ bump: '' }, { inputs: { bump: 'none' } }], [{ bump: 'none' }, { inputs: { bump: '' } }], [{ bump: 'none' }, { inputs: { bump: 'patch' } }]]) {
    const needs = allSuccess(NPM_JOBS);
    needs.version.result = 'skipped';
    const out = evaluate({ needs, inputs: { ...inputs, quality_gate: true }, event });
    assert.equal(out.conclusion, 'success', JSON.stringify({ inputs, event }));
  }
});

test("version skipped while the input is empty and the event's bump is 'patch' still fails passed", () => {
  const needs = allSuccess(NPM_JOBS);
  needs.version.result = 'skipped';
  assert.equal(evaluate({ needs, inputs: { bump: '', quality_gate: true }, event: { inputs: { bump: 'patch' } } }).conclusion, 'failure');
  assert.equal(evaluate({ needs, inputs: { bump: 'nonee', quality_gate: true }, event: {} }).conclusion, 'failure');
});

test('version skipped while inputs.bump is set fails passed', () => {
  const needs = allSuccess(NPM_JOBS);
  needs.version.result = 'skipped';
  const out = evaluate({ needs, inputs: { bump: 'minor', quality_gate: true }, event: {} });
  assert.equal(out.conclusion, 'failure');
});

test('version skipped while github.event.inputs.bump is set fails passed', () => {
  const needs = allSuccess(NUGET_JOBS);
  needs.version.result = 'skipped';
  const out = evaluate({ needs, inputs: { bump: '', quality_gate: true }, event: { inputs: { bump: 'patch' } } });
  assert.equal(out.conclusion, 'failure');
});

test('quality-gate skipped with inputs.quality_gate false passes', () => {
  const needs = allSuccess(STATIC_JOBS);
  needs['quality-gate'].result = 'skipped';
  const out = evaluate({ needs, inputs: { quality_gate: false }, event: {} });
  assert.equal(out.conclusion, 'success');
});

test('quality-gate skipped with inputs.quality_gate true fails passed', () => {
  const needs = allSuccess(STATIC_JOBS);
  needs['quality-gate'].result = 'skipped';
  const out = evaluate({ needs, inputs: { quality_gate: true }, event: {} });
  assert.equal(out.conclusion, 'failure');
});

test('both documented skips at once pass', () => {
  const needs = allSuccess(NUGET_JOBS);
  needs.version.result = 'skipped';
  needs['quality-gate'].result = 'skipped';
  const out = evaluate({ needs, inputs: { bump: '', quality_gate: false }, event: {} });
  assert.equal(out.conclusion, 'success');
});

// --- undocumented skips fail -------------------------------------------------

test("nuget: test skipped because restore-build failed fails passed", () => {
  const needs = allSuccess(NUGET_JOBS);
  needs['restore-build'].result = 'failure';
  needs.test.result = 'skipped';
  const out = evaluate({ needs, ...NO_BUMP });
  assert.equal(out.conclusion, 'failure');
});

for (const job of ['setup', 'lint', 'test', 'scan-suite', 'restore-build', 'build-and-upload']) {
  test(`${job} skipped (not a documented skip) fails passed`, () => {
    const needs = allSuccess([...new Set([...NPM_JOBS, ...NUGET_JOBS, ...STATIC_JOBS])]);
    needs[job].result = 'skipped';
    const out = evaluate({ needs, inputs: { bump: '', quality_gate: false }, event: {} });
    assert.equal(out.conclusion, 'failure');
  });
}

test('one undocumented skip among documented ones fails passed', () => {
  const needs = allSuccess(NPM_JOBS);
  needs.version.result = 'skipped';
  needs['quality-gate'].result = 'skipped';
  needs.lint.result = 'skipped';
  const out = evaluate({ needs, inputs: { bump: '', quality_gate: false }, event: {} });
  assert.equal(out.conclusion, 'failure');
});

// --- one summary line per needed job -----------------------------------------

test('one line per needed job, each naming the job and its result', () => {
  const results = {
    setup: 'success', version: 'skipped', lint: 'failure', test: 'cancelled',
    'scan-suite': 'success', 'quality-gate': 'skipped',
  };
  const out = evaluate({ needs: needsOf(results), inputs: { bump: '', quality_gate: false }, event: {} });
  assert.equal(out.lines.length, Object.keys(results).length);
  for (const [job, result] of Object.entries(results)) {
    assert.match(lineFor(out.lines, job), new RegExp(result));
  }
});

test('the version documented-skip line names the bump input', () => {
  const needs = allSuccess(NPM_JOBS);
  needs.version.result = 'skipped';
  const out = evaluate({ needs, ...NO_BUMP });
  const line = lineFor(out.lines, 'version');
  assert.match(line, /skipped/);
  assert.match(line, /bump/);
});

test('the quality-gate documented-skip line names the quality_gate input', () => {
  const needs = allSuccess(STATIC_JOBS);
  needs['quality-gate'].result = 'skipped';
  const out = evaluate({ needs, inputs: { quality_gate: false }, event: {} });
  const line = lineFor(out.lines, 'quality-gate');
  assert.match(line, /skipped/);
  assert.match(line, /quality_gate/);
});

test('lines are written for every job on a failing run too', () => {
  const needs = allSuccess(NUGET_JOBS);
  needs['restore-build'].result = 'failure';
  needs.test.result = 'skipped';
  const out = evaluate({ needs, ...NO_BUMP });
  assert.equal(out.lines.length, NUGET_JOBS.length);
  assert.match(lineFor(out.lines, 'restore-build'), /failure/);
  assert.match(lineFor(out.lines, 'test'), /skipped/);
});

// --- project convention: a new test gets a job in _self-ci.yml ---------------

test('_self-ci.yml runs this test file', () => {
  const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', '_self-ci.yml'), 'utf8');
  const runs = ci.split('\n').filter((line) => /node --test\b/.test(line) && line.includes('tests/ci-summary/verdict.test.js'));
  assert.ok(runs.length >= 1, '_self-ci.yml has no `node --test` line for tests/ci-summary/verdict.test.js');
});
