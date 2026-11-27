// Unit rules for the docs-build helpers that run without a VitePress build: link targets and
// heading ids (links.js), the sidebar, header and index rewrite (site-config.js), the accent
// CSS (accent.js), the theme bridge (theme-bridge.js) and the stage (prepare.js).
// docs-build-rules.test.js checks the same behaviour on built sites.
//
// Run with:
//   node --test tests/docs-build/docs-build-lib.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', '.github', 'actions', 'docs-build', 'lib');
const { escapeBraces, escapeHtml, githubSlug, rewriteLink } = require(path.join(LIB, 'links'));
const { h1Label } = require(path.join(LIB, 'h1-label'));
const site = require(path.join(LIB, 'site-config'));
const { accentCss, contrast, contrastWarnings, CANVAS, MIN_CONTRAST } = require(path.join(LIB, 'accent'));
const { dropCheckDarkMode } = require(path.join(LIB, 'theme-bridge'));
const { prepare, checkOutputDir } = require(path.join(LIB, 'prepare'));

const temps = [];
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-build-lib-'));
  temps.push(root);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

// ---------- links.js ----------

const REPO = 'https://github.com/octo/site';
const opts = { repo: REPO, unpublished: ['contributing.md'], rewrites: { 'getting-started.md': 'index.md' }, isFolder: (p) => p === 'docs/flows/' };

test('links that leave docs/ open the file on GitHub, anchor kept', () => {
  assert.equal(rewriteLink('catalog.md', '../README.md#top', opts), `${REPO}/blob/HEAD/README.md#top`);
  assert.equal(rewriteLink('flows/npm.md', '../../templates/npm/ci.yml', opts), `${REPO}/blob/HEAD/templates/npm/ci.yml`);
  assert.equal(rewriteLink('usage.md', '../', opts), `${REPO}/tree/HEAD/`);
});

test('a link to an unpublished page opens it on GitHub from any folder; ref is configurable', () => {
  assert.equal(rewriteLink('flows/nuget.md', '../contributing.md#x', opts), `${REPO}/blob/HEAD/docs/contributing.md#x`);
  assert.equal(rewriteLink('usage.md', 'contributing.md', { ...opts, ref: 'main' }), `${REPO}/blob/main/docs/contributing.md`);
});

test('published, missing and outside-the-repo links are left to VitePress', () => {
  for (const href of ['../usage.md#a', 'missing.md', 'https://x.example/a.md', '/abs/', '#here', '../../../x.md', '%E0%A4%A.md']) {
    assert.equal(rewriteLink('flows/npm.md', href, opts), null, href);
  }
});

test('a folder with no index opens on GitHub; a rewritten page is followed', () => {
  assert.equal(rewriteLink('usage.md', './flows/', opts), `${REPO}/tree/HEAD/docs/flows/`);
  assert.equal(rewriteLink('flows/npm.md', '../getting-started.md#next', opts), '../index.md#next');
  assert.equal(rewriteLink('usage.md', 'constructor', opts), null);
});

test('GitHub slugs, brace escaping and HTML escaping', () => {
  assert.equal(githubSlug('The `ci — passed` check'), 'the-ci--passed-check');
  assert.equal(escapeBraces('${{ a }}'), '$&#123;&#123; a &#125;&#125;');
  assert.equal(escapeHtml(`<b a="1">&'</b>`), '&#60;b a=&#34;1&#34;&#62;&#38;&#39;&#60;/b&#62;');
});

test('h1Label skips fenced code, strips marks and escapes markup', () => {
  assert.equal(h1Label('```sh\n# not a heading\n```\n\n# Use `npm` *now* & <x>\n', 'f.md'), 'Use npm now &amp; &lt;x>');
  assert.equal(h1Label('No heading here\n', 'f.md'), 'f.md');
  assert.equal(h1Label('Title\n=====\n', 'f.md'), 'Title');
});

// ---------- site-config.js ----------

