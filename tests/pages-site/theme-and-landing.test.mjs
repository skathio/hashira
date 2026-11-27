// Rules for the theme the docs share with the landing page, and for the landing page's links into
// the docs:
// - one theme choice under the `theme` localStorage key: a stored light or dark opens the other
//   side in that theme before first paint, anything else means auto, and a class change in the
//   docs (a system theme change in auto) is never stored as a choice;
// - the landing page's Docs links open built docs pages, Releases and Code still go to GitHub, and
//   the <site-nav> header shows a Docs link at every width, 390px included.
//
// The cases read the Pages folder that build-site.js builds the way site.yml does (pages-site.yml's
// site step, then site-kit and docs-build) in a copy of the working tree, so they never race
// another test file's build. The theme cases run each page's blocking head scripts against a stub
// browser, the way they run before first paint. Moved from docs-site/.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import vm from 'node:vm';

const { buildSite } = createRequire(import.meta.url)('./build-site.js');
const SITE_URL = 'https://skathio.github.io/hashira/';
const DOCS_BASE = '/hashira/docs/';
const REPO = 'https://github.com/skathio/hashira';
const KEY = 'theme';
// VitePress keeps its own choice here; a stale value must not beat the shared key.
const VP_KEY = 'vitepress-theme-appearance';
const OTHER_VALUES = ['auto', 'sepia', '', 'Dark', 'LIGHT', 'null'];
// The Docs section's guide links today, each of which must open a built docs page.
const GUIDE_LINKS = ['Usage and pin policy', 'npm flow', 'NuGet flow', 'Static site flow', 'Catalog', 'v2 to v3'];
const STAYS = { Releases: `${REPO}/releases`, Code: REPO };
const PHONE = 390;
const BUILD_TIMEOUT = 900_000;

const state = { build: null, error: null };

before(() => {
  try {
    state.build = buildSite();
  } catch (err) {
    state.error = err;
  }
});

after(() => { if (state.build) { rmSync(state.build.outer, { recursive: true, force: true }); } });

function pages() {
  assert.ok(state.build, `the site build failed:\n${state.error?.message}`);
  return state.build.site;
}

function readPage(rel) { return readFileSync(join(pages(), rel), 'utf8'); }

// Every built docs page except the 404 page, relative to artifacts/pages.
function docsPages() {
  const walk = (rel) => readdirSync(join(pages(), rel), { withFileTypes: true }).flatMap((e) => {
    const p = posix.join(rel, e.name);
    if (e.isDirectory()) { return e.name === 'assets' ? [] : walk(p); }
    return e.name.endsWith('.html') && p !== 'docs/404.html' ? [p] : [];
  });
  return walk('docs');
}

// The built file GitHub Pages serves for a /hashira/... path, or null.
function servedFile(pathname) {
  const rel = decodeURIComponent(pathname.slice('/hashira/'.length));
  const candidates = rel === '' || rel.endsWith('/') ? [`${rel}index.html`] : [rel, `${rel}.html`, `${rel}/index.html`];
  return candidates.map((c) => join(pages(), c)).find((p) => existsSync(p) && !lstatSync(p).isDirectory()) ?? null;
}

// ---------------------------------------------------------------- stub browsers

function makeStorage(initial) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

function makeSandbox(localStorage, prefersDark, docEl) {
  const listeners = [];
  const observers = [];
  const on = (type, fn) => { if (type === 'DOMContentLoaded' || type === 'load') { listeners.push(fn); } };
  const sandbox = {
    localStorage,
    navigator: { platform: 'Linux' },
    document: { documentElement: docEl, addEventListener: on, readyState: 'loading', getElementById: () => null },
    matchMedia: () => ({ matches: prefersDark, addEventListener() {}, addListener() {} }),
    addEventListener: on,
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe(target) { observers.push({ cb: this.cb, target }); } disconnect() {} },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, listeners, observers };
}

function makeRootElement() {
  const classes = new Set();
  const attrs = new Map();
  return {
    classes,
    attrs,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, force) => { const on = force ?? !classes.has(c); if (on) { classes.add(c); } else { classes.delete(c); } return on; },
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    dataset: {},
    style: {},
  };
}

