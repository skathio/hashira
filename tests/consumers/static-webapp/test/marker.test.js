'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { hashiraRef } = require('../scripts/marker');

const SHA = '0123456789abcdef0123456789abcdef01234567';

test('hashiraRef returns the ref the caller pins', () => {
  const caller = `jobs:\n  ci:\n    uses: skathio/hashira/.github/workflows/static-webapp-ci.yml@${SHA}\n`;
  assert.strictEqual(hashiraRef(caller), SHA);
});

test('hashiraRef stops at a trailing comment', () => {
  const caller = `    uses: skathio/hashira/.github/workflows/static-webapp-ci.yml@v3 # pinned\n`;
  assert.strictEqual(hashiraRef(caller), 'v3');
});

test('hashiraRef fails when the caller does not call the static workflow', () => {
  assert.throws(() => hashiraRef('uses: skathio/hashira/.github/workflows/npm-package-ci.yml@v3'), /does not call/);
});
