// The decision behind pages-site.yml's `released: true` check, in
// .github/pages-site/lib/released-approval.cjs: a run may skip the `gate` approval only when it
// already holds an approved `production` review, and every way the read can fail refuses.
//
// Run with:
//   node --test tests/pages-site/released-approval.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { decide, approvalsUrl, readApprovals, main } = require(
  path.join(__dirname, '..', '..', '.github', 'pages-site', 'lib', 'released-approval.cjs'));

const REFUSED = /^pages-site: released refused: /;
const approval = (state, ...names) => ({ state, environments: names.map((name) => ({ name })), user: { login: 'owner' } });

// ---------- decide ----------

test('an approved production review is accepted', () => {
  assert.equal(decide([approval('approved', 'production')]), true);
});

test('production among several environments of one approved review is accepted', () => {
  assert.equal(decide([approval('approved', 'staging', 'production')]), true);
});

test('one approved production review among others is accepted', () => {
  assert.equal(decide([approval('rejected', 'staging'), approval('approved', 'production')]), true);
});

for (const [label, approvals] of [
  ['an empty list', []],
  ['a rejected production review', [approval('rejected', 'production')]],
  ['an approval for another environment', [approval('approved', 'staging')]],
  ['an approval whose environment name differs in case', [approval('approved', 'Production')]],
  ['an approval with no environments', [{ state: 'approved' }]],
  ['environments that are not a list', [{ state: 'approved', environments: { name: 'production' } }]],
  ['null entries', [null, { state: 'approved', environments: [null] }]],
  ['a state that is not exactly approved', [approval('APPROVED', 'production')]],
]) {
  test(`${label} is refused`, () => {
    assert.throws(() => decide(approvals), (err) => REFUSED.test(err.message) && /no approved review for the 'production' environment/.test(err.message));
  });
}

for (const [label, value] of [['an object', { message: 'Not Found' }], ['null', null], ['a string', '[]'], ['undefined', undefined]]) {
  test(`an approvals answer that is ${label} is refused`, () => {
    assert.throws(() => decide(value), /not a list/);
  });
}

test('the refusal says how to go ahead', () => {
  assert.throws(() => decide([]), /released: false/);
});

// ---------- approvalsUrl ----------

test('the URL is this run\'s approvals endpoint on the default API', () => {
  assert.equal(approvalsUrl({ repository: 'octo/site', runId: '4242' }),
    'https://api.github.com/repos/octo/site/actions/runs/4242/approvals');
});

test('GITHUB_API_URL is honoured, without a trailing slash', () => {
  assert.equal(approvalsUrl({ apiUrl: 'https://ghe.example/api/v3/', repository: 'o/r', runId: '1' }),
    'https://ghe.example/api/v3/repos/o/r/actions/runs/1/approvals');
});

for (const [label, args, why] of [
  ['a missing repository', { runId: '1' }, /owner\/repo/],
  ['a repository with a path segment', { repository: 'o/r/../x', runId: '1' }, /owner\/repo/],
  ['a repository with a query', { repository: 'o/r?x=1', runId: '1' }, /owner\/repo/],
  ['a missing run id', { repository: 'o/r' }, /run id/],
  ['a run id that is not digits', { repository: 'o/r', runId: '12a' }, /run id/],
  ['a run id of 0', { repository: 'o/r', runId: '0' }, /run id/],
  ['a run id of 21 digits', { repository: 'o/r', runId: '1'.repeat(21) }, /run id/],
  ['an http API URL', { apiUrl: 'http://api.github.com', repository: 'o/r', runId: '1' }, /not https/],
]) {
  test(`${label} is refused`, () => {
    assert.throws(() => approvalsUrl(args), why);
  });
}

test('a run id of 20 digits is accepted', () => {
  assert.match(approvalsUrl({ repository: 'o/r', runId: '9'.repeat(20) }), /\/runs\/9{20}\/approvals$/);
});

// ---------- readApprovals ----------

function fakeFetch(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
  };
  return { fetch, calls };
}

