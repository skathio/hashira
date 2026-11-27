// The user's rules for the docs header, the sidebar and folder links:
//
// - docs-build's header holds every pages.json nav entry, Docs and home_link. With more than 2 nav
//   entries they no longer sit one by one in VitePress's top bar (one dropdown labelled with the
//   site name, or another layout that fits): with 8 entries and home_link, the built docs have
//   no horizontal overflow at 768, 1024 and 1280. Docs is marked active through activeMatch
//   instead of being a plain self-link. Labels stay HTML-escaped, as every header label is today.
// - pages.json `sidebar` takes, besides {file, label}: groups {label, items, collapsed?} nested
//   up to 3 levels, and folder sections {label, dir, collapsed?} that list the published pages
//   under that folder in path order, labelled by their H1. The same limits and unknown-field
//   rules hold for them as for {file, label}; a missing file, or one that is also unpublished,
//   still fails, and every page not in the sidebar is still listed after it, once.
// - A link to a folder of the repo outside docs/ opens it on GitHub as tree/HEAD, not blob/HEAD:
//   the real repo path is checked for any in-repo target, so a folder link without a trailing
//   '/' becomes a tree link too. Files keep blob/HEAD.
//
// The config cases go through loadPagesConfig and siteConfig, as prepare.js and the VitePress
// config do. The built cases run docs-build's action.yml steps with bash the way a runner does,
// against fixture repos in a temporary folder (the first build installs VitePress from the
// action's lockfile, so it needs network access once), and open the pages in headless Chrome,
// driven over the DevTools protocol on a pipe and found through CHROME_BIN, then google-chrome,
// chromium or a Playwright download.
//
// Left to the builder, so not tested here: the layout used past 2 nav entries and the dropdown's
// label, where Docs and home_link sit in it, the name of the reserved file a pre_build_command
// writes a generated sidebar to (so the generated sidebar is not tested here), what a group
// with no items or a folder section with no pages does, whether a folder section lists pages in
// sub-folders under groups of their own, and what `collapsed` left out becomes.
//
// Run with:
//   node --test tests/docs-build/docs-nav-sidebar.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ACTION_DIR = path.join(REPO, '.github', 'actions', 'docs-build');
const { loadPagesConfig } = require(path.join(ACTION_DIR, 'lib', 'pages-config'));
const { siteConfig } = require(path.join(ACTION_DIR, 'lib', 'site-config'));
const { escapeHtml } = require(path.join(ACTION_DIR, 'lib', 'links'));
const { h1Label } = require(path.join(ACTION_DIR, 'lib', 'h1-label'));

const WIDTHS = [768, 1024, 1280];
const HEIGHT = 900;
const BUILD_TIMEOUT = 600_000;
const WAIT_STEPS = 200;
const WAIT_STEP_MS = 50;
const FAKE_SHA = 'd'.repeat(40);
const NAV8 = ['Getting started', 'Flows', 'Security', 'Catalog', 'Releases', 'Changelog', 'Contributing', 'Blog']
  .map((label, i) => ({ label, href: `https://octo.example/p${i}/` }));
const HOME = { label: '← octo', href: 'https://octo.example/' };

const temps = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

// ---------------------------------------------------------------- pages.json and siteConfig

const DOCS = {
  'docs/getting-started.md': '# Getting started\n',
  'docs/guide.md': '# Guide\n',
  'docs/extra.md': '# Extra page\n',
  'docs/api/b.md': '# Beta & <b>\n',
  'docs/api/a.md': '# Alpha\n',
  'docs/api/sub/c.md': '# Gamma\n',
  'docs/api/secret.md': '# Secret\n',
};

function pagesRepo(pages, files = {}) {
  const root = writeTree(path.join(tempDir('docs-nav-config-'), 'site'), { ...DOCS, ...files });
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'pages.json'), JSON.stringify(pages));
  return root;
}

const load = (pages, files) => loadPagesConfig(pagesRepo(pages, files));
const assertLoads = (pages, what) => assert.doesNotThrow(() => load(pages), what);
const assertRefuses = (pages, pattern, what) => assert.throws(() => load(pages), pattern, what);