// Runs a docs page's inline head scripts in order, as the browser does before first paint.
function loadDocs(rel, storage, prefersDark) {
  const head = readPage(rel).match(/<head>([\s\S]*?)<\/head>/)[1];
  const scripts = [...head.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/\bsrc=/.test(m[1])).map((m) => m[2]);
  const localStorage = makeStorage(storage);
  const docEl = makeRootElement();
  const { sandbox, listeners, observers } = makeSandbox(localStorage, prefersDark, docEl);
  for (const s of scripts) { vm.runInContext(s, sandbox); }
  const darkAtFirstPaint = docEl.classes.has('dark');
  for (const fn of listeners) { fn(); }
  // What VitePress does when its own key changes: store it and flip the class.
  const toggle = (dark) => {
    localStorage.setItem(VP_KEY, dark ? 'dark' : 'light');
    docEl.classList.toggle('dark', dark);
    for (const o of observers.filter((x) => x.target === docEl)) { o.cb([{ type: 'attributes', attributeName: 'class', target: docEl }]); }
  };
  return { darkAtFirstPaint, toggle, storage: localStorage };
}

// Runs the landing page's head scripts before first paint and returns its data-theme, or null for auto.
function loadLanding(localStorage) {
  const head = readPage('index.html').match(/<head>([\s\S]*?)<\/head>/)[1];
  const docEl = makeRootElement();
  const { sandbox } = makeSandbox(localStorage, false, docEl);
  for (const m of head.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\b(?:async|defer)\b|type=["']?module/.test(m[1])) { continue; }
    const src = m[1].match(/\bsrc=["']?([^"'\s>]+)/)?.[1];
    vm.runInContext(src ? readFileSync(join(pages(), src), 'utf8') : m[2], sandbox);
  }
  return docEl.getAttribute('data-theme');
}

// ---------------------------------------------------------------- shared theme: landing to docs

describe('a theme stored by the landing page opens the docs in that theme', () => {
  test('stored dark opens every docs page dark before first paint, on a light system', () => {
    for (const rel of docsPages()) {
      assert.equal(loadDocs(rel, { [KEY]: 'dark' }, false).darkAtFirstPaint, true, `${rel} with theme=dark`);
      assert.equal(loadDocs(rel, { [KEY]: 'dark', [VP_KEY]: 'light' }, false).darkAtFirstPaint, true, `${rel} with a stale docs choice`);
    }
  });

  test('stored light opens every docs page light before first paint, on a dark system', () => {
    for (const rel of docsPages()) {
      assert.equal(loadDocs(rel, { [KEY]: 'light' }, true).darkAtFirstPaint, false, `${rel} with theme=light`);
      assert.equal(loadDocs(rel, { [KEY]: 'light', [VP_KEY]: 'dark' }, true).darkAtFirstPaint, false, `${rel} with a stale docs choice`);
    }
  });

  test('no stored theme means auto: the docs follow the system', () => {
    for (const rel of ['docs/index.html', 'docs/flows/npm.html']) {
      assert.equal(loadDocs(rel, {}, true).darkAtFirstPaint, true, `${rel}, system dark`);
      assert.equal(loadDocs(rel, {}, false).darkAtFirstPaint, false, `${rel}, system light`);
      assert.equal(loadDocs(rel, { [VP_KEY]: 'dark' }, false).darkAtFirstPaint, false, `${rel}, stale dark docs choice`);
      assert.equal(loadDocs(rel, { [VP_KEY]: 'light' }, true).darkAtFirstPaint, true, `${rel}, stale light docs choice`);
    }
  });

  test('any other stored value means auto: the docs follow the system', () => {
    for (const value of OTHER_VALUES) {
      const label = `theme=${JSON.stringify(value)}`;
      assert.equal(loadDocs('docs/index.html', { [KEY]: value }, true).darkAtFirstPaint, true, `${label}, system dark`);
      assert.equal(loadDocs('docs/index.html', { [KEY]: value }, false).darkAtFirstPaint, false, `${label}, system light`);
      assert.equal(loadDocs('docs/index.html', { [KEY]: value, [VP_KEY]: 'dark' }, false).darkAtFirstPaint, false, `${label}, stale dark`);
      assert.equal(loadDocs('docs/index.html', { [KEY]: value, [VP_KEY]: 'light' }, true).darkAtFirstPaint, true, `${label}, stale light`);
    }
  });
});

// ---------------------------------------------------------------- shared theme: docs to landing

describe('the docs and the landing page share one stored choice', () => {
  // The docs' theme control (ThemeSwitch.vue) stores the choice under `theme` itself;
  // theme-and-accent.test.js presses it in Chrome and opens the landing page after it.
  test('a class change in the docs, such as a system theme change in auto, stores no choice', () => {
    for (const rel of ['docs/index.html', 'docs/flows/nuget.html']) {
      const page = loadDocs(rel, {}, false);
      page.toggle(true);
      page.toggle(false);
      assert.equal(page.storage.getItem(KEY), null, rel);
      assert.equal(loadLanding(page.storage), null, `${rel}: the landing page left auto`);
    }
  });

  test('a stored light or dark opens the landing page in that theme; any other value means auto', () => {
    assert.equal(loadLanding(makeStorage({ [KEY]: 'dark' })), 'dark');
    assert.equal(loadLanding(makeStorage({ [KEY]: 'light' })), 'light');
    assert.equal(loadLanding(makeStorage({})), null);
    for (const value of OTHER_VALUES) {
      assert.equal(loadLanding(makeStorage({ [KEY]: value })), null, `theme=${JSON.stringify(value)}`);
    }
  });

  test('the landing page sets its theme from a script that blocks first paint', () => {
    const head = readPage('index.html').match(/<head>([\s\S]*?)<\/head>/)[1];
    const tags = [...head.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]).filter((a) => /_kit\/theme\.js/.test(a));
    assert.equal(tags.length, 1, 'the landing page does not load _kit/theme.js in <head>');
    assert.doesNotMatch(tags[0], /\b(?:async|defer)\b|type=["']?module/, `the theme script waits for the page: <script${tags[0]}>`);
  });
});

// ---------------------------------------------------------------- landing page links

function anchors(html) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    attrs: m[1],
    href: m[1].match(/\bhref=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/)?.slice(1).find((v) => v !== undefined) ?? null,
    text: m[2].replace(/<[^>]*>/g, '').trim(),
  }));
}

