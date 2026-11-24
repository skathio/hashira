// Unit tests for ci-summary/lib/comment.js: the body of the one hashira
// summary comment on a pull request, and the writer that keeps it to one.
//
// The contract these tests hold the module to:
//   MARKER is '<!-- hashira:ci-summary -->'.
//   renderBody({ needs, inputs, event, runUrl }) returns the comment body.
//     `needs` is `toJSON(needs)` as verdict.js takes it, with the job outputs
//     that carry the data: quality-gate `result` and `violations`, scan-suite
//     `verdicts` (one `<name>\t<pass|fail|skipped>` line per scanner), test
//     `lines_pct` and `branches_pct`, and npm's lint `commitlint_result`
//     (`clean` or `findings`) and `commitlint_report`. A run without a `lint`
//     job (nuget, static-webapp) has no commitlint result.
//   writeComment({ github, context, core, body }) writes it, given the
//     `github`, `context` and `core` objects of actions/github-script. It
//     never throws and never sets the job's conclusion.
//
// Run locally with:  node --test tests/ci-summary/comment.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const MODULE = path.join(REPO, '.github', 'actions', 'ci-summary', 'lib', 'comment.js');

// Loaded per test so a missing module fails each test with its reason.
const load = () => require(MODULE);

const MARKER = '<!-- hashira:ci-summary -->';
const CAP = 60000;
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const NEWER = 'ffffeeee0000111122223333444455556666aaaa';
const RUN_URL = 'https://github.com/acme/widget/actions/runs/4242';
const SCANNERS = ['codeql', 'osv', 'gitleaks', 'dependency-review', 'actionlint'];
const BOT = 'github-actions[bot]';

function verdicts(status) {
  return SCANNERS.map((name) => `${name}\t${typeof status === 'string' ? status : status[name]}`).join('\n');
}

function npmNeeds(overrides = {}) {
  return applyOverrides({
    setup: { result: 'success', outputs: {} },
    version: { result: 'success', outputs: {} },
    lint: { result: 'success', outputs: { commitlint_result: 'clean', commitlint_report: '' } },
    test: { result: 'success', outputs: { lines_pct: '87.5', branches_pct: '61.25' } },
    'scan-suite': { result: 'success', outputs: { verdicts: verdicts('pass') } },
    'quality-gate': { result: 'success', outputs: { result: 'pass', violations: '0' } },
  }, overrides);
}

function applyOverrides(needs, overrides) {
  for (const [job, value] of Object.entries(overrides)) {
    if (value === undefined) delete needs[job];
    else needs[job] = { ...needs[job], ...value, outputs: { ...(needs[job] || {}).outputs, ...value.outputs } };
  }
  return needs;
}

function staticNeeds(overrides = {}) {
  const needs = npmNeeds();
  delete needs.lint;
  delete needs.version;
  needs['build-and-upload'] = { result: 'success', outputs: {} };
  return applyOverrides(needs, overrides);
}

const PR_EVENT = {
  pull_request: {
    number: 7,
    head: { sha: HEAD, repo: { full_name: 'acme/widget' } },
    base: { repo: { full_name: 'acme/widget' } },
    user: { login: 'octocat' },
  },
  repository: { full_name: 'acme/widget', html_url: 'https://github.com/acme/widget' },
};

function render(needs, inputs = { bump: 'patch', quality_gate: true }) {
  return load().renderBody({ needs, inputs, event: PR_EVENT, runUrl: RUN_URL });
}

// The lines of the body that name `pattern`; the field it shows must be on
// such a line, whatever the layout around it.
function lineWith(body, pattern) {
  const found = body.split('\n').filter((line) => pattern.test(line) && !line.includes(MARKER));
  assert.ok(found.length > 0, `expected a line matching ${pattern}, got:\n${body}`);
  return found.join('\n');
}

const scannerPattern = (name) => new RegExp(`(^|[^a-z-])${name}([^a-z-]|$)`, 'i');

// --- the marker --------------------------------------------------------------

test('MARKER is the hidden hashira:ci-summary marker', () => {
  assert.equal(load().MARKER, MARKER);
});

