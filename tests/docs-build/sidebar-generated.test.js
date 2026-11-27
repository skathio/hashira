// The parts of the docs header and sidebar that docs-nav-sidebar.test.js leaves to the builder:
//
// - A pre_build_command may write a generated sidebar to $DOCS_STAGE/.sidebar.json, a JSON array
//   in the shape of pages.json's `sidebar`. It replaces pages.json's sidebar, is checked with the
//   same rules and limits (errors name the file), is read as data and is never published. A
//   repo's own docs/.sidebar.json is not staged, so only the pre_build_command can write one.
// - Past 2 nav entries the header holds one dropdown labelled with the site name, with the nav
//   entries in it, followed by Docs and home_link, in <site-nav>'s order.
// - A group with no items, or a folder section with no page left to list, fails the build.
// - A link that leaves docs/ opens a folder of the checkout as tree, found by its real path,
//   and never a folder outside the checkout.
//
// Run with:
//   node --test tests/docs-build/sidebar-generated.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', '.github', 'actions', 'docs-build', 'lib');
const { loadPagesConfig, loadGeneratedSidebar, MAX_BYTES } = require(path.join(LIB, 'pages-config'));
const { siteConfig } = require(path.join(LIB, 'site-config'));
const { docsFiles } = require(path.join(LIB, 'prepare'));
const { rewriteLink } = require(path.join(LIB, 'links'));

const temps = [];
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-generated-'));
  temps.push(root);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const DOCS = { 'docs/getting-started.md': '# Start\n', 'docs/guide.md': '# Guide\n', 'docs/api/a.md': '# Alpha\n' };

// siteConfig on a stage copied from docs/, with `staged` written into it as a pre_build_command would.
function build(pages, staged = {}) {
  const root = tree({ ...DOCS, '.github/pages.json': JSON.stringify(pages) });
  const stage = path.join(root, 'stage');
  fs.cpSync(path.join(root, 'docs'), stage, { recursive: true });
  for (const [rel, body] of Object.entries(staged)) fs.writeFileSync(path.join(stage, rel), body);
  return { root, stage, run: () => siteConfig({ config: loadPagesConfig(root), stage, docs: path.join(root, 'docs'), repo: 'https://github.com/o/r', themeCss: null }) };
}

const links = (sidebar) => sidebar.flatMap((i) => [i.link, ...links(i.items ?? [])]).filter(Boolean);

test('a generated .sidebar.json replaces pages.json sidebar and is rendered like it', () => {
  const generated = [{ label: 'API', items: [{ file: 'api/a.md', label: 'A <b>' }] }, { file: 'guide.md', label: 'Guide' }];
  const { sidebar } = build({ sidebar: [{ file: 'getting-started.md', label: 'Start' }] }, { '.sidebar.json': JSON.stringify(generated) }).run();
  assert.equal(sidebar[0].text, 'API');
  assert.deepEqual(sidebar[0].items, [{ text: 'A &#60;b&#62;', link: '/api/a' }]);
  assert.deepEqual(links(sidebar), ['/api/a', '/guide', '/']);
});

test('without .sidebar.json the pages.json sidebar is used', () => {
  assert.equal(loadGeneratedSidebar(build({}).stage), null);
  const { sidebar } = build({ sidebar: [{ file: 'guide.md', label: 'G' }] }).run();
  assert.equal(sidebar[0].text, 'G');
});

