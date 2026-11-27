// The user's rules for the docs-build action (brief requirements 7-13, the docs half of 16, 17,
// and the catalog line of 24): the VitePress build from the caller's docs/**/*.md, the behaviour
// carried over from docs-site/, the sidebar order, the failures that name each file,
// pre_build_command, output_dir, theme_css, the shared theme key and the docs header.
//
// Each case goes through the action itself: action.yml's run steps are executed with bash the
// way a runner does, against a fixture repo in a temporary folder, and the test reads the HTML,
// CSS and search index the build writes. The builds install VitePress from hashira's lockfile,
// so the first run needs network access once.
//
// Run with:
//   node --test tests/docs-build/docs-build-rules.test.js
//
// Left to the builder, so not tested here: where the toolchain is installed and the stage
// lives, the GitHub branch in a blob or tree URL, clean URLs or .html, sidebar groups, the
// header's GitHub link, the exact wording of each error, whether the docs index is the home
// page for a custom base, and what a stage written by pre_build_command holds besides the
// staged docs.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ACTION_DIR = path.join(REPO, '.github', 'actions', 'docs-build');
const VITEPRESS_DIR = path.join(ACTION_DIR, 'vitepress');
const CATALOG = path.join(REPO, 'docs', 'catalog.md');
const BUILD_TIMEOUT = 600_000;

// The fixture repo is octo/site, so the docs default to /site/docs/ and the landing is /site/.
const OWNER_REPO = 'octo/site';
const ORIGIN = 'https://octo.example';
const BASE = '/site/docs/';
const LANDING = `${ORIGIN}/site/`;
const GITHUB_REPO = `https://github.com/${OWNER_REPO}/`;
const DEFAULT_OUT = 'artifacts/pages/docs';

const temps = [];
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

// ---------- action.yml, read through PyYAML (the shape lints' own parser) ----------

