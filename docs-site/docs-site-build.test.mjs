// Rules for the VitePress docs site served at /hashira/docs/: which docs/ pages it
// publishes and how (read unchanged, no front matter), the sidebar order and H1
// labels for unlisted pages, links that leave docs/ or reach contributing.md going
// to GitHub with the anchor kept, the dead-link check, local search, the H2/H3
// outline, the mark as logo and favicon, the links to the landing page and to
// GitHub, the artifacts/pages layout, the site/docs guard, and the CI wiring.
//
// The tests drive the public entry point, docs-site/build.sh run from the repo
// root, then read the built HTML and the config VitePress resolves. The dead-link
// and outbound-link cases rebuild the staged sources into a temporary folder.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsSite = dirname(fileURLToPath(import.meta.url));
const root = join(docsSite, '..');
const docsDir = join(root, 'docs');
const pagesDir = join(root, 'artifacts', 'pages');
const outDir = join(pagesDir, 'docs');
const BASE = '/hashira/docs/';
const ORIGIN = 'https://skathio.github.io';
const GITHUB = 'https://github.com/skathio/hashira/blob/main/';
const UNPUBLISHED = ['contributing.md'];
const SIDEBAR = [
  'Getting started', 'Usage and pin policy', 'npm flow', 'NuGet flow', 'Static site flow', 'Catalog',
  'Migrating from v2 to v3',
];
const BUILD_TIMEOUT = 600_000;

// Doc paths relative to docs/: the top-level pages and the flows/ subfolder.
function docSources() {
  const list = (sub) => readdirSync(join(docsDir, sub)).filter((f) => f.endsWith('.md')).map((f) => posix.join(sub, f));
  return [...list('.'), ...list('flows')].sort();
}

const published = docSources().filter((md) => !UNPUBLISHED.includes(md));
const state = { build: null, docsBefore: null, gitBefore: null };

function snapshot(dir) {
  const files = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); } else { files[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex'); }
    }
  };
  walk(dir);
  return files;
}

function git(...args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed:\n${run.stderr}`);
  return run.stdout;
}

function runBuild() {
  return spawnSync('bash', [join(docsSite, 'build.sh')], { cwd: root, encoding: 'utf8', timeout: BUILD_TIMEOUT });
}

before(() => {
  state.docsBefore = snapshot(docsDir);
  state.gitBefore = git('status', '--porcelain', '--untracked-files=all');
  state.build = runBuild();
});

function built() {
  const log = `${state.build?.stdout}\n${state.build?.stderr}`;
  assert.equal(state.build?.status, 0, `docs-site/build.sh failed:\n${log}`);
  return outDir;
}

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function text(fragment) { return decode(fragment.replace(/<[^>]*>/g, '')).replace(/​/g, '').trim(); }

// The built file for a URL path under the docs base, as a static host serves it.
function urlToFile(pathname) {
  if (!pathname.startsWith(BASE)) { return null; }
  let rel = decodeURIComponent(pathname.slice(BASE.length));
  if (rel === '' || rel.endsWith('/')) { rel += 'index.html'; } else if (!/\.[a-z0-9]+$/i.test(rel)) { rel += '.html'; }
  return rel;
}

// The built page of a doc path relative to docs/. Getting started may be built as index.html.
function builtPageFor(md) {
  const page = md.replace(/\.md$/, '.html');
  const candidates = md === 'getting-started.md' ? [page, 'index.html'] : [page];
  return candidates.find((c) => existsSync(join(built(), c))) ?? null;
}

function html(rel, dir = built()) { return readFileSync(join(dir, rel), 'utf8'); }

function h1Of(page) {
  const m = html(page).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/);
  return m ? text(m[1].replace(/<a\b[^>]*class="header-anchor"[\s\S]*?<\/a>/g, '')) : null;
}

function anchors(page, dir) {
  return [...html(page, dir).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: decode(m[1].match(/\bhref="([^"]*)"/)?.[1] ?? ''), inner: m[2],
  }));
}

function hrefs(page, dir) { return anchors(page, dir).map((a) => a.href); }

// Each anchor of a built page, resolved as the browser resolves it.
function resolvedLinks(page) {
  const pageUrl = new URL(BASE + page, ORIGIN);
  return anchors(page).filter((a) => a.href).map((a) => {
    const u = new URL(a.href, pageUrl);
    return { url: u, file: u.origin === ORIGIN ? urlToFile(u.pathname) : null, hash: u.hash };
  });
}

function sourceLinks(md) {
  return [...readFileSync(join(docsDir, md), 'utf8').matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1])
    .filter((h) => !/^(?:[a-z]+:|#|\/)/i.test(h));
}

// Where a relative link in a doc points, as a repo path, and its #anchor.
function target(md, href) {
  const u = new URL(href, `https://repo.test/docs/${md}`);
  return { path: decodeURIComponent(u.pathname.slice(1)), hash: u.hash };
}

