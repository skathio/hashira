// Edge cases for tests/release/lib/release.js beyond the core rules in
// release.test.js: picking the CI run, refs that name no major, and the
// inputs planPublish refuses.
//
// Run locally with:  node --test tests/release/release-edges.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkRelease, planPublish, latestCiConclusion, hashiraRefs } = require('./lib/release.js');

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TAGS = ['v3', 'v3.0.0', 'v3.1.0'];

function template(ref) {
  return `jobs:\n  ci:\n    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@${ref}\n`;
}

function check(overrides) {
  return checkRelease({
    bump: 'patch', tags: TAGS, ciConclusion: 'success', templates: { 'templates/npm/ci.yml': template('v3') }, ...overrides,
  });
}

test('latestCiConclusion takes the newest completed run at HEAD', () => {
  const runs = [
    { head_sha: HEAD, status: 'completed', conclusion: 'failure', created_at: '2026-11-01T10:00:00Z' },
    { head_sha: HEAD, status: 'completed', conclusion: 'success', created_at: '2026-11-01T11:00:00Z' },
    { head_sha: HEAD, status: 'in_progress', conclusion: null, created_at: '2026-11-01T12:00:00Z' },
    { head_sha: OTHER, status: 'completed', conclusion: 'failure', created_at: '2026-11-01T13:00:00Z' },
  ];
  assert.equal(latestCiConclusion(runs, HEAD), 'success');
});

test('a newer failed rerun at HEAD wins over an older success', () => {
  const runs = [
    { head_sha: HEAD, status: 'completed', conclusion: 'success', created_at: '2026-11-01T10:00:00Z' },
    { head_sha: HEAD, status: 'completed', conclusion: 'failure', created_at: '2026-11-01T11:00:00Z' },
  ];
  assert.equal(latestCiConclusion(runs, HEAD), 'failure');
});

test('no completed run at HEAD gives null, which checkRelease refuses', () => {
  for (const runs of [[], undefined, null, 'x', [{ head_sha: HEAD, status: 'queued', conclusion: null }]]) {
    const c = latestCiConclusion(runs, HEAD);
    assert.equal(c, null);
    assert.throws(() => check({ ciConclusion: c }));
  }
});

test('hashiraRefs reads quoted refs and skips look-alike repos', () => {
  const text = [
    "      - uses: 'skathio/hashira/.github/actions/npm-release@v3'",
    '      - uses: skathio/hashira-fixture-npm/.github/x@v9',
    '      - uses: skathio/hashira/.github/actions/x@v3.2.1 # pinned',
  ].join('\n');
  assert.deepEqual(hashiraRefs(text), ['v3', 'v3.2.1']);
});

test('a template ref that names no major (a SHA or main) is refused', () => {
  for (const ref of ['c'.repeat(40), 'main', 'v3.1', 'v03']) {
    assert.throws(() => check({ templates: { 'templates/npm/ci.yml': template(ref) } }), ref);
  }
});

test('missing or empty templates are refused', () => {
  for (const templates of [undefined, null, {}, 'templates']) {
    assert.throws(() => check({ templates }));
  }
});

test('tags with no stable release are refused', () => {
  assert.throws(() => check({ tags: [] }));
  assert.throws(() => check({ tags: ['v3', 'v4.0.0-rc.1'] }));
});

test('planPublish refuses a malformed version, commit, tag map or releaseExists', () => {
  const ok = { version: '3.1.1', sha: HEAD, tags: {}, releaseExists: false };
  assert.deepEqual(planPublish(ok), { tag: 'create', release: 'create', majorTag: 'create', majorTagName: 'v3' });
  for (const bad of [
    { version: 'v3.1.1' }, { version: '3.1' }, { version: undefined },
    { sha: 'abc' }, { sha: HEAD.toUpperCase() }, { sha: undefined },
    { tags: null }, { tags: undefined },
    { releaseExists: 'false' }, { releaseExists: undefined },
  ]) {
    assert.throws(() => planPublish({ ...ok, ...bad }), JSON.stringify(bad));
  }
});

test('an inherited property is not taken for an existing tag', () => {
  const p = planPublish({ version: '3.1.1', sha: HEAD, tags: Object.create({ 'v3.1.1': OTHER }), releaseExists: false });
  assert.equal(p.tag, 'create');
});

// release.yml leaves the tags on the released commit out of the version
// input, so a re-run resolves the version it already tagged and finishes it.
// A dispatch with another bump on that commit resolves a different version
// and is refused, rather than tagging the commit twice.
test('a commit already released as another version is refused', () => {
  const tags = { v3: HEAD, 'v3.0.0': OTHER, 'v3.1.0': HEAD };
  assert.throws(() => planPublish({ version: '3.0.1', sha: HEAD, tags, releaseExists: false }),
    /already released as v3\.1\.0/);
  const p = planPublish({ version: '3.1.0', sha: HEAD, tags, releaseExists: true });
  assert.deepEqual(p, { tag: 'done', release: 'done', majorTag: 'done', majorTagName: 'v3' });
});

test('a major tag or a prerelease tag on the commit is not a release of it', () => {
  const tags = { v3: HEAD, 'v3.2.0-rc.1': HEAD, 'v3.1.0': OTHER };
  assert.equal(planPublish({ version: '3.1.1', sha: HEAD, tags, releaseExists: false }).tag, 'create');
});