function loadYaml(file) {
  const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))';
  const run = spawnSync('python3', ['-c', py, file], { encoding: 'utf8' });
  assert.equal(run.status, 0, `could not read ${file}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

const actionFile = path.join(ACTION_DIR, 'action.yml');
const actionSpec = () => loadYaml(actionFile);
const runSteps = (spec) => (spec.runs?.steps ?? []).filter((s) => s.run);

// ---------- running the composite action's steps the way a runner does ----------

const FAKE_SHA = 'b'.repeat(40);

function githubContext(ctx) {
  return {
    action_path: ACTION_DIR, workspace: ctx.workspace, sha: FAKE_SHA, workflow_sha: FAKE_SHA,
    action_ref: 'v3', action_repository: 'skathio/hashira', repository: OWNER_REPO, repository_owner: 'octo',
    ref: 'refs/heads/main', ref_name: 'main', server_url: 'https://github.com', event_name: 'push',
  };
}

function lookup(expr, ctx) {
  const [scope, ...keys] = expr.trim().split('.');
  const scopes = { inputs: ctx.inputs, github: githubContext(ctx), runner: { temp: ctx.outer, os: 'Linux' }, steps: ctx.steps, env: ctx.env };
  return keys.reduce((obj, key) => obj?.[key], scopes[scope]) ?? '';
}

const substitute = (text, ctx) => String(text ?? '').replace(/\$\{\{([^}]*)\}\}/g, (_, expr) => lookup(expr, ctx));

// A step's `if:` for the forms a composite action uses: always(), failure(), success() and a
// comparison of a context value with a quoted string. Anything else runs while nothing failed.
function stepRuns(step, ctx) {
  const cond = String(step.if ?? '').replace(/^\s*\$\{\{|\}\}\s*$/g, '').trim();
  if (/\balways\(\)/.test(cond)) return true;
  if (/\bfailure\(\)/.test(cond)) return ctx.failed;
  if (ctx.failed) return false;
  const cmp = cond.match(/^([\w.-]+)\s*(==|!=)\s*'([^']*)'$/);
  if (!cmp) return true;
  return (String(lookup(cmp[1], ctx)) === cmp[3]) === (cmp[2] === '==');
}

function runnerEnv(ctx, outputFile) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GITHUB_') && k !== 'NODE_TEST_CONTEXT'));
  return {
    ...env, GITHUB_WORKSPACE: ctx.workspace, GITHUB_ACTION_PATH: ACTION_DIR, GITHUB_REPOSITORY: OWNER_REPO,
    GITHUB_REPOSITORY_OWNER: 'octo', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_NAME: 'main', GITHUB_SHA: FAKE_SHA, GITHUB_OUTPUT: outputFile, GITHUB_ENV: path.join(ctx.outer, 'env'),
    GITHUB_STEP_SUMMARY: path.join(ctx.outer, 'summary'), RUNNER_TEMP: ctx.outer, CI: 'true',
  };
}

// `name=value` lines of a step's GITHUB_OUTPUT file, for `${{ steps.<id>.outputs.<name> }}`.
function readOutputs(file) {
  if (!fs.existsSync(file)) return {};
  const pairs = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.match(/^([\w-]+)=(.*)$/)).filter(Boolean);
  return Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
}

function runStep(step, ctx, index) {
  const outputFile = path.join(ctx.outer, `output-${index}`);
  const stepEnv = Object.entries(step.env ?? {}).map(([k, v]) => [k, substitute(v, ctx)]);
  const env = { ...runnerEnv(ctx, outputFile), ...Object.fromEntries(stepEnv) };
  const cwd = path.resolve(ctx.workspace, substitute(step['working-directory'], ctx));
  const script = substitute(step.run, ctx);
  const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd, env, encoding: 'utf8', timeout: BUILD_TIMEOUT });
  if (step.id) ctx.steps[step.id] = { outputs: readOutputs(outputFile) };
  return run;
}

const inputsWithDefaults = (spec, given) => ({
  ...Object.fromEntries(Object.entries(spec.inputs ?? {}).map(([name, def]) => [name, def.default ?? ''])),
  ...given,
});

// Runs action.yml's `run:` steps in order. After a failure only always() and failure() steps
// run, and the result carries the first failing step's exit code, as a runner reports it.
function runAction(workspace, given = {}) {
  const spec = actionSpec();
  const ctx = { outer: path.dirname(workspace), workspace, inputs: inputsWithDefaults(spec, given), steps: {}, env: {}, failed: false };
  const result = { status: 0, stdout: '', stderr: '' };
  runSteps(spec).forEach((step, i) => {
    if (!stepRuns(step, ctx)) return;
    const run = runStep(step, ctx, i);
    result.stdout += run.stdout ?? '';
    result.stderr += `${run.stderr ?? ''}${run.error ? `\n${run.error.message}` : ''}`;
    if (run.status !== 0 && !ctx.failed) {
      ctx.failed = true;
      result.status = run.status ?? 1;
    }
  });
  return result;
}

// ---------- fixture repos ----------

function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}

// A fresh caller repo with the given files: no docs-site/, no package.json, no node_modules.
function fixtureRepo(files) {
  const workspace = path.join(tempDir('docs-build-run-'), 'ws');
  fs.mkdirSync(workspace);
  writeTree(workspace, files);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  return workspace;
}

const pagesJson = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

const MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>\n';

const MAIN_PAGES = {
  name: 'Octo Site',
  logo: 'site/mark.svg',
  sidebar: [
    { file: 'zeta.md', label: 'Zeta <b>first</b> & co' },
    { file: 'getting-started.md', label: 'Start here' },
  ],
  unpublished: ['secret.md'],
  nav: [
    { label: 'Blog', href: './blog/' },
    { label: 'Tom & <i>Jerry</i>', href: '#features' },
    { label: 'Elsewhere', href: '/elsewhere/' },
    { label: 'Example', href: 'https://example.com/x' },
    { label: 'Up one', href: '../up/' },
  ],
  home_link: { label: '← octo', href: 'https://octo.example/' },
};

const LINKS_MD = [
  '# Link checks', '',
  '- [to bee](b-page.md)',
  '- [to bee section](b-page.md#bee-details)',
  '- [to secret](secret.md)',
  '- [to secret anchor](secret.md#hidden-part)',
  '- [to notes folder](notes/)',
  '- [to deep](api-notes/deep/inner.md)',
  '- [to braces](#braces-and-html)', '',
  '## Hello, World & Co.', '',
  'Words.', '',
  '## Braces and HTML', '',
  'Prose with ${{ github.token }} braces and `${{ inputs.name }}` in code.', '',
  '<span class="rogue">raw html</span>', '',
  '<script>window.pwned = 1</script>', '',
  '## Use `npm ci` *now*', '',
  'The end.', '',
].join('\n');

const MAIN_DOCS = {
  'docs/getting-started.md': '# Getting started\n\nWelcome.\n',
  'docs/zeta.md': '# Zeta page\n\nLast letter.\n',
  'docs/b-page.md': '# Bee page\n\n## Bee details\n\nText.\n\n# Second H1\n\nMore.\n',
  'docs/links.md': LINKS_MD,
  'docs/secret.md': '# Secret\n\n## Hidden part\n\nNot published.\n',
  'docs/notes/x.md': '# Note x\n\nA note.\n',
  'docs/api-notes/deep/inner.md': '# Deep & <inner>\n\n[back to bee](../../b-page.md)\n',
};

// What the pre-build step leaves behind for the tests: where it ran, what DOCS_STAGE held, and
// one page of its own in the stage.
const PRE_BUILD = [
  'pwd -P > "$RUNNER_TEMP/pre-pwd.txt"',
  '(cd "$DOCS_STAGE" && find . -name "*.md" | sort) > "$RUNNER_TEMP/pre-stage.txt"',
  'mkdir -p "$DOCS_STAGE/gen"',
  'printf "# Generated ref\\n\\nGenerated.\\n" > "$DOCS_STAGE/gen/index.md"',
].join('\n');

const MAIN_SIDEBAR = ['Zeta <b>first</b> & co', 'Start here', 'Deep & <inner>', 'Bee page', 'Generated ref', 'Link checks', 'Note x'];

// ---------- reading the build ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntity(match, body) {
  if (body[0] !== '#') return ENTITIES[body.toLowerCase()] ?? match;
  const hex = body[1].toLowerCase() === 'x';
  return String.fromCodePoint(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
}

const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity);
const textOf = (html) => decode(html.replace(/<[^>]*>/g, '')).replace(/​/g, '').trim();

// The built file GitHub Pages serves for a URL under the docs base, or null.
function servedFile(out, url) {
  if (url.origin !== ORIGIN || !url.pathname.startsWith(BASE)) return null;
  const rel = decodeURIComponent(url.pathname.slice(BASE.length));
  const candidates = rel === '' || rel.endsWith('/') ? [`${rel}index.html`] : [rel, `${rel}.html`, `${rel}/index.html`];
  return candidates.map((c) => path.join(out, c)).find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) ?? null;
}

const pageUrl = (rel) => new URL(BASE + rel, ORIGIN);

function readPage(out, rel) {
  const file = servedFile(out, pageUrl(rel));
  assert.ok(file, `no built page for ${BASE}${rel} in ${out}`);
  return fs.readFileSync(file, 'utf8');
}

const h1Of = (html) => textOf(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '');

function h1At(out, url) {
  const file = servedFile(out, url);
  assert.ok(file, `${url} has no built page`);
  return h1Of(fs.readFileSync(file, 'utf8'));
}

// Every <a> in the HTML, in document order, with its decoded href, text and offset.
function anchors(html) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: decode(m[1].match(/\bhref="([^"]*)"/)?.[1] ?? ''), text: textOf(m[2]), raw: m[0], at: m.index,
  }));
}

function linkTo(html, text) {
  const found = anchors(html).find((a) => a.text === text);
  assert.ok(found, `no link with the text ${JSON.stringify(text)}`);
  return found.href;
}

function sidebarLabels(html) {
  const start = html.indexOf('id="VPSidebarNav"');
  assert.ok(start >= 0, 'the page has no sidebar');
  const region = html.slice(start, html.indexOf('</nav>', start));
  return { region, labels: [...region.matchAll(/<p class="text"[^>]*>([\s\S]*?)<\/p>/g)].map((m) => textOf(m[1])) };
}

function navbar(html) {
  const start = html.indexOf('class="VPNavBar"');
  assert.ok(start >= 0, 'the page has no VitePress nav bar');
  const end = html.indexOf('VPNavBarHamburger', start);
  return html.slice(start, end < 0 ? undefined : end);
}

function searchIndex(out) {
  const chunks = path.join(out, 'assets', 'chunks');
  const files = fs.existsSync(chunks) ? fs.readdirSync(chunks).filter((f) => f.startsWith('@localSearchIndex')) : [];
  assert.ok(files.length > 0, 'no local search index was built');
  return files.map((f) => fs.readFileSync(path.join(chunks, f), 'utf8')).join('\n');
}

function snapshot(dir) {
  const files = {};
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  });
  walk(dir);
  return files;
}

// ---------- the builds, run once each ----------

const builds = {};

function build(name, files, inputs) {
  const workspace = fixtureRepo(files);
  const docsBefore = fs.existsSync(path.join(workspace, 'docs')) ? snapshot(path.join(workspace, 'docs')) : {};
  const run = runAction(workspace, inputs);
  builds[name] = { workspace, run, docsBefore, outer: path.dirname(workspace) };
  return builds[name];
}

function built(name, outDir = DEFAULT_OUT) {
  const b = builds[name];
  assert.equal(b?.run.status, 0, `the ${name} build failed:\n${b?.run.stdout}\n${b?.run.stderr}`);
  return path.join(b.workspace, outDir);
}

const THEME_CSS = ':root { --vp-c-brand-1: #abcdef; }\n.dark { --vp-c-brand-1: #fedcba; }\n';

test.before(() => {
  build('main', { '.github/pages.json': pagesJson(MAIN_PAGES), 'site/mark.svg': MARK_SVG, ...MAIN_DOCS }, { pre_build_command: PRE_BUILD });
  build('minimal', {
    '.github/pages.json': '{}\n',
    'docs/getting-started.md': '# Welcome\n\n## First section\n\nHello.\n',
    'docs/guide.md': '# Guide\n\n## First section\n\nRead me.\n',
  });
  build('themed', {
    '.github/pages.json': pagesJson({ theme_css: 'site/docs-theme.css', sidebar: [{ file: 'getting-started.md', label: 'Only entry' }] }),
    'site/docs-theme.css': THEME_CSS,
    'docs/getting-started.md': '# Start\n\nHi.\n',
    'docs/other.md': '# Other page\n\nMore.\n',
  }, { output_dir: 'out/docs-out' });
});

// ---------- (7) the action, its toolchain, and docs/ left alone ----------

test('(7) docs-build is a composite action with pre_build_command and output_dir inputs', () => {
  const spec = actionSpec();
  assert.equal(spec.runs?.using, 'composite');
  assert.ok('pre_build_command' in (spec.inputs ?? {}), 'action.yml has no pre_build_command input');
  assert.ok('output_dir' in (spec.inputs ?? {}), 'action.yml has no output_dir input');
});

test('(7) hashira keeps VitePress 1.6.4 with the vite 6.4.6 override and a lockfile for them', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(VITEPRESS_DIR, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.equal(deps.vitepress, '1.6.4');
  assert.equal(pkg.overrides?.vite, '6.4.6');
  const lock = JSON.parse(fs.readFileSync(path.join(VITEPRESS_DIR, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages?.['node_modules/vitepress']?.version, '1.6.4');
  assert.equal(lock.packages?.['node_modules/vite']?.version, '6.4.6');
});

test('(7) the toolchain is installed with npm ci --ignore-scripts and never with npm install', () => {
  const scripts = runSteps(actionSpec()).map((s) => s.run).join('\n');
  const installs = [...scripts.matchAll(/\bnpm\s+(ci|install|i|add)\b[^\n]*/g)].map((m) => m[0]);
  assert.ok(installs.length > 0, 'no npm ci in the action');
  for (const line of installs) {
    assert.match(line, /^npm\s+ci\b/, `the toolchain is installed with something other than npm ci: ${line}`);
    assert.match(line, /--ignore-scripts\b/, `npm ci runs without --ignore-scripts: ${line}`);
  }
});

test('(7) a caller with no docs-site/ and no packages builds, and gets no docs packages of its own', () => {
  const out = built('main');
  assert.match(readPage(out, 'links'), /<meta name="generator" content="VitePress v1\.6\.4">/);
  for (const rel of ['docs-site', 'node_modules', 'package.json', 'package-lock.json']) {
    assert.equal(fs.existsSync(path.join(builds.main.workspace, rel)), false, `the build left ${rel} in the caller's repo`);
  }
});

