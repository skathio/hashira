// The user's rules for <site-nav>'s layout, current link, brand slot and fallback, checked in a
// real headless Chrome, because widths, overflow, :not(:defined), ::slotted and the
// accessibility tree only exist in a browser that lays the page out.
//
// - The bar: brand pinned left; home_link, extras and the theme toggle in a right group that
//   stays on screen; no overflow-x on the bar; the nav links collapse into a disclosure menu
//   (a button with aria-expanded, Escape closes, reachable by keyboard) when they do not fit,
//   measured on the element's own width rather than a fixed breakpoint, and always on phones;
//   slotted extras stay visible. At 390, 768, 1024 and 1280 with 7 nav links, Docs, one extra
//   and home_link: no scrollWidth > innerWidth and the toggle visible.
// - aria-current="page" on a nav or Docs link whose href resolves to the current path; with the
//   opt-in `scrollspy` attribute, aria-current="location" on the #hash link of the section in
//   view. The current link gets an accent style, and so does the Docs link (a primary style).
// - A filled `brand` slot renders the site's own brand inside the brand link instead of logo and
//   name, and labels stay text.
// - tokens.css reserves the defined bar's height, padding and sticky position for
//   site-nav:not(:defined); slot="fallback" children show only until the element is defined;
//   ::slotted(a) extras match the built-in links in colour, hover and focus-visible; a host with
//   role="navigation" gets no second landmark; `site-nav:ready` fires and `ready` is set after
//   the first render.
//
// Chrome is driven over the DevTools protocol on a pipe (no packages to install, Node 20 safe).
// It is found through CHROME_BIN, then google-chrome, chromium or a Playwright download.
//
// Left to the builder, so not tested here: how the menu looks and where it opens, whether Docs
// collapses with the nav links, what a hash link gets without `scrollspy`, whether the brand link
// can be current, which section counts as in view at the very top of a page, the event's target
// and detail, and which property carries the accent style.
//
// Run with:
//   node --test tests/site-kit/site-nav-layout.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const KIT_DIR = path.join(REPO, '.github', 'actions', 'site-kit', 'kit');
const WIDTHS = [390, 768, 1024, 1280];
const PHONE = 390;
const DESKTOP = 1280;
const HEIGHT = 900;
const ACCENT = '#c0392b';
const ACCENT_RGB = 'rgb(192, 57, 43)';
const NAV7 = ['Getting started', 'Flows', 'Security', 'Catalog', 'Releases', 'Changelog', 'Contributing']
  .map((label, i) => ({ label, href: `#s${i}` }));
const HOME = { label: '← skathio', href: 'https://skathio.github.io/' };
const EXTRA = '<a id="extra" href="https://github.com/skathio/hashira">GitHub</a>';
const WAIT_STEPS = 100;
const WAIT_STEP_MS = 50;
const MAX_TABS = 40;

const temps = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---------------------------------------------------------------- finding Chrome

const PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const PLAYWRIGHT_BINS = [
  ['chromium_headless_shell-', 'chrome-headless-shell-linux64', 'chrome-headless-shell'],
  ['chromium-', 'chrome-linux64', 'chrome'],
  ['chromium-', 'chrome-linux', 'chrome'],
];

