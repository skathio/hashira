// The pages.json contract (brief requirements 1-6): loading, defaults and validation.
//
// Run with:
//   node --test tests/docs-build/pages-config.test.js
//
// Each test builds a throwaway repo under the OS temp folder and calls
// loadPagesConfig(repoRoot), which returns the resolved config (the pages.json field names,
// defaults filled in) or throws an Error whose message names the field. The repo folder and
// GITHUB_REPOSITORY share one name, so "the repo name" is the same however it is read.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadPagesConfig } = require('../../.github/actions/docs-build/lib/pages-config');

const REPO = 'fixture-site';
process.env.GITHUB_REPOSITORY = `octo/${REPO}`;

const temps = [];
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// pages: an object (written as JSON), a raw string, or null for no file.
function makeRepo({ pages = {}, homepage = null, files = [] } = {}) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-config-'));
  temps.push(outer);
  const root = path.join(outer, REPO);
  write(root, 'docs/getting-started.md', '# Getting started\n');
  for (const rel of files) write(root, rel, rel.endsWith('.md') ? '# Page\n' : 'x');
  if (homepage) write(root, '.github/homepage.json', JSON.stringify(homepage));
  if (pages !== null) write(root, '.github/pages.json', typeof pages === 'string' ? pages : JSON.stringify(pages));
  return root;
}

async function assertLoads(opts) {
  return loadPagesConfig(makeRepo(opts));
}

async function assertFails(opts, ...needles) {
  const root = makeRepo(opts);
  await assert.rejects(async () => loadPagesConfig(root), (err) => {
    for (const n of needles) {
      const ok = n instanceof RegExp ? n.test(err.message) : err.message.includes(n);
      assert.ok(ok, `expected ${n} in: ${err.message}`);
    }
    return true;
  });
}

const str = (n) => 'a'.repeat(n);
const entries = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const link = (i) => ({ label: `L${i}`, href: `/p${i}/` });

// ---------- (1) the file must exist ----------

test('(1) no .github/pages.json fails with "not found"', async () => {
  await assertFails({ pages: null }, '.github/pages.json not found');
});

test('(1) an empty object is a valid pages.json', async () => {
  await assertLoads({ pages: {} });
});

// ---------- (3) defaults ----------

test('(3) without homepage.json: repo name, #1e7d69, no logo', async () => {
  const c = await assertLoads();
  assert.equal(c.name, REPO);
  assert.equal(c.accent, '#1e7d69');
  assert.ok(c.logo == null, `logo: ${c.logo}`);
});

test('(3) base is /<repo>/docs/, home_page getting-started.md, empty lists, no home_link', async () => {
  const c = await assertLoads();
  assert.equal(c.base, `/${REPO}/docs/`);
  assert.equal(c.home_page, 'getting-started.md');
  assert.deepEqual(c.sidebar, []);
  assert.deepEqual(c.unpublished, []);
  assert.deepEqual(c.nav, []);
  assert.ok(c.home_link == null, `home_link: ${JSON.stringify(c.home_link)}`);
});

test('(3) name, accent and logo come from homepage.json name, colour and image', async () => {
  const homepage = { name: 'hashira', colour: '#4fd1b5', image: 'site/mark.svg' };
  const c = await assertLoads({ homepage, files: ['site/mark.svg'] });
  assert.equal(c.name, 'hashira');
  assert.equal(c.accent, '#4fd1b5');
  assert.equal(c.logo, 'site/mark.svg');
});

test('(3) a homepage.json without colour or image falls back per field', async () => {
  const c = await assertLoads({ homepage: { name: 'tile-name' } });
  assert.equal(c.name, 'tile-name');
  assert.equal(c.accent, '#1e7d69');
  assert.ok(c.logo == null);
});

test('(3) a homepage.json without name falls back to the repo name', async () => {
  const c = await assertLoads({ homepage: { colour: '#abc' } });
  assert.equal(c.name, REPO);
  assert.equal(c.accent, '#abc');
});