function expectedGithubUrl(md, href) {
  const { path, hash } = target(md, href);
  const outbound = !path.startsWith('docs/') || UNPUBLISHED.some((f) => path === `docs/${f}`);
  return outbound ? GITHUB + path + hash : null;
}

async function siteConfig() {
  const { resolveConfig } = await import('vitepress');
  return resolveConfig(docsSite, 'build', 'production');
}

function flattenSidebar(sidebar) {
  const groups = Array.isArray(sidebar) ? sidebar : Object.values(sidebar ?? {}).flat();
  const walk = (items) => items.flatMap((i) => [...(i.link ? [i] : []), ...walk(i.items ?? [])]);
  return walk(groups);
}

async function sidebarTexts() {
  const config = await siteConfig();
  return flattenSidebar(config.userConfig.themeConfig?.sidebar).map((i) => decode(i.text));
}

// ---------------------------------------------------------------- build and sources

test('the docs build exits 0 and prints no dead-link warning', () => {
  built();
  assert.doesNotMatch(`${state.build.stdout}\n${state.build.stderr}`, /dead link/i);
});

test('the build leaves every file under docs/ unchanged and adds none', () => {
  built();
  assert.deepEqual(snapshot(docsDir), state.docsBefore);
});

test('the build leaves git status as it was: nothing generated shows', () => {
  built();
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), state.gitBefore);
});

test('no docs page carries front matter', () => {
  for (const md of docSources()) {
    assert.doesNotMatch(readFileSync(join(docsDir, md), 'utf8'), /^﻿?---\s*\n/, `${md} has front matter`);
  }
});

test('the pages VitePress builds are the docs/ files byte for byte, flows/ kept as a subfolder', async () => {
  built();
  const { srcDir } = await siteConfig();
  for (const md of published) {
    const staged = join(srcDir, md);
    assert.ok(existsSync(staged), `${md} is not staged at ${staged}`);
    assert.equal(readFileSync(staged, 'utf8'), readFileSync(join(docsDir, md), 'utf8'), `${md} was edited`);
  }
});

test('the staged sources live under the gitignored artifacts/ folder', async () => {
  built();
  const { srcDir } = await siteConfig();
  assert.ok(relative(join(root, 'artifacts'), srcDir).split(/[\\/]/)[0] !== '..', `${srcDir} is outside artifacts/`);
  git('check-ignore', '-q', 'artifacts/pages/index.html');
  git('check-ignore', '-q', 'docs-site/node_modules');
});

// ---------------------------------------------------------------- assembled Pages folder

test('artifacts/pages holds the landing page files at its root and the docs under docs/', () => {
  built();
  const site = join(root, 'site');
  for (const f of readdirSync(site, { recursive: true })) {
    if (statSync(join(site, f)).isDirectory()) { continue; }
    const copy = join(pagesDir, f);
    assert.ok(existsSync(copy), `site/${f} is missing from artifacts/pages`);
    assert.ok(readFileSync(copy).equals(readFileSync(join(site, f))), `artifacts/pages/${f} differs from site/${f}`);
  }
  assert.ok(existsSync(join(pagesDir, 'docs', 'index.html')), 'no artifacts/pages/docs/index.html');
});