test('(7) pages in nested folders of docs/ are published', () => {
  const out = built('main');
  assert.equal(h1Of(readPage(out, 'api-notes/deep/inner')), 'Deep & <inner>');
  assert.equal(h1Of(readPage(out, 'notes/x')), 'Note x');
});

test('(7) the build leaves every file under docs/ unchanged and adds none, pre-build step included', () => {
  for (const name of ['main', 'minimal', 'themed']) {
    built(name, name === 'themed' ? 'out/docs-out' : DEFAULT_OUT);
    assert.deepEqual(snapshot(path.join(builds[name].workspace, 'docs')), builds[name].docsBefore, `the ${name} build changed docs/`);
  }
});

// ---------- (8) behaviour carried over from docs-site/ ----------

test("(8) heading anchors follow GitHub's slug rule", () => {
  const html = readPage(built('main'), 'links');
  for (const id of ['hello-world--co', 'braces-and-html', 'use-npm-ci-now']) {
    assert.match(html, new RegExp(`<h2 id="${id}"`), `no heading with the GitHub id ${id}`);
  }
  assert.match(readPage(built('main'), 'b-page'), /<h2 id="bee-details"/);
});

test('(8) a .md link opens the published page, from the top folder and from a nested one', () => {
  const out = built('main');
  const fromLinks = new URL(linkTo(readPage(out, 'links'), 'to bee'), pageUrl('links'));
  assert.equal(h1At(out, fromLinks), 'Bee page');
  const fromDeep = new URL(linkTo(readPage(out, 'api-notes/deep/inner'), 'back to bee'), pageUrl('api-notes/deep/inner'));
  assert.ok(servedFile(out, fromDeep), `${fromDeep} has no built page`);
  const toDeep = new URL(linkTo(readPage(out, 'links'), 'to deep'), pageUrl('links'));
  assert.equal(h1At(out, toDeep), 'Deep & <inner>');
});

