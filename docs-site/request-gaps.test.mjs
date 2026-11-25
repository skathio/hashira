// Cases the request's lines imply that the first tests left open: inputs left out or of the
// wrong type, link targets with a query, an escape or the repo root, H1 forms GitHub accepts,
// template refs GitHub reads the same as the plain form, and the CI wiring of the
// getting-started contract. The release logic is CommonJS under tests/release/lib; it is loaded
// here so every such case sits in one file, which `node --test docs-site/` runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { rewriteLink } from './links.mjs'
import { h1Label } from './h1-label.mjs'

const repoFile = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const { checkRelease, planPublish, latestCiConclusion, hashiraRefs } =
  createRequire(import.meta.url)(repoFile('tests/release/lib/release.js'))

const GITHUB = 'https://github.com/skathio/hashira/blob/main/'
const opts = { unpublished: ['contributing.md'], rewrites: { 'getting-started.md': 'index.md' } }
const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

// --- Links that leave docs/ or reach an unpublished page ---

test('an outbound link keeps its escapes, so the GitHub URL holds no raw space', () => {
  assert.equal(rewriteLink('usage.md', '../templates/a%20b.yml#L3', opts), `${GITHUB}templates/a%20b.yml#L3`)
})

test('a query on an outbound or unpublished link is kept with the anchor', () => {
  assert.equal(rewriteLink('usage.md', '../templates/npm/ci.yml?plain=1#L2', opts), `${GITHUB}templates/npm/ci.yml?plain=1#L2`)
  assert.equal(rewriteLink('usage.md', 'contributing.md?plain=1#checklist', opts), `${GITHUB}docs/contributing.md?plain=1#checklist`)
  assert.equal(rewriteLink('usage.md', './flows/npm.md?x=1', opts), null, 'a published page stays with VitePress')
})

test('a link to the repo root opens the repo on GitHub, not a blob named "."', () => {
  assert.equal(rewriteLink('usage.md', '..', opts), 'https://github.com/skathio/hashira/tree/main/')
  assert.equal(rewriteLink('flows/npm.md', '../../#readme', opts), 'https://github.com/skathio/hashira/tree/main/#readme')
})

test('a page or href left out, or not a string, is left alone', () => {
  for (const args of [[], ['usage.md'], ['usage.md', undefined, opts], ['usage.md', 5, opts], ['usage.md', null, opts],
    [undefined, '../README.md', opts], [5, '../README.md', opts], ['usage.md', '', opts]]) {
    assert.equal(rewriteLink(...args), null, JSON.stringify(args))
  }
})

// --- The sidebar label of an unlisted page: its H1 ---

test('an H1 in any form GitHub renders is the label', () => {
  assert.equal(h1Label('# Title #\n', 'f.md'), 'Title', 'closing hashes are not part of the heading')
  assert.equal(h1Label('   # Indented\n', 'f.md'), 'Indented', 'up to three leading spaces')
  assert.equal(h1Label('Setext title\n===\n\ntext\n', 'f.md'), 'Setext title')
  assert.equal(h1Label('# See [the guide](./usage.md)\n', 'f.md'), 'See the guide')
  assert.equal(h1Label('# C# notes\n', 'f.md'), 'C# notes', 'a hash inside a word stays')
})

test('a page with no usable H1 falls back to its file name', () => {
  assert.equal(h1Label('# \n\ntext\n', 'f.md'), 'f.md', 'an empty H1 would leave a blank sidebar entry')
  assert.equal(h1Label('#\n', 'f.md'), 'f.md')
  assert.equal(h1Label('## Only an H2\n', 'f.md'), 'f.md')
  assert.equal(h1Label('    # code, four spaces in\n', 'f.md'), 'f.md')
  assert.equal(h1Label('', 'f.md'), 'f.md')
  for (const wrong of [undefined, null, 5, {}]) {
    assert.equal(h1Label(wrong, 'f.md'), 'f.md', String(wrong))
  }
})

// --- Release refusals ---