test('the site is served under /hashira/docs/', async () => {
  const config = await siteConfig();
  assert.equal(config.site.base, BASE);
  for (const md of published) {
    const head = html(builtPageFor(md)).match(/<head>([\s\S]*?)<\/head>/)[1];
    const urls = [...head.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    for (const u of urls.filter((x) => !/^https?:/.test(x))) { assert.ok(u.startsWith(BASE), `${md}: ${u} is not under ${BASE}`); }
  }
});

// ---------------------------------------------------------------- published pages and sidebar

test('the seven published docs each get a page and contributing.md gets none', () => {
  for (const md of [
    'getting-started.md', 'usage.md', 'flows/npm.md', 'flows/nuget.md', 'flows/static-webapp.md', 'catalog.md',
    'migration-v2-to-v3.md',
  ]) { assert.ok(builtPageFor(md), `${md} has no built page`); }
  for (const md of published) { assert.ok(builtPageFor(md), `${md} has no built page`); }
  assert.equal(existsSync(join(built(), 'contributing.html')), false, 'contributing.md was published');
  assert.equal(existsSync(join(built(), 'contributing', 'index.html')), false, 'contributing.md was published');
});

test('/hashira/docs/ opens Getting started', () => {
  assert.ok(existsSync(join(built(), 'index.html')), 'no index.html at /hashira/docs/');
  const index = html('index.html');
  const redirect = index.match(/http-equiv="refresh"[^>]*content="[^"]*url=([^"]+)"/i)?.[1]
    ?? index.match(/location\.(?:replace\(|href\s*=\s*)['"]([^'"]+)['"]/)?.[1];
  const to = redirect ? urlToFile(new URL(decode(redirect), new URL(BASE, ORIGIN)).pathname) : null;
  const isPage = h1Of('index.html') === 'Getting started';
  assert.ok(isPage || (to && to === builtPageFor('getting-started.md')), 'index.html neither is nor redirects to Getting started');
});

test('the sidebar lists the seven pages in the requested order and nothing else today', async () => {
  built();
  assert.deepEqual(await sidebarTexts(), SIDEBAR);
});

test('each sidebar entry links to a built page', async () => {
  built();
  const items = flattenSidebar((await siteConfig()).userConfig.themeConfig?.sidebar);
  assert.equal(items.length, SIDEBAR.length);
  for (const { text: label, link } of items) {
    const file = urlToFile(new URL(link.replace(/^\//, ''), new URL(BASE, ORIGIN)).pathname);
    assert.ok(file && existsSync(join(built(), file)), `${label}: ${link} has no built page`);
  }
});

test('contributing.md is in neither the sidebar nor the search index', async () => {
  built();
  const items = flattenSidebar((await siteConfig()).userConfig.themeConfig?.sidebar);
  assert.equal(items.some((i) => /contributing/.test(i.link)), false, 'contributing.md is in the sidebar');
  assert.doesNotMatch(searchIndex(), /\/hashira\/docs\/contributing/);
});

// ---------------------------------------------------------------- links

test('relative links that leave docs/ or reach contributing.md go to GitHub with the anchor kept', () => {
  let checked = 0;
  for (const md of published) {
    const have = hrefs(builtPageFor(md));
    for (const href of sourceLinks(md)) {
      const want = expectedGithubUrl(md, href);
      if (!want) { continue; }
      assert.ok(have.includes(want), `${md}: ${href} is not rewritten to ${want}`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'no outbound links were checked');
});

test('a flows/ page sends ../../templates/<flow>/ci.yml to GitHub and keeps ../usage.md on the site', () => {
  const page = builtPageFor('flows/npm.md');
  assert.ok(hrefs(page).includes(`${GITHUB}templates/npm/ci.yml`), 'templates/npm/ci.yml is not linked on GitHub');
  assert.ok(resolvedLinks(page).some((l) => l.file === builtPageFor('usage.md') && l.hash === '#gate-model'),
    'flows/npm.md does not link ../usage.md#gate-model to the built usage page');
});

test('usage.md links contributing.md on GitHub', () => {
  assert.ok(hrefs(builtPageFor('usage.md')).includes(`${GITHUB}docs/contributing.md`));
});

test('relative links between published pages resolve to the built page with the anchor kept', () => {
  let checked = 0;
  for (const md of published) {
    const links = resolvedLinks(builtPageFor(md));
    for (const href of sourceLinks(md).filter((h) => !expectedGithubUrl(md, h))) {
      const { path, hash } = target(md, href);
      const doc = path.slice('docs/'.length);
      if (!published.includes(doc)) { continue; }
      const want = builtPageFor(doc);
      assert.ok(links.some((l) => l.file === want && l.hash === hash), `${md}: ${href} does not link to ${want}${hash}`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'no links between pages were checked');
});

// Builds the staged sources with one staged page changed into a temporary folder, then puts the page back.
async function buildWithStagedChange(md, extra) {
  const { srcDir } = await siteConfig();
  const staged = join(srcDir, md);
  const original = readFileSync(staged, 'utf8');
  const tmp = mkdtempSync(join(tmpdir(), 'hashira-docs-'));
  try {
    appendFileSync(staged, `\n\n${extra}\n`);
    const cli = join(docsSite, 'node_modules', 'vitepress', 'bin', 'vitepress.js');
    const run = spawnSync(process.execPath, [cli, 'build', docsSite, '--outDir', tmp], { cwd: root, encoding: 'utf8', timeout: BUILD_TIMEOUT });
    return { run, tmp, keep: () => hrefs(md.replace(/\.md$/, '.html'), tmp) };
  } finally {
    writeFileSync(staged, original);
  }
}

async function stagedBuild(md, extra, check) {
  built();
  const result = await buildWithStagedChange(md, extra);
  try { check(result); } finally { rmSync(result.tmp, { recursive: true, force: true }); }
}

test('a dead link to a missing page fails the build', async () => {
  await stagedBuild('catalog.md', '[x](missing.md)', ({ run }) => {
    assert.notEqual(run.status, 0, `the build passed with a dead link:\n${run.stdout}\n${run.stderr}`);
  });
});

test('a dead link from a flows/ page fails the build', async () => {
  await stagedBuild('flows/nuget.md', '[x](../no-such-page.md#here)', ({ run }) => {
    assert.notEqual(run.status, 0, `the build passed with a dead link:\n${run.stdout}\n${run.stderr}`);
  });
});

test('the dead-link check is not switched off', async () => {
  built();
  assert.ok([undefined, false].includes((await siteConfig()).userConfig.ignoreDeadLinks));
});

test('staged ../README.md, ../templates and contributing.md links build and go to GitHub with anchors', async () => {
  const extra = '[r](../README.md#hashira) [t](../templates/npm/ci.yml) [c](./contributing.md#checklist) [d](contributing.md)';
  await stagedBuild('catalog.md', extra, ({ run, keep }) => {
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const have = keep();
    for (const want of [`${GITHUB}README.md#hashira`, `${GITHUB}templates/npm/ci.yml`, `${GITHUB}docs/contributing.md#checklist`, `${GITHUB}docs/contributing.md`]) {
      assert.ok(have.includes(want), `missing ${want}`);
    }
  });
});

test('staged links from a flows/ page that leave docs/ or reach contributing.md go to GitHub', async () => {
  const extra = '[s](../../site/index.html#docs) [c](../contributing.md#adding-an-action)';
  await stagedBuild('flows/static-webapp.md', extra, ({ run, keep }) => {
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const have = keep();
    for (const want of [`${GITHUB}site/index.html#docs`, `${GITHUB}docs/contributing.md#adding-an-action`]) {
      assert.ok(have.includes(want), `missing ${want}`);
    }
  });
});

// ---------------------------------------------------------------- search, outline, logo, favicon, nav

function searchIndex() {
  const chunks = join(built(), 'assets', 'chunks');
  const files = existsSync(chunks) ? readdirSync(chunks).filter((f) => f.startsWith('@localSearchIndex')) : [];
  assert.ok(files.length > 0, 'no local search index was built');
  return files.map((f) => readFileSync(join(chunks, f), 'utf8')).join('\n');
}

test('local search is on and indexes every published page', async () => {
  built();
  assert.equal((await siteConfig()).userConfig.themeConfig?.search?.provider, 'local');
  const body = searchIndex();
  const files = new Set([...body.matchAll(/(\/hashira\/docs\/[^"#\\]*)#/g)].map((m) => urlToFile(m[1])));
  for (const md of published) { assert.ok(files.has(builtPageFor(md)), `${md} is not in the search index`); }
});

test('the outline shows H2 and H3 headings', async () => {
  built();
  const outline = (await siteConfig()).userConfig.themeConfig?.outline;
  const level = Array.isArray(outline) ? outline : outline?.level;
  assert.deepEqual(level, [2, 3]);
});

function resolvesToMark(href, page) {
  const file = urlToFile(new URL(decode(href), new URL(BASE + page, ORIGIN)).pathname);
  return Boolean(file) && existsSync(join(built(), file)) && readFileSync(join(built(), file)).equals(readFileSync(join(root, 'site', 'mark.svg')));
}

test('the logo is site/mark.svg', () => {
  const page = builtPageFor('usage.md');
  const logos = [...html(page).matchAll(/<img\b[^>]*class="[^"]*\blogo\b[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.ok(logos.length > 0, 'no logo image');
  for (const img of logos) { assert.ok(resolvesToMark(img.match(/\bsrc="([^"]*)"/)[1], page), `${img} is not site/mark.svg`); }
});

test('the favicon is site/mark.svg', () => {
  for (const page of [builtPageFor('usage.md'), builtPageFor('flows/npm.md')]) {
    const icons = [...html(page).matchAll(/<link\b[^>]*\brel="(?:shortcut )?icon"[^>]*>/g)].map((m) => m[0]);
    assert.ok(icons.length > 0, `${page}: no favicon link`);
    assert.ok(icons.some((l) => resolvesToMark(l.match(/\bhref="([^"]*)"/)[1], page)), `${page}: favicon is not site/mark.svg`);
  }
});

test('every docs page links back to the landing page at /hashira/', () => {
  for (const md of published) {
    const page = builtPageFor(md);
    const landing = resolvedLinks(page).filter((l) => l.url.origin === ORIGIN && ['/hashira/', '/hashira/index.html'].includes(l.url.pathname));
    assert.ok(landing.length > 0, `${md}: no link to /hashira/`);
  }
});

test('the docs link to the hashira repository on GitHub', () => {
  const have = hrefs(builtPageFor('usage.md'));
  assert.ok(have.some((h) => /^https:\/\/github\.com\/skathio\/hashira\/?$/.test(h)), 'no link to https://github.com/skathio/hashira');
});

// ---------------------------------------------------------------- toolchain and CI wiring

test('VitePress 1.6.4 with a vite override is installed from a committed lockfile', () => {
  const pkg = JSON.parse(readFileSync(join(docsSite, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(docsSite, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.devDependencies?.vitepress ?? pkg.dependencies?.vitepress, '1.6.4');
  assert.equal(lock.packages?.['node_modules/vitepress']?.version, '1.6.4');
  assert.ok(pkg.overrides?.vite, 'no vite override');
  assert.equal(lock.packages?.['node_modules/vite']?.version, pkg.overrides.vite);
  git('ls-files', '--error-unmatch', 'docs-site/package-lock.json');
});

// The lines of one job under `jobs:` in a workflow, found by a step it runs.
function jobsRunning(workflow, needle) {
  const lines = readFileSync(join(root, '.github', 'workflows', workflow), 'utf8').split('\n');
  const starts = lines.map((l, i) => (/^ {2}[\w-]+:\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  return starts.map((s, k) => lines.slice(s, starts[k + 1] ?? lines.length).join('\n')).filter((job) => job.includes(needle));
}

test('_self-ci.yml has a docs job: setup-node 24, npm ci, build.sh, node --test docs-site/', () => {
  const jobs = jobsRunning('_self-ci.yml', 'docs-site/build.sh');
  assert.ok(jobs.length > 0, 'no _self-ci.yml job runs docs-site/build.sh');
  const job = jobs.find((j) => j.includes('node --test docs-site'));
  assert.ok(job, 'the docs job does not run node --test docs-site/');
  assert.match(job, /actions\/setup-node@/);
  assert.match(job, /node-version:\s*['"]?24\b/);
  assert.match(job, /npm ci/);
});

test('the docs job pins every third-party action to a full SHA with a version comment', () => {
  const job = jobsRunning('_self-ci.yml', 'docs-site/build.sh')[0];
  assert.ok(job, 'no docs job');
  const lines = job.split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
    if (!m || m[1].startsWith('./')) { return; }
    assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${m[1]} is not pinned to a full SHA`);
    const commented = /#\s*v\d+\.\d+\.\d+/.test(line) || /^\s*#.*\bv\d+\.\d+\.\d+/.test(lines[i - 1] ?? '');
    assert.ok(commented, `${m[1]} has no version comment`);
  });
});

test('dependabot keeps /docs-site npm dependencies fresh', () => {
  const config = readFileSync(join(root, '.github', 'dependabot.yml'), 'utf8');
  const entries = config.split(/\n\s*-\s+(?=package-ecosystem:)/).slice(1);
  assert.ok(entries.some((e) => /^package-ecosystem:\s*['"]?npm['"]?\s*$/m.test(e) && /directory:\s*['"]?\/docs-site\/?['"]?\s*$/m.test(e)),
    'no npm entry for /docs-site');
});

// ---------------------------------------------------------------- guards that change the tree

test('build.sh refuses to run when site/docs exists', () => {
  built();
  const guard = join(root, 'site', 'docs');
  assert.equal(existsSync(guard), false, 'site/docs already exists');
  mkdirSync(guard);
  try {
    const run = runBuild();
    assert.notEqual(run.status, 0, 'build.sh ran with site/docs present');
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
});

// Runs last: it adds a doc to docs/ and docs/flows/, rebuilds, and removes them again.
test('a future unlisted doc in docs/ or docs/flows/ appears in the sidebar under its H1', async () => {
  built();
  const extras = { 'zz-future-page.md': 'Future top-level page', 'flows/zz-future-flow.md': 'Future flow page' };
  try {
    for (const [md, h1] of Object.entries(extras)) { writeFileSync(join(docsDir, md), `Intro line.\n\n# ${h1}\n\n## Section\n\nBody.\n`); }
    const run = runBuild();
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const texts = await sidebarTexts();
    assert.deepEqual(texts.filter((t) => SIDEBAR.includes(t)), SIDEBAR);
    for (const [md, h1] of Object.entries(extras)) {
      assert.ok(texts.includes(h1), `${md} is not in the sidebar as "${h1}"`);
      assert.ok(existsSync(join(outDir, md.replace(/\.md$/, '.html'))), `${md} has no built page`);
    }
  } finally {
    for (const md of Object.keys(extras)) { rmSync(join(docsDir, md), { force: true }); }
  }
});