test('(8) a link to an unpublished page opens the file on GitHub, and the page is not built', () => {
  const out = built('main');
  const href = linkTo(readPage(out, 'links'), 'to secret');
  assert.ok(href.startsWith(GITHUB_REPO), `${href} does not open the caller's repo on GitHub`);
  assert.match(new URL(href).pathname, /\/docs\/secret\.md$/);
  assert.equal(servedFile(out, pageUrl('secret')), null, 'secret.md was published');
});

test('(8) a link to a folder without an index opens the folder on GitHub', () => {
  const href = linkTo(readPage(built('main'), 'links'), 'to notes folder');
  assert.ok(href.startsWith(GITHUB_REPO), `${href} does not open the caller's repo on GitHub`);
  assert.match(new URL(href).pathname.replace(/\/$/, ''), /\/docs\/notes$/);
});

test('(8) #anchors are kept on published, unpublished and in-page links', () => {
  const html = readPage(built('main'), 'links');
  assert.equal(new URL(linkTo(html, 'to bee section'), pageUrl('links')).hash, '#bee-details');
  assert.equal(new URL(linkTo(html, 'to secret anchor')).hash, '#hidden-part');
  assert.equal(linkTo(html, 'to braces'), '#braces-and-html');
});

test('(8) braces in text and in inline code render as text', () => {
  const html = readPage(built('main'), 'links');
  const text = textOf(html.match(/<main\b[\s\S]*<\/main>/)?.[0] ?? html);
  assert.ok(text.includes('Prose with ${{ github.token }} braces'), 'the braces in prose did not render as text');
  const code = [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => textOf(m[1]));
  assert.ok(code.includes('${{ inputs.name }}'), 'the braces in inline code did not render as text');
});