test('the generated sidebar is checked with the same rules, naming the file', () => {
  const refuses = (body, pattern) => assert.throws(() => build({}, { '.sidebar.json': body }).run(), pattern, body.slice(0, 60));
  refuses(JSON.stringify([{ file: 'guide.md', label: 'G', icon: 'x' }]), /DOCS_STAGE\/\.sidebar\.json: unknown field sidebar\[0\]\.icon/);
  refuses(JSON.stringify([{ label: 'x'.repeat(61), dir: 'api/' }]), /\.sidebar\.json: sidebar\[0\]\.label must be at most 60/);
  refuses(JSON.stringify([{ label: 'D', dir: '../x/' }]), /\.sidebar\.json: sidebar\[0\]\.dir/);
  refuses(JSON.stringify({ sidebar: [] }), /\.sidebar\.json: sidebar must be an array/);
  refuses('[{', /\.sidebar\.json: invalid JSON/);
  refuses(JSON.stringify([{ file: 'nope.md', label: 'N' }]), /nope\.md/);
  refuses(`[${' '.repeat(MAX_BYTES)}]`, /\.sidebar\.json: is \d+ bytes; the limit is 64 KB/);
  const deep = (n) => (n === 0 ? { file: 'guide.md', label: 'G' } : { label: `L${n}`, items: [deep(n - 1)] });
  refuses(JSON.stringify([deep(4)]), /\.sidebar\.json: .*nest at most 3/);
});

test('a symlinked .sidebar.json is refused', () => {
  const b = build({});
  const target = path.join(b.root, 'elsewhere.json');
  fs.writeFileSync(target, '[]');
  fs.symlinkSync(target, path.join(b.stage, '.sidebar.json'));
  assert.throws(() => b.run(), /\.sidebar\.json: is not a regular file/);
});

test('a repo docs/.sidebar.json is never staged, so pages.json data cannot set it', () => {
  const root = tree({ ...DOCS, 'docs/.sidebar.json': '[]' });
  assert.ok(!docsFiles(path.join(root, 'docs'), fs.realpathSync(root)).includes('.sidebar.json'));
});

test('an empty group and a folder section with no page left fail', () => {
  assert.throws(() => build({ sidebar: [{ label: 'Empty', items: [] }] }).run(), /sidebar\[0\]\.items must not be empty/);
  assert.throws(() => build({ sidebar: [{ label: 'None', dir: 'nothing/' }] }).run(), /folder section nothing\/ lists no page/);
  assert.throws(() => build({ sidebar: [{ file: 'api/a.md', label: 'A' }, { label: 'API', dir: 'api' }] }).run(), /folder section api\/ lists no page/);
});

test('past 2 nav entries: one dropdown named after the site holds them, then Docs and home_link', () => {
  const nav = ['A', 'B', 'C'].map((l) => ({ label: l, href: `https://e.example/${l}` }));
  const items = build({ name: 'Site <x>', nav, home_link: { label: 'Home', href: 'https://e.example/' } }).run().nav;
  assert.deepEqual(items.map((i) => i.text), ['Site &#60;x&#62;', 'Docs', 'Home']);
  assert.deepEqual(items[0].items.map((i) => i.text), ['A', 'B', 'C']);
  assert.ok(items[0].items.every((i) => i.target === '_self'));
  assert.deepEqual(items[1], { text: 'Docs', link: '/', activeMatch: '^/' });
  assert.equal(items[2].target, '_self');
  assert.equal(build({ nav }).run().nav.length, 2, 'no home_link: the dropdown and Docs');
});

test('folder links leaving docs/ follow the real path in the checkout', () => {
  const b = build({});
  fs.mkdirSync(path.join(b.root, 'tools'));
  fs.writeFileSync(path.join(b.root, 'NOTES'), 'x');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-outside-'));
  temps.push(outside);
  fs.symlinkSync(outside, path.join(b.root, 'away'));
  const { isRepoDir } = b.run();
  const opts = { repo: 'https://github.com/o/r', isRepoDir };
  assert.equal(rewriteLink('guide.md', '../tools', opts), 'https://github.com/o/r/tree/HEAD/tools');
  assert.equal(rewriteLink('guide.md', '../NOTES', opts), 'https://github.com/o/r/blob/HEAD/NOTES');
  assert.equal(rewriteLink('guide.md', '../away', opts), 'https://github.com/o/r/blob/HEAD/away', 'a folder outside the checkout is not a repo folder');
  assert.equal(rewriteLink('guide.md', '../missing', opts), 'https://github.com/o/r/blob/HEAD/missing');
});
