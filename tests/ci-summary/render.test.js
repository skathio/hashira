// Unit tests for ci-summary/lib/render.js: the action's first step, which
// judges the needed jobs, writes one line per job to the job summary, and
// writes the comment body and the step outputs.
//
// Run locally with:  node --test tests/ci-summary/render.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require(path.join(__dirname, '..', '..', '.github', 'actions', 'ci-summary', 'lib', 'render.js'));

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const ALL_GREEN = {
  setup: { result: 'success', outputs: {} },
  test: { result: 'success', outputs: { lines_pct: '80.0', branches_pct: '75.0' } },
  'scan-suite': { result: 'success', outputs: { verdicts: 'osv\tpass\ncodeql\tskipped' } },
  'quality-gate': { result: 'success', outputs: { result: 'pass', violations: '0' } },
};

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-summary-render-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function render({ needs = ALL_GREEN, inputs = {}, event = { pull_request: { head: { sha: HEAD } } }, over = {} } = {}) {
  const dir = scratch();
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(event));
  const env = {
    CI_SUMMARY_NEEDS: JSON.stringify(needs),
    CI_SUMMARY_INPUTS: JSON.stringify(inputs),
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'acme/widget',
    GITHUB_RUN_ID: '4242',
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
    GITHUB_OUTPUT: path.join(dir, 'output'),
    RUNNER_TEMP: dir,
    ...over,
  };
  const result = run(env);
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  const outputs = Object.fromEntries(read(env.GITHUB_OUTPUT).split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  return { result, summary: read(env.GITHUB_STEP_SUMMARY), outputs, dir };
}

test('all needed jobs green: conclusion success, one summary line per job', () => {
  const { result, summary, outputs } = render();
  assert.equal(result.conclusion, 'success');
  assert.equal(outputs.conclusion, 'success');
  for (const job of Object.keys(ALL_GREEN)) assert.match(summary, new RegExp(`^- ok ${job}: success$`, 'm'));
});

test('a failed job: conclusion failure and a FAIL line naming it', () => {
  const needs = { ...ALL_GREEN, 'scan-suite': { result: 'failure', outputs: {} } };
  const { result, summary, outputs } = render({ needs });
  assert.equal(result.conclusion, 'failure');
  assert.equal(outputs.conclusion, 'failure');
  assert.match(summary, /^- FAIL scan-suite: failure$/m);
});

test('a documented skip passes and its summary line names the input', () => {
  const needs = { ...ALL_GREEN, 'quality-gate': { result: 'skipped', outputs: {} } };
  const { result, summary } = render({ needs, inputs: { quality_gate: false } });
  assert.equal(result.conclusion, 'success');
  assert.match(summary, /^- ok quality-gate: skipped \(documented skip: inputs\.quality_gate is false\)$/m);
});

test('a bump set by workflow_dispatch makes a skipped version job fail', () => {
  const needs = { ...ALL_GREEN, version: { result: 'skipped', outputs: {} } };
  assert.equal(render({ needs }).result.conclusion, 'success');
  assert.equal(render({ needs, event: { inputs: { bump: 'patch' } } }).result.conclusion, 'failure');
});

test('the body file holds the comment body, starting with the marker and naming the run', () => {
  const { result, outputs } = render();
  const body = fs.readFileSync(outputs.body_file, 'utf8');
  assert.equal(body, result.body);
  assert.ok(body.startsWith('<!-- hashira:ci-summary -->'));
  assert.match(body, /https:\/\/github\.com\/acme\/widget\/actions\/runs\/4242/);
  assert.match(body, /a1b2c3d/);
});

test('lib_dir points at the directory holding comment.js', () => {
  const { outputs } = render();
  assert.ok(fs.existsSync(path.join(outputs.lib_dir, 'comment.js')));
});

test('an unreadable event file leaves the event empty and still renders', () => {
  const { result } = render({ over: { GITHUB_EVENT_PATH: path.join(os.tmpdir(), 'no-such-event.json') } });
  assert.equal(result.conclusion, 'success');
  assert.match(result.body, /Head commit unknown/);
});

test('needs left out is an empty object: nothing failed, nothing listed', () => {
  const { result, summary } = render({ over: { CI_SUMMARY_NEEDS: undefined } });
  assert.equal(result.conclusion, 'success');
  assert.doesNotMatch(summary, /^- /m);
});

for (const [what, text] of [['not JSON', '{oops'], ['an array', '[]'], ['a string', '"x"'], ['null', 'null']]) {
  test(`needs that is ${what} throws, so the step and the job fail`, () => {
    assert.throws(() => render({ over: { CI_SUMMARY_NEEDS: text } }), /ci-summary: the needs context/);
  });
  test(`inputs that is ${what} throws`, () => {
    assert.throws(() => render({ over: { CI_SUMMARY_INPUTS: text } }), /ci-summary: the inputs context/);
  });
}

test('without a run URL the body still renders', () => {
  const { result } = render({ over: { GITHUB_RUN_ID: '' } });
  assert.match(result.body, /workflow run: unknown/);
});