test('(8) raw HTML in Markdown renders as text, not as elements', () => {
  const html = readPage(built('main'), 'links');
  assert.doesNotMatch(html, /<span class="rogue"/);
  assert.doesNotMatch(html, /<script>window\.pwned/);
  const text = textOf(html);
  assert.ok(text.includes('<span class="rogue">raw html</span>'), 'the raw span is not shown as text');
  assert.ok(text.includes('<script>window.pwned = 1</script>'), 'the raw script is not shown as text');
});

test("(8) each permalink's aria-label is the heading's plain text", () => {
  const html = readPage(built('main'), 'links');
  const heading = html.match(/<h2 id="use-npm-ci-now"[\s\S]*?<\/h2>/)?.[0] ?? '';
  const label = decode(heading.match(/class="header-anchor"[^>]*aria-label="([^"]*)"/)?.[1] ?? heading.match(/aria-label="([^"]*)"[^>]*class="header-anchor"/)?.[1] ?? '');
  assert.ok(label.includes('Use npm ci now'), `the permalink label ${JSON.stringify(label)} is not the heading's text`);
  assert.doesNotMatch(label, /[`*\\]/);
});

test('(8) local search is on and indexes the published pages, not the unpublished one', () => {
  const index = searchIndex(built('main'));
  for (const text of ['Link checks', 'Bee page', 'Note x', 'Generated ref']) assert.ok(index.includes(text), `${text} is not in the search index`);
  assert.equal(index.includes('Not published.'), false, 'the unpublished page is in the search index');
});

// ---------- (9) the sidebar ----------

test('(9) sidebar entries come first in order, then every other published page by path under its first H1', () => {
  const { labels } = sidebarLabels(readPage(built('main'), 'links'));
  assert.deepEqual(labels, MAIN_SIDEBAR);
});

test('(9) with no sidebar entries every published page is listed by path under its first H1', () => {
  const out = built('minimal');
  assert.deepEqual(sidebarLabels(readPage(out, 'guide')).labels, ['Welcome', 'Guide']);
});

test('(9) one sidebar entry comes first, then the other pages', () => {
  const out = built('themed', 'out/docs-out');
  assert.deepEqual(sidebarLabels(readPage(out, 'other')).labels, ['Only entry', 'Other page']);
});

test('(9) sidebar labels from pages.json and from H1s render as text', () => {
  const { region } = sidebarLabels(readPage(built('main'), 'links'));
  assert.doesNotMatch(region, /<b>first<\/b>/);
  assert.doesNotMatch(region, /<inner>/);
});

test('(9) each sidebar entry links to a built page', () => {
  const out = built('main');
  const { region } = sidebarLabels(readPage(out, 'links'));
  const links = anchors(region).filter((a) => a.href);
  assert.equal(links.length, MAIN_SIDEBAR.length);
  for (const a of links) assert.ok(servedFile(out, new URL(a.href, pageUrl('links'))), `${a.text}: ${a.href} has no built page`);
});

// ---------- (10) the failures that name each file ----------

const SMALL_DOCS = { 'docs/getting-started.md': '# Start\n\nHi.\n', 'docs/guide.md': '# Guide\n\nRead me.\n' };

function failingBuild(pages, extraFiles = {}, inputs = {}) {
  const workspace = fixtureRepo({ '.github/pages.json': pagesJson(pages), ...SMALL_DOCS, ...extraFiles });
  return { workspace, run: runAction(workspace, inputs) };
}

function assertRefused(run, ...named) {
  assert.notEqual(run.status, 0, 'the build passed');
  assert.match(run.stderr, /::error::docs-build:/, `no ::error::docs-build: annotation on stderr:\n${run.stderr}`);
  for (const name of named) assert.ok(run.stderr.includes(name), `the error does not name ${name}:\n${run.stderr}`);
}

test('(10) missing sidebar files fail the build, naming each file', () => {
  const { run } = failingBuild({ sidebar: [{ file: 'gone-one.md', label: 'One' }, { file: 'guide.md', label: 'Guide' }, { file: 'gone-two.md', label: 'Two' }] });
  assertRefused(run, 'gone-one.md', 'gone-two.md');
  assert.equal(run.status, 1);
});

test('(10) sidebar files that are also unpublished fail the build, naming each file', () => {
  const { run } = failingBuild(
    { sidebar: [{ file: 'guide.md', label: 'Guide' }, { file: 'extra.md', label: 'Extra' }], unpublished: ['guide.md', 'extra.md'] },
    { 'docs/extra.md': '# Extra\n' },
  );
  assertRefused(run, 'guide.md', 'extra.md');
});

test('(10) docs/index.md fails the build while the home page is published as the docs index', () => {
  const { run } = failingBuild({}, { 'docs/index.md': '# Index\n' });
  assertRefused(run, 'index.md');
});

// ---------- (11) pre_build_command ----------

test('(11) pre_build_command defaults to empty and is documented as trusted input', () => {
  const input = actionSpec().inputs?.pre_build_command ?? {};
  assert.equal(input.default ?? '', '');
  assert.match(String(input.description ?? ''), /trusted/i);
});

test('(11) pre_build_command runs from the repo root with DOCS_STAGE holding the staged docs', () => {
  const b = builds.main;
  built('main');
  assert.equal(fs.readFileSync(path.join(b.outer, 'pre-pwd.txt'), 'utf8').trim(), fs.realpathSync(b.workspace));
  const staged = fs.readFileSync(path.join(b.outer, 'pre-stage.txt'), 'utf8');
  for (const md of ['./links.md', './b-page.md', './api-notes/deep/inner.md']) assert.ok(staged.includes(md), `${md} was not staged in DOCS_STAGE`);
});

test('(11) Markdown that pre_build_command writes into DOCS_STAGE is published', () => {
  const out = built('main');
  assert.equal(h1Of(readPage(out, 'gen/')), 'Generated ref');
  assert.equal(fs.existsSync(path.join(builds.main.workspace, 'docs', 'gen')), false, 'the stage write reached docs/');
});

test('(11) a pre_build_command that exits non-zero fails the build with that code', () => {
  const { run } = failingBuild({}, {}, { pre_build_command: 'exit 7' });
  assert.equal(run.status, 7, `expected exit 7:\n${run.stderr}`);
});

test('(11) inputs reach the shell through env:, never as ${{ inputs.* }} inside run:', () => {
  for (const step of runSteps(actionSpec())) assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./, `step ${step.name ?? step.id} interpolates an input into run:`);
});

// ---------- (12) output_dir ----------

test('(12) output_dir defaults to artifacts/pages/docs', () => {
  assert.equal(actionSpec().inputs?.output_dir?.default, DEFAULT_OUT);
  const out = built('minimal');
  assert.ok(servedFile(out, pageUrl('guide')), 'no guide page under artifacts/pages/docs');
});

test('(12) the site is written to the given output_dir', () => {
  const out = built('themed', 'out/docs-out');
  assert.ok(fs.existsSync(path.join(out, 'other.html')) || fs.existsSync(path.join(out, 'other', 'index.html')));
  assert.equal(fs.existsSync(path.join(builds.themed.workspace, DEFAULT_OUT)), false, 'the default output_dir was written too');
});

test('(12) an output_dir that already exists as a folder is refused, and its contents kept', () => {
  const { workspace, run } = failingBuild({}, { 'out/existing/keep.txt': 'mine\n' }, { output_dir: 'out/existing' });
  assertRefused(run, 'out/existing');
  assert.equal(run.status, 1);
  assert.deepEqual(fs.readdirSync(path.join(workspace, 'out', 'existing')), ['keep.txt']);
});

test('(12) an output_dir that exists as an empty folder is refused', () => {
  const workspace = fixtureRepo({ '.github/pages.json': '{}\n', ...SMALL_DOCS });
  fs.mkdirSync(path.join(workspace, 'artifacts', 'pages', 'docs'), { recursive: true });
  assertRefused(runAction(workspace), DEFAULT_OUT);
  assert.deepEqual(fs.readdirSync(path.join(workspace, DEFAULT_OUT)), []);
});

test('(12) an output_dir that exists as a file is refused, and the file kept', () => {
  const { workspace, run } = failingBuild({}, { 'out/file': 'mine\n' }, { output_dir: 'out/file' });
  assertRefused(run, 'out/file');
  assert.equal(fs.readFileSync(path.join(workspace, 'out', 'file'), 'utf8'), 'mine\n');
});

test("(12) an absolute output_dir or one with a '..' segment is refused", () => {
  const abs = path.join(tempDir('docs-build-abs-'), 'docs');
  assertRefused(failingBuild({}, {}, { output_dir: abs }).run);
  assert.equal(fs.existsSync(abs), false, 'the absolute output_dir was written');
  const { workspace, run } = failingBuild({}, {}, { output_dir: '../escape' });
  assertRefused(run);
  assert.equal(fs.existsSync(path.join(path.dirname(workspace), 'escape')), false, 'the build wrote outside the repo');
});

// ---------- (13) theme_css ----------

// The page's CSS in the order the browser applies it: each stylesheet <link> and <style> in <head>.
function pageCss(out, html) {
  const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';
  return [...head.matchAll(/<link\b([^>]*)>|<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => {
    if (m[2] !== undefined) return m[2];
    if (!/\brel="[^"]*stylesheet/.test(m[1])) return '';
    const file = servedFile(out, new URL(decode(m[1].match(/\bhref="([^"]*)"/)?.[1] ?? ''), pageUrl('')));
    return file ? fs.readFileSync(file, 'utf8') : '';
  }).join('\n');
}

test('(13) theme_css loads after the shared theme, so its rules win', () => {
  const out = built('themed', 'out/docs-out');
  const css = pageCss(out, readPage(out, 'other'));
  const values = [...css.matchAll(/--vp-c-brand-1\s*:\s*([^;}]+)/g)].map((m) => m[1].trim().toLowerCase());
  const first = values.indexOf('#abcdef');
  assert.ok(first > 0, 'the theme_css rule is missing, or no shared theme rule comes before it');
  assert.deepEqual(values.slice(first).filter((v) => v !== '#abcdef' && v !== '#fedcba'), [], 'a shared theme rule loads after theme_css');
  assert.ok(values.includes('#fedcba'), 'the theme_css dark rule is missing');
});

// ---------- (16, docs half) the shared theme key ----------

const VP_KEY = 'vitepress-theme-appearance';

function makeStorage(initial) {
  const store = new Map(Object.entries(initial));
  return { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
}

function makeRoot() {
  const classes = new Set();
  const attrs = new Map();
  const classList = {
    add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
    toggle: (c, force) => { const on = force ?? !classes.has(c); if (on) classes.add(c); else classes.delete(c); return on; },
  };
  return { classes, classList, setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => attrs.get(k) ?? null, removeAttribute: (k) => attrs.delete(k), dataset: {}, style: {} };
}

function makeSandbox(storage, prefersDark, root) {
  const listeners = [];
  const observers = [];
  const on = (type, fn) => { if (type === 'DOMContentLoaded' || type === 'load') listeners.push(fn); };
  const sandbox = {
    navigator: { platform: 'Linux' }, addEventListener: on,
    document: { documentElement: root, addEventListener: on, readyState: 'loading', getElementById: () => null },
    matchMedia: () => ({ matches: prefersDark, addEventListener() {}, addListener() {} }),
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe(target) { observers.push({ cb: this.cb, target }); } disconnect() {} },
  };
  const blocked = () => { throw new Error('SecurityError: storage is disabled'); };
  Object.defineProperty(sandbox, 'localStorage', storage ? { value: storage } : { get: blocked });
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, listeners, observers };
}

// Runs a docs page's inline <head> scripts in order, as the browser does before first paint.
// `storage` null means storage is unavailable: every access throws.
function loadDocs(storage, prefersDark) {
  const head = readPage(built('main'), 'links').match(/<head>([\s\S]*?)<\/head>/)[1];
  const scripts = [...head.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/\bsrc=/.test(m[1]) && !/type="(?:module|application\/json)"/.test(m[1]));
  const root = makeRoot();
  const { sandbox, listeners, observers } = makeSandbox(storage, prefersDark, root);
  scripts.forEach((m) => vm.runInContext(m[2], sandbox));
  const darkAtFirstPaint = root.classes.has('dark');
  listeners.forEach((fn) => fn());
  // What VitePress does when its own key changes: store it and flip the class.
  const toggle = (dark) => {
    storage?.setItem(VP_KEY, dark ? 'dark' : 'light');
    root.classList.toggle('dark', dark);
    observers.filter((o) => o.target === root).forEach((o) => o.cb([{ type: 'attributes', attributeName: 'class', target: root }]));
  };
  return { darkAtFirstPaint, toggle };
}

test('(16) a stored dark or light opens the docs in that theme before first paint, whatever VitePress stored', () => {
  assert.equal(loadDocs(makeStorage({ theme: 'dark', [VP_KEY]: 'light' }), false).darkAtFirstPaint, true);
  assert.equal(loadDocs(makeStorage({ theme: 'light', [VP_KEY]: 'dark' }), true).darkAtFirstPaint, false);
});

test('(16) no stored theme, auto, or any other value follows the system', () => {
  for (const value of [undefined, 'auto', 'sepia', '', 'Dark']) {
    const initial = value === undefined ? { [VP_KEY]: 'light' } : { theme: value, [VP_KEY]: 'light' };
    assert.equal(loadDocs(makeStorage(initial), true).darkAtFirstPaint, true, `theme=${value} on a dark system`);
    assert.equal(loadDocs(makeStorage({ ...initial, [VP_KEY]: 'dark' }), false).darkAtFirstPaint, false, `theme=${value} on a light system`);
  }
});

// The docs' theme control (ThemeSwitch.vue) stores a choice itself, and theme-and-accent.test.js
// presses it in Chrome. The head scripts must never turn a class change into a choice: in auto
// the class follows the system, and storing it would pin the theme the system happened to show.
test('(16) a class change in the docs, such as a system theme change in auto, stores no choice', () => {
  const storage = makeStorage({});
  const docs = loadDocs(storage, false);
  docs.toggle(true);
  assert.equal(storage.getItem('theme'), null);
  docs.toggle(false);
  assert.equal(storage.getItem('theme'), null);
});

test('(16) with storage unavailable the docs follow the system and the head scripts throw nothing', () => {
  assert.equal(loadDocs(null, true).darkAtFirstPaint, true);
  assert.equal(loadDocs(null, false).darkAtFirstPaint, false);
});

// ---------- (17) the docs header ----------

const NAV_EXPECTED = [
  ['Blog', `${LANDING}blog/`],
  ['Tom & <i>Jerry</i>', `${LANDING}#features`],
  ['Elsewhere', `${ORIGIN}/elsewhere/`],
  ['Example', 'https://example.com/x'],
  ['Up one', `${ORIGIN}/up/`],
];

function headerLinks() {
  const bar = navbar(readPage(built('main'), 'links'));
  const links = anchors(bar).map((a) => ({ ...a, url: a.href && new URL(a.href, pageUrl('links')).href }));
  return { bar, links };
}

test('(17) the brand shows the logo and name and links to the landing', () => {
  const { links } = headerLinks();
  const brand = links[0];
  assert.ok(brand, 'the header has no links');
  assert.equal(brand.url, LANDING);
  assert.ok(brand.text.includes('Octo Site'), `the brand shows ${JSON.stringify(brand.text)}`);
  assert.match(brand.raw, /<img\b/, 'the brand has no logo');
});

test('(17) the header shows brand, nav links, Docs and home_link in that order, then the theme toggle', () => {
  const { bar, links } = headerLinks();
  const labels = [...NAV_EXPECTED.map(([label]) => label), 'Docs', MAIN_PAGES.home_link.label];
  const at = labels.map((label) => links.findIndex((a) => a.text === label));
  assert.deepEqual(at.filter((i) => i < 0), [], `missing from the header: ${labels.filter((_, i) => at[i] < 0).join(', ')}`);
  assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), `header order is ${links.map((a) => a.text).join(' | ')}`);
  const homeAt = links[at[at.length - 1]].at;
  const toggles = [...bar.matchAll(/VPSwitchAppearance|role="switch"/g)].map((m) => m.index);
  assert.ok(toggles.some((i) => i > homeAt), 'no theme toggle after home_link');
  assert.equal(toggles.some((i) => i < homeAt), false, 'a theme toggle comes before home_link');
});

test('(17) nav links resolve against the landing, Docs opens the docs, home_link keeps its href', () => {
  const { links } = headerLinks();
  for (const [label, url] of NAV_EXPECTED) assert.equal(links.find((a) => a.text === label)?.url, url, label);
  assert.match(links.find((a) => a.text === 'Docs')?.url ?? '', new RegExp(`^${ORIGIN}${BASE}(index\\.html)?$`));
  assert.equal(links.find((a) => a.text === MAIN_PAGES.home_link.label)?.url, MAIN_PAGES.home_link.href);
});

test('(17) header labels from pages.json render as text', () => {
  assert.doesNotMatch(headerLinks().bar, /<i>Jerry<\/i>/);
});

// ---------- the acceptance fixture and the catalog line ----------

test('acceptance: a minimal pages.json builds with a sidebar, search and anchors', () => {
  const out = built('minimal');
  const html = readPage(out, 'guide');
  assert.ok(sidebarLabels(html).labels.length > 0, 'no sidebar');
  assert.ok(searchIndex(out).includes('Welcome'), 'the home page is not in the search index');
  assert.match(html, /<h2 id="first-section"[^>]*>[\s\S]*?class="header-anchor"/);
});

test('(24) docs/catalog.md has a docs-build entry with both inputs and their defaults', () => {
  const lines = fs.readFileSync(CATALOG, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === '### docs-build');
  assert.ok(start >= 0, 'docs/catalog.md has no ### docs-build section');
  const end = lines.findIndex((l, i) => i > start && /^#{1,3}\s/.test(l));
  const section = lines.slice(start, end < 0 ? undefined : end).join('\n');
  assert.match(section, /\|\s*`pre_build_command`\s*\|\s*no\s*\|\s*`''`\s*\|/);
  assert.match(section, /\|\s*`output_dir`\s*\|\s*no\s*\|\s*`artifacts\/pages\/docs`\s*\|/);
});

test('third-party actions in action.yml are pinned to a full commit SHA with a version comment', () => {
  const lines = fs.readFileSync(actionFile, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const ref = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/)?.[1];
    if (!ref || ref.startsWith('./')) return;
    assert.match(ref, /@[0-9a-f]{40}$/, `${ref} is not pinned to a full SHA`);
    assert.ok(/#\s*v\d/.test(line) || /^\s*#.*v\d/.test(lines[i - 1] ?? ''), `${ref} has no version comment`);
  });
});