function onPath(name) {
  const run = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

function playwrightChrome() {
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : [];
  const found = PLAYWRIGHT_BINS.flatMap(([prefix, sub, bin]) => dirs
    .filter((d) => d.startsWith(prefix) && /^[a-z_]+-\d+$/.test(d))
    .map((d) => path.join(cache, d, sub, bin)));
  return found.find((p) => fs.existsSync(p)) ?? null;
}

function findChrome() {
  const fromEnv = process.env.CHROME_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return PATH_NAMES.map(onPath).find(Boolean) ?? playwrightChrome();
}

// ---------------------------------------------------------------- DevTools protocol over a pipe

class Browser {
  constructor(bin) {
    const profile = tempDir('site-nav-chrome-');
    const args = ['--headless=new', '--remote-debugging-pipe', '--no-sandbox', '--disable-gpu',
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--user-data-dir=${profile}`];
    this.proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.proc.stdio[4].on('data', (chunk) => this.receive(chunk));
    this.proc.on('exit', () => this.pending.forEach(({ reject }) => reject(new Error('Chrome exited'))));
  }

  receive(chunk) {
    this.buffer += chunk.toString('utf8');
    const parts = this.buffer.split('\0');
    this.buffer = parts.pop();
    parts.forEach((raw) => this.dispatch(JSON.parse(raw)));
  }

  dispatch(message) {
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter.resolve(message.result);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const frame = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.proc.stdio[3].write(`${frame}\0`);
    });
  }

  async newPage(width) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await page.resize(width);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    return page;
  }

  close() { this.proc.kill('SIGKILL'); }
}

class Page {
  constructor(browser, targetId, sessionId) {
    Object.assign(this, { browser, targetId, sessionId });
  }

  send(method, params) { return this.browser.send(method, params, this.sessionId); }

  resize(width) {
    return this.send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`page error: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value;
  }

  // Polls a page expression until it is truthy; the step count bounds the wait, not an assertion.
  async waitFor(expression, what) {
    for (let i = 0; i < WAIT_STEPS; i++) {
      if (await this.eval(`!!(${expression})`)) return;
      await pause(WAIT_STEP_MS);
    }
    assert.fail(`timed out waiting for ${what}`);
  }

  async open(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', `${url} to load`);
    await this.settle();
  }

  // Two animation frames: lets ResizeObserver and render callbacks run.
  settle() {
    return this.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  }

  async key(key, code, keyCode) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await this.settle();
  }

  tab() { return this.key('Tab', 'Tab', 9); }
  escape() { return this.key('Escape', 'Escape', 27); }
  enter() { return this.key('Enter', 'Enter', 13); }

  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await this.settle();
  }

  async hover(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.settle();
  }

  close() { return this.browser.send('Target.closeTarget', { targetId: this.targetId }); }
}

// ---------------------------------------------------------------- serving the test pages

