// Unit tests for tests/consumer-integration/lib/plan.js: the pure rules the
// consumer-integration job follows.
//
// Run locally with:  node --test tests/consumer-integration/plan.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('./lib/plan.js');

const S = 'a'.repeat(40);

test('branch names carry the commit under test', () => {
  assert.deepEqual(plan.branchNames(S), { main: `hashira/${S}`, gate: `hashira/${S}-gate` });
});

test('a commit that is not 40 hex characters is refused', () => {
  for (const bad of [undefined, '', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${'a'.repeat(39)};`]) {
    assert.throws(() => plan.branchNames(bad), /not a 40-character commit/);
  }
});

test('every skathio/hashira ref is set to the commit, and nothing else changes', () => {
  const text = [
    '    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@v3',
    "      - uses: 'skathio/hashira/.github/actions/npm-release@v3.1.0' # pinned",
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    '# see https://github.com/skathio/hashira-fixture-npm and skathio/hashira',
  ].join('\n');
  const out = plan.rewriteRefs(text, S).split('\n');
  assert.equal(out[0], `    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@${S}`);
  assert.equal(out[1], `      - uses: 'skathio/hashira/.github/actions/npm-release@${S}' # pinned`);
  assert.equal(out[2], '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
  assert.equal(out[3], '# see https://github.com/skathio/hashira-fixture-npm and skathio/hashira');
});

test('the gate source has one function with more parameters than the strict limit of 4', () => {
  const match = /function overLimit\(([^)]*)\)/.exec(plan.gateSource());
  assert.ok(match);
  assert.equal(match[1].split(',').length, 6);
});

test('only npm carries the gate case; static has no tag or Release', () => {
  assert.deepEqual(Object.keys(plan.FLOWS).sort(), ['npm', 'nuget', 'static']);
  assert.equal(plan.FLOWS.npm.gate, true);
  assert.equal(plan.FLOWS.nuget.gate, false);
  assert.equal(plan.FLOWS.static.tagged, false);
});

test('release inputs: bump patch, with seed 0.0.0 only when no stable tag exists', () => {
  assert.deepEqual(plan.releaseInputs('npm', []), { bump: 'patch', seed_version: '0.0.0' });
  assert.deepEqual(plan.releaseInputs('nuget', ['v1.0.0-rc.1', 'not-a-version']), { bump: 'patch', seed_version: '0.0.0' });
  assert.deepEqual(plan.releaseInputs('npm', ['v1.2.3']), { bump: 'patch' });
  assert.deepEqual(plan.releaseInputs('static', []), {});
});

test('the expected tag follows the version resolver', () => {
  assert.equal(plan.expectedTag([], { bump: 'patch', seed_version: '0.0.0' }), 'v0.0.1');
  assert.equal(plan.expectedTag(['v0.0.9', 'v0.1.2', 'v0.2.0-rc.1'], { bump: 'patch' }), 'v0.1.3');
});

test('pickRun takes the newest run of the event at the head commit', () => {
  const runs = [
    { id: 1, event: 'pull_request', head_sha: S, created_at: '2026-01-01T00:00:00Z' },
    { id: 2, event: 'pull_request', head_sha: S, created_at: '2026-01-02T00:00:00Z' },
    { id: 3, event: 'workflow_dispatch', head_sha: S, created_at: '2026-01-03T00:00:00Z' },
    { id: 4, event: 'pull_request', head_sha: 'b'.repeat(40), created_at: '2026-01-04T00:00:00Z' },
  ];
  assert.equal(plan.pickRun(runs, 'pull_request', S).id, 2);
  assert.equal(plan.pickRun(runs, 'workflow_dispatch', S).id, 3);
  assert.equal(plan.pickRun(runs, 'push', S), null);
  assert.equal(plan.pickRun(undefined, 'push', S), null);
});

test('the timeout message names the repo and the run', () => {
  assert.equal(plan.timeoutMessage('skathio/r', { id: 7 }), 'timed out waiting for skathio/r run 7');
  assert.equal(plan.timeoutMessage('skathio/r', null), 'timed out waiting for skathio/r run (not started)');
  assert.equal(plan.WAIT_MS, 30 * 60 * 1000);
});

test('the summary line links the run', () => {
  const line = plan.summaryLine('skathio/r', 'fixture CI', { id: 7, html_url: 'https://x/7', conclusion: 'success' });
  assert.equal(line, '- fixture CI: [skathio/r run 7](https://x/7) success\n');
});

test('gate verdict: only the quality-gate job failed', () => {
  const verdict = plan.gateVerdict([
    { name: 'ci / setup', conclusion: 'success' },
    { name: 'ci / test', conclusion: 'success' },
    { name: 'ci / quality-gate', conclusion: 'failure' },
    { name: 'publish', conclusion: 'skipped' },
  ]);
  assert.equal(verdict.ok, true);
});

test('gate verdict: an earlier failure or a passing gate is not the negative case', () => {
  const earlier = plan.gateVerdict([
    { name: 'ci / setup', conclusion: 'failure' },
    { name: 'ci / quality-gate', conclusion: 'failure' },
  ]);
  assert.equal(earlier.ok, false);
  assert.match(earlier.reason, /ci \/ setup/);
  const skipped = plan.gateVerdict([
    { name: 'ci / setup', conclusion: 'failure' },
    { name: 'ci / quality-gate', conclusion: 'skipped' },
  ]);
  assert.equal(skipped.ok, false);
  assert.match(skipped.reason, /did not fail/);
  assert.equal(plan.gateVerdict([{ name: 'ci / quality-gate', conclusion: 'success' }]).ok, false);
  assert.equal(plan.gateVerdict([{ name: 'ci / not-quality-gate', conclusion: 'failure' }]).ok, false);
  assert.equal(plan.gateVerdict(undefined).ok, false);
});