test('the landing is the folder above the docs base', () => {
  assert.equal(site.landingOf('/site/docs/'), '/site/');
  assert.equal(site.landingOf('/a/b/docs/'), '/a/b/');
  assert.equal(site.landingOf('/docs/'), '/');
  assert.equal(site.landingOf('/'), '/');
});

test('header hrefs resolve against the landing; URLs stay as written', () => {
  const cases = [['./blog/', '/site/blog/'], ['#f', '/site/#f'], ['/x/', '/x/'], ['../up', '/up'], ['./about?q=1', '/site/about?q=1'], ['https://e.example/a', 'https://e.example/a']];
  for (const [href, want] of cases) assert.equal(site.landingHref(href, '/site/'), want, href);
});

test('nav items: links, Docs, then home_link, all labels escaped', () => {
  const items = site.navItems({ nav: [{ label: '<i>A</i>', href: './a/' }], home_link: { label: 'Home & co', href: 'https://h.example/' } }, '/site/');
  assert.deepEqual(items.map((i) => i.text), ['&#60;i&#62;A&#60;/i&#62;', 'Docs', 'Home &#38; co']);
  assert.deepEqual(items.map((i) => i.link), ['/site/a/', '/', 'https://h.example/']);
  assert.equal(items[0].target, '_self');
  assert.equal(items[1].target, undefined, 'Docs stays inside the router');
  assert.deepEqual(site.navItems({ nav: [], home_link: null }, '/').map((i) => i.text), ['Docs']);
});

test('the home page becomes the index unless it is index.md or unpublished; an index beside it fails', () => {
  assert.deepEqual(site.indexRewrite({ home_page: 'getting-started.md' }, ['getting-started.md']), { 'getting-started.md': 'index.md' });
  assert.deepEqual(site.indexRewrite({ home_page: 'index.md' }, ['index.md']), {});
  assert.deepEqual(site.indexRewrite({ home_page: 'getting-started.md' }, ['index.md']), {});
  assert.throws(() => site.indexRewrite({ home_page: 'getting-started.md' }, ['getting-started.md', 'index.md']), /docs-build: index\.md/);
});

test('staged pages skip public/, dot entries and unpublished folders, in byte order', () => {
  const stage = makeTree({ 'b.md': '', 'B.md': '', 'a/x.md': '', 'public/p.md': '', '.vitepress/c.md': '', 'hid/den.md': '', 'img.png': '' });
  assert.deepEqual(site.stagedPages(stage, ['hid']), ['B.md', 'a/x.md', 'b.md']);
});

test('the sidebar: entries in order, then the rest by path under their H1; a file pre_build_command removed fails', () => {
  const stage = makeTree({ 'z.md': '# Zed\n', 'a.md': '# Ay & <b>\n', 'n/index.md': 'no heading\n' });
  const config = { sidebar: [{ file: 'z.md', label: 'Last <first>' }] };
  const items = site.sidebarItems(config, site.stagedPages(stage, []), stage, {});
  assert.deepEqual(items, [
    { text: 'Last &#60;first&#62;', link: '/z' },
    { text: 'Ay &amp; &lt;b>', link: '/a' },
    { text: 'n/index.md', link: '/n/' },
  ]);
  assert.throws(() => site.sidebarItems({ sidebar: [{ file: 'gone.md', label: 'G' }, { file: 'z.md', label: 'Z' }] }, ['z.md'], stage, {}), /gone\.md/);
});

// ---------- accent.js and theme-bridge.js ----------