const site = { dir: null, server: null, origin: null };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serve(req, res) {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html');
  const file = path.join(site.dir, path.normalize(rel));
  if (!file.startsWith(site.dir) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}

function startServer() {
  site.dir = tempDir('site-nav-pages-');
  fs.cpSync(KIT_DIR, path.join(site.dir, '_kit'), { recursive: true });
  fs.writeFileSync(path.join(site.dir, 'mark.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#1e7d69"/></svg>');
  site.server = http.createServer(serve);
  return new Promise((resolve) => {
    site.server.listen(0, '127.0.0.1', () => {
      site.origin = `http://127.0.0.1:${site.server.address().port}`;
      resolve();
    });
  });
}

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// A <site-nav> with its config as the inline JSON child, plus raw attributes and children.
function siteNav({ config = {}, attrs = '', children = '' } = {}) {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<site-nav ${attrs}><script type="application/json">${json}</script>${children}</site-nav>`;
}

// Writes a page under the served folder and returns its URL. `kit: false` leaves site-nav.js
// out, so the element stays undefined.
function writePage(rel, { nav, main = '', head = '', kit = true }) {
  const file = path.join(site.dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const navScript = kit ? '<script src="/_kit/site-nav.js"></script>' : '';
  fs.writeFileSync(file, `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/_kit/tokens.css"><script src="/_kit/theme.js"></script>${head}</head>
<body style="margin:0">${nav}<main>${main}</main>${navScript}</body></html>`);
  return `${site.origin}/${rel.replace(/index\.html$/, '')}`;
}

let pageCount = 0;
const uniquePath = (name) => `t${++pageCount}/${name}`;

// ---------------------------------------------------------------- in-page probes

// Installed in every probe: helpers that read the shadow root the way a user sees it. `shown`
// is true when the node has a box inside the viewport and is what a hit test at its centre finds.
const PROBE = `
  const host = document.querySelector('site-nav');
  const sr = host.shadowRoot;
  const q = (sel) => (sr ? Array.from(sr.querySelectorAll(sel)) : []);
  const shown = (n) => {
    if (!n) return false;
    const r = n.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.left < -0.5 || r.right > innerWidth + 0.5 || r.bottom < 0) return false;
    const hit = n.getRootNode().elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === n || n.contains(hit));
  };
  const byText = (sel, text) => q(sel).filter((n) => n.textContent.trim() === text);
  const menuButton = () => q('button[aria-expanded]').find(shown) || null;
  const deepFocus = () => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a; };
  const centre = (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
`;

const probe = (page, body) => page.eval(`(() => { ${PROBE} ${body} })()`);

async function layout(page, labels) {
  return probe(page, `
    const labels = ${JSON.stringify(labels)};
    const right = ['home', 'toggle'].map((p) => q('[part~="' + p + '"]').find(shown) || null);
    const brand = q('[part~="brand"]')[0];
    const lefts = q('a, button').filter(shown).map((n) => n.getBoundingClientRect().left);
    const bar = q('[part~="bar"]')[0];
    return {
      innerWidth, scrollWidth: document.documentElement.scrollWidth,
      barOverflowX: bar ? getComputedStyle(bar).overflowX : null,
      linksShown: labels.map((l) => byText('a', l).some(shown)),
      menu: !!menuButton(), menuExpanded: menuButton() && menuButton().getAttribute('aria-expanded'),
      home: !!right[0], toggle: !!right[1], extra: shown(document.getElementById('extra')),
      brandShown: shown(brand), brandLeftmost: !!brand && lefts.every((x) => x >= brand.getBoundingClientRect().left - 0.5),
    };
  `);
}

async function openAt(width, url) {
  const page = await state.browser.newPage(width);
  await page.open(url);
  await page.waitFor('document.querySelector("site-nav").shadowRoot', 'site-nav to render');
  await page.settle();
  return page;
}

async function withPage(width, url, fn) {
  const page = await openAt(width, url);
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

const state = { browser: null, error: null };

test.before(async () => {
  const bin = findChrome();
  if (!bin) {
    state.error = 'no Chrome found: set CHROME_BIN, or install google-chrome or chromium';
    return;
  }
  await startServer();
  state.browser = new Browser(bin);
  await state.browser.send('Browser.getVersion');
});

test.after(() => {
  if (state.browser) state.browser.close();
  if (site.server) site.server.close();
  temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

function needBrowser() {
  assert.ok(state.browser, state.error ?? 'Chrome did not start');
}

const fullConfig = (nav = NAV7) => ({ name: 'hashira', logo: '/mark.svg', root: '/', docs: 'docs/', nav, home_link: HOME });
const labelsOf = (nav) => nav.map((e) => e.label);

function fullPage(nav = NAV7, attrs = '') {
  return writePage(uniquePath('index.html'), { nav: siteNav({ config: fullConfig(nav), attrs, children: EXTRA }) });
}

// ---------------------------------------------------------------- the bar at each width

WIDTHS.forEach((width) => {
  test(`at ${width}px with 7 nav links, Docs, one extra and home_link: no horizontal scroll`, async () => {
    needBrowser();
    const m = await withPage(width, fullPage(), (page) => layout(page, labelsOf(NAV7)));
    assert.equal(m.innerWidth, width);
    assert.ok(m.scrollWidth <= m.innerWidth, `scrollWidth ${m.scrollWidth} > innerWidth ${m.innerWidth}`);
  });

  test(`at ${width}px: the theme toggle, home_link and the slotted extra are visible`, async () => {
    needBrowser();
    const m = await withPage(width, fullPage(), (page) => layout(page, labelsOf(NAV7)));
    assert.equal(m.toggle, true, 'the theme toggle is not on screen');
    assert.equal(m.home, true, 'home_link is not on screen');
    assert.equal(m.extra, true, 'the slotted extra is not on screen');
  });

  test(`at ${width}px: the brand is visible and leftmost`, async () => {
    needBrowser();
    const m = await withPage(width, fullPage(), (page) => layout(page, labelsOf(NAV7)));
    assert.equal(m.brandShown, true, 'the brand is not on screen');
    assert.equal(m.brandLeftmost, true, 'an item sits left of the brand');
  });

  test(`at ${width}px: the bar has no overflow-x scrolling`, async () => {
    needBrowser();
    const m = await withPage(width, fullPage(), (page) => layout(page, labelsOf(NAV7)));
    assert.ok(!['auto', 'scroll'].includes(m.barOverflowX), `the bar has overflow-x: ${m.barOverflowX}`);
  });

  test(`at ${width}px: every nav link is shown inline, or a menu button with aria-expanded is`, async () => {
    needBrowser();
    const m = await withPage(width, fullPage(), (page) => layout(page, labelsOf(NAV7)));
    if (m.linksShown.every(Boolean)) return;
    assert.equal(m.menu, true, `links ${JSON.stringify(m.linksShown)} are hidden with no menu button`);
    assert.equal(m.menuExpanded, 'false');
  });
});

// ---------------------------------------------------------------- the disclosure menu on phones

[[], NAV7.slice(0, 1), NAV7].forEach((nav) => {
  test(`at ${PHONE}px with ${nav.length} nav link(s): no horizontal scroll and the toggle visible`, async () => {
    needBrowser();
    const m = await withPage(PHONE, fullPage(nav), (page) => layout(page, labelsOf(nav)));
    assert.ok(m.scrollWidth <= m.innerWidth, `scrollWidth ${m.scrollWidth} > ${m.innerWidth}`);
    assert.equal(m.toggle, true);
  });
});

[NAV7.slice(0, 1), NAV7].forEach((nav) => {
  test(`at ${PHONE}px with ${nav.length} nav link(s) the links are always behind a closed menu button`, async () => {
    needBrowser();
    const m = await withPage(PHONE, fullPage(nav), (page) => layout(page, labelsOf(nav)));
    assert.equal(m.menu, true, 'no visible button with aria-expanded on a phone');
    assert.equal(m.menuExpanded, 'false');
    assert.deepEqual(m.linksShown, nav.map(() => false), 'a nav link shows while the menu is closed');
    assert.equal(m.extra, true, 'the slotted extra must stay visible while the links collapse');
  });
});

async function clickMenu(page) {
  const at = await probe(page, 'return menuButton() && centre(menuButton());');
  assert.ok(at, 'no visible menu button');
  await page.click(at.x, at.y);
}

test(`at ${PHONE}px clicking the menu button opens it: aria-expanded="true", every link shown, no horizontal scroll`, async () => {
  needBrowser();
  await withPage(PHONE, fullPage(), async (page) => {
    await clickMenu(page);
    const expanded = await probe(page, 'return q("button[aria-expanded]").map((b) => b.getAttribute("aria-expanded"));');
    assert.ok(expanded.includes('true'), `aria-expanded is ${JSON.stringify(expanded)}`);
    const m = await layout(page, labelsOf(NAV7));
    assert.deepEqual(m.linksShown, NAV7.map(() => true), 'not every nav link shows in the open menu');
    assert.ok(m.scrollWidth <= m.innerWidth, `scrollWidth ${m.scrollWidth} > ${m.innerWidth}`);
  });
});

test(`at ${PHONE}px Escape closes the open menu`, async () => {
  needBrowser();
  await withPage(PHONE, fullPage(), async (page) => {
    await clickMenu(page);
    await page.escape();
    const expanded = await probe(page, 'return q("button[aria-expanded]").map((b) => b.getAttribute("aria-expanded"));');
    assert.ok(!expanded.includes('true'), `still expanded after Escape: ${JSON.stringify(expanded)}`);
    const m = await layout(page, labelsOf(NAV7));
    assert.deepEqual(m.linksShown, NAV7.map(() => false), 'a nav link still shows after Escape');
  });
});

// Presses Tab until `predicate` (an in-page expression over `f`, the deep focus) holds.
async function tabUntil(page, predicate) {
  for (let i = 0; i < MAX_TABS; i++) {
    await page.tab();
    if (await probe(page, `const f = deepFocus(); return !!f && (${predicate});`)) return true;
  }
  return false;
}

test(`at ${PHONE}px the menu is keyboard reachable: Tab reaches the button, Enter opens it, Tab reaches every link, Escape closes`, async () => {
  needBrowser();
  await withPage(PHONE, fullPage(), async (page) => {
    assert.ok(await tabUntil(page, 'f.localName === "button" && f.hasAttribute("aria-expanded")'), 'Tab never reached the menu button');
    await page.enter();
    const opened = await probe(page, 'return deepFocus().getRootNode().querySelector("button[aria-expanded=true]") !== null;');
    assert.equal(opened, true, 'Enter on the menu button did not open it');
    for (const { label } of NAV7) {
      assert.ok(await tabUntil(page, `f.textContent.trim() === ${JSON.stringify(label)}`), `Tab never reached "${label}"`);
    }
    await page.escape();
    const closed = await probe(page, 'return q("button[aria-expanded]").every((b) => b.getAttribute("aria-expanded") !== "true");');
    assert.equal(closed, true, 'Escape from a menu link did not close the menu');
  });
});

// The viewport stays at 1280px and only the element's container narrows, so a media query
// cannot tell the difference: only a measurement of the element's own width can.
test('the links collapse on the measured width of the element, not on a viewport breakpoint', async () => {
  needBrowser();
  const nav = NAV7.slice(0, 3);
  const url = writePage(uniquePath('index.html'), {
    nav: `<div id="box" style="width:1200px">${siteNav({ config: fullConfig(nav), children: EXTRA })}</div>`,
  });
  await withPage(DESKTOP, url, async (page) => {
    const wide = await layout(page, labelsOf(nav));
    assert.deepEqual(wide.linksShown, [true, true, true], 'three short links do not show inline at 1200px');
    assert.equal(wide.menu, false, 'a menu button shows while the links fit');
    await page.eval('document.getElementById("box").style.width = "480px"; true');
    await page.waitFor(`(() => { ${PROBE} return !!menuButton(); })()`, 'the menu button after the element narrowed');
    const narrow = await layout(page, labelsOf(nav));
    assert.deepEqual(narrow.linksShown, [false, false, false], 'links still inline in a 480px element');
    assert.equal(narrow.toggle, true);
  });
});

// ---------------------------------------------------------------- aria-current and accent styles

const currentOf = (page, sel) => probe(page, `return q(${JSON.stringify(sel)}).map((a) => [a.textContent.trim(), a.getAttribute('aria-current')]);`);

function currentMap(pairs) {
  const map = {};
  pairs.forEach(([label, value]) => { if (value !== null) map[label] = value; });
  return map;
}

test('aria-current="page" goes on the nav link whose relative href resolves to this page, and only on it', async () => {
  needBrowser();
  const nav = [{ label: 'Guide', href: 'guide.html' }, { label: 'Other', href: 'other.html' }, { label: 'Up', href: '../' }];
  const url = writePage(uniquePath('sub/guide.html'), { nav: siteNav({ config: { name: 'x', nav } }) });
  const pairs = await withPage(DESKTOP, url, (page) => currentOf(page, '[part~="link"]'));
  const map = currentMap(pairs);
  assert.equal(map.Guide, 'page');
  assert.notEqual(map.Other, 'page');
  assert.notEqual(map.Up, 'page');
});

test('aria-current="page" goes on a nav link whose absolute-path href is this page', async () => {
  needBrowser();
  const rel = uniquePath('sub/third.html');
  const nav = [{ label: 'First', href: '/nowhere.html' }, { label: 'Third', href: `/${rel}` }];
  const url = writePage(rel, { nav: siteNav({ config: { name: 'x', nav } }) });
  const map = currentMap(await withPage(DESKTOP, url, (page) => currentOf(page, '[part~="link"]')));
  assert.equal(map.Third, 'page');
  assert.notEqual(map.First, 'page');
});

test('aria-current="page" goes on the Docs link when its href resolves to this page', async () => {
  needBrowser();
  const rel = uniquePath('docs/index.html');
  const url = writePage(rel, { nav: siteNav({ config: { name: 'x', docs: `/${rel.replace('index.html', '')}` } }) });
  const map = currentMap(await withPage(DESKTOP, url, (page) => currentOf(page, '[part~="docs"]')));
  assert.equal(map.Docs, 'page');
});

test('the Docs link is not current on the landing page it leaves from', async () => {
  needBrowser();
  const url = writePage(uniquePath('index.html'), { nav: siteNav({ config: { name: 'x', docs: 'docs/' } }) });
  const map = currentMap(await withPage(DESKTOP, url, (page) => currentOf(page, '[part~="docs"]')));
  assert.notEqual(map.Docs, 'page');
});

// True when one of the properties an accent style shows through holds the accent colour.
const ACCENT_STYLE = `
  const accentStyle = (n) => {
    const s = getComputedStyle(n);
    const want = ${JSON.stringify(ACCENT_RGB)};
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(s['border' + side + 'Width']) > 0 && s['border' + side + 'Color'] === want);
    const deco = s.textDecorationLine !== 'none' && s.textDecorationColor === want;
    return s.color === want || s.backgroundColor === want || border || deco || s.boxShadow.includes(want);
  };
