// Rules for hashira's own docs site at /hashira/docs/, as site.yml builds it through
// pages-site.yml and the docs-build action: which docs/ pages it publishes and how (read
// unchanged, no front matter), the sidebar of .github/pages.json, links that leave docs/ or reach
// contributing.md going to GitHub with the anchor kept, links between pages, local search, the
// landing files at the root of the Pages folder, and the CI wiring. Moved from docs-site/ when the
// docs moved onto docs-build; the rules every docs-build site shares (dead links, the lockfile,
// unlisted pages under their H1) are in tests/docs-build/, and the logo, favicon and landing
// links in hashira-site-rules.test.js.
//
// The tests build the site with build-site.js, in a copy of the working tree, then read the HTML.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildSite } = require('./build-site.js');
const root = fileURLToPath(new URL('../../', import.meta.url));
const { loadPagesConfig } = require(join(root, '.github/actions/docs-build/lib/pages-config.js'));

const docsDir = join(root, 'docs');
const config = loadPagesConfig(root);
const BASE = config.base;
const ORIGIN = 'https://skathio.github.io';
// docs-build links a file on GitHub at HEAD, the default branch.
const GITHUB = 'https://github.com/skathio/hashira/blob/HEAD/';
const UNPUBLISHED = config.unpublished;

// Doc paths relative to docs/: the top-level pages and the flows/ subfolder.
function docSources() {
  const list = (sub) => readdirSync(join(docsDir, sub)).filter((f) => f.endsWith('.md')).map((f) => posix.join(sub, f));
  return [...list('.'), ...list('flows')].sort();
}

const published = docSources().filter((md) => !UNPUBLISHED.includes(md));
const state = { build: null, error: null, docsBefore: null, gitBefore: null };

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

before(() => {
  state.docsBefore = snapshot(docsDir);
  state.gitBefore = git('status', '--porcelain', '--untracked-files=all');
  try {
    state.build = buildSite();
  } catch (err) {
    state.error = err;
  }
});

after(() => { if (state.build) { rmSync(state.build.outer, { recursive: true, force: true }); } });

function site() {
  assert.ok(state.build, `the site build failed:\n${state.error?.message}`);
  return state.build.site;
}

function built() { return join(site(), 'docs'); }

// The folder VitePress read: docs-build stages the docs in <work>/vitepress/src under RUNNER_TEMP.
function stage() {
  const work = readdirSync(state.build.outer).find((d) => d.startsWith('docs-build-'));
  assert.ok(work, 'no docs-build work folder');
  return join(state.build.outer, work, 'vitepress', 'src');
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

// The built page of a doc path relative to docs/. The home page is built as index.html.
function builtPageFor(md) {
  const page = md === config.home_page ? 'index.html' : md.replace(/\.md$/, '.html');
  return existsSync(join(built(), page)) ? page : null;
}

function html(rel) { return readFileSync(join(built(), rel), 'utf8'); }

function anchors(page) {
  return [...html(page).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: decode(m[1].match(/\bhref="([^"]*)"/)?.[1] ?? ''), inner: m[2],
  }));
}

function hrefs(page) { return anchors(page).map((a) => a.href); }

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

// The sidebar entries of a built page, as label and link, in order.
function sidebar(page) {
  const aside = html(page).match(/<aside class="VPSidebar[\s\S]*?<\/aside>/);
  assert.ok(aside, `${page} has no sidebar`);
  return [...aside[0].matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>[\s\S]*?<p class="text"[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => ({ link: decode(m[1]), text: text(m[2]) }));
}

function searchIndex() {
  const chunks = join(built(), 'assets', 'chunks');
  const files = existsSync(chunks) ? readdirSync(chunks).filter((f) => f.startsWith('@localSearchIndex')) : [];
  assert.ok(files.length > 0, 'no local search index was built');
  return files.map((f) => readFileSync(join(chunks, f), 'utf8')).join('\n');
}

// ---------------------------------------------------------------- build and sources

test('the site builds and prints no dead-link warning', () => {
  site();
  assert.doesNotMatch(state.build.log, /dead link/i);
});

test('the build leaves every file under docs/ unchanged and adds none', () => {
  site();
  assert.deepEqual(snapshot(docsDir), state.docsBefore);
});

test('the build leaves git status as it was: nothing generated shows', () => {
  site();
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), state.gitBefore);
});

test('no docs page carries front matter', () => {
  for (const md of docSources()) {
    assert.doesNotMatch(readFileSync(join(docsDir, md), 'utf8'), /^﻿?---\s*\n/, `${md} has front matter`);
  }
});

test('the pages VitePress builds are the docs/ files byte for byte, flows/ kept as a subfolder', () => {
  site();
  for (const md of published) {
    const staged = join(stage(), md);
    assert.ok(existsSync(staged), `${md} is not staged at ${staged}`);
    assert.equal(readFileSync(staged, 'utf8'), readFileSync(join(docsDir, md), 'utf8'), `${md} was edited`);
  }
});

test('artifacts/pages is gitignored, where build-site.js writes the site for a local look', () => {
  const run = spawnSync('git', ['check-ignore', '-q', 'artifacts/pages/index.html'], { cwd: root });
  assert.equal(run.status, 0, 'artifacts/pages is not gitignored');
});

// ---------------------------------------------------------------- assembled Pages folder