test('the body starts with the marker', () => {
  assert.ok(render(npmNeeds()).startsWith(MARKER));
});

// --- head commit and run link ------------------------------------------------

test('the body links the short SHA of pull_request.head.sha', () => {
  const body = render(npmNeeds());
  const links = [...body.matchAll(/\[`?([0-9a-f]+)`?\]\(([^)\s]+)\)/g)];
  const head = links.find(([, text, url]) => HEAD.startsWith(text) && text.length < 40 && url.includes(HEAD));
  assert.ok(head, `no link with a short SHA of ${HEAD} to that commit in:\n${body}`);
});

test('the body links the run', () => {
  assert.ok(render(npmNeeds()).includes(`(${RUN_URL})`));
});

// --- overall verdict ---------------------------------------------------------

test('the verdict shows a pass when every job succeeded', () => {
  const body = render(npmNeeds());
  assert.match(body, /pass|success/i);
  assert.doesNotMatch(body, /fail/i);
});

test('the verdict shows a failure when a job outside the listed fields failed', () => {
  // version is not a field of its own, so only the verdict can say "fail".
  assert.match(render(npmNeeds({ version: { result: 'failure' } })), /fail/i);
});

test('an undocumented skip shows a failing verdict', () => {
  const body = render(staticNeeds({ 'build-and-upload': { result: 'skipped' } }));
  assert.match(body, /fail/i);
});

// --- quality-gate ------------------------------------------------------------

const GATE = /quality[- ]gate/i;

test('quality-gate pass shows pass and a count of 0', () => {
  const line = lineWith(render(npmNeeds()), GATE);
  assert.match(line, /pass/i);
  assert.match(line, /(^|\D)0(\D|$)/);
});

test('quality-gate with one violation shows fail and the count 1', () => {
  const needs = npmNeeds({ 'quality-gate': { result: 'failure', outputs: { result: 'fail', violations: '1' } } });
  const line = lineWith(render(needs), GATE);
  assert.match(line, /fail/i);
  assert.match(line, /(^|\D)1(\D|$)/);
});

test('quality-gate with many violations shows fail and the count', () => {
  const needs = npmNeeds({ 'quality-gate': { result: 'failure', outputs: { result: 'fail', violations: '37' } } });
  const line = lineWith(render(needs), GATE);
  assert.match(line, /fail/i);
  assert.match(line, /(^|\D)37(\D|$)/);
});

test('quality-gate turned off by its input shows skipped, not pass', () => {
  const needs = npmNeeds({ 'quality-gate': { result: 'skipped', outputs: { result: 'skipped', violations: '0' } } });
  const line = lineWith(render(needs, { bump: 'patch', quality_gate: false }), GATE);
  assert.match(line, /skipped/i);
  assert.doesNotMatch(line, /pass/i);
});

test('quality-gate that never ran because setup failed does not show pass', () => {
  const needs = npmNeeds({ setup: { result: 'failure' }, 'quality-gate': { result: 'skipped', outputs: {} } });
  delete needs['quality-gate'].outputs.result;
  delete needs['quality-gate'].outputs.violations;
  const line = lineWith(render(needs), GATE);
  assert.doesNotMatch(line, /pass/i);
});

// --- scan-suite: five scanners x pass, fail, skipped -------------------------

for (const name of SCANNERS) {
  for (const status of ['pass', 'fail', 'skipped']) {
    test(`scan-suite ${name} ${status} shows ${status} on its line`, () => {
      const others = Object.fromEntries(SCANNERS.map((s) => [s, s === name ? status : 'pass']));
      const needs = npmNeeds({ 'scan-suite': { result: status === 'fail' ? 'failure' : 'success', outputs: { verdicts: verdicts(others) } } });
      const line = lineWith(render(needs), scannerPattern(name));
      assert.match(line, new RegExp(status, 'i'));
      for (const other of ['pass', 'fail', 'skipped'].filter((s) => s !== status)) {
        assert.doesNotMatch(line, new RegExp(other, 'i'));
      }
    });
  }
}

// --- test and coverage -------------------------------------------------------