`;

const accentOf = (page, sel) => probe(page, `${ACCENT_STYLE} return q(${JSON.stringify(sel)}).map((a) => [a.textContent.trim(), accentStyle(a)]);`);

test('the current nav link has an accent style and a link that is not current has none', async () => {
  needBrowser();
  const nav = [{ label: 'Here', href: 'here.html' }, { label: 'Elsewhere', href: 'elsewhere.html' }];
  const url = writePage(uniquePath('here.html'), { nav: siteNav({ config: { name: 'x', accent: ACCENT, nav } }) });
  const styled = Object.fromEntries(await withPage(DESKTOP, url, (page) => accentOf(page, '[part~="link"]')));
  assert.equal(styled.Here, true, 'the current link shows no accent');
  assert.equal(styled.Elsewhere, false, 'a link that is not current shows the accent');
});

test('the Docs link on the landing has a primary (accent) style', async () => {
  needBrowser();
  const url = writePage(uniquePath('index.html'), {
    nav: siteNav({ config: { name: 'x', accent: ACCENT, docs: 'docs/', nav: [{ label: 'Flows', href: 'flows.html' }] } }),
  });
  const styled = Object.fromEntries(await withPage(DESKTOP, url, (page) => accentOf(page, '[part~="docs"], [part~="link"]')));
  assert.equal(styled.Docs, true, 'the Docs link shows no accent');
  assert.equal(styled.Flows, false, 'a plain nav link shows the accent, so Docs does not stand out');
});

// ---------------------------------------------------------------- scrollspy

const SECTIONS = ['one', 'two', 'three'];
const SPY_NAV = SECTIONS.map((id) => ({ label: id, href: `#${id}` }));
const SPY_MAIN = SECTIONS.map((id) => `<section id="${id}" style="height:${HEIGHT * 2}px"><h2>${id}</h2></section>`).join('');

