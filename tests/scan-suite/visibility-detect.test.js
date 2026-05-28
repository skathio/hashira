'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { detect } = require(path.join(
  __dirname,
  '..',
  '..',
  '.github',
  'actions',
  'scan-suite',
  'lib',
  'visibility-detect.js'
));

test('public repo with no security_and_analysis field → hasGHAS true', () => {
  const r = detect({
    ghContext: { payload: { repository: { visibility: 'public' } } },
    env: {},
  });
  assert.equal(r.visibility, 'public');
  assert.equal(r.hasGHAS, true);
  assert.equal(r.forced, false);
});

test('public repo with advanced_security.status=disabled → hasGHAS false', () => {
  // Edge case: public repo where the owner has explicitly disabled GHAS
  // features (unusual but possible). We honor the explicit marker.
  const r = detect({
    ghContext: {
      payload: {
        repository: {
          visibility: 'public',
          security_and_analysis: { advanced_security: { status: 'disabled' } },
        },
      },
    },
    env: {},
  });
  assert.equal(r.visibility, 'public');
  assert.equal(r.hasGHAS, false);
});

test('private repo with advanced_security.status=enabled → hasGHAS true', () => {
  const r = detect({
    ghContext: {
      payload: {
        repository: {
          visibility: 'private',
          security_and_analysis: { advanced_security: { status: 'enabled' } },
        },
      },
    },
    env: {},
  });
  assert.equal(r.visibility, 'private');
  assert.equal(r.hasGHAS, true);
  assert.equal(r.forced, false);
});

test('private repo with no security_and_analysis field → hasGHAS false', () => {
  const r = detect({
    ghContext: { payload: { repository: { visibility: 'private' } } },
    env: {},
  });
  assert.equal(r.visibility, 'private');
  assert.equal(r.hasGHAS, false);
});

test('private repo with advanced_security.status=disabled → hasGHAS false', () => {
  const r = detect({
    ghContext: {
      payload: {
        repository: {
          visibility: 'private',
          security_and_analysis: { advanced_security: { status: 'disabled' } },
        },
      },
    },
    env: {},
  });
  assert.equal(r.hasGHAS, false);
});

test('HASHIRA_FORCE_PRIVATE_NO_GHAS=1 → forced override regardless of context', () => {
  const r = detect({
    ghContext: {
      payload: {
        repository: {
          visibility: 'public',
          security_and_analysis: { advanced_security: { status: 'enabled' } },
        },
      },
    },
    env: { HASHIRA_FORCE_PRIVATE_NO_GHAS: '1' },
  });
  assert.equal(r.visibility, 'private');
  assert.equal(r.hasGHAS, false);
  assert.equal(r.forced, true);
});

test('HASHIRA_FORCE_PRIVATE_NO_GHAS=0 → not forced (only "1" triggers override)', () => {
  const r = detect({
    ghContext: { payload: { repository: { visibility: 'public' } } },
    env: { HASHIRA_FORCE_PRIVATE_NO_GHAS: '0' },
  });
  assert.equal(r.visibility, 'public');
  assert.equal(r.hasGHAS, true);
  assert.equal(r.forced, false);
});

test('completely missing ghContext / env → safe defaults (private, no GHAS)', () => {
  const r = detect({});
  assert.equal(r.visibility, 'private');
  assert.equal(r.hasGHAS, false);
  assert.equal(r.forced, false);
});

test('missing repository.visibility but field tree present → defaults to private', () => {
  const r = detect({
    ghContext: { payload: { repository: {} } },
    env: {},
  });
  assert.equal(r.visibility, 'private');
  assert.equal(r.hasGHAS, false);
});

test('called with no arguments at all → safe defaults', () => {
  const r = detect();
  assert.equal(r.visibility, 'private');
  assert.equal(r.hasGHAS, false);
  assert.equal(r.forced, false);
});