const WHERE = { repository: 'octo/site', runId: '4242' };

test('the job token is tried first, and its answer is used', async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: [approval('approved', 'production')] }]);
  const got = await readApprovals({ fetch, ...WHERE, token: 'tok' });
  assert.deepEqual(got, [approval('approved', 'production')]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.equal(calls[0].url, 'https://api.github.com/repos/octo/site/actions/runs/4242/approvals');
});

test('a refused token falls back to an unauthenticated read', async () => {
  const { fetch, calls } = fakeFetch([{ status: 403 }, { status: 200, body: [] }]);
  assert.deepEqual(await readApprovals({ fetch, ...WHERE, token: 'tok' }), []);
  assert.deepEqual(calls.map((c) => c.auth), ['Bearer tok', undefined]);
});

test('with no token, only the unauthenticated read is made', async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: [] }]);
  await readApprovals({ fetch, ...WHERE, token: '' });
  assert.deepEqual(calls.map((c) => c.auth), [undefined]);
});

test('both reads failing refuses, naming each failure', async () => {
  const { fetch } = fakeFetch([{ status: 403 }, { status: 404 }]);
  await assert.rejects(readApprovals({ fetch, ...WHERE, token: 'tok' }),
    (err) => REFUSED.test(err.message) && /HTTP 403 with the job token/.test(err.message) && /HTTP 404 unauthenticated/.test(err.message));
});

const noWait = async () => {};

test('a network error that lasts refuses too, after three tries', async () => {
  const err = () => new Error('getaddrinfo ENOTFOUND');
  const { fetch, calls } = fakeFetch([err(), err(), err()]);
  await assert.rejects(readApprovals({ fetch, ...WHERE, sleep: noWait }), /could not read .*ENOTFOUND/);
  assert.equal(calls.length, 3);
});

test('a rate limit or server error is retried, and a later answer is used', async () => {
  const waits = [];
  const { fetch, calls } = fakeFetch([{ status: 429 }, { status: 502 }, { status: 200, body: [] }]);
  assert.deepEqual(await readApprovals({ fetch, ...WHERE, token: 'tok', sleep: async (ms) => waits.push(ms) }), []);
  assert.deepEqual(calls.map((c) => c.auth), ['Bearer tok', 'Bearer tok', 'Bearer tok']);
  assert.equal(waits.length, 2);
});

test('a 403 or 404 is not retried', async () => {
  const { fetch, calls } = fakeFetch([{ status: 403 }, { status: 404 }]);
  await assert.rejects(readApprovals({ fetch, ...WHERE, token: 'tok', sleep: noWait }), (err) => REFUSED.test(err.message));
  assert.equal(calls.length, 2);
});

test('the token never appears in a refusal', async () => {
  const { fetch } = fakeFetch([{ status: 401 }, { status: 401 }]);
  await assert.rejects(readApprovals({ fetch, ...WHERE, token: 'secret-token-value' }),
    (err) => !err.message.includes('secret-token-value'));
});

// ---------- main ----------

const ENV = { GITHUB_REPOSITORY: 'octo/site', GITHUB_RUN_ID: '4242', GITHUB_TOKEN: 'tok' };

test('main accepts a run with an approved production review', async () => {
  const { fetch } = fakeFetch([{ status: 200, body: [approval('approved', 'production')] }]);
  assert.match(await main(ENV, fetch), /run 4242 holds an approved 'production' review/);
});

test('main refuses a run without one', async () => {
  const { fetch } = fakeFetch([{ status: 200, body: [approval('approved', 'github-pages')] }]);
  await assert.rejects(main(ENV, fetch), (err) => REFUSED.test(err.message));
});

test('main refuses when GITHUB_RUN_ID is missing, before any read', async () => {
  const { fetch, calls } = fakeFetch([]);
  await assert.rejects(main({ GITHUB_REPOSITORY: 'octo/site' }, fetch), /run id/);
  assert.equal(calls.length, 0);
});