function spyPage(attrs) {
  return writePage(uniquePath('index.html'), { nav: siteNav({ config: { name: 'x', nav: SPY_NAV }, attrs }), main: SPY_MAIN });
}

const scrollTo = (page, id) => page.eval(`window.scrollTo(0, document.getElementById(${JSON.stringify(id)}).offsetTop + 100); true`);
const locationLinks = (page) => probe(page, 'return q("a").filter((a) => a.getAttribute("aria-current") === "location").map((a) => a.textContent.trim());');

for (const id of ['two', 'three']) {
  test(`with scrollspy, scrolling section #${id} into view sets aria-current="location" on its link alone`, async () => {
    needBrowser();
    await withPage(DESKTOP, spyPage('scrollspy'), async (page) => {
      await scrollTo(page, id);
      const sel = JSON.stringify(`a[href="#${id}"][aria-current="location"]`);
      await page.waitFor(`document.querySelector("site-nav").shadowRoot.querySelector(${sel})`, `#${id} to become current`);
      assert.deepEqual(await locationLinks(page), [id]);
    });
  });
}

test('without the scrollspy attribute no link gets aria-current="location" (it is opt-in)', async () => {
  needBrowser();
  await withPage(DESKTOP, spyPage(''), async (page) => {
    await scrollTo(page, 'two');
    await pause(300);
    await page.settle();
    assert.deepEqual(await locationLinks(page), []);
  });
});

