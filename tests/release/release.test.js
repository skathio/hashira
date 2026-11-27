// Unit tests for tests/release/lib/release.js: the decisions release.yml
// makes before anything is approved or pushed, and the idempotent plan for
// the tag, the GitHub Release and the major tag. Pure calls, no git or gh.
//
// Run locally with:  node --test tests/release/release.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkRelease, planPublish } = require('./lib/release.js');

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TAGS = ['v2.0.1', 'v3', 'v3.0.0', 'v3.1.0'];
const ROOT = path.join(__dirname, '..', '..');

// The real caller templates, which name @v3 today.
function realTemplates() {
  const out = {};
  for (const flow of fs.readdirSync(path.join(ROOT, 'templates'))) {
    const file = path.join(ROOT, 'templates', flow, 'ci.yml');
    if (fs.existsSync(file)) out[`templates/${flow}/ci.yml`] = fs.readFileSync(file, 'utf8');
  }
  return out;
}

function caller(ref) {
  return [
    'jobs:',
    '  ci:',
    `    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@${ref}`,
    '  release:',
    '    steps:',
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    `      - uses: skathio/hashira/.github/actions/npm-release@${ref}`,
    '',
  ].join('\n');
}

function check(overrides) {
  return checkRelease({
    bump: 'patch', tags: TAGS, ciConclusion: 'success', templates: realTemplates(), ...overrides,
  });
}

test('the real templates exist and name hashira', () => {
  const t = realTemplates();
  assert.ok(Object.keys(t).length >= 3);
  for (const body of Object.values(t)) assert.match(body, /uses: skathio\/hashira\/\S+@v3\b/);
});

// The version comes from version-resolver: patch and minor advance the
// current major, major produces v(N+1).0.0.
test('patch from v2.0.1, v3, v3.0.0, v3.1.0 resolves 3.1.1 and major tag v3', () => {
  const r = check({ bump: 'patch' });
  assert.equal(r.version, '3.1.1');
  assert.equal(r.tag, 'v3.1.1');
  assert.equal(r.majorTag, 'v3');
});

test('minor from the same tags resolves 3.2.0 and major tag v3', () => {
  const r = check({ bump: 'minor' });
  assert.equal(r.version, '3.2.0');
  assert.equal(r.tag, 'v3.2.0');
  assert.equal(r.majorTag, 'v3');
});

test('major from the same tags resolves 4.0.0 and major tag v4', () => {
  const r = check({ bump: 'major', templates: { 'templates/npm/ci.yml': caller('v4') } });
  assert.equal(r.version, '4.0.0');
  assert.equal(r.tag, 'v4.0.0');
  assert.equal(r.majorTag, 'v4');
});

test('a bump other than patch, minor or major is refused', () => {
  for (const bump of [undefined, '', 'Patch', 'premajor', 1, null]) {
    assert.throws(() => check({ bump }), `bump ${JSON.stringify(bump)}`);
  }
});

