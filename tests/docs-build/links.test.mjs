// Unit rules for docs-build's lib/links.js as hashira's own docs use it: link targets, GitHub
// heading ids and brace escaping. Moved from docs-site/ when the docs moved onto docs-build;
// tests/pages-site/hashira-site.test.js checks the same behaviour on the built site.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { escapeBraces, githubSlug, rewriteLink } = createRequire(import.meta.url)('../../.github/actions/docs-build/lib/links.js')

const REPO = 'https://github.com/skathio/hashira'
const GITHUB = `${REPO}/blob/main/`
const opts = { repo: REPO, ref: 'main', unpublished: ['contributing.md'], rewrites: { 'getting-started.md': 'index.md' }, isFolder: (p) => p === 'docs/flows/' }

test('links that leave docs/ go to the GitHub blob with the anchor kept', () => {
  assert.equal(rewriteLink('catalog.md', '../README.md#hashira', opts), `${GITHUB}README.md#hashira`)
  assert.equal(rewriteLink('flows/npm.md', '../../templates/npm/ci.yml', opts), `${GITHUB}templates/npm/ci.yml`)
  assert.equal(rewriteLink('usage.md', '../.github/actions/version-resolver/action.yml', opts),
    `${GITHUB}.github/actions/version-resolver/action.yml`)
})

test('links to an unpublished page go to GitHub from any folder', () => {
  assert.equal(rewriteLink('usage.md', './contributing.md', opts), `${GITHUB}docs/contributing.md`)
  assert.equal(rewriteLink('usage.md', 'contributing.md#checklist', opts), `${GITHUB}docs/contributing.md#checklist`)
  assert.equal(rewriteLink('flows/nuget.md', '../contributing.md#adding-an-action', opts), `${GITHUB}docs/contributing.md#adding-an-action`)
})

test('links between published pages are left to VitePress', () => {
  assert.equal(rewriteLink('flows/npm.md', '../usage.md#gate-model', opts), null)
  assert.equal(rewriteLink('usage.md', './flows/npm.md', opts), null)
  assert.equal(rewriteLink('usage.md', 'missing.md', opts), null, 'a dead link must reach the dead-link check')
  assert.equal(rewriteLink('flows/npm.md', '../no-such-page.md#here', opts), null)
})

test('URLs, site paths, in-page anchors and links out of the repo are left alone', () => {
  for (const href of ['https://example.com/a.md', 'mailto:x@example.com', '/hashira/', '#pin-policy', '../../x.md']) {
    assert.equal(rewriteLink('usage.md', href, opts), null, href)
  }
  assert.equal(rewriteLink('flows/npm.md', '../../../x.md', opts), null)
  assert.equal(rewriteLink('usage.md', '%E0%A4%A.md', opts), null, 'a malformed escape is left to VitePress')
})

test('a link to a folder of docs/ with no page opens the folder on GitHub', () => {
  assert.equal(rewriteLink('usage.md', './flows/', opts), 'https://github.com/skathio/hashira/tree/main/docs/flows/')
  assert.equal(rewriteLink('usage.md', './nope/', opts), null, 'a missing folder is left to the dead-link check')
})

test('a link to a rewritten page follows it, relative to the linking page', () => {
  assert.equal(rewriteLink('usage.md', './getting-started.md#next-steps', opts), 'index.md#next-steps')
  assert.equal(rewriteLink('flows/npm.md', '../getting-started.md', opts), '../index.md')
})

test('options left out mean nothing is unpublished, rewritten or a folder, and links name HEAD', () => {
  assert.equal(rewriteLink('usage.md', 'contributing.md', { repo: REPO }), null)
  assert.equal(rewriteLink('usage.md', '../README.md', { repo: REPO }), `${REPO}/blob/HEAD/README.md`)
})

test('heading ids follow GitHub: punctuation dropped, hyphen runs kept, leading digits kept', () => {
  assert.equal(githubSlug('The `ci — passed` check'), 'the-ci--passed-check')
  assert.equal(githubSlug('1. Choose a flow'), '1-choose-a-flow')
  assert.equal(githubSlug('Auth model — `auth: oidc | token | auto`'), 'auth-model--auth-oidc--token--auto')
  assert.equal(githubSlug('Not workflow_run'), 'not-workflow_run')
})

test('braces in rendered text become entities, so Vue never evaluates them', () => {
  assert.equal(escapeBraces('<code>${{ github.token }}</code>'), '<code>$&#123;&#123; github.token &#125;&#125;</code>')
  assert.equal(escapeBraces('no braces'), 'no braces')
})