// ---------------------------------------------------------------- the brand slot

const BRAND = '<span slot="brand" id="own-brand">My<b>Brand</b></span>';

test('a filled brand slot renders the site\'s own brand inside the brand link instead of logo and name', async () => {
  needBrowser();
  const url = writePage(uniquePath('index.html'), {
    nav: siteNav({ config: { name: 'kit-name', logo: '/mark.svg', root: '/home/' }, children: BRAND }),
  });
  const m = await withPage(DESKTOP, url, (page) => probe(page, `
    const own = document.getElementById('own-brand');
    const brand = q('[part~="brand"]')[0];
    return {
      inBrand: !!own.assignedSlot && !!brand && brand.contains(own.assignedSlot),
      shown: shown(own), href: brand && brand.getAttribute('href'),
      img: brand ? brand.querySelectorAll('img').length : -1,
      kitName: sr.textContent.includes('kit-name'),
    };`));
  assert.equal(m.inBrand, true, 'the brand slot is not inside the brand link');
  assert.equal(m.shown, true, 'the site\'s own brand is not on screen');
  assert.equal(m.href, '/home/', 'the brand link lost its root href');
  assert.equal(m.img, 0, 'the kit logo still renders beside the slotted brand');
  assert.equal(m.kitName, false, 'the kit name still renders beside the slotted brand');
});

test('with the brand slot empty the brand link keeps the logo and name', async () => {
  needBrowser();
  const url = writePage(uniquePath('index.html'), { nav: siteNav({ config: { name: 'kit-name', logo: '/mark.svg' } }) });
  const m = await withPage(DESKTOP, url, (page) => probe(page, `
    const brand = q('[part~="brand"]')[0];
    return { img: brand.querySelectorAll('img').length, text: brand.textContent.trim() };`));
  assert.equal(m.img, 1);
  assert.equal(m.text, 'kit-name');
});

