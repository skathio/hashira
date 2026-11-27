// Loads and validates a repo's .github/pages.json, the file that describes its Pages site, and
// fills in the defaults (some from .github/homepage.json). Every check runs before VitePress
// does, and every failure throws an Error that names the field, so a bad file stops the build
// with a message the author can act on instead of a page that renders wrong.
//
// pages.json is data a pull request can edit, so nothing in it may reach a shell, a link
// scheme other than the allow-list, or a file outside the repo.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { errorOffset, lineColumn } = require('./json-error');

const PAGES = '.github/pages.json';
const HOMEPAGE = '.github/homepage.json';
const MAX_BYTES = 64 * 1024;
const DEFAULT_ACCENT = '#1e7d69';
const DEFAULT_HOME_PAGE = 'getting-started.md';
const HREF_PREFIXES = ['https://', 'http://', '/', './', '../', '#'];
const ACCENT_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const BASE_RE = /^\/(?:(?!\.{1,2}\/)[A-Za-z0-9._~%-]+\/)*$/;

const fail = (msg) => {
  throw new Error(`docs-build: ${PAGES}: ${msg}`);
};

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// ---------- shapes ----------

function expectType(field, value, type) {
  if (typeOf(value) !== type) fail(`${field} must be ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}, got ${typeOf(value)}`);
}

function checkString(field, value, { min = 0, max }) {
  expectType(field, value, 'string');
  if (value.length < min) fail(`${field} must not be empty`);
  if (value.length > max) fail(`${field} must be at most ${max} characters, got ${value.length}`);
}

function checkArray(field, value, max) {
  expectType(field, value, 'array');
  if (value.length > max) fail(`${field} must have at most ${max} entries, got ${value.length}`);
}

function checkAccent(field, value) {
  expectType(field, value, 'string');
  if (!ACCENT_RE.test(value)) fail(`${field} must be #rgb or #rrggbb, got ${JSON.stringify(value)}`);
}

function checkKeys(field, obj, allowed) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`unknown field ${field ? `${field}.` : ''}${key} (allowed: ${allowed.join(', ')})`);
  }
}

// A backslash reads as '/' in a browser's URL parser, so '/\\host/x' would leave the site, and a
// control character or DEL could split or hide the link.
function checkHref(field, href) {
  checkString(field, href, { min: 1, max: 2048 });
  if (/[\\\x00-\x1f\x7f]/.test(href)) fail(`${field} must not contain a backslash or a control character, got ${JSON.stringify(href)}`);
  if (!HREF_PREFIXES.some((p) => href.startsWith(p))) {
    fail(`${field} must start with one of ${HREF_PREFIXES.join(' ')}, got ${JSON.stringify(href)}`);
  }
}

function checkLink(field, entry, labelMax) {
  expectType(field, entry, 'object');
  checkKeys(field, entry, ['label', 'href']);
  checkString(`${field}.label`, entry.label, { min: 1, max: labelMax });
  checkHref(`${field}.href`, entry.href);
}

// ---------- paths ----------

// A repo-relative path: no absolute form, no '..' segment, no backslash or NUL that a later
// join could read differently.
function checkRelative(field, rel) {
  checkString(field, rel, { min: 1, max: 500 });
  if (path.isAbsolute(rel) || rel.startsWith('/')) fail(`${field} must be a relative path, got ${JSON.stringify(rel)}`);
  if (/[\\\0]/.test(rel)) fail(`${field} must not contain a backslash or NUL, got ${JSON.stringify(rel)}`);
  if (rel.split('/').includes('..')) fail(`${field} must not contain a '..' segment, got ${JSON.stringify(rel)}`);
  // Paths are compared as strings later (unpublished, sidebar), so each has one spelling:
  // no '.' or empty segment. A folder may end in one '/'.
  if (rel.replace(/\/$/, '').split('/').some((seg) => seg === '' || seg === '.')) {
    fail(`${field} must be a normalized path, with no '.' or empty segment, got ${JSON.stringify(rel)}`);
  }
}