test('(3) pages.json values win over homepage.json', async () => {
  const homepage = { name: 'tile', colour: '#4fd1b5', image: 'site/mark.svg' };
  const pages = { name: 'own', accent: '#123456', logo: 'site/own.png' };
  const c = await assertLoads({ homepage, pages, files: ['site/mark.svg', 'site/own.png'] });
  assert.equal(c.name, 'own');
  assert.equal(c.accent, '#123456');
  assert.equal(c.logo, 'site/own.png');
});

test('(2) given values are returned as set', async () => {
  const pages = {
    description: 'd', base: '/x/docs/', home_page: 'intro.md',
    sidebar: [{ file: 'intro.md', label: 'Intro' }], unpublished: ['gone.md'],
    nav: [{ label: 'Flows', href: '#flows' }], home_link: { label: 'Home', href: 'https://example.com/' },
    theme_css: 'site/extra.css',
  };
  const c = await assertLoads({ pages, files: ['docs/intro.md', 'site/extra.css'] });
  for (const key of Object.keys(pages)) assert.deepEqual(c[key], pages[key], key);
});

// ---------- (2)/(4) unknown fields and types ----------

test('(4) an unknown field fails naming it', async () => {
  await assertFails({ pages: { foo: 1 } }, 'foo');
});

for (const [field, value, type] of [
  ['name', 5, 'string'], ['description', [], 'string'], ['base', true, 'string'],
  ['home_page', 1, 'string'], ['accent', 1, 'string'], ['logo', {}, 'string'], ['theme_css', 2, 'string'],
  ['sidebar', {}, 'array'], ['unpublished', 'a.md', 'array'], ['nav', {}, 'array'],
  ['home_link', [], 'object'], ['home_link', 'x', 'object'],
]) {
  test(`(4) ${field}: ${JSON.stringify(value)} fails naming the field and type ${type}`, async () => {
    await assertFails({ pages: { [field]: value } }, field, type);
  });
}

test('(4) a nav entry that is not an object fails naming nav and object', async () => {
  await assertFails({ pages: { nav: ['x'] } }, 'nav', 'object');
});

test('(4) a sidebar entry that is not an object fails naming sidebar and object', async () => {
  await assertFails({ pages: { sidebar: [3] } }, 'sidebar', 'object');
});

// ---------- (2)/(4) string limits ----------

test('(2) name of 1 and 40 chars passes', async () => {
  assert.equal((await assertLoads({ pages: { name: 'a' } })).name, 'a');
  assert.equal((await assertLoads({ pages: { name: str(40) } })).name, str(40));
});

test('(4) name of 41 chars fails naming name and 40', async () => {
  await assertFails({ pages: { name: str(41) } }, 'name', '40');
});

test('(4) an empty name fails naming name', async () => {
  await assertFails({ pages: { name: '' } }, 'name');
});

test('(2) description of 0 and 200 chars passes, 201 fails naming 200', async () => {
  await assertLoads({ pages: { description: '' } });
  await assertLoads({ pages: { description: str(200) } });
  await assertFails({ pages: { description: str(201) } }, 'description', '200');
});

test('(2) base that starts and ends with / passes, up to 100 chars', async () => {
  await assertLoads({ pages: { base: '/' } });
  await assertLoads({ pages: { base: '/docs/' } });
  await assertLoads({ pages: { base: `/${str(98)}/` } });
});

test('(4) base over 100 chars fails naming base and 100', async () => {
  await assertFails({ pages: { base: `/${str(99)}/` } }, 'base', '100');
});

for (const base of ['docs/', '/docs', 'docs', '']) {
  test(`(2) base ${JSON.stringify(base)} fails naming base`, async () => {
    await assertFails({ pages: { base } }, 'base');
  });
}

// ---------- (2)/(4) sidebar ----------

const sidebarFiles = (n) => entries(n, (i) => `docs/s${i}.md`);
const sidebar = (n) => entries(n, (i) => ({ file: `s${i}.md`, label: `S${i}` }));

test('(2) sidebar with 0, 1 and 100 entries passes', async () => {
  for (const n of [0, 1, 100]) {
    const c = await assertLoads({ pages: { sidebar: sidebar(n) }, files: sidebarFiles(n) });
    assert.equal(c.sidebar.length, n);
  }
});

