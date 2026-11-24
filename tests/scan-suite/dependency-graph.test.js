// Unit tests for scan-suite/lib/dependency-graph.js: whether dependency review
// can run, asked of the dependency-graph compare endpoint before the action.
//
// Run locally with:  node --test tests/scan-suite/dependency-graph.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { classify, probe, main } = require(path.join(__dirname, '..', '..', '.github', 'actions', 'scan-suite', 'lib', 'dependency-graph.js'));

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const ENV = { GITHUB_API_URL: 'https://api.github.com', GITHUB_REPOSITORY: 'o/r', DR_TOKEN: 't', DR_BASE_SHA: BASE, DR_HEAD_SHA: HEAD };
const OFF_MESSAGE = 'Dependency review is not supported on this repository. Please ensure that Dependency graph is enabled.';

const reply = (status, body) => async () => ({ status, json: async () => body });

test('200 means the graph is on', () => assert.equal(classify(200, ''), 'on'));
test('403 with the not-supported message means off', () => assert.equal(classify(403, OFF_MESSAGE), 'off'));
test('404 with the not-supported message means off', () => assert.equal(classify(404, OFF_MESSAGE), 'off'));
test('403 with another message is unknown', () => assert.equal(classify(403, 'Resource not accessible by integration'), 'unknown'));
test('404 with no message is unknown', () => assert.equal(classify(404, undefined), 'unknown'));
test('500 is unknown even with the message', () => assert.equal(classify(500, OFF_MESSAGE), 'unknown'));

test('probe calls the compare endpoint for base...head with the token', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { status: 200, json: async () => ({}) }; };
  assert.equal(await probe(ENV, fetchImpl), 'on');
  assert.equal(seen.url, `https://api.github.com/repos/o/r/dependency-graph/compare/${BASE}...${HEAD}`);
  assert.equal(seen.init.headers.authorization, 'Bearer t');
});

test('probe reads the refusal from the body', async () => {
  assert.equal(await probe(ENV, reply(403, { message: OFF_MESSAGE })), 'off');
});

test('probe gives unknown on a network error', async () => {
  assert.equal(await probe(ENV, async () => { throw new Error('ECONNRESET'); }), 'unknown');
});

test('probe gives unknown when the error body is not JSON', async () => {
  const fetchImpl = async () => ({ status: 403, json: async () => { throw new SyntaxError('bad'); } });
  assert.equal(await probe(ENV, fetchImpl), 'unknown');
});

for (const [name, patch] of [
  ['missing base', { DR_BASE_SHA: '' }],
  ['short head', { DR_HEAD_SHA: 'abc' }],
  ['bad repository', { GITHUB_REPOSITORY: 'o/r/../x' }],
  ['non-https API URL', { GITHUB_API_URL: 'http://api.github.com' }],
]) {
  test(`probe gives unknown without calling out for a ${name}`, async () => {
    let called = false;
    assert.equal(await probe({ ...ENV, ...patch }, async () => { called = true; return { status: 200 }; }), 'unknown');
    assert.equal(called, false);
  });
}

test('main writes graph=<value> to GITHUB_OUTPUT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-graph-'));
  const out = path.join(dir, 'out');
  fs.writeFileSync(out, '');
  assert.equal(await main({ ...ENV, DR_BASE_SHA: '', GITHUB_OUTPUT: out }), 'unknown');
  assert.equal(fs.readFileSync(out, 'utf8'), 'graph=unknown\n');
  fs.rmSync(dir, { recursive: true, force: true });
});
