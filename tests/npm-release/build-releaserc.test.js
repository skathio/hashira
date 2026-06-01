'use strict';

// Unit tests for the npm-release action's build-releaserc.js — the pure,
// tag-driven native-OIDC .releaserc builder.
// Run with: node --test (Node's built-in test runner; no deps).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildReleaserc,
  parseCsv,
  deepMerge,
  DEFAULT_TARGET,
} = require('../../.github/actions/npm-release/lib/build-releaserc');

const pluginName = (p) => (Array.isArray(p) ? p[0] : p);

test('parseCsv: empty/whitespace yields empty array', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('   '), []);
  assert.deepEqual(parseCsv(undefined), []);
  assert.deepEqual(parseCsv(null), []);
});

test('parseCsv: trims and filters blanks', () => {
  assert.deepEqual(parseCsv('a, b ,,c'), ['a', 'b', 'c']);
});

test('buildReleaserc: default target when none provided', () => {
  const rc = buildReleaserc({});
  assert.equal(DEFAULT_TARGET, 'https://registry.npmjs.org');
  const npm = rc.plugins.find((p) => Array.isArray(p) && p[0] === '@semantic-release/npm');
  assert.ok(npm);
  assert.equal(npm[1].registry, 'https://registry.npmjs.org');
});

test('buildReleaserc: custom target wires into npm plugin', () => {
  const rc = buildReleaserc({ target: 'https://npm.pkg.github.com' });
  const npm = rc.plugins.find((p) => Array.isArray(p) && p[0] === '@semantic-release/npm');
  assert.equal(npm[1].registry, 'https://npm.pkg.github.com');
});

test('buildReleaserc: branches include main', () => {
  const rc = buildReleaserc({});
  assert.ok(rc.branches.includes('main'));
});

test('buildReleaserc: maintenance + prerelease branch order (full array)', () => {
  // semantic-release `branches` is order-sensitive: maintenance must precede
  // the generic `main` release branch, and prerelease entries follow it.
  // Assert the whole ordered array, not just endpoints (review m2).
  const rc = buildReleaserc({
    prerelease_branches: 'next,beta',
    maintenance_branches: '1.x,2.x',
  });
  assert.deepEqual(rc.branches, [
    { name: '1.x', channel: '1.x', range: '1.x.x' },
    { name: '2.x', channel: '2.x', range: '2.x.x' },
    'main',
    { name: 'next', prerelease: true },
    { name: 'beta', prerelease: true },
  ]);
});

test('buildReleaserc: tag-driven OIDC plugin set — exact order and tuple', () => {
  const rc = buildReleaserc({});
  // Exact ordered plugin list (acceptance criterion for iter 1.1).
  assert.deepEqual(rc.plugins, [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    ['@semantic-release/npm', { npmPublish: true, registry: 'https://registry.npmjs.org' }],
    '@semantic-release/github',
  ]);
});

test('buildReleaserc: no @semantic-release/changelog or /git (tag-driven, D3)', () => {
  const rc = buildReleaserc({});
  const names = rc.plugins.map(pluginName);
  assert.ok(!names.includes('@semantic-release/changelog'));
  assert.ok(!names.includes('@semantic-release/git'));
});

test('buildReleaserc: npmPublish:true (D2 native OIDC publish)', () => {
  const rc = buildReleaserc({});
  const npm = rc.plugins.find((p) => Array.isArray(p) && p[0] === '@semantic-release/npm');
  assert.equal(npm[1].npmPublish, true);
});

test('buildReleaserc: plugin shape is env-independent (pure builder)', () => {
  // The old builder sniffed NPM_TOKEN / ACTIONS_ID_TOKEN_REQUEST_TOKEN to
  // toggle the shape. The new one must NOT: the npm plugin decides OIDC-vs-token
  // at runtime, so the .releaserc is constant regardless of env.
  const saved = {
    tok: process.env.NPM_TOKEN,
    oidc: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };
  try {
    process.env.NPM_TOKEN = 'fake-token';
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'fake-oidc';
    const withEnv = buildReleaserc({});
    delete process.env.NPM_TOKEN;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    const withoutEnv = buildReleaserc({});
    assert.deepEqual(withEnv, withoutEnv);
    const npm = withEnv.plugins.find((p) => Array.isArray(p) && p[0] === '@semantic-release/npm');
    assert.equal(npm[1].npmPublish, true);
  } finally {
    if (saved.tok !== undefined) process.env.NPM_TOKEN = saved.tok;
    else delete process.env.NPM_TOKEN;
    if (saved.oidc !== undefined) process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = saved.oidc;
    else delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  }
});

test('deepMerge: arrays replace, objects merge', () => {
  const base = { a: 1, b: { c: 2 }, arr: [1, 2] };
  const over = { b: { d: 3 }, arr: [9] };
  assert.deepEqual(deepMerge(base, over), { a: 1, b: { c: 2, d: 3 }, arr: [9] });
});

test('buildReleaserc: x_releaserc_overrides deep-merges; arrays replace', () => {
  const rc = buildReleaserc({
    x_releaserc_overrides: JSON.stringify({ branches: ['main', 'release'] }),
  });
  assert.deepEqual(rc.branches, ['main', 'release']);
});

test('buildReleaserc: x_releaserc_overrides can replace the plugin list', () => {
  const rc = buildReleaserc({
    x_releaserc_overrides: JSON.stringify({ plugins: ['@semantic-release/commit-analyzer'] }),
  });
  assert.deepEqual(rc.plugins, ['@semantic-release/commit-analyzer']);
});

test('buildReleaserc: invalid override JSON throws', () => {
  assert.throws(
    () => buildReleaserc({ x_releaserc_overrides: '{not json' }),
    /not valid JSON/,
  );
});

test('buildReleaserc: non-object override (JSON array) throws', () => {
  assert.throws(
    () => buildReleaserc({ x_releaserc_overrides: '[1,2,3]' }),
    /must be a JSON object/,
  );
});