// Resolves rel under base (inside repoRoot) and checks that the real file, after symlinks,
// stays inside the repo. A missing file fails unless allowMissing, which returns false for it
// instead (true when it is there).
function checkFile(ctx, field, rel, { base = '.', allowMissing = false } = {}) {
  checkRelative(field, rel);
  const full = path.join(ctx.root, base, rel);
  let real;
  try {
    real = fs.realpathSync(full);
  } catch {
    if (allowMissing) return false;
    fail(`${field}: ${path.posix.join(base, rel)} not found`);
  }
  if (real !== ctx.realRoot && !real.startsWith(ctx.realRoot + path.sep)) {
    fail(`${field}: ${path.posix.join(base, rel)} resolves outside the repo`);
  }
  // The file is published, so a symlink with an ordinary name may not reach into .git (its
  // config can hold a token) or node_modules, nor to a file of another kind.
  const hidden = path.relative(ctx.realRoot, real).split(path.sep).find((seg) => seg === '.git' || seg === 'node_modules');
  if (hidden) fail(`${field}: ${path.posix.join(base, rel)} resolves into ${hidden}, which is never published`);
  if (path.extname(real).toLowerCase() !== path.extname(rel).toLowerCase()) {
    fail(`${field}: ${path.posix.join(base, rel)} resolves to a file of another kind`);
  }
  if (!allowMissing && !fs.statSync(real).isFile()) fail(`${field}: ${path.posix.join(base, rel)} is not a file`);
  return true;
}

function checkExtension(field, rel, exts) {
  if (!exts.some((ext) => rel.toLowerCase().endsWith(ext))) fail(`${field} must end in ${exts.join(' or ')}, got ${JSON.stringify(rel)}`);
}

// ---------- reading ----------

// JSON.parse's message names a position on some Node versions and errors, and nothing on
// others (Node 26: "Unexpected token ','"), so the line and column come from a scan of the
// text instead of from the message.
function parseError(text, err) {
  const offset = errorOffset(text);
  if (offset < 0) return err.message;
  return `${lineColumn(text, offset)}: ${err.message}`;
}

function readPages(root) {
  const file = path.join(root, PAGES);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`docs-build: ${PAGES} not found in ${root}`);
  }
  if (!stat.isFile()) fail('is not a file');
  checkSize(fail, stat);
  const text = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    fail(`invalid JSON at ${parseError(text, err)}`);
  }
  if (typeOf(data) !== 'object') fail(`must hold a JSON object, got ${typeOf(data)}`);
  return data;
}

function checkSize(failWith, stat) {
  if (stat.size > MAX_BYTES) failWith(`is ${stat.size} bytes; the limit is 64 KB (${MAX_BYTES} bytes)`);
}

// homepage.json feeds the org homepage tile; only name, colour and image matter here. A file
// that is too big, not valid JSON or not an object fails, since a silent fallback would hide
// the broken tile.
function readHomepage(root) {
  const file = path.join(root, HOMEPAGE);
  if (!fs.existsSync(file)) return {};
  const failHome = (msg) => {
    throw new Error(`docs-build: ${HOMEPAGE}: ${msg}`);
  };
  checkSize(failHome, fs.statSync(file));
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    failHome(`invalid JSON: ${err.message}`);
  }
  if (typeOf(data) !== 'object') failHome(`must hold a JSON object, got ${typeOf(data)}`);
  return data;
}

// The repo name: the part of GITHUB_REPOSITORY after the slash in Actions, else the name of
// the checkout's folder, which is the repo name for a plain `git clone`.
function repoName(root) {
  const fromEnv = (process.env.GITHUB_REPOSITORY || '').split('/')[1];
  return fromEnv || path.basename(path.resolve(root));
}

// ---------- the fields ----------