test('(4) sidebar with 101 entries fails naming sidebar and 100', async () => {
  await assertFails({ pages: { sidebar: sidebar(101) }, files: sidebarFiles(101) }, 'sidebar', '100');
});

test('(2) sidebar label of 60 chars passes, 61 fails naming 60', async () => {
  const files = ['docs/a.md'];
  await assertLoads({ pages: { sidebar: [{ file: 'a.md', label: str(60) }] }, files });
  await assertFails({ pages: { sidebar: [{ file: 'a.md', label: str(61) }] }, files }, 'sidebar', 'label', '60');
});

test('(4) an empty sidebar label or file fails naming the sub-field', async () => {
  const files = ['docs/a.md'];
  await assertFails({ pages: { sidebar: [{ file: 'a.md', label: '' }] }, files }, 'sidebar', 'label');
  await assertFails({ pages: { sidebar: [{ file: '', label: 'A' }] }, files }, 'sidebar', 'file');
});

test('(6) a sidebar file missing from docs/ fails naming sidebar', async () => {
  await assertFails({ pages: { sidebar: [{ file: 'nope.md', label: 'Nope' }] } }, 'sidebar');
});

// ---------- (2)/(4) unpublished ----------

test('(2) unpublished with 0, 1 and 100 entries passes; missing files are allowed', async () => {
  for (const n of [0, 1, 100]) {
    const c = await assertLoads({ pages: { unpublished: entries(n, (i) => `u${i}.md`) } });
    assert.equal(c.unpublished.length, n);
  }
});

test('(4) unpublished with 101 entries fails naming unpublished and 100', async () => {
  await assertFails({ pages: { unpublished: entries(101, (i) => `u${i}.md`) } }, 'unpublished', '100');
});

// ---------- (2)/(4) nav and home_link ----------

test('(2) nav with 0, 1 and 8 entries passes', async () => {
  for (const n of [0, 1, 8]) assert.equal((await assertLoads({ pages: { nav: entries(n, link) } })).nav.length, n);
});

test('(4) nav with 9 entries fails naming nav and limit 8', async () => {
  await assertFails({ pages: { nav: entries(9, link) } }, 'nav', '8');
});

test('(2) nav label of 30 chars passes, 31 fails naming 30', async () => {
  await assertLoads({ pages: { nav: [{ label: str(30), href: '/' }] } });
  await assertFails({ pages: { nav: [{ label: str(31), href: '/' }] } }, 'nav', 'label', '30');
});

test('(4) an empty nav label or href fails naming the sub-field', async () => {
  await assertFails({ pages: { nav: [{ label: '', href: '/' }] } }, 'nav', 'label');
  await assertFails({ pages: { nav: [{ label: 'A', href: '' }] } }, 'nav', 'href');
});

test('(4) an empty home_link label or href fails naming home_link', async () => {
  await assertFails({ pages: { home_link: { label: '', href: '/' } } }, 'home_link', 'label');
  await assertFails({ pages: { home_link: { label: 'Home', href: '' } } }, 'home_link', 'href');
});

// ---------- (5) href scheme allow-list ----------

for (const href of ['https://example.com/', 'http://example.com/', '/abs/', './rel', '../up/', '#anchor']) {
  test(`(5) href ${href} is allowed in nav and home_link`, async () => {
    await assertLoads({ pages: { nav: [{ label: 'A', href }], home_link: { label: 'H', href } } });
  });
}

for (const href of ['javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.c', 'page.html']) {
  test(`(5) href ${href} fails in nav and in home_link, naming the field`, async () => {
    await assertFails({ pages: { nav: [{ label: 'A', href }] } }, 'nav');
    await assertFails({ pages: { home_link: { label: 'H', href } } }, 'home_link');
  });
}

// ---------- (2) accent, logo, theme_css ----------

for (const accent of ['#abc', '#a1b2c3']) {
  test(`(2) accent ${accent} passes`, async () => {
    assert.equal((await assertLoads({ pages: { accent } })).accent, accent);
  });
}