test('test pass shows pass with line and branch coverage %', () => {
  const line = lineWith(render(npmNeeds()), /87\.5/);
  assert.match(line, /pass/i);
  assert.match(line, /61\.25/);
  assert.match(line, /%/);
});

test('test failure shows fail with its coverage', () => {
  const needs = npmNeeds({ test: { result: 'failure' } });
  const line = lineWith(render(needs), /87\.5/);
  assert.match(line, /fail/i);
});

test('missing coverage renders without undefined or NaN', () => {
  const needs = npmNeeds({ test: { result: 'success', outputs: {} } });
  delete needs.test.outputs.lines_pct;
  delete needs.test.outputs.branches_pct;
  const body = render(needs);
  assert.ok(body.startsWith(MARKER));
  assert.doesNotMatch(body, /undefined|NaN|null/);
});

// --- commitlint (npm only) ---------------------------------------------------

test('npm commitlint clean shows clean', () => {
  assert.match(lineWith(render(npmNeeds()), /commitlint/i), /clean/i);
});

test('npm commitlint findings show the report', () => {
  const report = 'subject may not be empty [subject-empty]';
  const needs = npmNeeds({ lint: { outputs: { commitlint_result: 'findings', commitlint_report: report } } });
  const body = render(needs);
  assert.ok(body.includes(report), body);
});

test('commitlint findings are warn-only: they do not fail the verdict', () => {
  const needs = npmNeeds({ lint: { outputs: { commitlint_result: 'findings', commitlint_report: 'x [type-empty]' } } });
  assert.doesNotMatch(render(needs).replace(/x \[type-empty\]/g, ''), /fail/i);
});

test('a run without a lint job shows no commitlint result', () => {
  assert.doesNotMatch(render(staticNeeds()), /commitlint/i);
});

// --- the 60,000-character cap ------------------------------------------------

function withReport(length) {
  const report = 'a'.repeat(length);
  return render(npmNeeds({ lint: { outputs: { commitlint_result: 'findings', commitlint_report: report } } }));
}

test('a short commitlint report is not truncated', () => {
  assert.doesNotMatch(withReport(10), /truncated/i);
});

test('a body exactly at the cap is not truncated', () => {
  const base = withReport(1).length;
  const body = withReport(CAP - base + 1);
  assert.equal(body.length, CAP);
  assert.doesNotMatch(body, /truncated/i);
});

test('a body one past the cap truncates the report with a note', () => {
  const base = withReport(1).length;
  const body = withReport(CAP - base + 2);
  assert.ok(body.length <= CAP, `body is ${body.length} characters`);
  assert.match(body, /truncated/i);
  assert.ok(body.startsWith(MARKER));
});

test('an over-long report is truncated first and the other fields stay', () => {
  const body = withReport(200000);
  assert.ok(body.length <= CAP, `body is ${body.length} characters`);
  assert.match(body, /truncated/i);
  assert.ok(body.includes(`(${RUN_URL})`));
  assert.match(lineWith(body, /87\.5/), /pass/i);
  for (const name of SCANNERS) assert.match(lineWith(body, scannerPattern(name)), /pass/i);
});

// --- writer: fakes for github-script's github, context and core --------------