const caller = (line) => `jobs:\n  ci:\n    ${line}\n`
const check = (overrides) => checkRelease({
  bump: 'patch', tags: ['v2.0.1', 'v3', 'v3.0.0', 'v3.1.0'], ciConclusion: 'success',
  templates: { 'templates/npm/ci.yml': caller('uses: skathio/hashira/.github/workflows/npm-package-ci.yml@v3') }, ...overrides,
})

test('a template ref GitHub reads as hashira is checked however it is spelled', () => {
  // GitHub matches the owner and repo of a `uses:` without regard to case, and YAML allows a quoted key.
  for (const line of [
    'uses: Skathio/Hashira/.github/workflows/npm-package-ci.yml@v2',
    'uses:   skathio/hashira/.github/workflows/npm-package-ci.yml@v2',
    '"uses": skathio/hashira/.github/workflows/npm-package-ci.yml@v2',
    "'uses': 'skathio/hashira/.github/workflows/npm-package-ci.yml@v2'",
  ]) {
    assert.deepEqual(hashiraRefs(caller(line)), ['v2'], line)
    assert.throws(() => check({ templates: { 'templates/npm/ci.yml': caller(line) } }), /release refused: .*@v2/, line)
  }
  assert.equal(check().version, '3.1.1')
})

test('templates that are not a map of file to text are refused, not read as empty', () => {
  for (const templates of [['uses: skathio/hashira/x/y@v3'], { 'templates/npm/ci.yml': null },
    { 'templates/npm/ci.yml': undefined }, { 'templates/npm/ci.yml': 5 }]) {
    assert.throws(() => check({ templates }), /release refused/, JSON.stringify(templates))
  }
})

test('the CI conclusion is read only for a named 40-character commit', () => {
  const runs = [{ status: 'completed', conclusion: 'success', created_at: '2026-11-01T10:00:00Z' }]
  assert.equal(latestCiConclusion(runs), null, 'a run with no head_sha must not match a SHA left out')
  assert.equal(latestCiConclusion(runs, undefined), null)
  assert.equal(latestCiConclusion([{ ...runs[0], head_sha: 'main' }], 'main'), null)
  assert.equal(latestCiConclusion([{ ...runs[0], head_sha: HEAD }], HEAD), 'success')
})

test('planPublish takes the commit as a string and the tags as a map', () => {
  const ok = { version: '3.1.1', sha: HEAD, tags: { v3: OTHER }, releaseExists: false }
  assert.deepEqual(planPublish(ok), { tag: 'create', release: 'create', majorTag: 'move', majorTagName: 'v3' })
  for (const bad of [{ sha: [HEAD] }, { sha: 1 }, { tags: ['v3.1.1'] }, { tags: 'v3.1.1' }, { releaseExists: 1 }]) {
    assert.throws(() => planPublish({ ...ok, ...bad }), /release refused/, JSON.stringify(bad))
  }
})

test('the ends of the tag list: no tag, one tag, and the frozen majors either side of v3', () => {
  assert.throws(() => check({ tags: [] }))
  assert.throws(() => check({ tags: undefined }))
  assert.equal(check({ tags: ['v3.0.0'] }).version, '3.0.1')
  // v2.x: patch and minor stay in the frozen v2; major leaves it for v3.
  assert.throws(() => check({ tags: ['v2.0.1'], templates: { t: caller('uses: skathio/hashira/a/b@v2') } }), /frozen/)
  assert.equal(check({ tags: ['v2.0.1'], bump: 'major' }).version, '3.0.0')
  // v1.x: major lands on the frozen v2.
  assert.throws(() => check({ tags: ['v1.1.0'], bump: 'major', templates: { t: caller('uses: skathio/hashira/a/b@v2') } }), /frozen/)
})

// --- A new test gets a job in _self-ci.yml ---

test('_self-ci.yml and CLAUDE.md run the getting-started contract test', () => {
  const command = 'python3 tests/getting-started/test_getting_started.py'
  assert.ok(readFileSync(repoFile('.github/workflows/_self-ci.yml'), 'utf8').includes(command), '_self-ci.yml runs it')
  assert.ok(readFileSync(repoFile('CLAUDE.md'), 'utf8').includes(command), "CLAUDE.md's Commands list it")
})
