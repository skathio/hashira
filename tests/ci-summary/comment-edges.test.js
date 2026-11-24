// Edge cases of ci-summary's comment body: values in job outputs that do not
// have the shape they must have, and a commitlint report that tries to break
// out of its code block. Malformed values render as "n/a" or "not run",
// never as themselves.
//
// Run locally with:  node --test tests/ci-summary/comment-edges.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { renderBody, MARKER } = require(path.join(__dirname, '..', '..', '.github', 'actions', 'ci-summary', 'lib', 'comment.js'));

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const EVENT = {
  pull_request: { head: { sha: HEAD } },
  repository: { html_url: 'https://github.com/acme/widget' },
};

function needs(overrides = {}) {
  return {
    lint: { result: 'success', outputs: { commitlint_result: 'clean' } },
    test: { result: 'success', outputs: { lines_pct: '80', branches_pct: '70' } },
    'scan-suite': { result: 'success', outputs: { verdicts: 'codeql\tpass' } },
    'quality-gate': { result: 'success', outputs: { result: 'pass', violations: '0' } },
    ...overrides,
  };
}

const render = (n, extra = {}) => renderBody({ needs: n, inputs: {}, event: EVENT, runUrl: 'https://github.com/acme/widget/actions/runs/1', ...extra });

test('a scanner missing from the verdicts shows not run', () => {
  assert.match(render(needs()), /\| ⚪ \| \*\*OSV\*\* \| Not run · no result \|/);
});

test('an unknown scanner status or name is not rendered', () => {
  const body = render(needs({ 'scan-suite': { result: 'success', outputs: { verdicts: 'codeql\t<b>x</b>\nevil\tpass' } } }));
  assert.match(body, /\| ⚪ \| \*\*CodeQL\*\* \| Not run/);
  assert.doesNotMatch(body, /<b>|evil/);
});

test('a coverage value that is not a percentage renders as n/a', () => {
  const body = render(needs({ test: { result: 'success', outputs: { lines_pct: '](javascript:x)', branches_pct: '1000' } } }));
  assert.match(body, /\*\*Tests\*\* \| Passed · coverage n\/a \|/);
  assert.doesNotMatch(body, /javascript/);
});

test('a violation count that is not an integer is left out', () => {
  const body = render(needs({ 'quality-gate': { result: 'failure', outputs: { result: 'fail', violations: '3; rm' } } }));
  assert.match(body, /\| ❌ \| \*\*Quality gate\*\* \| Failed \|\n/);
  assert.doesNotMatch(body, /rm/);
});

test('a skipped test job shows not run, not pass', () => {
  assert.match(render(needs({ test: { result: 'skipped', outputs: {} } })), /\| ⚪ \| \*\*Tests\*\* \| Not run · job skipped \|/);
});

test('a commitlint report with a code fence cannot close the block it sits in', () => {
  const report = 'bad\n```\n# injected heading\n````';
  const body = render(needs({ lint: { result: 'success', outputs: { commitlint_result: 'findings', commitlint_report: report } } }));
  assert.ok(body.includes('`````\nbad\n'), body);
  assert.ok(body.trimEnd().endsWith('`````\n\n</details>'), body);
});

test('control characters in the report are replaced, newlines kept', () => {
  const report = 'one\u0007\r\ntwo\u001b[31m';
  const body = render(needs({ lint: { result: 'success', outputs: { commitlint_result: 'findings', commitlint_report: report } } }));
  assert.ok(body.includes('one \ntwo [31m'), body);
});

test('lint with no commitlint result says so', () => {
  assert.match(render(needs({ lint: { result: 'failure', outputs: {} } })), /\*\*commitlint\*\* \| Not run · no result \|/);
});

test('a head SHA that is not a SHA, and a run URL that is not https, are not linked', () => {
  const body = renderBody({ needs: needs(), inputs: {}, event: { pull_request: { head: { sha: 'x)(y' } } }, runUrl: 'javascript:alert(1)' });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /<sub>commit unknown · run unknown<\/sub>/);
  assert.doesNotMatch(body, /javascript|x\)\(y/);
});

test('called with nothing, it still renders a body that starts with the marker', () => {
  const body = renderBody();
  assert.ok(body.startsWith(MARKER));
  assert.doesNotMatch(body, /undefined|NaN|null/);
});