// siteConfig on a stage copied from docs/, plus the files a pre_build_command would add there.
function siteOf(pages, { staged = {} } = {}) {
  const root = pagesRepo(pages);
  const config = loadPagesConfig(root);
  const stage = path.join(tempDir('docs-nav-stage-'), 'src');
  fs.cpSync(path.join(root, 'docs'), stage, { recursive: true });
  for (const u of config.unpublished) fs.rmSync(path.join(stage, u), { recursive: true, force: true });
  writeTree(stage, staged);
  return siteConfig({ config, stage, docs: path.join(root, 'docs'), repo: 'https://github.com/octo/site', themeCss: null });
}

// Every item of a VitePress nav or sidebar tree, depth first.
function flatten(items) {
  return items.flatMap((item) => [item, ...flatten(item.items ?? [])]);
}

const file = (f, label = f) => ({ file: f, label });
const group = (label, items, extra = {}) => ({ label, items, ...extra });
const nested = (depth) => (depth === 0 ? file('guide.md') : group(`Level ${depth}`, [nested(depth - 1)]));

test('a sidebar group of pages loads, with collapsed true, false or left out', () => {
  assertLoads({ sidebar: [group('Guides', [file('guide.md'), file('extra.md')])] });
  assertLoads({ sidebar: [group('Guides', [file('guide.md')], { collapsed: true })] });
  assertLoads({ sidebar: [group('Guides', [file('guide.md')], { collapsed: false })] });
});

test('groups nest up to 3 levels, and a 4th level fails naming the sidebar', () => {
  assertLoads({ sidebar: [nested(1)] }, 'one level');
  assertLoads({ sidebar: [nested(3)] }, 'three levels');
  assertRefuses({ sidebar: [nested(4)] }, /sidebar/, 'four levels');
});

test('a folder section loads, with collapsed true, false or left out', () => {
  assertLoads({ sidebar: [{ label: 'API', dir: 'api/' }] });
  assertLoads({ sidebar: [{ label: 'API', dir: 'api/', collapsed: true }] });
  assertLoads({ sidebar: [group('Reference', [{ label: 'API', dir: 'api/', collapsed: false }])] });
});

test('group and folder labels keep the 1-60 character limit, naming the field', () => {
  assertLoads({ sidebar: [group('g'.repeat(60), [file('guide.md')])] }, 'a 60-character group label');
  assertLoads({ sidebar: [{ label: 'd'.repeat(60), dir: 'api/' }] }, 'a 60-character folder label');
  assertRefuses({ sidebar: [group('', [file('guide.md')])] }, /sidebar.*label/, 'an empty group label');
  assertRefuses({ sidebar: [group('g'.repeat(61), [file('guide.md')])] }, /sidebar.*label/, 'a 61-character group label');
  assertRefuses({ sidebar: [{ label: 'd'.repeat(61), dir: 'api/' }] }, /sidebar.*label/, 'a 61-character folder label');
  assertRefuses({ sidebar: [{ label: '', dir: 'api/' }] }, /sidebar.*label/, 'an empty folder label');
  assertRefuses({ sidebar: [group('Guides', [file('guide.md', 'x'.repeat(61))])] }, /sidebar.*label/, 'a 61-character page label in a group');
});

test('a group of 99 pages loads and one of 101 fails, naming the sidebar', () => {
  const files = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`docs/many/p${i}.md`, `# P${i}\n`]));
  const pagesOf = (n) => ({ sidebar: [group('Many', Array.from({ length: n }, (_, i) => file(`many/p${i}.md`)))] });
  assert.doesNotThrow(() => load(pagesOf(99), files));
  assert.throws(() => load(pagesOf(101), files), /sidebar/);
});

test('fields of the wrong type fail, naming the field', () => {
  for (const items of ['guide.md', { file: 'guide.md' }, null, 3]) {
    assertRefuses({ sidebar: [{ label: 'Guides', items }] }, /items/, `items ${JSON.stringify(items)}`);
  }
  for (const collapsed of ['true', 1, null, []]) {
    assertRefuses({ sidebar: [group('Guides', [file('guide.md')], { collapsed })] }, /collapsed/, `group collapsed ${JSON.stringify(collapsed)}`);
    assertRefuses({ sidebar: [{ label: 'API', dir: 'api/', collapsed }] }, /collapsed/, `folder collapsed ${JSON.stringify(collapsed)}`);
  }
  for (const label of [7, null, ['x']]) assertRefuses({ sidebar: [group(label, [file('guide.md')])] }, /label/, `label ${JSON.stringify(label)}`);
  for (const dir of [7, null, ['api/']]) assertRefuses({ sidebar: [{ label: 'API', dir }] }, /dir/, `dir ${JSON.stringify(dir)}`);
});