for (const accent of ['abc', '#ab', '#abcd', '#abcdeff', '#ggg', 'red', '']) {
  test(`(2) accent ${JSON.stringify(accent)} fails naming accent`, async () => {
    await assertFails({ pages: { accent } }, 'accent');
  });
}

test('(2) logo .svg and .png pass; another extension fails naming logo', async () => {
  await assertLoads({ pages: { logo: 'site/l.svg' }, files: ['site/l.svg'] });
  await assertLoads({ pages: { logo: 'site/l.png' }, files: ['site/l.png'] });
  await assertFails({ pages: { logo: 'site/l.jpg' }, files: ['site/l.jpg'] }, 'logo');
});

test('(2) theme_css must end in .css, naming theme_css', async () => {
  await assertLoads({ pages: { theme_css: 'site/t.css' }, files: ['site/t.css'] });
  await assertFails({ pages: { theme_css: 'site/t.txt' }, files: ['site/t.txt'] }, 'theme_css');
});

// ---------- (6) paths stay inside the repo ----------

test('(6) logo "../x.svg" fails naming logo', async () => {
  await assertFails({ pages: { logo: '../x.svg' } }, 'logo');
});

for (const [field, value] of [
  ['logo', '/etc/x.svg'], ['logo', 'site/../site/l.svg'], ['theme_css', '/tmp/t.css'], ['theme_css', '../t.css'],
  ['home_page', '/abs.md'], ['home_page', '../README.md'],
  ['unpublished', ['/abs.md']], ['unpublished', ['../README.md']],
  ['sidebar', [{ file: '../README.md', label: 'R' }]], ['sidebar', [{ file: '/abs.md', label: 'A' }]],
]) {
  test(`(6) ${field} ${JSON.stringify(value)} (absolute or ..) fails naming ${field}`, async () => {
    await assertFails({ pages: { [field]: value }, files: ['site/l.svg', 'README.md'] }, field);
  });
}

test('(6) a symlink leaving the repo fails naming the field', async () => {
  const root = makeRepo({ pages: { logo: 'site/l.svg', theme_css: 'site/t.css' } });
  const outside = path.join(path.dirname(root), 'outside');
  write(outside, 'l.svg', '<svg/>');
  fs.mkdirSync(path.join(root, 'site'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'l.svg'), path.join(root, 'site/l.svg'));
  write(root, 'site/t.css', 'a{}');
  await assert.rejects(async () => loadPagesConfig(root), /logo/);
});

test('(6) a symlinked docs/ file leaving the repo fails naming sidebar', async () => {
  const root = makeRepo({ pages: { sidebar: [{ file: 'out.md', label: 'Out' }] } });
  const outside = path.join(path.dirname(root), 'outside');
  write(outside, 'out.md', '# Out\n');
  fs.symlinkSync(path.join(outside, 'out.md'), path.join(root, 'docs/out.md'));
  await assert.rejects(async () => loadPagesConfig(root), /sidebar/);
});

for (const [field, value] of [
  ['logo', 'site/none.svg'], ['theme_css', 'site/none.css'], ['home_page', 'none.md'],
]) {
  test(`(6) a missing ${field} file fails naming ${field}`, async () => {
    await assertFails({ pages: { [field]: value } }, field);
  });
}

test('(6) a homepage.json image that is missing fails naming logo', async () => {
  await assertFails({ homepage: { image: 'site/none.svg' } }, 'logo');
});

// ---------- (4) file size and JSON syntax ----------

const padded = (bytes) => {
  const body = '{"name":"padded"}';
  return body.slice(0, -1) + ' '.repeat(bytes - body.length) + '}';
};

test('(4) a 64000-byte pages.json passes', async () => {
  assert.equal((await assertLoads({ pages: padded(64000) })).name, 'padded');
});

test('(4) a pages.json over 64 KB fails', async () => {
  await assertFails({ pages: padded(65 * 1024) }, '64');
  await assertFails({ pages: padded(64 * 1024 + 1) }, '64');
});

test('(4) invalid JSON fails with the line of the parse error', async () => {
  await assertFails({ pages: '{\n  "name": "x",\n  oops\n}\n' }, /line\D{0,3}3\b/i);
});