const FIELDS = {
  name: (ctx, v) => checkString('name', v, { min: 1, max: 40 }),
  description: (ctx, v) => checkString('description', v, { max: 200 }),
  base: (ctx, v) => {
    checkString('base', v, { min: 1, max: 100 });
    if (!v.startsWith('/') || !v.endsWith('/')) fail(`base must start and end with '/', got ${JSON.stringify(v)}`);
    // VitePress writes base into src and href attributes unescaped, so it is a plain URL path.
    if (!BASE_RE.test(v)) fail(`base must be a URL path of letters, digits and . _ ~ % - between single '/'s, with no '.' or '..' segment, got ${JSON.stringify(v)}`);
  },
  home_page: (ctx, v) => {
    checkFile(ctx, 'home_page', v, { base: 'docs' });
    checkExtension('home_page', v, ['.md']);
  },
  sidebar: (ctx, v) => {
    checkArray('sidebar', v, 100);
    // Every missing file is named at once, so one run shows the whole list to fix.
    const missing = v.filter((entry, i) => !checkSidebarEntry(ctx, `sidebar[${i}]`, entry)).map((entry) => entry.file);
    if (missing.length) fail(`sidebar: files not found in docs/: ${missing.join(', ')}`);
  },
  unpublished: (ctx, v) => {
    checkArray('unpublished', v, 100);
    v.forEach((rel, i) => checkFile(ctx, `unpublished[${i}]`, rel, { base: 'docs', allowMissing: true }));
  },
  nav: (ctx, v) => {
    checkArray('nav', v, 8);
    v.forEach((entry, i) => checkLink(`nav[${i}]`, entry, 30));
  },
  home_link: (ctx, v) => checkLink('home_link', v, 30),
  accent: (ctx, v) => checkAccent('accent', v),
  // The dark-mode accent; left out, the docs keep using `accent` in both modes.
  accent_dark: (ctx, v) => checkAccent('accent_dark', v),
  logo: (ctx, v) => {
    checkRelative('logo', v);
    checkExtension('logo', v, ['.svg', '.png']);
    checkFile(ctx, 'logo', v);
  },
  theme_css: (ctx, v) => {
    checkRelative('theme_css', v);
    checkExtension('theme_css', v, ['.css']);
    checkFile(ctx, 'theme_css', v);
  },
};

function checkSidebarEntry(ctx, field, entry) {
  expectType(field, entry, 'object');
  checkKeys(field, entry, ['file', 'label']);
  checkString(`${field}.file`, entry.file, { min: 1, max: 500 });
  checkString(`${field}.label`, entry.label, { min: 1, max: 60 });
  // Only Markdown becomes a page; any other file would be reported missing after the build.
  checkRelative(`${field}.file`, entry.file);
  checkExtension(`${field}.file`, entry.file, ['.md']);
  const found = checkFile(ctx, `${field}.file`, entry.file, { base: 'docs', allowMissing: true });
  if (found && !fs.statSync(path.join(ctx.root, 'docs', entry.file)).isFile()) fail(`${field}.file: docs/${entry.file} is not a file`);
  return found;
}

// A page listed in the sidebar and kept off the site would leave an entry pointing at no page.
function checkSidebarPublished(config) {
  const hidden = new Set(config.unpublished);
  const both = config.sidebar.map((entry) => entry.file).filter((file) => hidden.has(file));
  if (both.length) fail(`sidebar files are also in unpublished: ${both.join(', ')}`);
}

function withDefaults(pages, homepage, repo) {
  const tile = {};
  if (homepage.name !== undefined) tile.name = homepage.name;
  if (homepage.colour !== undefined) tile.accent = homepage.colour;
  if (homepage.image !== undefined) tile.logo = homepage.image;
  return {
    name: repo,
    description: '',
    base: `/${repo}/docs/`,
    home_page: DEFAULT_HOME_PAGE,
    sidebar: [],
    unpublished: [],
    nav: [],
    home_link: null,
    accent: DEFAULT_ACCENT,
    accent_dark: null,
    logo: null,
    theme_css: null,
    ...tile,
    ...pages,
  };
}

// Returns the resolved config, keyed by the pages.json field names. Values from homepage.json
// are checked like pages.json's own, under the pages.json field they fill (image -> logo).
function loadPagesConfig(repoRoot) {
  const root = path.resolve(repoRoot);
  const pages = readPages(root);
  checkKeys('', pages, Object.keys(FIELDS));
  const config = withDefaults(pages, readHomepage(root), repoName(root));
  const ctx = { root, realRoot: fs.realpathSync(root) };
  for (const [field, check] of Object.entries(FIELDS)) {
    if (config[field] !== null || field in pages) check(ctx, config[field]);
  }
  checkSidebarPublished(config);
  return config;
}

module.exports = { loadPagesConfig, parseError, repoName, PAGES, MAX_BYTES, DEFAULT_ACCENT, DEFAULT_HOME_PAGE, HREF_PREFIXES };