test('a folder section dir must be a normalized path inside docs/', () => {
  for (const dir of ['../api/', '/api/', 'api/../guide/', 'api\\sub/', './api/', 'api//sub/', '']) {
    assertRefuses({ sidebar: [{ label: 'API', dir }] }, /dir/, `dir ${JSON.stringify(dir)}`);
  }
});

test('unknown fields fail in a group, a folder section and a page inside a group', () => {
  assertRefuses({ sidebar: [group('Guides', [file('guide.md')], { open: true })] }, /open/);
  assertRefuses({ sidebar: [{ label: 'API', dir: 'api/', sort: 'name' }] }, /sort/);
  assertRefuses({ sidebar: [group('Guides', [{ ...file('guide.md'), icon: 'x' }])] }, /icon/);
  assertRefuses({ sidebar: [group('Outer', [group('Inner', [file('guide.md')], { badge: 'new' })])] }, /badge/);
});

test('an entry mixing the page, group and folder shapes fails', () => {
  assertRefuses({ sidebar: [{ file: 'guide.md', label: 'Guide', items: [file('extra.md')] }] }, /sidebar/, 'file with items');
  assertRefuses({ sidebar: [{ file: 'guide.md', label: 'Guide', dir: 'api/' }] }, /sidebar/, 'file with dir');
  assertRefuses({ sidebar: [{ label: 'Both', dir: 'api/', items: [file('guide.md')] }] }, /sidebar/, 'dir with items');
});

test('a missing page in a group fails naming it, and so does one that is unpublished', () => {
  assertRefuses({ sidebar: [group('Guides', [file('guide.md'), file('nope.md')])] }, /nope\.md/);
  assertRefuses({ sidebar: [group('Outer', [group('Inner', [file('gone/deep.md')])])] }, /gone\/deep\.md/);
  assertRefuses({ sidebar: [group('Guides', [file('extra.md')])], unpublished: ['extra.md'] }, /extra\.md/);
});

test('a group renders as a VitePress group: escaped label, its pages, nesting and collapsed', () => {
  const { sidebar } = siteOf({ sidebar: [group('Guides & <i>', [file('guide.md', 'The <guide>'), group('More', [file('extra.md')], { collapsed: true })], { collapsed: false })] });
  const top = sidebar.find((item) => item.text === escapeHtml('Guides & <i>'));
  assert.ok(top, `no group labelled Guides & <i>: ${JSON.stringify(sidebar)}`);
  assert.equal(top.collapsed, false);
  assert.ok(top.items.some((i) => i.text === escapeHtml('The <guide>') && i.link === '/guide'), JSON.stringify(top.items));
  const inner = top.items.find((i) => i.text === 'More');
  assert.ok(inner, JSON.stringify(top.items));
  assert.equal(inner.collapsed, true);
  assert.deepEqual(inner.items.map((i) => i.link), ['/extra']);
});

test('a folder section lists the published pages under dir in path order, labelled by H1', () => {
  const { sidebar } = siteOf({ sidebar: [{ label: 'API', dir: 'api/', collapsed: true }], unpublished: ['api/secret.md'] });
  const api = sidebar.find((item) => item.text === 'API');
  assert.ok(api, JSON.stringify(sidebar));
  assert.equal(api.collapsed, true);
  const pages = flatten(api.items).filter((i) => i.link);
  assert.deepEqual(pages.map((i) => i.link), ['/api/a', '/api/b', '/api/sub/c']);
  assert.deepEqual(pages.map((i) => i.text), ['Alpha', h1Label(DOCS['docs/api/b.md'], 'api/b.md'), 'Gamma']);
});

test('a folder section takes the pages a pre_build_command wrote under dir', () => {
  const { sidebar } = siteOf({ sidebar: [{ label: 'API', dir: 'api/' }], unpublished: ['api/secret.md'] }, { staged: { 'api/aa-generated.md': '# Generated\n' } });
  const links = flatten(sidebar.find((item) => item.text === 'API').items).map((i) => i.link).filter(Boolean);
  assert.deepEqual(links, ['/api/a', '/api/aa-generated', '/api/b', '/api/sub/c']);
});