// Refusal: the latest completed _self-ci.yml run for HEAD is not success.
test('CI conclusion success passes; any other conclusion is refused', () => {
  assert.equal(check({ ciConclusion: 'success' }).version, '3.1.1');
  for (const c of ['failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'SUCCESS']) {
    assert.throws(() => check({ ciConclusion: c }), c);
  }
});

test('no completed CI run for HEAD is refused', () => {
  assert.throws(() => check({ ciConclusion: null }));
  assert.throws(() => check({ ciConclusion: undefined }));
  assert.throws(() => check({ ciConclusion: '' }));
});

// Refusal: the resolved version's major is 1 or 2.
test('a resolved major of 1 is refused', () => {
  assert.throws(() => check({ tags: ['v1.0.0'], bump: 'patch', templates: { 'templates/npm/ci.yml': caller('v1') } }));
  assert.throws(() => check({ tags: ['v1.4.2'], bump: 'minor', templates: { 'templates/npm/ci.yml': caller('v1') } }));
});

test('a resolved major of 2 is refused, including a major bump from v1', () => {
  assert.throws(() => check({ tags: ['v1.4.2'], bump: 'major', templates: { 'templates/npm/ci.yml': caller('v2') } }));
  assert.throws(() => check({ tags: ['v2.0.1'], bump: 'patch', templates: { 'templates/npm/ci.yml': caller('v2') } }));
  assert.throws(() => check({ tags: ['v2.0.1'], bump: 'minor', templates: { 'templates/npm/ci.yml': caller('v2') } }));
});

test('a resolved major of 3, just past 2, passes', () => {
  const r = check({ tags: ['v2.0.1'], bump: 'major', templates: { 'templates/npm/ci.yml': caller('v3') } });
  assert.equal(r.version, '3.0.0');
  assert.equal(r.majorTag, 'v3');
});

// Refusal: a uses: skathio/hashira/...@ ref in templates/*/ci.yml names
// another major than the resolved version's.
test('one template naming the resolved major passes', () => {
  assert.equal(check({ templates: { 'templates/npm/ci.yml': caller('v3') } }).version, '3.1.1');
});

test('a template ref to a full version of the resolved major passes', () => {
  assert.equal(check({ templates: { 'templates/npm/ci.yml': caller('v3.1.0') } }).version, '3.1.1');
});

test('a template with no hashira ref raises no refusal', () => {
  const t = { ...realTemplates(), 'templates/other/ci.yml': 'jobs:\n  x:\n    runs-on: ubuntu-latest\n' };
  assert.equal(check({ templates: t }).version, '3.1.1');
});

test('a template naming another major is refused', () => {
  for (const ref of ['v4', 'v2', 'v4.0.0', 'v2.1.0']) {
    assert.throws(() => check({ templates: { 'templates/npm/ci.yml': caller(ref) } }), ref);
  }
});

test('one mismatched template among good ones is refused', () => {
  const t = realTemplates();
  t['templates/nuget/ci.yml'] = t['templates/nuget/ci.yml'].replace(
    'skathio/hashira/.github/actions/nuget-push@v3', 'skathio/hashira/.github/actions/nuget-push@v4');
  assert.notEqual(t['templates/nuget/ci.yml'], realTemplates()['templates/nuget/ci.yml']);
  assert.throws(() => check({ templates: t }));
});

test('a single mismatched ref inside an otherwise good template is refused', () => {
  const body = caller('v3').replace('npm-release@v3', 'npm-release@v2');
  assert.throws(() => check({ templates: { 'templates/npm/ci.yml': body } }));
});

test('a major release is refused while the templates still name the current major', () => {
  assert.throws(() => check({ bump: 'major' }));
  assert.throws(() => check({ bump: 'major', templates: { 'templates/npm/ci.yml': caller('v3') } }));
});

// The idempotent plan. A tag already on the same commit, an existing
// Release and a major tag already on the commit count as done.
function plan(overrides) {
  return planPublish({ version: '3.1.1', sha: HEAD, tags: { 'v3.1.0': OTHER, v3: OTHER }, releaseExists: false, ...overrides });
}

test('a fresh release creates the tag and the Release and moves the major tag', () => {
  assert.deepEqual(plan(), { tag: 'create', release: 'create', majorTag: 'move', majorTagName: 'v3' });
});

test('the release tag already on the same commit counts as done', () => {
  const p = plan({ tags: { 'v3.1.0': OTHER, 'v3.1.1': HEAD, v3: OTHER } });
  assert.equal(p.tag, 'done');
  assert.equal(p.release, 'create');
  assert.equal(p.majorTag, 'move');
});

test('the release tag on a different commit is refused', () => {
  assert.throws(() => plan({ tags: { 'v3.1.1': OTHER, v3: OTHER } }));
});

test('an existing Release counts as done', () => {
  const p = plan({ tags: { 'v3.1.1': HEAD, v3: OTHER }, releaseExists: true });
  assert.equal(p.tag, 'done');
  assert.equal(p.release, 'done');
});

test('the major tag already on the commit counts as done', () => {
  const p = plan({ tags: { 'v3.1.1': HEAD, v3: HEAD }, releaseExists: true });
  assert.deepEqual(p, { tag: 'done', release: 'done', majorTag: 'done', majorTagName: 'v3' });
});

test('a new major creates its major tag and leaves the previous major tag alone', () => {
  const p = planPublish({
    version: '4.0.0', sha: HEAD, tags: { v2: OTHER, v3: OTHER, 'v3.1.0': OTHER }, releaseExists: false,
  });
  assert.deepEqual(p, { tag: 'create', release: 'create', majorTag: 'create', majorTagName: 'v4' });
});

test('a plan never names v1 or v2: versions of major 1 or 2 are refused', () => {
  assert.throws(() => planPublish({ version: '2.1.0', sha: HEAD, tags: { v2: OTHER }, releaseExists: false }));
  assert.throws(() => planPublish({ version: '1.0.1', sha: HEAD, tags: { v1: OTHER }, releaseExists: false }));
});
