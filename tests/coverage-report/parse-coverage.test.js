// Unit tests for the coverage-report parser shim. Uses node:test (stdlib;
// zero-install so this can run on `actions/setup-node` without npm install
// inside the action itself).
//
// Run locally with:  node --test tests/coverage-report/parse-coverage.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  parseCoverage,
  detectFormat,
} = require('../../.github/actions/coverage-report/lib/parse-coverage');

const FIX = path.resolve(__dirname, '..', 'fixtures', 'coverage-samples');

test('detectFormat: lcov by extension', () => {
  assert.equal(detectFormat(path.join(FIX, 'lcov.info')), 'lcov');
});

test('detectFormat: cobertura vs opencover by content sniff', () => {
  assert.equal(detectFormat(path.join(FIX, 'cobertura.xml')), 'cobertura');
  assert.equal(detectFormat(path.join(FIX, 'opencover.xml')), 'opencover');
});

test('parseCoverage: lcov totals + per-file', () => {
  const result = parseCoverage({ path: path.join(FIX, 'lcov.info') });
  // alpha: 3/4 lines, beta: 5/6 lines -> totals 8/10 = 80.0
  assert.equal(result.lines_pct, 80);
  // alpha branches: 1/2, beta branches: 2/2 -> totals 3/4 = 75.0
  assert.equal(result.branches_pct, 75);
  assert.equal(result.files.length, 2);
  const alpha = result.files.find((f) => f.path === 'src/alpha.js');
  const beta = result.files.find((f) => f.path === 'src/beta.js');
  assert.ok(alpha, 'expected alpha file entry');
  assert.ok(beta, 'expected beta file entry');
  assert.equal(alpha.lines_pct, 75);
  // 5/6 rounds to 83.3
  assert.equal(beta.lines_pct, 83.3);
});

test('parseCoverage: cobertura reads root line-rate + branch-rate', () => {
  const result = parseCoverage({ path: path.join(FIX, 'cobertura.xml') });
  assert.equal(result.lines_pct, 80); // 0.8 * 100
  assert.equal(result.branches_pct, 50); // 0.5 * 100
  assert.equal(result.files.length, 2);
  const alpha = result.files.find((f) => f.path === 'src/Alpha.cs');
  const beta = result.files.find((f) => f.path === 'src/Beta.cs');
  assert.ok(alpha && beta);
  // Alpha: 3 hit / 4 total -> 75.0
  assert.equal(alpha.lines_pct, 75);
  // Beta: 5 hit / 6 total -> 83.3
  assert.equal(beta.lines_pct, 83.3);
});

test('parseCoverage: opencover aggregates root sequence points + per-file', () => {
  const result = parseCoverage({ path: path.join(FIX, 'opencover.xml') });
  assert.equal(result.lines_pct, 80); // 8 / 10
  assert.equal(result.branches_pct, 0); // not implemented in v1
  assert.equal(result.files.length, 2);
  const alpha = result.files.find((f) => f.path === 'src/Alpha.cs');
  const beta = result.files.find((f) => f.path === 'src/Beta.cs');
  assert.ok(alpha && beta);
  assert.equal(alpha.lines_pct, 75);
  assert.equal(beta.lines_pct, 83.3);
});

test('parseCoverage: opencover with reordered root Summary still parses root rollup', () => {
  // Regression guard for the depth-tracking fix in walkXml. The fixture
  // places the per-<Class> <Summary> elements BEFORE the top-level
  // <CoverageSession> <Summary>; the parser must still pick the root
  // (depth-2) Summary, not the first one in document order.
  const result = parseCoverage({
    path: path.join(FIX, 'opencover-reordered.xml'),
  });
  assert.equal(result.lines_pct, 80); // 8 / 10 — root rollup, not a per-class 3/4 or 5/6
  assert.equal(result.files.length, 2);
  const alpha = result.files.find((f) => f.path === 'src/Alpha.cs');
  const beta = result.files.find((f) => f.path === 'src/Beta.cs');
  assert.ok(alpha && beta);
  assert.equal(alpha.lines_pct, 75);
  assert.equal(beta.lines_pct, 83.3);
});

test('parseCoverage: cobertura with method-level <lines> does not double-count', () => {
  // Regression guard for the inMethod flag in parseCobertura. The fixture
  // emits <lines> both at <class> level and inside <method>; per-file
  // line totals must reflect class-level only (4 lines for Alpha, 6 for
  // Beta), not the doubled values (8 / 12).
  const result = parseCoverage({
    path: path.join(FIX, 'cobertura-method-lines.xml'),
  });
  assert.equal(result.files.length, 2);
  const alpha = result.files.find((f) => f.path === 'src/Alpha.cs');
  const beta = result.files.find((f) => f.path === 'src/Beta.cs');
  assert.ok(alpha && beta);
  // Alpha: 3 covered of 4 (NOT 6 of 8) -> 75.0
  assert.equal(alpha.lines_pct, 75);
  // Beta: 5 covered of 6 (NOT 10 of 12) -> 83.3
  assert.equal(beta.lines_pct, 83.3);
});

test('parseCoverage: explicit format overrides auto-detect', () => {
  const result = parseCoverage({
    path: path.join(FIX, 'lcov.info'),
    format: 'lcov',
  });
  assert.equal(result.lines_pct, 80);
});

test('parseCoverage: missing file throws', () => {
  assert.throws(
    () => parseCoverage({ path: path.join(FIX, 'does-not-exist.info') }),
    /file not found/
  );
});

test('parseCoverage: unknown extension without explicit format throws', () => {
  const tmp = path.join(require('node:os').tmpdir(), 'hashira-cov.bogus');
  require('node:fs').writeFileSync(tmp, 'irrelevant');
  try {
    assert.throws(
      () => parseCoverage({ path: tmp }),
      /cannot auto-detect format/
    );
  } finally {
    require('node:fs').unlinkSync(tmp);
  }
});