test('each page is listed once, and pages outside the sidebar still follow it', () => {
  const { sidebar } = siteOf({ sidebar: [group('Guides', [file('guide.md')]), { label: 'API', dir: 'api/' }], unpublished: ['api/secret.md'] });
  const links = flatten(sidebar).map((i) => i.link).filter(Boolean);
  assert.equal(new Set(links).size, links.length, `a page is listed twice: ${links.join(', ')}`);
  for (const link of ['/guide', '/api/a', '/extra', '/']) assert.ok(links.includes(link), `${link} missing from ${links.join(', ')}`);
});

// ---------------------------------------------------------------- the header in siteConfig

const navOf = (nav, extra = {}) => siteConfig({ ...siteBuild({ nav, ...extra }) }).nav;
const siteBuild = (pages) => {
  const root = pagesRepo(pages);
  const stage = path.join(tempDir('docs-nav-stage-'), 'src');
  fs.cpSync(path.join(root, 'docs'), stage, { recursive: true });
  return { config: loadPagesConfig(root), stage, docs: path.join(root, 'docs'), repo: 'https://github.com/octo/site', themeCss: null };
};
const docsItem = (nav) => flatten(nav).find((i) => i.text === 'Docs');

test('with 0, 1 or 2 nav entries each stays a top-level header link, as today', () => {
  for (const n of [0, 1, 2]) {
    const nav = navOf(NAV8.slice(0, n));
    for (const entry of NAV8.slice(0, n)) {
      assert.ok(nav.some((i) => i.text === entry.label && i.link === entry.href), `${n} entries: ${entry.label} not top level in ${JSON.stringify(nav)}`);
    }
    assert.ok(docsItem(nav), `${n} entries: no Docs item`);
  }
});

test('with 3 or 8 nav entries every entry, Docs and home_link stay in the header, escaped', () => {
  for (const n of [3, 8]) {
    const entries = [{ label: 'A & <b>', href: 'https://octo.example/ab/' }, ...NAV8.slice(0, n - 1)];
    const items = flatten(navOf(entries, { home_link: HOME, name: 'Octo <i>' }));
    for (const entry of [...entries, HOME]) {
      assert.ok(items.some((i) => i.text === escapeHtml(entry.label) && i.link === entry.href), `${n} entries: ${entry.label} missing`);
    }
    assert.ok(docsItem(items), `${n} entries: no Docs item`);
    for (const i of items) assert.ok(!/[<>]/.test(i.text ?? ''), `${n} entries: unescaped header text ${i.text}`);
  }
});

test('Docs is marked active through activeMatch on every docs page', () => {
  for (const n of [0, 3, 8]) {
    const docs = docsItem(navOf(NAV8.slice(0, n), { home_link: HOME }));
    assert.equal(typeof docs?.activeMatch, 'string', `${n} entries: Docs has no activeMatch: ${JSON.stringify(docs)}`);
    // VitePress tests activeMatch against the page path without the base and with no .md.
    for (const page of ['/', '/guide', '/flows/npm']) assert.match(page, new RegExp(docs.activeMatch), `${n} entries: ${page}`);
  }
});

// ---------------------------------------------------------------- running docs-build's action.yml

