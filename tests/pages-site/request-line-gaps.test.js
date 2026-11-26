// Cases the request's lines call for that the rules files leave open: pages.json values that
// VitePress writes into the HTML unescaped (the boundary "pages.json -> HTML: labels escaped as
// text"), a home_page or sidebar file that is not a Markdown page, a scheme-relative header link
// in the docs (requirement 17: nav links resolve as on the landing), and <site-nav> given its
// `config` property before its script defined it (requirement 15: works in React 19).
//
// Run with:
//   node --test tests/pages-site/request-line-gaps.test.js
// The one build case runs on Node 22 or later only, and installs VitePress from docs-build's
// lockfile, so it needs network once.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const DOCS_BUILD = path.join(REPO, '.github', 'actions', 'docs-build');
const LIB = path.join(DOCS_BUILD, 'lib');
const { loadPagesConfig } = require(path.join(LIB, 'pages-config.js'));
const { landingHref } = require(path.join(LIB, 'site-config.js'));
const { escapeInlineMetadata, descriptionTag } = require(path.join(LIB, 'html-safety.js'));
const SITE_NAV = fs.readFileSync(path.join(REPO, '.github', 'actions', 'site-kit', 'kit', 'site-nav.js'), 'utf8');

const temps = [];
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function repo(pages, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'line-gaps-'));
  temps.push(root);
  const all = { '.github/pages.json': JSON.stringify(pages), 'docs/getting-started.md': '# Getting started\n\nHi.\n', ...files };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const assertFails = (pages, files, ...names) => assert.throws(() => loadPagesConfig(repo(pages, files)), (err) => names.every((n) => err.message.includes(n)), names.join(' '));

// ---------- pages.json: values that become HTML or pages ----------

test('(2) a home_page that is not a .md page fails naming home_page', () => {
  assertFails({ home_page: 'notes.txt' }, { 'docs/notes.txt': 'x' }, 'home_page', '.md');
});

test('(2) a sidebar file that is not a .md page fails naming its field', () => {
  assertFails({ sidebar: [{ file: 'notes.txt', label: 'Notes' }] }, { 'docs/notes.txt': 'x' }, 'sidebar[0].file', '.md');
});

for (const base of ['/a"b/', '/a<b/', '/a b/', '/../', '/./', '/a//b/']) {
  test(`(2) base ${JSON.stringify(base)} is not a plain URL path and fails naming base`, () => assertFails({ base }, {}, 'base'));
}

test('(2) the bases in use still pass', () => {
  for (const base of ['/', '/docs/', '/hashira/docs/', '/my.site/docs-v1/']) {
    assert.equal(loadPagesConfig(repo({ base })).base, base);
  }
});

// ---------- (17) the docs header resolves links as the landing does ----------

test('(17) a scheme-relative header link keeps its host in the docs, as it does on the landing', () => {
  assert.equal(landingHref('//other.example/p', '/site/'), '//other.example/p');
  assert.equal(landingHref('/x/', '/site/'), '/x/');
});

// ---------- the HTML VitePress writes ----------

test('the inline site data holds no `<`, and still parses to the same value', () => {
  const data = { title: 'a</script><script>x()</script>', description: 'd' };
  const literal = JSON.stringify(JSON.stringify(data));
  const html = `<script>window.__VP_HASH_MAP__=JSON.parse(${JSON.stringify(JSON.stringify({ '</script>.md': 'h' }))});window.__VP_SITE_DATA__=JSON.parse(${literal});</script>`;
  const out = escapeInlineMetadata(html);
  const inner = out.slice('<script>'.length, -'</script>'.length);
  assert.doesNotMatch(inner, /</);
  const window = {};
  vm.runInNewContext(inner, { window, JSON });
  assert.deepEqual(window.__VP_SITE_DATA__, data);
  assert.deepEqual(window.__VP_HASH_MAP__, { '</script>.md': 'h' });
});

test('HTML outside the inline site data is left as it is', () => {
  const html = '<p>a < b</p><script>window.__VP_SITE_DATA__=JSON.parse("{}");</script>';
  assert.equal(escapeInlineMetadata(html), html);
});

test('the description becomes a head tag, which VitePress escapes', () => {
  assert.deepEqual(descriptionTag('d"><b>'), ['meta', { name: 'description', content: 'd"><b>' }]);
  assert.deepEqual(descriptionTag(undefined), ['meta', { name: 'description', content: '' }]);
});

function bashOk(cmd, cwd, env) {
  const run = spawnSync('bash', ['-eo', 'pipefail', '-c', cmd], { cwd, env, encoding: 'utf8' });
  assert.equal(run.status, 0, `${cmd}\n${run.stdout}\n${run.stderr}`);
}