test('the Pages folder holds the landing page files at its root and the docs under docs/', () => {
  const landing = join(root, 'site');
  for (const f of readdirSync(landing, { recursive: true })) {
    if (statSync(join(landing, f)).isDirectory()) { continue; }
    const copy = join(site(), f);
    assert.ok(existsSync(copy), `site/${f} is missing from the Pages folder`);
    assert.ok(readFileSync(copy).equals(readFileSync(join(landing, f))), `${f} differs from site/${f}`);
  }
  assert.ok(existsSync(join(site(), 'docs', 'index.html')), 'no docs/index.html');
});

test('the docs are served under /hashira/docs/', () => {
  assert.equal(BASE, '/hashira/docs/');
  for (const md of published) {
    const head = html(builtPageFor(md)).match(/<head>([\s\S]*?)<\/head>/)[1];
    const urls = [...head.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    for (const u of urls.filter((x) => !/^https?:/.test(x))) { assert.ok(u.startsWith(BASE), `${md}: ${u} is not under ${BASE}`); }
  }
});

// ---------------------------------------------------------------- published pages and sidebar

test('every published doc gets a page and contributing.md gets none', () => {
  for (const md of published) { assert.ok(builtPageFor(md), `${md} has no built page`); }
  assert.equal(existsSync(join(built(), 'contributing.html')), false, 'contributing.md was published');
  assert.equal(existsSync(join(built(), 'contributing', 'index.html')), false, 'contributing.md was published');
});

test('/hashira/docs/ opens Getting started', () => {
  const h1 = html('index.html').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/);
  assert.ok(h1, 'index.html has no H1');
  assert.equal(text(h1[1].replace(/<a\b[^>]*class="header-anchor"[\s\S]*?<\/a>/g, '')), 'Getting started');
});

test('the sidebar lists the pages of pages.json in order, and every published page', () => {
  const entries = sidebar(builtPageFor('usage.md'));
  const labels = config.sidebar.map((e) => e.label);
  assert.deepEqual(entries.slice(0, labels.length).map((e) => e.text), labels);
  assert.equal(entries.length, published.length, `the sidebar has ${entries.length} entries for ${published.length} pages`);
});

test('each sidebar entry links to a built page', () => {
  for (const { text: label, link } of sidebar(builtPageFor('usage.md'))) {
    const file = urlToFile(new URL(link, new URL(BASE, ORIGIN)).pathname);
    assert.ok(file && existsSync(join(built(), file)), `${label}: ${link} has no built page`);
  }
});

test('contributing.md is in neither the sidebar nor the search index', () => {
  assert.equal(sidebar(builtPageFor('usage.md')).some((e) => /contributing/.test(e.link)), false, 'contributing.md is in the sidebar');
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

// ---------------------------------------------------------------- search and outline

test('local search indexes every published page', () => {
  const body = searchIndex();
  const files = new Set([...body.matchAll(/(\/hashira\/docs\/[^"#\\]*)#/g)].map((m) => urlToFile(m[1])));
  for (const md of published) { assert.ok(files.has(builtPageFor(md)), `${md} is not in the search index`); }
});

test('the outline shows H2 and H3 headings', () => {
  const vitepressConfig = readFileSync(join(root, '.github/actions/docs-build/vitepress/.vitepress/config.mts'), 'utf8');
  assert.match(vitepressConfig, /outline:\s*\[2,\s*3\]/);
});

// ---------------------------------------------------------------- CI wiring

// The lines of one job under `jobs:` in a workflow, found by a pattern a step of it matches.
function jobsRunning(workflow, needle) {
  const lines = readFileSync(join(root, '.github', 'workflows', workflow), 'utf8').split('\n');
  const starts = lines.map((l, i) => (/^ {2}[\w-]+:\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  return starts.map((s, k) => lines.slice(s, starts[k + 1] ?? lines.length).join('\n')).filter((job) => needle.test(job));
}

test('_self-ci.yml builds hashira\'s site and runs these tests on Node 24', () => {
  const job = jobsRunning('_self-ci.yml', /node --test tests\/pages-site\/\s*$/m)[0];
  assert.ok(job, 'no _self-ci.yml job runs node --test tests/pages-site/');
  assert.match(job, /actions\/setup-node@/);
  assert.match(job, /node-version:\s*['"]?24\b/);
});

test('the site job pins every third-party action to a full SHA with a version comment', () => {
  const job = jobsRunning('_self-ci.yml', /node --test tests\/pages-site\/\s*$/m)[0];
  const lines = job.split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
    if (!m || m[1].startsWith('./')) { return; }
    assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${m[1]} is not pinned to a full SHA`);
    const commented = /#\s*v\d+\.\d+\.\d+/.test(line) || /^\s*#.*\bv\d+\.\d+\.\d+/.test(lines[i - 1] ?? '');
    assert.ok(commented, `${m[1]} has no version comment`);
  });
});

test('dependabot keeps the docs-build VitePress pin fresh', () => {
  const dependabot = readFileSync(join(root, '.github', 'dependabot.yml'), 'utf8');
  const entries = dependabot.split(/\n\s*-\s+(?=package-ecosystem:)/).slice(1);
  assert.ok(entries.some((e) => /^package-ecosystem:\s*['"]?npm['"]?\s*$/m.test(e)
    && /directory:\s*['"]?\/\.github\/actions\/docs-build\/vitepress\/?['"]?\s*$/m.test(e)), 'no npm entry for the docs-build vitepress folder');
});