function comment(id, login, body, createdAt) {
  return { id, user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' }, body, created_at: createdAt };
}

function fakeGithub({ comments = [], headSha = HEAD, fail = {} } = {}) {
  const calls = { create: [], update: [], remove: [], any: 0 };
  const state = comments.map((c) => ({ ...c }));
  let next = 9000;
  const guard = (name) => {
    calls.any += 1;
    if (fail[name]) throw Object.assign(new Error(`${name} failed`), { status: fail[name] });
  };
  const rest = {
    pulls: {
      get: async () => { guard('get'); return { data: { number: 7, head: { sha: headSha } } }; },
    },
    issues: {
      listComments: async () => { guard('list'); return { data: state.map((c) => ({ ...c })) }; },
      createComment: async ({ body }) => {
        guard('create');
        const made = comment(next++, BOT, body, '2026-11-24T12:00:00Z');
        state.push(made);
        calls.create.push(body);
        return { data: made };
      },
      updateComment: async ({ comment_id, body }) => {
        guard('update');
        calls.update.push({ id: comment_id, body });
        const found = state.find((c) => c.id === comment_id);
        if (found) found.body = body;
        return { data: found };
      },
      deleteComment: async ({ comment_id }) => {
        guard('delete');
        calls.remove.push(comment_id);
        state.splice(state.findIndex((c) => c.id === comment_id), 1);
        return { data: {} };
      },
    },
  };
  const paginate = async (fn, params) => (await fn(params)).data;
  return { github: { rest, paginate }, calls, state };
}

function fakeCore() {
  const out = { text: [], warnings: [], failed: [] };
  const summary = new Proxy({}, {
    // `then` stays undefined so awaiting the summary does not hang on it.
    get: (_, key) => (key === 'then' ? undefined : key === 'write' ? async () => summary : (...args) => {
      out.text.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      return summary;
    }),
  });
  const core = {
    summary,
    warning: (msg) => out.warnings.push(String(msg)),
    setFailed: (msg) => out.failed.push(String(msg)),
    info: () => {}, notice: () => {}, debug: () => {}, error: () => {},
  };
  return { core, out };
}

function prContext({ author = 'octocat', fork = false, eventName = 'pull_request' } = {}) {
  const payload = eventName === 'pull_request' ? {
    pull_request: {
      number: 7,
      user: { login: author },
      head: { sha: HEAD, repo: { full_name: fork ? 'stranger/widget' : 'acme/widget' } },
      base: { repo: { full_name: 'acme/widget' } },
    },
  } : {};
  return {
    eventName, payload, actor: author, sha: HEAD, runId: 4242,
    repo: { owner: 'acme', repo: 'widget' },
    issue: { owner: 'acme', repo: 'widget', number: eventName === 'pull_request' ? 7 : undefined },
  };
}

// Runs the writer with GITHUB_STEP_SUMMARY on a temp file and console.log captured,
// so the job summary and ::warning:: are seen however the module writes them.
async function write({ gh, context = prContext(), body = `${MARKER}\nsummary body ${HEAD}` }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-summary-comment-'));
  const file = path.join(dir, 'summary.md');
  fs.writeFileSync(file, '');
  const saved = { summary: process.env.GITHUB_STEP_SUMMARY, exitCode: process.exitCode, log: console.log };
  const stdout = [];
  const { core, out } = fakeCore();
  process.env.GITHUB_STEP_SUMMARY = file;
  process.exitCode = undefined;
  // console.log, not process.stdout.write: the test runner reports on stdout.
  console.log = (...args) => { stdout.push(args.join(' ')); };
  let exitCode;
  try {
    await load().writeComment({ github: gh.github, context, core, body });
  } finally {
    console.log = saved.log;
    exitCode = process.exitCode;
    process.exitCode = saved.exitCode;
    if (saved.summary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = saved.summary;
  }
  const summary = out.text.join('\n') + fs.readFileSync(file, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  const warned = out.warnings.length > 0 || stdout.some((s) => s.includes('::warning'));
  return { summary, warned, failed: out.failed, exitCode, stdout };
}

function assertConclusionUntouched(result) {
  assert.deepEqual(result.failed, [], 'writeComment must not call core.setFailed');
  assert.equal(result.exitCode, undefined, 'writeComment must not set process.exitCode');
  assert.ok(!result.stdout.some((s) => s.includes('::error')), 'writeComment must not emit ::error');
}

const BODY = `${MARKER}\nsummary body ${HEAD}`;

// --- create, update, find by marker and bot author ---------------------------

test('no existing comment: creates exactly one', async () => {
  const gh = fakeGithub();
  const result = await write({ gh });
  assert.deepEqual(gh.calls.create, [BODY]);
  assert.equal(gh.calls.update.length, 0);
  assert.equal(gh.calls.remove.length, 0);
  assertConclusionUntouched(result);
});

test('one bot-owned marker comment: updates it in place, creates none', async () => {
  const gh = fakeGithub({ comments: [comment(11, BOT, `${MARKER}\nold`, '2026-11-01T00:00:00Z')] });
  await write({ gh });
  assert.deepEqual(gh.calls.update, [{ id: 11, body: BODY }]);
  assert.equal(gh.calls.create.length, 0);
  assert.equal(gh.calls.remove.length, 0);
});

test('two runs in a row leave exactly one marker comment', async () => {
  const gh = fakeGithub();
  await write({ gh });
  await write({ gh, body: `${MARKER}\nsecond run` });
  const ours = gh.state.filter((c) => c.body.startsWith(MARKER));
  assert.equal(ours.length, 1);
  assert.equal(ours[0].body, `${MARKER}\nsecond run`);
});

test('a user comment containing the marker is never edited or deleted', async () => {
  const user = comment(5, 'octocat', `${MARKER}\nI copied this`, '2026-10-01T00:00:00Z');
  const gh = fakeGithub({ comments: [user] });
  await write({ gh });
  assert.equal(gh.calls.update.length, 0);
  assert.equal(gh.calls.remove.length, 0);
  assert.deepEqual(gh.calls.create, [BODY]);
  assert.equal(gh.state.find((c) => c.id === 5).body, `${MARKER}\nI copied this`);
});

test('a user comment with the marker beside a bot one: only the bot one is updated', async () => {
  const gh = fakeGithub({ comments: [
    comment(5, 'octocat', `${MARKER}\nmine`, '2026-10-01T00:00:00Z'),
    comment(12, BOT, `${MARKER}\nold`, '2026-11-01T00:00:00Z'),
  ] });
  await write({ gh });
  assert.deepEqual(gh.calls.update, [{ id: 12, body: BODY }]);
  assert.equal(gh.calls.remove.length, 0);
  assert.equal(gh.calls.create.length, 0);
});

test('a comment by another bot with the marker is left alone', async () => {
  const gh = fakeGithub({ comments: [comment(6, 'renovate[bot]', `${MARKER}\nnot ours`, '2026-10-01T00:00:00Z')] });
  await write({ gh });
  assert.equal(gh.calls.update.length, 0);
  assert.equal(gh.calls.remove.length, 0);
  assert.deepEqual(gh.calls.create, [BODY]);
});

test('a bot comment with the marker not at the start is not the summary comment', async () => {
  const gh = fakeGithub({ comments: [comment(8, BOT, `quoted: ${MARKER}`, '2026-10-01T00:00:00Z')] });
  await write({ gh });
  assert.equal(gh.calls.update.length, 0);
  assert.equal(gh.calls.remove.length, 0);
  assert.deepEqual(gh.calls.create, [BODY]);
});

test('the old coverage and commitlint comments are left untouched', async () => {
  const gh = fakeGithub({ comments: [
    comment(21, BOT, '<!-- hashira:coverage-report -->\ncoverage', '2026-09-01T00:00:00Z'),
    comment(22, BOT, '<!-- hashira:npm-package-ci:commitlint -->\nfindings', '2026-09-02T00:00:00Z'),
  ] });
  await write({ gh });
  assert.equal(gh.calls.update.length, 0);
  assert.equal(gh.calls.remove.length, 0);
  assert.deepEqual(gh.calls.create, [BODY]);
});

// --- duplicates: oldest updated, other bot-owned ones deleted ----------------

test('two bot-owned marker comments: the oldest is updated and the other deleted', async () => {
  // Listed newest first, so the writer has to pick the oldest, not the first.
  const gh = fakeGithub({ comments: [
    comment(40, BOT, `${MARKER}\nnewer`, '2026-11-20T00:00:00Z'),
    comment(30, BOT, `${MARKER}\noldest`, '2026-11-02T00:00:00Z'),
  ] });
  await write({ gh });
  assert.deepEqual(gh.calls.update, [{ id: 30, body: BODY }]);
  assert.deepEqual(gh.calls.remove, [40]);
  assert.equal(gh.calls.create.length, 0);
});

test('three bot-owned marker comments: the two newer ones are deleted, user ones kept', async () => {
  const gh = fakeGithub({ comments: [
    comment(52, BOT, `${MARKER}\nc`, '2026-11-22T00:00:00Z'),
    comment(51, 'octocat', `${MARKER}\nuser`, '2026-11-01T00:00:00Z'),
    comment(50, BOT, `${MARKER}\na`, '2026-11-10T00:00:00Z'),
    comment(53, BOT, `${MARKER}\nb`, '2026-11-15T00:00:00Z'),
  ] });
  await write({ gh });
  assert.deepEqual(gh.calls.update, [{ id: 50, body: BODY }]);
  assert.deepEqual([...gh.calls.remove].sort(), [52, 53]);
  assert.ok(gh.state.some((c) => c.id === 51));
});

// --- stale head --------------------------------------------------------------

test('a newer push on the PR: no write, and the job summary says so', async () => {
  const gh = fakeGithub({ comments: [comment(11, BOT, `${MARKER}\nold`, '2026-11-01T00:00:00Z')], headSha: NEWER });
  const result = await write({ gh });
  assert.equal(gh.calls.create.length, 0);
  assert.equal(gh.calls.update.length, 0);
  assert.equal(gh.calls.remove.length, 0);
  assert.notEqual(result.summary.trim(), '', 'the job summary must say the comment was not written');
  assertConclusionUntouched(result);
});

test('the head SHA matching the run: the comment is written', async () => {
  const gh = fakeGithub({ headSha: HEAD });
  await write({ gh });
  assert.equal(gh.calls.create.length, 1);
});

// --- fork and Dependabot: no attempt, job-summary fallback -------------------

test('a fork PR: no comment API call, the body goes to the job summary', async () => {
  const gh = fakeGithub();
  const result = await write({ gh, context: prContext({ fork: true }) });
  assert.equal(gh.calls.any, 0, 'a fork PR must not call the API at all');
  assert.ok(result.summary.includes(`summary body ${HEAD}`), result.summary);
  assertConclusionUntouched(result);
});

test('a Dependabot PR: no comment API call, the body goes to the job summary', async () => {
  const gh = fakeGithub();
  const result = await write({ gh, context: prContext({ author: 'dependabot[bot]' }) });
  assert.equal(gh.calls.any, 0, 'a Dependabot PR must not call the API at all');
  assert.ok(result.summary.includes(`summary body ${HEAD}`), result.summary);
  assertConclusionUntouched(result);
});

// --- API errors: warning, job-summary fallback, conclusion unchanged ---------

for (const [step, status] of [['list', 403], ['create', 403], ['get', 500]]) {
  test(`a ${status} on ${step}: ::warning::, body in the job summary, no throw`, async () => {
    const gh = fakeGithub({ fail: { [step]: status } });
    const result = await write({ gh });
    assert.ok(result.warned, 'expected a warning');
    assert.ok(result.summary.includes(`summary body ${HEAD}`), result.summary);
    assertConclusionUntouched(result);
  });
}

test('an error on update: ::warning::, body in the job summary, no throw', async () => {
  const gh = fakeGithub({ comments: [comment(11, BOT, `${MARKER}\nold`, '2026-11-01T00:00:00Z')], fail: { update: 403 } });
  const result = await write({ gh });
  assert.ok(result.warned, 'expected a warning');
  assert.ok(result.summary.includes(`summary body ${HEAD}`), result.summary);
  assertConclusionUntouched(result);
});

test('an error on delete: ::warning::, no throw', async () => {
  const gh = fakeGithub({ comments: [
    comment(30, BOT, `${MARKER}\noldest`, '2026-11-02T00:00:00Z'),
    comment(40, BOT, `${MARKER}\nnewer`, '2026-11-20T00:00:00Z'),
  ], fail: { delete: 403 } });
  const result = await write({ gh });
  assert.ok(result.warned, 'expected a warning');
  assertConclusionUntouched(result);
});

// --- non-pull_request events -------------------------------------------------

for (const eventName of ['push', 'workflow_dispatch']) {
  test(`a ${eventName} event writes no comment and calls no API`, async () => {
    const gh = fakeGithub();
    const result = await write({ gh, context: prContext({ eventName }) });
    assert.equal(gh.calls.any, 0);
    assertConclusionUntouched(result);
  });
}