function loadYaml(f) {
  const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))';
  const run = spawnSync('python3', ['-c', py, f], { encoding: 'utf8' });
  assert.equal(run.status, 0, `could not read ${f}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

function lookup(expr, ctx) {
  const [scope, ...keys] = expr.trim().split('.');
  const github = { action_path: ACTION_DIR, workspace: ctx.workspace, sha: FAKE_SHA, workflow_sha: FAKE_SHA, action_ref: 'v3',
    action_repository: 'skathio/hashira', repository: `octo/${ctx.name}`, repository_owner: 'octo', ref: 'refs/heads/main',
    ref_name: 'main', server_url: 'https://github.com', event_name: 'push' };
  const scopes = { inputs: ctx.inputs, github, runner: { temp: ctx.outer, os: 'Linux' }, steps: ctx.steps, env: {} };
  return keys.reduce((obj, key) => obj?.[key], scopes[scope]) ?? '';
}

const substitute = (text, ctx) => String(text ?? '').replace(/\$\{\{([^}]*)\}\}/g, (_, expr) => lookup(expr, ctx));

// A step's `if:` for the forms a composite action uses; anything else runs while nothing failed.
function stepRuns(step, ctx) {
  const cond = String(step.if ?? '').replace(/^\s*\$\{\{|\}\}\s*$/g, '').trim();
  if (/\balways\(\)/.test(cond)) return true;
  if (/\bfailure\(\)/.test(cond)) return ctx.failed;
  if (ctx.failed) return false;
  const cmp = cond.match(/^([\w.-]+)\s*(==|!=)\s*'([^']*)'$/);
  return !cmp || (String(lookup(cmp[1], ctx)) === cmp[3]) === (cmp[2] === '==');
}

function stepEnv(step, ctx, outputFile) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GITHUB_') && k !== 'NODE_TEST_CONTEXT'));
  return {
    ...env, GITHUB_WORKSPACE: ctx.workspace, GITHUB_ACTION_PATH: ACTION_DIR, GITHUB_REPOSITORY: `octo/${ctx.name}`,
    GITHUB_REPOSITORY_OWNER: 'octo', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main',
    GITHUB_SHA: FAKE_SHA, GITHUB_OUTPUT: outputFile, GITHUB_ENV: path.join(ctx.outer, 'env'), GITHUB_STEP_SUMMARY: path.join(ctx.outer, 'summary'),
    RUNNER_TEMP: ctx.outer, CI: 'true', ...Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, substitute(v, ctx)])),
  };
}

function runStep(step, ctx, index) {
  const outputFile = path.join(ctx.outer, `output-${index}`);
  const cwd = path.resolve(ctx.workspace, substitute(step['working-directory'], ctx));
  const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', substitute(step.run, ctx)],
    { cwd, env: stepEnv(step, ctx, outputFile), encoding: 'utf8', timeout: BUILD_TIMEOUT });
  const lines = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8').split('\n') : [];
  const outputs = Object.fromEntries(lines.map((l) => l.match(/^([\w-]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  if (step.id) ctx.steps[step.id] = { outputs };
  return run;
}

// Runs action.yml's `run:` steps in order with every input at its default.
function runAction(workspace, name) {
  const spec = loadYaml(path.join(ACTION_DIR, 'action.yml'));
  const inputs = Object.fromEntries(Object.entries(spec.inputs ?? {}).map(([k, def]) => [k, def.default ?? '']));
  const ctx = { name, outer: path.dirname(workspace), workspace, inputs, steps: {}, failed: false };
  const result = { status: 0, output: '' };
  const steps = (spec.runs?.steps ?? []).filter((s) => s.run);
  for (const [i, step] of steps.entries()) {
    if (!stepRuns(step, ctx)) continue;
    const run = runStep(step, ctx, i);
    result.output += `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? `\n${run.error.message}` : ''}`;
    if (run.status !== 0 && !ctx.failed) {
      ctx.failed = true;
      result.status = run.status ?? 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------- fixture docs sites

const LINKS_PAGE = '# Guide\n\n[tests](../tests/) [templates](../templates) [workflows](../.github/workflows/)\n'
  + '[readme](../README.md) [template file](../templates/ci.yml) [api](./api/)\n';
const FIXTURES = {
  nav8: { pages: { name: 'Octo', nav: NAV8, home_link: HOME } },
  nav3: { pages: { name: 'Octo', nav: NAV8.slice(0, 3), home_link: HOME } },
  tree: {
    pages: { name: 'Octo', sidebar: [group('Guides', [file('guide.md', 'The guide'), group('Deeper', [file('extra.md', 'Deeper page')])]), { label: 'API section', dir: 'api/' }], unpublished: ['api/secret.md'] },
  },
  links: {
    pages: { name: 'Octo', unpublished: ['api/secret.md'] },
    files: { 'README.md': '# Octo\n', 'tests/unit/x.txt': 'x\n', 'templates/ci.yml': 'on: push\n', 'docs/guide.md': LINKS_PAGE },
  },
};
const builds = {};

function buildDocs(name) {
  if (builds[name]) return builds[name];
  const workspace = writeTree(path.join(tempDir(`docs-nav-${name}-`), name), { ...DOCS, ...FIXTURES[name].files });
  fs.mkdirSync(path.join(workspace, '.github'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.github', 'pages.json'), JSON.stringify(FIXTURES[name].pages));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  const run = runAction(workspace, name);
  const out = path.join(workspace, 'artifacts', 'pages', 'docs');
  if (run.status === 0 && fs.existsSync(out) && site.dir) fs.cpSync(out, path.join(site.dir, name, 'docs'), { recursive: true });
  builds[name] = { ...run, out, url: `${site.origin}/${name}/docs/` };
  return builds[name];
}

function builtDocs(name) {
  const build = buildDocs(name);
  assert.equal(build.status, 0, `docs-build failed for ${name}:\n${build.output}`);
  return build;
}

// The built HTML of a page, as clean URLs or .html files.
function builtPage(build, page) {
  const found = [`${page}.html`, path.join(page, 'index.html')].map((f) => path.join(build.out, f)).find((f) => fs.existsSync(f));
  assert.ok(found, `no built page for ${page}`);
  return fs.readFileSync(found, 'utf8');
}

test('folder links outside docs/ open as tree/HEAD, with or without a trailing slash; files stay blob/HEAD', () => {
  const html = builtPage(builtDocs('links'), 'guide');
  const gh = 'https://github.com/octo/links';
  for (const href of [`${gh}/tree/HEAD/tests/`, `${gh}/tree/HEAD/templates`, `${gh}/tree/HEAD/.github/workflows/`,
    `${gh}/blob/HEAD/README.md`, `${gh}/blob/HEAD/templates/ci.yml`]) {
    assert.ok(html.includes(`href="${href}"`), `no link to ${href}`);
  }
  for (const wrong of [`${gh}/blob/HEAD/tests/`, `${gh}/blob/HEAD/templates"`, `${gh}/blob/HEAD/.github/workflows/`]) {
    assert.ok(!html.includes(`href="${wrong}`), `folder linked as a file: ${wrong}`);
  }
});

