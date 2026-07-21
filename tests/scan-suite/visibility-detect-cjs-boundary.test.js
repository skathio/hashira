'use strict';

// Regression test for a real incident: a consumer with `"type": "module"`
// in their own package.json caused `require(GITHUB_WORKSPACE +
// "/.hashira/.github/actions/scan-suite/lib/visibility-detect.js")` to be
// misresolved as an ES module (no `.hashira`-local package.json existed to
// stop Node's CJS/ESM boundary walk before it reached the consumer's own
// root). require() didn't throw — it silently returned an object with no
// `detect` export, which then failed downstream as "detect is not a
// function". Fixed by the repo-root `package.json` (`"type": "commonjs"`).
// Self-CI can't catch this by running the real require() line against its
// own tree (hashira itself has no ESM-typed package.json), so this test
// fabricates the exact vulnerable shape instead: a real (not symlinked —
// Node resolves symlinks to their real path before walking up for package
// boundaries, which would silently skip the fake consumer root and defeat
// the repro) copy of this repo's `.github/` + `package.json` sitting in a
// `.hashira/` dir under an ESM-typed consumer root, exactly as
// `actions/checkout` lays it out in CI.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

test('visibility-detect.js resolves as CommonJS under an ESM-typed consumer workspace', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hashira-cjs-boundary-'));
  try {
    fs.writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({ name: 'fake-esm-consumer', type: 'module' })
    );
    const hashiraCheckout = path.join(workspace, '.hashira');
    fs.mkdirSync(hashiraCheckout);
    fs.cpSync(path.join(REPO_ROOT, '.github'), path.join(hashiraCheckout, '.github'), {
      recursive: true,
    });
    fs.cpSync(
      path.join(REPO_ROOT, 'package.json'),
      path.join(hashiraCheckout, 'package.json')
    );

    const out = execFileSync(
      process.execPath,
      [
        '-e',
        'const { detect } = require(process.env.GITHUB_WORKSPACE + ' +
          '"/.hashira/.github/actions/scan-suite/lib/visibility-detect.js"); ' +
          'console.log(typeof detect);',
      ],
      { env: { ...process.env, GITHUB_WORKSPACE: workspace }, encoding: 'utf8' }
    );

    assert.equal(out.trim(), 'function');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
