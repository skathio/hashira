// How the docs read the same on the site as on GitHub: where a relative link goes, the
// heading ids its #anchor names, and Actions expressions shown as text. The VitePress config
// (vitepress/.vitepress/config.mts) wires these into the Markdown renderer.

'use strict';

const { posix } = require('node:path');

// Where a relative link on a page (a path relative to docs/) points: its path from the repo
// root, decoded to compare with file names and as written to build a URL, plus its ?query and
// #anchor. null for links left alone (URLs, site paths, in-page anchors, and anything that is
// not a link at all).
function resolveLink(page, href) {
  if (typeof page !== 'string' || typeof href !== 'string' || href === '' || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) {
    return null;
  }
  const at = href.search(/[?#]/);
  const cut = at < 0 ? href.length : at;
  const fromRoot = (file) => posix.normalize(posix.join('docs', posix.dirname(page), file));
  try {
    return { path: fromRoot(decodeURI(href.slice(0, cut))), written: fromRoot(href.slice(0, cut)), rest: href.slice(cut) };
  } catch {
    return null;
  }
}

// Whether a page (a path relative to docs/) is unpublished: an entry names a page, or a folder
// whose pages are all unpublished ('internal' and 'internal/' cover internal/x.md, not
// internalx/y.md).
const isUnpublished = (rel, unpublished) => unpublished.some((u) => rel === u || rel.startsWith(`${u.replace(/\/$/, '')}/`));

// The href a link should have on the site, or null to keep it. `repo` is the repo's GitHub URL
// (https://github.com/<owner>/<repo>) and `ref` the branch or commit its file links name.
//
// A link that leaves docs/, or reaches an unpublished page, goes to the file on GitHub with its
// ?query and #anchor; the path stays as the page wrote it, escapes included. A link to the repo
// root opens the repo, and one to a folder opens it as a folder: a path that ends in '/' names
// one, and so does any other that isRepoDir finds is a folder of the checkout. A link to a folder of docs/ that has no page (isFolder
// says which) opens that folder on GitHub, as it does when the page is read there. A link to a page that
// `rewrites` moved follows it. Every other relative link is left to VitePress's dead-link
// check, and so is one that leaves the repo.
function rewriteLink(page, href, { repo, ref = 'HEAD', unpublished = [], rewrites = {}, isFolder = () => false, isRepoDir = () => false } = {}) {
  const target = resolveLink(page, href);
  if (!target || target.path === '..' || target.path.startsWith('../')) {
    return null;
  }
  const { path, written, rest } = target;
  const github = (kind, file) => `${repo}/${kind}/${ref}/${file}${rest}`;
  if (path === '.' || path === './') {
    return github('tree', '');
  }
  if (!path.startsWith('docs/') || isUnpublished(path.slice('docs/'.length), unpublished)) {
    return github(path.endsWith('/') || isRepoDir(path) ? 'tree' : 'blob', written);
  }
  if (path.endsWith('/') && isFolder(path)) {
    return github('tree', written);
  }
  // Own keys only: a link named `constructor` or `__proto__` must not find Object's own members.
  const key = path.slice('docs/'.length);
  const moved = Object.hasOwn(rewrites, key) ? rewrites[key] : undefined;
  return typeof moved === 'string' ? posix.relative(posix.dirname(page), moved) + rest : null;
}

// GitHub's heading id: lower case, punctuation dropped, each space a hyphen, and runs of
// hyphens kept (VitePress's own slugify merges them), so `#the-ci--passed-check` lands.
function githubSlug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
}

// VitePress compiles each page as a Vue template, so `${{ github.token }}` in prose or inline
// code would run as Vue code. Rendered text has its braces written as entities instead.
function escapeBraces(html) {
  return html.replace(/[{}]/g, (c) => (c === '{' ? '&#123;' : '&#125;'));
}

// Text for a place VitePress renders as HTML (v-html: the sidebar, the nav, the site title):
// a label from pages.json or a heading shows as written, never as markup.
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// The in-page #anchors of a rendered page that match no id on it, decoded, each once. An
// anchor that is not valid percent-encoding is compared as written.
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// A numeric entity past U+10FFFF names no character: it is kept as written, never thrown on.
const codePoint = (m, value) => (value <= 0x10ffff ? String.fromCodePoint(value) : m);
const unescapeHtml = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (m, d, h, n) => (n ? ENTITY[n.toLowerCase()] : codePoint(m, d ? Number(d) : parseInt(h, 16))));

function decodeAnchor(anchor) {
  try {
    return decodeURIComponent(anchor);
  } catch {
    return anchor;
  }
}

function missingAnchors(html) {
  const ids = new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => unescapeHtml(m[1])));
  const anchors = [...html.matchAll(/\shref="#([^"]+)"/g)].map((m) => decodeAnchor(unescapeHtml(m[1])));
  return [...new Set(anchors.filter((a) => !ids.has(a)))];
}

module.exports = { rewriteLink, isUnpublished, githubSlug, escapeBraces, escapeHtml, missingAnchors };