test('the built sidebar shows groups, nested groups and a folder section by H1', () => {
  const html = builtPage(builtDocs('tree'), 'guide');
  for (const text of ['Guides', 'The guide', 'Deeper', 'Deeper page', 'API section', 'Alpha', 'Gamma']) {
    assert.ok(html.includes(`>${text}<`), `the sidebar has no ${text}`);
  }
  assert.ok(html.includes('/tree/docs/api/a'), 'no sidebar link to api/a');
  assert.ok(!html.includes('/tree/docs/api/secret'), 'an unpublished page is linked');
});

// ---------------------------------------------------------------- Chrome over the DevTools protocol

const PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const PLAYWRIGHT_BINS = [['chromium_headless_shell-', 'chrome-headless-shell-linux64', 'chrome-headless-shell'], ['chromium-', 'chrome-linux64', 'chrome']];

function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const onPath = PATH_NAMES.map((n) => spawnSync('sh', ['-c', 'command -v "$1"', 'sh', n], { encoding: 'utf8' }))
    .find((r) => r.status === 0);
  if (onPath) return onPath.stdout.trim();
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : [];
  return PLAYWRIGHT_BINS.flatMap(([prefix, sub, bin]) => dirs.filter((d) => d.startsWith(prefix)).map((d) => path.join(cache, d, sub, bin)))
    .find((p) => fs.existsSync(p)) ?? null;
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

class Browser {
  constructor(bin) {
    const args = ['--headless=new', '--remote-debugging-pipe', '--no-sandbox', '--disable-gpu', '--no-first-run',
      '--hide-scrollbars', `--user-data-dir=${tempDir('docs-nav-chrome-')}`];
    // Its own process group, so close() can stop Chrome's helper processes along with it.
    this.proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: true });
    Object.assign(this, { nextId: 1, pending: new Map(), buffer: '' });
    this.proc.stdio[4].on('data', (chunk) => this.receive(chunk));
    this.proc.on('exit', () => this.pending.forEach(({ reject }) => reject(new Error('Chrome exited'))));
  }

  receive(chunk) {
    const parts = (this.buffer + chunk.toString('utf8')).split('\0');
    this.buffer = parts.pop();
    for (const message of parts.map((raw) => JSON.parse(raw))) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (waiter && message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else if (waiter) waiter.resolve(message.result);
    }
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.proc.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  // Asks Chrome to shut down (which ends its helpers and flushes the profile), and kills the
  // whole process group if it has not exited a few seconds later.
  close() {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = setTimeout(() => {
        try { process.kill(-this.proc.pid, 'SIGKILL'); } catch { this.proc.kill('SIGKILL'); }
      }, 5000);
      this.proc.once('exit', () => {
        clearTimeout(kill);
        try { process.kill(-this.proc.pid, 'SIGKILL'); } catch { /* the group is gone already */ }
        resolve();
      });
      this.send('Browser.close').catch(() => {});
    });
  }
}

