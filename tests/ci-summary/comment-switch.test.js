// The summary_comment switch: ci-summary's `comment` input, read by
// render.js as CI_SUMMARY_COMMENT, and the three workflows' mapping of it.
//
// Run locally with:  node --test tests/ci-summary/comment-switch.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const { main } = require(path.join(ROOT, '.github', 'actions', 'ci-summary', 'lib', 'render.js'));
const { MARKER } = require(path.join(ROOT, '.github', 'actions', 'ci-summary', 'lib', 'body.js'));

const NEEDS = { setup: { result: 'success', outputs: {} }, test: { result: 'success', outputs: { lines_pct: '80.0', branches_pct: '75.0' } } };
const NOTE = 'The pull request comment is turned off (summary_comment: false).';

function step({ comment, event = 'pull_request' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-summary-switch-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { sha: 'a'.repeat(40) } } }));
  const env = {
    CI_SUMMARY_NEEDS: JSON.stringify(NEEDS),
    CI_SUMMARY_INPUTS: '{}',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: event,
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
    GITHUB_OUTPUT: path.join(dir, 'output'),
    RUNNER_TEMP: dir,
  };
  if (comment !== undefined) env.CI_SUMMARY_COMMENT = comment;
  const writes = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  const before = process.exitCode;
  try {
    main(env);
  } finally {
    process.stdout.write = original;
  }
  const code = process.exitCode;
  process.exitCode = before;
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return { code, stdout: writes.join(''), summary: read(env.GITHUB_STEP_SUMMARY), output: read(env.GITHUB_OUTPUT) };
}

test('comment left out acts as true: no body in the job summary', () => {
  const r = step();
  assert.notEqual(r.code, 1);
  assert.match(r.output, /^conclusion=success$/m);
  assert.ok(!r.summary.includes(MARKER), r.summary);
});

test("comment 'true' on a pull request: the body stays out of the job summary", () => {
  const r = step({ comment: 'true' });
  assert.ok(!r.summary.includes(NOTE));
  assert.ok(!r.summary.includes(MARKER));
});

test("comment 'false' on a pull request: the note and the body go to the job summary", () => {
  const r = step({ comment: 'false' });
  assert.ok(r.summary.includes(NOTE), r.summary);
  assert.ok(r.summary.includes(MARKER), r.summary);
  assert.ok(r.summary.includes('### ✅ hashira CI passed'), r.summary);
});

test("comment 'false' on a push: nothing extra, since no comment would be written", () => {
  const r = step({ comment: 'false', event: 'push' });
  assert.ok(!r.summary.includes(NOTE));
});

for (const bad of ['', 'yes', 'TRUE', 'False', ' true', 'true\n']) {
  test(`comment ${JSON.stringify(bad)} fails the step with an error and writes no verdict`, () => {
    const r = step({ comment: bad });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /::error title=passed::ci-summary: comment must be 'true' or 'false'/);
    assert.equal(r.output, '');
  });
}