function docsSection(html) {
  const m = html.match(/<section\b[^>]*\bid=["']?docs["']?[^>]*>([\s\S]*?)<\/section>/);
  assert.ok(m, 'the landing page has no Docs section (id="docs")');
  return anchors(m[1]);
}

// The header's Docs link: <site-nav>'s `docs` attribute ("docs/" when it is just present).
function navDocsLink(html) {
  const nav = html.match(/<site-nav\b([^>]*)>/);
  assert.ok(nav, 'the landing page has no <site-nav> header');
  const docs = nav[1].match(/\bdocs(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/);
  assert.ok(docs, 'the header has no Docs link (no docs attribute on <site-nav>)');
  const value = docs.slice(1).find((v) => v !== undefined);
  return { attrs: nav[1], href: value === undefined || value === '' || value === 'true' ? 'docs/' : value };
}

// The CSS <site-nav> renders its links with, from the built _kit/site-nav.js.
function siteNavCss() {
  const js = readPage('_kit/site-nav.js');
  const block = js.match(/var STYLE = \[([\s\S]*?)\]\.join/);
  assert.ok(block, 'site-nav.js has no STYLE');
  return [...block[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]).join('');
}

// The landing page's top-level CSS rules and those in @media blocks, with their media condition.
function cssRules(html) {
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const flat = (text, media) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ media, selector: m[1].trim(), body: m[2] }));
  const mediaBlock = /(@media[^{]*)\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g;
  const nested = [...css.matchAll(mediaBlock)].flatMap((m) => flat(m[2], m[1].trim()));
  return [...flat(css.replace(mediaBlock, ''), null), ...nested];
}

// Whether a media condition holds at a viewport width; non-width conditions may hold, so they count.
function mediaApplies(media, width) {
  if (!media) { return true; }
  const max = [...media.matchAll(/max-width\s*:\s*(\d+)px/g)].map((m) => Number(m[1]));
  const min = [...media.matchAll(/min-width\s*:\s*(\d+)px/g)].map((m) => Number(m[1]));
  return max.every((v) => width <= v) && min.every((v) => width >= v);
}

function compound(part) {
  return {
    tag: part.match(/^[a-z][\w-]*/i)?.[0]?.toLowerCase() ?? null,
    classes: [...part.matchAll(/\.([\w-]+)/g)].map((m) => m[1]),
    id: part.match(/#([\w-]+)/)?.[1] ?? null,
  };
}

function elementOf(tag, attrs) {
  const cls = attrs.match(/\bclass=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/)?.slice(1).find((v) => v !== undefined) ?? '';
  return { tag, classes: cls.split(/\s+/).filter(Boolean), id: attrs.match(/\bid=["']?([\w-]+)/)?.[1] ?? null };
}

function matchesCompound(c, el) {
  return (!c.tag || c.tag === el.tag) && c.classes.every((k) => el.classes.includes(k)) && (!c.id || c.id === el.id);
}

// The display:none selectors that apply at a width and could reach the header's Docs link. Ancestor
// parts count when some element of the page could be that ancestor, so the check errs toward hidden.
function hidingSelectors(html, link, width, tag = 'a') {
  const el = elementOf(tag, link.attrs);
  const pageElements = [...html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)].map((m) => elementOf(m[1].toLowerCase(), m[2]));
  return cssRules(html)
    .filter((r) => mediaApplies(r.media, width) && /(?:^|;)\s*display\s*:\s*none\b/.test(r.body))
    .flatMap((r) => r.selector.split(','))
    .map((s) => s.trim())
    .filter((s) => {
      const parts = s.split(/\s*[\s>+~]\s*/).filter(Boolean);
      const last = compound(parts.pop());
      return matchesCompound(last, el) && parts.every((p) => pageElements.some((e) => matchesCompound(compound(p), e)));
    });
}

describe('landing page Docs links', () => {
  test('each existing guide link in the Docs section is still there', () => {
    const texts = docsSection(readPage('index.html')).map((a) => a.text);
    for (const text of GUIDE_LINKS) { assert.ok(texts.includes(text), `the Docs section lost "${text}"`); }
  });

  test('every Docs section link other than Releases and Code opens a built docs page, not GitHub', () => {
    const links = docsSection(readPage('index.html')).filter((a) => !(a.text in STAYS));
    assert.ok(links.length >= GUIDE_LINKS.length, 'the Docs section has fewer guide links than before');
    for (const { text, href } of links) {
      assert.ok(href, `"${text}" has no href`);
      const url = new URL(href, SITE_URL);
      assert.equal(url.origin, new URL(SITE_URL).origin, `"${text}" leaves the site: ${href}`);
      assert.ok(url.pathname.startsWith(DOCS_BASE), `"${text}" does not open a ${DOCS_BASE} page: ${href}`);
      assert.ok(servedFile(url.pathname), `"${text}" opens ${url.pathname}, which the build did not produce`);
    }
  });

  test('Releases and Code still go to GitHub', () => {
    const links = docsSection(readPage('index.html'));
    for (const [text, href] of Object.entries(STAYS)) {
      const link = links.find((a) => a.text === text);
      assert.ok(link, `the Docs section lost "${text}"`);
      assert.equal(link.href, href, `"${text}" no longer goes to ${href}`);
    }
  });

  test('the header Docs link opens a built docs page', () => {
    const { href } = navDocsLink(readPage('index.html'));
    assert.ok(href, 'the header "Docs" link has no href');
    const url = new URL(href, SITE_URL);
    assert.equal(url.origin, new URL(SITE_URL).origin, `the header "Docs" link leaves the site: ${href}`);
    assert.ok(url.pathname.startsWith(DOCS_BASE), `the header "Docs" link does not open a ${DOCS_BASE} page: ${href}`);
    assert.ok(servedFile(url.pathname), `the header "Docs" link opens ${url.pathname}, which the build did not produce`);
  });

  test('no CSS rule hides the header Docs link at 390px or at desktop width', () => {
    const html = readPage('index.html');
    const host = navDocsLink(html);
    assert.doesNotMatch(host.attrs, /\bhidden\b|display\s*:\s*none/, `the header is hidden: <site-nav${host.attrs}>`);
    // The landing's own rules must not hide <site-nav>, and <site-nav>'s must not hide its Docs link.
    const shadow = `<style>${siteNavCss()}</style><nav><a class="docs" part="docs" href="docs/">Docs</a></nav>`;
    const docsLink = { attrs: ' class="docs" part="docs" href="docs/"' };
    for (const width of [PHONE, 1440]) {
      assert.deepEqual(hidingSelectors(html, { attrs: host.attrs }, width, 'site-nav'), [], `<site-nav> is hidden at ${width}px`);
      assert.deepEqual(hidingSelectors(shadow, docsLink, width), [], `the header "Docs" link is hidden at ${width}px`);
    }
  });

  test('the width check sees a phone-only rule that hides a header link', () => {
    // Guards the check above with a page whose Docs link a phone media rule hides.
    const html = '<style>nav a{color:red}@media (max-width:760px){nav .muted{display:none}}</style>'
      + '<nav><a class=muted href="docs/">Docs</a></nav>';
    const link = { attrs: ' class=muted href="docs/"' };
    assert.deepEqual(hidingSelectors(html, link, PHONE), ['nav .muted']);
    assert.deepEqual(hidingSelectors(html, link, 1440), []);
  });
});