async function openPage(url, width) {
  assert.ok(state.browser, state.error ?? 'Chrome did not start');
  const { browserContextId } = await state.browser.send('Target.createBrowserContext');
  const { targetId } = await state.browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await state.browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => state.browser.send(method, params, sessionId);
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`page error: ${res.exceptionDetails.text}`);
    return res.result.value;
  };
  await send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  for (let i = 0; i < WAIT_STEPS && !(await evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`)); i++) await pause(WAIT_STEP_MS);
  await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  return { evaluate, close: () => state.browser.send('Target.disposeBrowserContext', { browserContextId }) };
}

// The page's horizontal overflow, and every visible header link or button that ends off screen.
const OVERFLOW = `(() => {
  const w = window.innerWidth;
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const off = [...document.querySelectorAll('header a, header button')].filter(shown)
    .map((el) => ({ text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30), r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && (r.right > w + 0.5 || r.left < -0.5)).map(({ text, r }) => text + '@' + Math.round(r.left) + '-' + Math.round(r.right));
  return { scroll: document.documentElement.scrollWidth, width: w, off };
})()`;

async function assertFits(url, width) {
  const page = await openPage(url, width);
  try {
    const { scroll, width: w, off } = await page.evaluate(OVERFLOW);
    assert.ok(scroll <= w, `${url} at ${width}px scrolls sideways: scrollWidth ${scroll} > ${w}`);
    assert.deepEqual(off, [], `${url} at ${width}px: header items off screen`);
  } finally {
    await page.close();
  }
}

const site = { dir: null, server: null, origin: null };
const state = { browser: null, error: null };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function serve(req, res) {
  const rel = path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const base = path.join(site.dir, rel);
  const tries = rel.endsWith(path.sep) ? [path.join(base, 'index.html')] : [base, `${base}.html`, path.join(base, 'index.html')];
  const found = tries.find((f) => f.startsWith(site.dir) && fs.existsSync(f) && fs.statSync(f).isFile());
  res.writeHead(found ? 200 : 404, found ? { 'content-type': TYPES[path.extname(found)] ?? 'application/octet-stream' } : {});
  res.end(found ? fs.readFileSync(found) : undefined);
}

test.before(async () => {
  site.dir = tempDir('docs-nav-pages-');
  site.server = http.createServer(serve);
  await new Promise((resolve) => { site.server.listen(0, '127.0.0.1', resolve); });
  site.origin = `http://127.0.0.1:${site.server.address().port}`;
  const bin = findChrome();
  if (!bin) {
    state.error = 'no Chrome found: set CHROME_BIN, or install google-chrome or chromium';
    return;
  }
  state.browser = new Browser(bin);
  await state.browser.send('Browser.getVersion');
});

test.after(async () => {
  if (state.browser) await state.browser.close();
  if (site.server) site.server.close();
  // A temp folder left behind is not a test failure: report it and go on.
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (err) {
      console.warn(`could not remove ${dir}: ${err.message}`);
    }
  }
});

test('with 8 nav entries and home_link the built docs fit at 768, 1024 and 1280', async () => {
  const build = builtDocs('nav8');
  for (const width of WIDTHS) {
    await assertFits(build.url, width);
    await assertFits(`${build.url}guide`, width);
  }
});

test('with 3 nav entries, just past the limit of 2, the built docs fit at 768, 1024 and 1280', async () => {
  const build = builtDocs('nav3');
  for (const width of WIDTHS) await assertFits(`${build.url}guide`, width);
});
