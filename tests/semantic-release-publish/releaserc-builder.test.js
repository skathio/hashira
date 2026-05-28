// Unit tests for the .releaserc builder used by `semantic-release-publish`.
// Uses node:test (stdlib; zero-install).
//
// Run locally with:  node --test tests/semantic-release-publish/releaserc-builder.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReleaserc,
  parseCsv,
  deepMerge,
  DEFAULT_TARGET,
} = require('../../.github/actions/semantic-release-publish/lib/build-releaserc');

// ---------- parseCsv ---------------------------------------------------

test('parseCsv: empty / whitespace / undefined return []', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('   '), []);
  assert.deepEqual(parseCsv(undefined), []);
  assert.deepEqual(parseCsv(null), []);
});

test('parseCsv: trims and drops empty tokens', () => {
  assert.deepEqual(parseCsv(' next , beta ,, alpha '), ['next', 'beta', 'alpha']);
});

// ---------- buildReleaserc default ------------------------------------

test('buildReleaserc: default config (main only, default target, six plugins in order)', () => {
  const rc = buildReleaserc({});
  assert.deepEqual(rc.branches, ['main']);
  assert.equal(rc.plugins.length, 6);
  // first two and last one are bare strings
  assert.equal(rc.plugins[0], '@semantic-release/commit-analyzer');
  assert.equal(rc.plugins[1], '@semantic-release/release-notes-generator');
  assert.equal(rc.plugins[5], '@semantic-release/github');
  // changelog tuple
  assert.deepEqual(rc.plugins[2], ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }]);
  // npm tuple carries the default registry
  assert.deepEqual(rc.plugins[3], [
    '@semantic-release/npm',
    { npmPublish: true, registry: DEFAULT_TARGET },
  ]);
  // git tuple carries the expected commit message + assets
  assert.equal(rc.plugins[4][0], '@semantic-release/git');
  assert.deepEqual(rc.plugins[4][1].assets, ['CHANGELOG.md', 'package.json', 'package-lock.json']);
});

// ---------- prerelease branches ----------------------------------------

test('buildReleaserc: prerelease branches appended after main with prerelease:true', () => {
  const rc = buildReleaserc({ prerelease_branches: 'next,beta' });
  assert.deepEqual(rc.branches, [
    'main',
    { name: 'next', prerelease: true },
    { name: 'beta', prerelease: true },
  ]);
});

// ---------- maintenance branches ---------------------------------------

test('buildReleaserc: maintenance branches prepended with range', () => {
  const rc = buildReleaserc({ maintenance_branches: '1.x,2.x' });
  assert.deepEqual(rc.branches, [
    { name: '1.x', channel: '1.x', range: '1.x.x' },
    { name: '2.x', channel: '2.x', range: '2.x.x' },
    'main',
  ]);
});

// ---------- both --------------------------------------------------------

test('buildReleaserc: maintenance + main + prerelease ordering', () => {
  const rc = buildReleaserc({
    maintenance_branches: '1.x',
    prerelease_branches: 'next',
  });
  assert.deepEqual(rc.branches, [
    { name: '1.x', channel: '1.x', range: '1.x.x' },
    'main',
    { name: 'next', prerelease: true },
  ]);
});

// ---------- custom registry --------------------------------------------

test('buildReleaserc: custom target propagates to @semantic-release/npm', () => {
  const rc = buildReleaserc({ target: 'https://npm.pkg.github.com' });
  assert.equal(rc.plugins[3][1].registry, 'https://npm.pkg.github.com');
});

// ---------- overrides ---------------------------------------------------

test('buildReleaserc: x_releaserc_overrides merges top-level scalars and objects', () => {
  const overrides = JSON.stringify({ tagFormat: 'v${version}', dryRun: false });
  const rc = buildReleaserc({ x_releaserc_overrides: overrides });
  assert.equal(rc.tagFormat, 'v${version}');
  assert.equal(rc.dryRun, false);
  // base config still intact
  assert.deepEqual(rc.branches, ['main']);
  assert.equal(rc.plugins.length, 6);
});

test('buildReleaserc: x_releaserc_overrides arrays REPLACE base arrays', () => {
  // Documented behavior: overrides.branches REPLACES base.branches.
  const overrides = JSON.stringify({ branches: ['release'] });
  const rc = buildReleaserc({
    prerelease_branches: 'next',
    x_releaserc_overrides: overrides,
  });
  assert.deepEqual(rc.branches, ['release']);
});

test('buildReleaserc: invalid JSON in x_releaserc_overrides throws clear error', () => {
  assert.throws(
    () => buildReleaserc({ x_releaserc_overrides: '{not json' }),
    /x_releaserc_overrides is not valid JSON/,
  );
});

test('buildReleaserc: non-object JSON top-level in overrides throws clear error', () => {
  assert.throws(
    () => buildReleaserc({ x_releaserc_overrides: '["a", "b"]' }),
    /must be a JSON object at the top level/,
  );
});

// ---------- deepMerge ---------------------------------------------------

test('deepMerge: nested objects merge key-by-key; scalars from override win', () => {
  const base = { a: 1, b: { c: 2, d: 3 } };
  const override = { b: { c: 99 }, e: 4 };
  assert.deepEqual(deepMerge(base, override), { a: 1, b: { c: 99, d: 3 }, e: 4 });
});