// The unit cases above also run on Node 20 (docs-build-unit-tests); this build runs where the
// other VitePress builds do, on a current Node (the hashira-site job, Node 24).
const OLD_NODE = Number(process.versions.node.split('.')[0]) < 22;

test('a pages.json name, description or home_link with </script> never becomes markup in the built docs', { timeout: 900_000, skip: OLD_NODE && 'VitePress builds run on Node 22 or later' }, () => {
  const pages = {
    name: 'a</title><script>x()</script>',
    description: 'd"><script>y()</script>',
    home_link: { label: 'Home', href: 'https://h.example/</script><script>z()</script>' },
  };
  const root = repo(pages);
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'line-gaps-run-'));
  temps.push(outer);
  const { NODE_TEST_CONTEXT: _, ...base } = process.env;
  const env = { ...base, GITHUB_REPOSITORY: 'octo/site', RUNNER_TEMP: outer, GITHUB_OUTPUT: path.join(outer, 'out'), DB_OUTPUT_DIR: 'out', DB_ACTION: DOCS_BUILD };
  bashOk(`node "${path.join(LIB, 'prepare.js')}"`, root, env);
  const work = fs.readFileSync(env.GITHUB_OUTPUT, 'utf8').match(/^work=(.*)$/m)[1];
  bashOk('npm ci --ignore-scripts --include=dev --no-audit --no-fund', path.join(work, 'vitepress'), env);
  bashOk(`node node_modules/vitepress/bin/vitepress.js build "${path.join(work, 'vitepress')}"`, path.join(work, 'vitepress'), env);
  const html = fs.readFileSync(path.join(work, 'dist', 'index.html'), 'utf8');
  for (const call of ['x()', 'y()', 'z()']) assert.ok(!html.includes(`<script>${call}`), `${call} became a script`);
  const meta = html.match(/<meta name="description" content="([^"]*)">/g) ?? [];
  assert.equal(meta.length, 1, `one description tag: ${meta.join(' ')}`);
  assert.match(meta[0], /^<meta name="description" content="d&quot;&gt;&lt;script&gt;y\(\)&lt;\/script&gt;">$/);
});

// ---------- (15) <site-nav> given its config before the script defines it ----------

class Node {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.text = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  appendChild(n) { this.children.push(n); return n; }
  replaceChildren(...n) { this.children = n; }
  addEventListener() {}
  set textContent(v) { this.text = v; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
}

function fakeWindow() {
  const registry = new Map();
  let upgrading = null;
  class HTMLElement extends Node {
    constructor() {
      super('site-nav');
      // A browser's upgrade runs the constructor on the element already in the page.
      if (upgrading) {
        const el = upgrading;
        upgrading = null;
        Object.setPrototypeOf(el, new.target.prototype);
        return el;
      }
    }
    get isConnected() { return true; }
    attachShadow() { this.shadowRoot = new Node('#shadow'); return this.shadowRoot; }
    querySelector() { return null; }
  }
  const document = {
    readyState: 'complete', addEventListener() {}, removeEventListener() {},
    createElement: (tag) => new Node(tag),
    documentElement: { style: { setProperty() {} } },
  };
  const customElements = {
    get: (name) => registry.get(name),
    define: (name, cls) => registry.set(name, cls),
    upgrade: (el) => { upgrading = el; return new (registry.get('site-nav'))(); },
  };
  const window = { customElements, document, HTMLElement };
  window.window = window;
  return { window, document, HTMLElement, customElements };
}

const links = (el) => {
  const bar = el.shadowRoot.children.find((n) => n.tag === 'nav');
  return bar.children.filter((n) => n.tag === 'a').map((a) => a.textContent);
};

test('(15) config set before site-nav.js defines the element is used once it upgrades', () => {
  const ctx = fakeWindow();
  const el = new ctx.HTMLElement();
  el.config = { name: 'Early', nav: [{ label: 'Flows', href: '#flows' }] };
  vm.runInNewContext(SITE_NAV, ctx);
  const upgraded = ctx.customElements.upgrade(el);
  upgraded.connectedCallback();
  assert.deepEqual(links(upgraded), ['Early', 'Flows']);
  assert.deepEqual(upgraded.config, el.config);
});

test('(15) config set as a property after definition renders, as React 19 sets it', () => {
  const ctx = fakeWindow();
  vm.runInNewContext(SITE_NAV, ctx);
  const el = new (ctx.customElements.get('site-nav'))();
  el.connectedCallback();
  el.config = { name: 'Late', nav: [{ label: 'Use it', href: '#use' }], home_link: { label: 'Home', href: 'https://h.example/' } };
  assert.deepEqual(links(el), ['Late', 'Use it', 'Home']);
});