test('with the brand slot filled, nav labels are still set as text, never as markup', async () => {
  needBrowser();
  const label = '<img src=x onerror="window.__pwned=1">Evil';
  const url = writePage(uniquePath('index.html'), {
    nav: siteNav({ config: { name: 'x', nav: [{ label, href: '#a' }] }, children: BRAND }),
  });
  const m = await withPage(DESKTOP, url, (page) => probe(page, `
    return { imgs: q('img').length, text: q('[part~="link"]').map((a) => a.textContent), pwned: !!window.__pwned };`));
  assert.equal(m.imgs, 0);
  assert.ok(m.text.includes(label));
  assert.equal(m.pwned, false);
});

// ---------------------------------------------------------------- fallback, :not(:defined), slotted extras

const FALLBACK = '<a slot="fallback" id="fb" href="/">fallback brand</a>';
const fallbackConfig = () => ({ name: 'hashira', docs: 'docs/', nav: NAV7.slice(0, 3), home_link: HOME });

const defineNav = (page) => page.eval(`new Promise((resolve) => {
  const s = document.createElement('script'); s.src = '/_kit/site-nav.js'; s.onload = () => resolve(true);
  document.body.appendChild(s);
})`);

const hostBox = (page) => page.eval(`(() => {
  const host = document.querySelector('site-nav'); const s = getComputedStyle(host);
  return { height: host.getBoundingClientRect().height, position: s.position, top: s.top,
    pad: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft] };
})()`);

const barBox = (page) => probe(page, `
  const s = getComputedStyle(q('[part~="bar"]')[0]);
  return { pad: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft] };`);

for (const width of [PHONE, DESKTOP]) {
  test(`at ${width}px tokens.css reserves the defined bar's height, padding and sticky position before site-nav is defined`, async () => {
    needBrowser();
    const url = writePage(uniquePath('index.html'), { nav: siteNav({ config: fallbackConfig() }), kit: false });
    const page = await state.browser.newPage(width);
    try {
      await page.open(url);
      const before = await hostBox(page);
      await defineNav(page);
      await page.waitFor('document.querySelector("site-nav").shadowRoot', 'site-nav to render');
      await page.settle();
      const after = await hostBox(page);
      const bar = await barBox(page);
      assert.equal(before.position, 'sticky', 'site-nav:not(:defined) is not sticky');
      assert.equal(before.top, '0px');
      assert.ok(Math.abs(before.height - after.height) <= 1, `undefined height ${before.height} != defined ${after.height}`);
      assert.deepEqual(before.pad, bar.pad, 'the undefined element does not reserve the bar\'s padding');
    } finally {
      await page.close();
    }
  });
}

test('slot="fallback" children show until site-nav is defined and are never slotted after', async () => {
  needBrowser();
  const url = writePage(uniquePath('index.html'), { nav: siteNav({ config: fallbackConfig(), children: FALLBACK + EXTRA }), kit: false });
  const page = await state.browser.newPage(DESKTOP);
  try {
    await page.open(url);
    const before = await page.eval('(() => { const r = document.getElementById("fb").getBoundingClientRect(); return r.width > 0 && r.height > 0; })()');
    assert.equal(before, true, 'the fallback child is not shown before site-nav is defined');
    assert.equal(await page.eval('document.querySelector("site-nav").hasAttribute("ready")'), false, 'ready is set before any render');
    await defineNav(page);
    await page.waitFor('document.querySelector("site-nav").hasAttribute("ready")', 'site-nav to be ready');
    await page.eval('document.querySelector("site-nav").setAttribute("name", "again"); true');
    await page.settle();
    const after = await page.eval(`(() => { const fb = document.getElementById('fb'); const ex = document.getElementById('extra');
      return { fbSlot: fb.assignedSlot, fbBoxes: fb.getClientRects().length, extraSlotted: !!ex.assignedSlot }; })()`);
    assert.equal(after.fbSlot, null, 'the fallback child is slotted once site-nav is defined');
    assert.equal(after.fbBoxes, 0, 'the fallback child still renders once site-nav is defined');
    assert.equal(after.extraSlotted, true, 'a plain extra child is no longer slotted');
  } finally {
    await page.close();
  }
});

