// The user's rules for .github/pages.json (brief requirements 1-6), held at each end of every
// limit they name. Each test builds a throwaway repo and calls loadPagesConfig(repoRoot), which
// returns the resolved config or throws an Error naming the field.
//
// Run with:
//   node --test tests/docs-build/pages-rules.test.js
//
// How "the repo name" is found is left to the builder, so the folder and GITHUB_REPOSITORY
// carry the same name here.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadPagesConfig } = require('../../.github/actions/docs-build/lib/pages-config');

const REPO = 'rules-site';
process.env.GITHUB_REPOSITORY = `octo/${REPO}`;

const outers = [];
test.after(() => outers.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function put(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// pages: an object (written as JSON), a raw string, or null for no file. files: extra repo files.
function repo({ pages = {}, homepage = null, files = [] } = {}) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-rules-'));
  outers.push(outer);
  const root = path.join(outer, REPO);
  put(root, 'docs/getting-started.md', '# Getting started\n');
  put(outer, 'outside.svg', '<svg/>');
  for (const rel of files) put(root, rel, 'x');
  if (homepage) put(root, '.github/homepage.json', JSON.stringify(homepage));
  if (pages !== null) put(root, '.github/pages.json', typeof pages === 'string' ? pages : JSON.stringify(pages));
  return root;
}

const load = (opts) => loadPagesConfig(repo(opts));

function assertFails(opts, ...needles) {
  assert.throws(() => load(opts), (err) => {
    for (const n of needles) {
      const ok = n instanceof RegExp ? n.test(err.message) : err.message.includes(n);
      assert.ok(ok, `expected ${n} in: ${err.message}`);
    }
    return true;
  });
}

const str = (n) => 'a'.repeat(n);
const list = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const link = (i) => ({ label: `L${i}`, href: `/p${i}/` });
const page = (i) => `p${i}.md`;

// ---------- (1) the file ----------

test('(1) no .github/pages.json fails with ".github/pages.json not found"', () => {
  assertFails({ pages: null }, '.github/pages.json not found');
});

test('(2) every field is optional: {} loads', () => {
  assert.ok(load({ pages: {} }));
});

// ---------- (3) defaults ----------

test('(3) with no homepage.json: repo name, #1e7d69, no logo', () => {
  const c = load();
  assert.equal(c.name, REPO);
  assert.equal(c.accent, '#1e7d69');
  assert.ok(c.logo == null, `logo: ${c.logo}`);
});

test('(3) base /<repo>/docs/, home_page getting-started.md, empty lists, no home_link', () => {
  const c = load();
  assert.equal(c.base, `/${REPO}/docs/`);
  assert.equal(c.home_page, 'getting-started.md');
  assert.deepEqual([c.sidebar, c.unpublished, c.nav], [[], [], []]);
  assert.ok(c.home_link == null, `home_link: ${JSON.stringify(c.home_link)}`);
});

test('(3) name, accent and logo come from homepage.json name, colour and image', () => {
  const c = load({ homepage: { name: 'tile', colour: '#4fd1b5', image: 'site/mark.svg' }, files: ['site/mark.svg'] });
  assert.deepEqual([c.name, c.accent, c.logo], ['tile', '#4fd1b5', 'site/mark.svg']);
});

test('(3) a homepage.json missing a field falls back for that field only', () => {
  const c = load({ homepage: { colour: '#abc' } });
  assert.deepEqual([c.name, c.accent], [REPO, '#abc']);
  assert.ok(c.logo == null, `logo: ${c.logo}`);
});

test('(3) pages.json values win over the homepage.json defaults', () => {
  const homepage = { name: 'tile', colour: '#4fd1b5', image: 'site/mark.svg' };
  const pages = { name: 'own', accent: '#123456', logo: 'own.png' };
  const c = load({ pages, homepage, files: ['site/mark.svg', 'own.png'] });
  assert.deepEqual([c.name, c.accent, c.logo], ['own', '#123456', 'own.png']);
});

// ---------- (2)/(4) fields, types and limits ----------

test('(4) unknown field foo fails naming foo', () => {
  assertFails({ pages: { foo: 1 } }, 'foo');
});

test('(2) an extra key inside a nav entry, a sidebar entry or home_link fails naming it', () => {
  assertFails({ pages: { nav: [{ label: 'a', href: '/', target: '_blank' }] } }, 'target');
  assertFails({ pages: { sidebar: [{ file: 'getting-started.md', label: 'a', icon: 'x' }] } }, 'icon');
  assertFails({ pages: { home_link: { label: 'a', href: '/', rel: 'x' } } }, 'rel');
});

const WRONG_TYPES = [
  ['name', 5, 'string'], ['description', [], 'string'], ['base', true, 'string'],
  ['home_page', 1, 'string'], ['sidebar', {}, 'array'], ['unpublished', 'x.md', 'array'],
  ['nav', {}, 'array'], ['home_link', [], 'object'], ['home_link', 'x', 'object'],
  ['accent', 0x1e7d69, 'string'], ['logo', {}, 'string'], ['theme_css', 1, 'string'],
];
for (const [field, value, type] of WRONG_TYPES) {
  test(`(4) ${field}: ${JSON.stringify(value)} fails naming ${field} and the type ${type}`, () => {
    assertFails({ pages: { [field]: value } }, field, type);
  });
}

test('(4) a nav or sidebar entry that is not an object fails naming the field and object', () => {
  assertFails({ pages: { nav: ['/'] } }, 'nav', 'object');
  assertFails({ pages: { sidebar: ['getting-started.md'] } }, 'sidebar', 'object');
});

test('(2) name: 1 and 40 chars pass; empty fails; 41 fails naming 40', () => {
  assert.equal(load({ pages: { name: str(1) } }).name, str(1));
  assert.equal(load({ pages: { name: str(40) } }).name, str(40));
  assertFails({ pages: { name: '' } }, 'name');
  assertFails({ pages: { name: str(41) } }, 'name', '40');
});

test('(2) description: empty, 1 and 200 chars pass; 201 fails naming 200', () => {
  for (const n of [0, 1, 200]) assert.equal(load({ pages: { description: str(n) } }).description, str(n));
  assertFails({ pages: { description: str(201) } }, 'description', '200');
});

test('(2) base: starts and ends with /, 100 chars pass; 101 fails naming 100', () => {
  assert.equal(load({ pages: { base: '/x/' } }).base, '/x/');
  const at = `/${str(98)}/`;
  assert.equal(load({ pages: { base: at } }).base, at);
  assertFails({ pages: { base: `/${str(99)}/` } }, 'base', '100');
});

test('(2) base without a leading or a trailing / fails naming base', () => {
  assertFails({ pages: { base: 'x/' } }, 'base');
  assertFails({ pages: { base: '/x' } }, 'base');
});

test('(2) sidebar: 0, 1 and 100 entries pass in the given order; 101 fails naming 100', () => {
  const files = list(101, (i) => `docs/${page(i)}`);
  for (const n of [0, 1, 100]) {
    const sidebar = list(n, (i) => ({ file: page(i), label: `S${i}` }));
    assert.deepEqual(load({ pages: { sidebar }, files }).sidebar, sidebar);
  }
  assertFails({ pages: { sidebar: list(101, (i) => ({ file: page(i), label: 'S' })) }, files }, 'sidebar', '100');
});

test('(2) sidebar label: 1 and 60 chars pass; empty fails; 61 fails naming 60', () => {
  const entry = (label) => ({ pages: { sidebar: [{ file: 'getting-started.md', label }] } });
  assert.ok(load(entry(str(1))));
  assert.ok(load(entry(str(60))));
  assertFails(entry(''), 'sidebar', 'label');
  assertFails(entry(str(61)), 'sidebar', 'label', '60');
});

test('(4) a sidebar entry with an empty or missing file fails naming file', () => {
  assertFails({ pages: { sidebar: [{ file: '', label: 'a' }] } }, 'sidebar', 'file');
  assertFails({ pages: { sidebar: [{ label: 'a' }] } }, 'sidebar', 'file');
});

test('(2) unpublished: 0, 1 and 100 entries pass; 101 fails naming 100', () => {
  for (const n of [0, 1, 100]) {
    const unpublished = list(n, page);
    assert.deepEqual(load({ pages: { unpublished } }).unpublished, unpublished);
  }
  assertFails({ pages: { unpublished: list(101, page) } }, 'unpublished', '100');
});

test('(2) nav: 0, 1 and 8 entries pass in the given order; 9 fails naming nav and 8', () => {
  for (const n of [0, 1, 8]) assert.deepEqual(load({ pages: { nav: list(n, link) } }).nav, list(n, link));
  assertFails({ pages: { nav: list(9, link) } }, 'nav', '8');
});

test('(2) nav label: 1 and 30 chars pass; empty fails; 31 fails naming 30', () => {
  const entry = (label) => ({ pages: { nav: [{ label, href: '/' }] } });
  assert.ok(load(entry(str(1))));
  assert.ok(load(entry(str(30))));
  assertFails(entry(''), 'nav', 'label');
  assertFails(entry(str(31)), 'nav', 'label', '30');
});

test('(4) an empty or missing href fails naming href', () => {
  assertFails({ pages: { nav: [{ label: 'a', href: '' }] } }, 'nav', 'href');
  assertFails({ pages: { nav: [{ label: 'a' }] } }, 'nav', 'href');
  assertFails({ pages: { home_link: { label: 'a', href: '' } } }, 'home_link', 'href');
});

test('(2) home_link: one { label, href } object is returned; an empty label fails', () => {
  const home_link = { label: '← skathio', href: 'https://skathio.github.io/' };
  assert.deepEqual(load({ pages: { home_link } }).home_link, home_link);
  assertFails({ pages: { home_link: { label: '', href: '/' } } }, 'home_link', 'label');
});

for (const accent of ['#abc', '#ABC', '#1e7d69', '#4FD1B5']) {
  test(`(2) accent ${accent} passes`, () => assert.equal(load({ pages: { accent } }).accent, accent));
}
for (const accent of ['', 'abc', '#ab', '#abcd', '#abcde', '#1e7d6', '#1e7d699', '#1e7d69ff', '#ggg', 'red']) {
  test(`(2) accent ${JSON.stringify(accent)} fails naming accent`, () => assertFails({ pages: { accent } }, 'accent'));
}

test('(2) logo: .svg and .png pass; any other extension fails naming logo', () => {
  const files = ['a.svg', 'a.png', 'a.jpg', 'a.svgz'];
  assert.equal(load({ pages: { logo: 'a.svg' }, files }).logo, 'a.svg');
  assert.equal(load({ pages: { logo: 'a.png' }, files }).logo, 'a.png');
  assertFails({ pages: { logo: 'a.jpg' }, files }, 'logo');
  assertFails({ pages: { logo: 'a.svgz' }, files }, 'logo');
});

test('(2) theme_css: .css passes; any other extension fails naming theme_css', () => {
  const files = ['t.css', 't.scss'];
  assert.equal(load({ pages: { theme_css: 't.css' }, files }).theme_css, 't.css');
  assertFails({ pages: { theme_css: 't.scss' }, files }, 'theme_css');
});

// ---------- (4) size and parse errors ----------

// Valid JSON padded with spaces to exactly `bytes` bytes.
const padded = (bytes) => `{"name":"x"}${' '.repeat(bytes - 12)}`;

test('(4) a pages.json of exactly 64 KB passes; one byte more fails', () => {
  assert.equal(load({ pages: padded(64 * 1024) }).name, 'x');
  assertFails({ pages: padded(64 * 1024 + 1) }, /64/);
});

test('(4) a 65 KB pages.json fails', () => {
  assertFails({ pages: padded(65 * 1024) }, /64/);
});

test('(4) invalid JSON fails with the line of the parse error', () => {
  assertFails({ pages: '{\n  "name": "x",\n  "nav": [,]\n}\n' }, /line 3\b/);
});

// ---------- (5) href allow-list ----------

const GOOD_HREFS = ['https://x.org/', 'http://x.org/', '/abs/', './rel', '../up', '#top'];
const BAD_HREFS = ['javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.c', 'ftp://x', 'x.html', 'JAVASCRIPT:alert(1)', ' https://x.org/'];
for (const href of GOOD_HREFS) {
  test(`(5) href ${href} is allowed in nav and home_link`, () => {
    assert.equal(load({ pages: { nav: [{ label: 'a', href }] } }).nav[0].href, href);
    assert.equal(load({ pages: { home_link: { label: 'a', href } } }).home_link.href, href);
  });
}
for (const href of BAD_HREFS) {
  test(`(5) href ${JSON.stringify(href)} fails naming the field`, () => {
    assertFails({ pages: { nav: [link(0), { label: 'a', href }] } }, 'nav', 'href');
    assertFails({ pages: { home_link: { label: 'a', href } } }, 'home_link', 'href');
  });
}

// ---------- (6) paths stay in the repo ----------

const PATH_FIELDS = {
  logo: (p) => ({ logo: p }),
  theme_css: (p) => ({ theme_css: p }),
  home_page: (p) => ({ home_page: p }),
  sidebar: (p) => ({ sidebar: [{ file: p, label: 'a' }] }),
  unpublished: (p) => ({ unpublished: [p] }),
};
const ext = (field) => ({ logo: '.svg', theme_css: '.css' }[field] || '.md');

for (const [field, make] of Object.entries(PATH_FIELDS)) {
  test(`(6) ${field}: an absolute path fails naming ${field}`, () => {
    assertFails({ pages: make(`/etc/x${ext(field)}`) }, field);
  });
  test(`(6) ${field}: a .. segment fails naming ${field}, even one that lands inside the repo`, () => {
    assertFails({ pages: make(`../x${ext(field)}`) }, field);
    assertFails({ pages: make(`a/../b${ext(field)}`), files: [`b${ext(field)}`, `docs/b${ext(field)}`] }, field);
  });
  test(`(6) ${field}: a symlink leaving the repo fails naming ${field}`, () => {
    const rel = `link${ext(field)}`;
    const root = repo({ pages: make(rel) });
    const target = path.join(path.dirname(root), 'outside.svg');
    for (const dir of ['', 'docs']) fs.symlinkSync(target, path.join(root, dir, rel));
    assert.throws(() => loadPagesConfig(root), (err) => err.message.includes(field));
  });
}

test('(6) a missing logo, theme_css, home_page or sidebar file fails naming the field', () => {
  assertFails({ pages: { logo: 'gone.svg' } }, 'logo');
  assertFails({ pages: { theme_css: 'gone.css' } }, 'theme_css');
  assertFails({ pages: { home_page: 'gone.md' } }, 'home_page');
  assertFails({ pages: { sidebar: [{ file: 'gone.md', label: 'a' }] } }, 'sidebar');
});

test('(6) a missing unpublished entry is allowed', () => {
  assert.deepEqual(load({ pages: { unpublished: ['gone.md'] } }).unpublished, ['gone.md']);
});

test('(6) existing files under docs/ and in the repo pass', () => {
  const files = ['docs/guide.md', 'site/mark.svg', 'site/theme.css'];
  const pages = { home_page: 'guide.md', sidebar: [{ file: 'guide.md', label: 'G' }], logo: 'site/mark.svg', theme_css: 'site/theme.css' };
  assert.equal(load({ pages, files }).home_page, 'guide.md');
});
