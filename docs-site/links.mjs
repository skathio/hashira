// How the docs read the same on the site as on GitHub: where a relative link goes, the
// heading ids its #anchor names, and Actions expressions shown as text. config.mts wires
// these into VitePress's Markdown renderer.
import { posix } from 'node:path'

const REPO = 'https://github.com/skathio/hashira'

// Where a relative link on a page (a path relative to docs/) points: its path from the repo
// root, decoded to compare with file names and as written to build a URL, plus its ?query and
// #anchor. null for links left alone (URLs, site paths, in-page anchors, and anything that is
// not a link at all).
function resolveLink(page, href) {
  if (typeof page !== 'string' || typeof href !== 'string' || href === '' || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) {
    return null
  }
  const at = href.search(/[?#]/)
  const cut = at < 0 ? href.length : at
  const fromRoot = (file) => posix.normalize(posix.join('docs', posix.dirname(page), file))
  try {
    return { path: fromRoot(decodeURI(href.slice(0, cut))), written: fromRoot(href.slice(0, cut)), rest: href.slice(cut) }
  } catch {
    return null
  }
}

// The href a link should have on the site, or null to keep it. A link that leaves docs/, or
// reaches an unpublished page, goes to the file on GitHub with its ?query and #anchor; the
// path stays as the page wrote it, escapes included. A link to the repo root opens the repo.
// A link to a folder of docs/ that has no page (isFolder says which) opens that folder on
// GitHub, as it does when the page is read there. A link to a page that `rewrites` moved
// follows it. Every other relative link is left to VitePress's dead-link check, and so is one
// that leaves the repo.
export function rewriteLink(page, href, { unpublished = [], rewrites = {}, isFolder = () => false } = {}) {
  const target = resolveLink(page, href)
  if (!target || target.path === '..' || target.path.startsWith('../')) {
    return null
  }
  const { path, written, rest } = target
  if (path === '.' || path === './') {
    return `${REPO}/tree/main/${rest}`
  }
  if (!path.startsWith('docs/') || unpublished.some((f) => path === `docs/${f}`)) {
    return `${REPO}/blob/main/${written}${rest}`
  }
  if (path.endsWith('/') && isFolder(path)) {
    return `${REPO}/tree/main/${written}${rest}`
  }
  // Own keys only: a link named `constructor` or `__proto__` must not find Object's own members.
  const key = path.slice('docs/'.length)
  const moved = Object.hasOwn(rewrites, key) ? rewrites[key] : undefined
  return typeof moved === 'string' ? posix.relative(posix.dirname(page), moved) + rest : null
}

// GitHub's heading id: lower case, punctuation dropped, each space a hyphen, and runs of
// hyphens kept (VitePress's own slugify merges them), so `#the-ci--passed-check` lands.
export function githubSlug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-')
}

// VitePress compiles each page as a Vue template, so `${{ github.token }}` in prose or inline
// code would run as Vue code. Rendered text has its braces written as entities instead.
export function escapeBraces(html) {
  return html.replace(/[{}]/g, (c) => (c === '{' ? '&#123;' : '&#125;'))
}