// Colour, hover colour and keyboard-focus outline of the first built-in nav link and of the
// slotted extra, read with the real mouse and Tab key.
async function linkLooks(page) {
  const looks = (sel) => `const n = ${sel}; const s = getComputedStyle(n); return { color: s.color, outline: [s.outlineStyle, s.outlineWidth, s.outlineColor].join(' ') };`;
  const builtIn = 'q("[part~=\\"link\\"]").find(shown)';
  const extra = 'document.getElementById("extra")';
  const rest = { link: await probe(page, looks(builtIn)), extra: await probe(page, looks(extra)) };
  const hover = async (sel) => {
    const at = await probe(page, `return centre(${sel});`);
    await page.hover(at.x, at.y);
    return probe(page, looks(sel));
  };
  const hovered = { link: await hover(builtIn), extra: await hover(extra) };
  await page.hover(0, HEIGHT - 1);
  const focusOf = async (sel) => {
    assert.ok(await tabUntil(page, `f === ${sel}`), `Tab never reached ${sel}`);
    return probe(page, looks(sel));
  };
  const focused = { link: await focusOf(builtIn), extra: await focusOf(extra) };
  return { rest, hovered, focused };
}

test('a slotted <a> extra matches the built-in links in colour, hover colour and focus-visible outline', async () => {
  needBrowser();
  const url = writePage(uniquePath('index.html'), { nav: siteNav({ config: fallbackConfig(), children: EXTRA }) });
  const m = await withPage(DESKTOP, url, linkLooks);
  assert.equal(m.rest.extra.color, m.rest.link.color, 'the extra\'s colour differs from a built-in link');
  assert.equal(m.hovered.extra.color, m.hovered.link.color, 'the extra\'s hover colour differs from a built-in link');
  assert.notEqual(m.hovered.link.color, m.rest.link.color, 'built-in links show no hover colour to match');
  assert.equal(m.focused.extra.outline, m.focused.link.outline, 'the extra\'s focus-visible outline differs from a built-in link');
});

// ---------------------------------------------------------------- landmarks

async function landmarks(page) {
  await page.send('Accessibility.enable');
  const { nodes } = await page.send('Accessibility.getFullAXTree');
  return nodes.filter((n) => !n.ignored && n.role?.value === 'navigation').map((n) => n.name?.value ?? '');
}

[['role="navigation" aria-label="Site"', 'a host with role="navigation"'], ['', 'a plain host']].forEach(([attrs, what]) => {
  test(`${what} gives exactly one navigation landmark`, async () => {
    needBrowser();
    const url = writePage(uniquePath('index.html'), { nav: siteNav({ config: fallbackConfig(), attrs }) });
    const found = await withPage(DESKTOP, url, landmarks);
    assert.equal(found.length, 1, `navigation landmarks: ${JSON.stringify(found)}`);
  });
});

test('the recommended markup <site-nav role="navigation" aria-label="Site"> is documented in docs/flows/pages.md', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'flows', 'pages.md'), 'utf8');
  assert.ok(/<site-nav\s+role="navigation"\s+aria-label="Site"/.test(doc), 'docs/flows/pages.md does not show <site-nav role="navigation" aria-label="Site">');
});

// ---------------------------------------------------------------- site-nav:ready

const READY_HEAD = `<script>window.__ready = [];
window.addEventListener('site-nav:ready', function () {
  var host = document.querySelector('site-nav');
  window.__ready.push(!!(host && host.shadowRoot && host.shadowRoot.querySelector('[part~="bar"]')));
}, true);</script>`;

test('site-nav:ready fires once after the first render, and the ready attribute is set', async () => {
  needBrowser();
  const url = writePage(uniquePath('index.html'), { nav: siteNav({ config: fallbackConfig() }), head: READY_HEAD });
  await withPage(DESKTOP, url, async (page) => {
    await page.waitFor('window.__ready.length > 0', 'site-nav:ready');
    assert.deepEqual(await page.eval('window.__ready'), [true], 'the event fired before the bar rendered');
    assert.equal(await page.eval('document.querySelector("site-nav").hasAttribute("ready")'), true);
    await page.eval('document.querySelector("site-nav").setAttribute("name", "changed"); true');
    await page.settle();
    assert.equal(await page.eval('window.__ready.length'), 1, 'site-nav:ready fired again on a later render');
  });
});

// ---------------------------------------------------------------- CI

test('_self-ci.yml runs this test file', () => {
  const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', '_self-ci.yml'), 'utf8');
  assert.ok(ci.includes('tests/site-kit/site-nav-layout.test.js'), '_self-ci.yml does not run tests/site-kit/site-nav-layout.test.js');
});