test('the default accent keeps the shared palette; another sets every brand shade in both modes', () => {
  assert.equal(accentCss('#1e7d69'), '');
  assert.equal(accentCss('#1E7D69'), '');
  const css = accentCss('#c0ffee');
  assert.match(css, /:root \{[^}]*--vp-c-brand-1: #c0ffee;/);
  assert.match(css, /\.dark \{[^}]*--vp-c-brand-soft:/);
  assert.throws(() => accentCss('red;}body{x'), /accent/);
});

test('accent_dark sets the dark brand shades; with the default accent the light palette stays shared', () => {
  const pair = accentCss('#c0ffee', '#123abc');
  assert.match(pair, /:root \{[^}]*--vp-c-brand-1: #c0ffee;[^}]*--vp-c-brand-2: color-mix\(in srgb, #c0ffee 85%, #000\);/);
  assert.match(pair, /\.dark \{[^}]*--vp-c-brand-1: #123abc;[^}]*--vp-c-brand-soft: color-mix\(in srgb, #123abc 18%, var\(--vp-c-bg\)\);/);
  const darkOnly = accentCss('#1e7d69', '#abc');
  assert.doesNotMatch(darkOnly, /:root/);
  assert.match(darkOnly, /\.dark \{[^}]*--vp-c-brand-1: #abc;/);
  // A custom accent with no accent_dark is used in both modes, as before accent_dark existed.
  assert.match(accentCss('#c0ffee'), /\.dark \{[^}]*--vp-c-brand-1: #c0ffee;/);
  assert.throws(() => accentCss('#c0ffee', 'red;}body{x'), /accent_dark/);
});

test("the contrast check's canvases are the shared theme's --vp-c-bg in each mode", () => {
  const css = fs.readFileSync(path.join(LIB, '..', 'vitepress', '.vitepress', 'theme', 'custom.css'), 'utf8');
  const bg = (block) => css.match(new RegExp(`${block}\\s*\\{[^}]*--vp-c-bg:\\s*(#[0-9a-fA-F]{3,6})`))[1];
  assert.deepEqual(CANVAS, { light: bg(':root'), dark: bg('\\.dark') });
});

test('contrast follows WCAG 2: black on white is 21:1, a colour on itself 1:1', () => {
  assert.equal(Math.round(contrast('#000', '#fff') * 100) / 100, 21);
  assert.equal(contrast('#f7f6f2', '#f7f6f2'), 1);
});

test('a contrast warning names the field and mode only below 4.5:1', () => {
  assert.deepEqual(contrastWarnings('#1e7d69'), [], 'the default pair');
  assert.deepEqual(contrastWarnings('#1e7d69', '#4fd1b5'), []);
  const light = contrastWarnings('#4fd1b5', '#4fd1b5');
  assert.equal(light.length, 1);
  assert.match(light[0], /accent #4fd1b5 .*light canvas/);
  const dark = contrastWarnings('#1e7d69', '#1e7d69');
  assert.equal(dark.length, 1);
  assert.match(dark[0], /accent_dark #1e7d69 .*dark canvas/);
  // A custom accent with no accent_dark is the dark link colour too, and is checked there.
  const both = contrastWarnings('#777777');
  assert.equal(both.length, 2);
  assert.match(both[1], /accent \(no accent_dark is set\) #777777 .*dark canvas/);
  assert.ok(both.every((w) => !w.includes('\n')));
  assert.ok(contrast('#1e7d69', CANVAS.light) >= MIN_CONTRAST);
});

test("VitePress's unguarded check-dark-mode script is dropped, the rest kept", () => {
  const html = '<head><script id="check-dark-mode">;(() => { localStorage.getItem("x") })()</script><script id="check-mac-os">m()</script></head>';
  assert.equal(dropCheckDarkMode(html), '<head><script id="check-mac-os">m()</script></head>');
});

// ---------- prepare.js ----------

test('output_dir: empty, absolute, .., existing and symlinked-out parents are refused', () => {
  const root = makeTree({ 'docs/a.md': '# A\n', 'taken/x': '' });
  const outside = makeTree({});
  fs.symlinkSync(outside, path.join(root, 'link'));
  for (const [out, msg] of [['', /required/], ['/abs', /repo-relative/], ['a/../b', /'\.\.'/], ['taken', /already exists/], ['link/docs', /outside the repo/]]) {
    assert.throws(() => checkOutputDir(root, out), msg, out);
  }
  assert.equal(checkOutputDir(root, 'new/docs'), path.join(root, 'new', 'docs'));
});

function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('prepare stages docs/ without unpublished files, copies the logo and writes the theme files', () => {
  const root = makeTree({
    '.github/pages.json': JSON.stringify({ unpublished: ['secret.md', 'drafts'], logo: 'site/mark.svg', accent: '#123456', theme_css: 'site/t.css' }),
    'site/mark.svg': '<svg/>', 'site/t.css': 'a{}\n',
    'docs/getting-started.md': '# Hi\n', 'docs/secret.md': '# S\n', 'docs/drafts/d.md': '# D\n', 'docs/img/p.png': 'png', 'docs/.hidden.md': '',
  });
  const temp = makeTree({});
  const { work, stage } = withEnv({ GITHUB_REPOSITORY: 'octo/site', RUNNER_TEMP: temp }, () => prepare(root, 'out/docs'));
  assert.ok(work.startsWith(temp));
  const staged = [];
  const walk = (d, rel) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name), `${rel}${e.name}/`) : staged.push(`${rel}${e.name}`)));
  walk(stage, '');
  assert.deepEqual(staged.sort(), ['getting-started.md', 'img/p.png', 'public/mark.svg', 'public/site-theme.css']);
  const theme = path.join(work, 'vitepress', '.vitepress', 'theme');
  assert.match(fs.readFileSync(path.join(theme, 'accent.css'), 'utf8'), /#123456/);
  assert.equal(fs.existsSync(path.join(theme, 'site.css')), false, 'theme_css is not imported into the theme Vite bundles');
  assert.equal(fs.readFileSync(path.join(stage, 'public', 'site-theme.css'), 'utf8'), 'a{}\n');
  const build = JSON.parse(fs.readFileSync(path.join(work, 'vitepress', '.vitepress', 'build.json'), 'utf8'));
  assert.equal(build.repo, 'https://github.com/octo/site');
  assert.equal(build.logo, 'mark.svg');
  assert.equal(build.themeCss, 'site-theme.css');
  assert.equal(fs.existsSync(path.join(work, 'vitepress', 'node_modules')), false, 'the toolchain is copied without node_modules');
  assert.equal(fs.existsSync(path.join(root, 'out')), false, 'prepare writes nothing to output_dir');
});

test('prepare refuses a docs/ symlink that leaves the repo, a logo clash and a missing GITHUB_REPOSITORY', () => {
  const outside = makeTree({ 'x.md': '# X\n' });
  const base = { '.github/pages.json': '{}', 'docs/getting-started.md': '# Hi\n' };
  const env = { GITHUB_REPOSITORY: 'octo/site', RUNNER_TEMP: makeTree({}) };
  const linked = makeTree(base);
  fs.symlinkSync(path.join(outside, 'x.md'), path.join(linked, 'docs', 'x.md'));
  assert.throws(() => withEnv(env, () => prepare(linked, 'out')), /docs\/x\.md is a symlink that leaves the repo/);
  const clash = makeTree({ ...base, '.github/pages.json': '{"logo":"m.svg"}', 'm.svg': '<svg/>', 'docs/public/m.svg': '<svg/>' });
  assert.throws(() => withEnv(env, () => prepare(clash, 'out')), /docs\/public\/m\.svg/);
  const noRepo = makeTree(base);
  assert.throws(() => withEnv({ ...env, GITHUB_REPOSITORY: '' }, () => prepare(noRepo, 'out')), /GITHUB_REPOSITORY/);
});

test('prepare refuses a missing docs/ and an index.md beside the home page', () => {
  const env = { GITHUB_REPOSITORY: 'octo/site', RUNNER_TEMP: makeTree({}) };
  const noDocs = makeTree({ '.github/pages.json': '{"home_page":"x.md"}' });
  assert.throws(() => withEnv(env, () => prepare(noDocs, 'out')), /home_page|docs\//);
  const both = makeTree({ '.github/pages.json': '{}', 'docs/getting-started.md': '# A\n', 'docs/index.md': '# B\n' });
  assert.throws(() => withEnv(env, () => prepare(both, 'out')), /docs\/index\.md/);
  const indexHome = makeTree({ '.github/pages.json': '{"home_page":"index.md"}', 'docs/index.md': '# B\n' });
  assert.doesNotThrow(() => withEnv(env, () => prepare(indexHome, 'out')));
});
