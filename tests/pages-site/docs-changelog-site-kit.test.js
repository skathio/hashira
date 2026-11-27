// The user's rules for the docs and changelog part of the Pages release: the sections pages.md
// must hold (the <site-nav> reference, the pages-site vs static-webapp-ci table, the pages-deploy
// pin note, migration notes for a repo leaving its own VitePress config, pre-build in a repo
// script, the semver-covered kit API and SHA pins, an org-root site reserving _kit), a link to
// site-kit from docs/flows/static-webapp.md, static-webapp-ci's new `site_kit` input (default
// false, site-kit run after build_command and before the upload), and CHANGELOG.md in Keep a
// Changelog style with a v3.4.0 entry naming every change, the actionlint default note included.
// Also the project conventions the new input keeps: it is in the YAML, its flow page, catalog.md
// and the shape-validate expectations; the action comes from the library checkout; the job that
// runs it holds no id-token or pages; and _self-ci.yml runs this file.
//
// Run with:
//   node --test tests/pages-site/docs-changelog-site-kit.test.js
//
// Left to the builder, so not tested here: the wording, headings and order of the docs, what
// `dest` site-kit gets when output_dir is left to autodetect, the changelog's date and section
// split, and the screenshots, which a person looks at.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const THIS_FILE = 'tests/pages-site/docs-changelog-site-kit.test.js';
const readRepo = (...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf8');
const PAGES_MD = () => readRepo('docs', 'flows', 'pages.md');
const STATIC_MD = () => readRepo('docs', 'flows', 'static-webapp.md');
const KIT_NAV = () => readRepo('.github', 'actions', 'site-kit', 'kit', 'site-nav.js');

// ==================== helpers ====================

const yamlCache = new Map();
function yamlOf(rel) {
  if (!yamlCache.has(rel)) {
    const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))';
    const r = spawnSync('python3', ['-c', py, path.join(REPO, rel)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `PyYAML could not read ${rel}: ${r.stderr}`);
    yamlCache.set(rel, JSON.parse(r.stdout));
  }
  return yamlCache.get(rel);
}

const STATIC_WF = '.github/workflows/static-webapp-ci.yml';
const callOf = (wf) => (wf.on ?? wf.true ?? {}).workflow_call ?? {};
const staticInputs = () => callOf(yamlOf(STATIC_WF)).inputs ?? {};
const buildJob = () => (yamlOf(STATIC_WF).jobs ?? {})['build-and-upload'] ?? {};
const buildSteps = () => (buildJob().steps ?? []).filter(Boolean);

// Paragraphs of a markdown text: blocks between blank lines.
const paragraphs = (md) => md.split(/\n\s*\n/);
const someParagraph = (md, ...patterns) => paragraphs(md).some((p) => patterns.every((re) => re.test(p)));

// The body under each heading, up to the next heading of the same or a higher level.
function sections(md) {
  const lines = md.split('\n');
  const out = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (/^```/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) out.push({ level: m[1].length, title: m[2], start: i });
  });
  return out.map((s, idx) => {
    const next = out.slice(idx + 1).find((o) => o.level <= s.level);
    return { ...s, body: lines.slice(s.start, next ? next.start : lines.length).join('\n') };
  });
}

// Markdown table blocks: runs of lines that start with `|`.
const tables = (md) => (md.match(/(?:^\|.*\n?)+/gm) ?? []);

// A table row for `name` in a markdown text, split into its trimmed cells.
function rowOf(md, name) {
  const line = md.split('\n').find((l) => l.startsWith(`| \`${name}\``));
  return line ? line.split('|').slice(1, -1).map((c) => c.trim()) : null;
}

// Evaluates a step's `if:` the way a runner would for the few forms such a step uses.
function evalIf(expr, inputs) {
  if (expr === undefined) return true;
  if (typeof expr === 'boolean') return expr;
  let js = String(expr).trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  js = js.replace(/\binputs\.([A-Za-z_][\w-]*)/g, (_, n) => JSON.stringify(inputs[n] ?? ''));
  js = js.replace(/\b(success|always)\(\)/g, 'true').replace(/!\s*cancelled\(\)/g, 'true');
  js = js.replace(/==/g, '===').replace(/!===/g, '!==').replace(/'/g, '"');
  assert.match(js, /^[\s"\w!=&|().-]*$/, `step if: uses more than inputs and status checks: ${expr}`);
  return Boolean(Function(`"use strict"; return (${js});`)());
}

const usesOf = (step) => String(step.uses ?? '');
const siteKitIndex = () => buildSteps().findIndex((s) => /\/actions\/site-kit$/.test(usesOf(s)));
const buildIndex = () => buildSteps().findIndex((s) => s.env && 'BUILD_COMMAND' in s.env
  || /inputs\.build_command/.test(String(s.run ?? '')));
const uploadIndex = () => buildSteps().findIndex((s) => /\/actions\/pages-upload$/.test(usesOf(s)));

// The 3.4.0 entry of CHANGELOG.md, from its heading to the next release heading.
function changelogEntry() {
  const md = readRepo('CHANGELOG.md');
  const start = md.search(/^## \[3\.4\.0\]/m);
  assert.ok(start >= 0, 'CHANGELOG.md has no "## [3.4.0]" entry');
  const rest = md.slice(start + 1);
  const end = rest.search(/^## \[/m);
  return end >= 0 ? md.slice(start, start + 1 + end) : md.slice(start);
}

// The public names of <site-nav>, read from the kit's own source.
function kitAttributes() {
  const m = /var FIELDS = \[([^\]]*)\]/.exec(KIT_NAV());
  assert.ok(m, 'site-nav.js has no FIELDS list');
  const fields = [...m[1].matchAll(/'([\w-]+)'/g)].map((x) => x[1]);
  return [...fields, 'scrollspy'];
}
function kitParts() {
  const src = KIT_NAV();
  const literal = [...src.matchAll(/part: '([\w-]+)'/g)].map((x) => x[1]);
  const viaLink = [...src.matchAll(/\blink\([^()]*(?:\([^()]*\))?[^()]*,\s*'([\w-]+)'\)/g)].map((x) => x[1]);
  return [...new Set([...literal, ...viaLink])];
}
function kitCssVars() {
  const src = KIT_NAV();
  const read = [...src.matchAll(/var\((--nav-[\w-]+)/g)].map((x) => x[1]);
  const set = [...src.matchAll(/setAccent\('(--[\w-]+)'/g)].map((x) => x[1]);
  return [...new Set([...read, ...set])];
}

// ==================== pages.md: the <site-nav> reference ====================

test('pages.md names every <site-nav> attribute, scrollspy included', () => {
  const md = PAGES_MD();
  const missing = kitAttributes().filter((a) => !md.includes(`\`${a}\``));
  assert.deepEqual(missing, [], `pages.md does not name these attributes as code: ${missing.join(', ')}`);
});

test('pages.md gives the precedence of attributes, the config property and the JSON child', () => {
  const md = PAGES_MD();
  assert.ok(someParagraph(md, /application\/json/, /`config`/, /attribute/i, /propert/i),
    'no paragraph names the JSON child, the `config` property and attributes together');
  assert.ok(someParagraph(md, /`config`/, /attribute/i, /\b(win|wins|over|precedence|override)/i),
    'no paragraph says which of attributes, the property and the JSON child wins');
});

test('pages.md shows the kit paths from the root and from a sub-page (../_kit)', () => {
  const md = PAGES_MD();
  assert.match(md, /["'(]_kit\/(tokens\.css|theme\.js|site-nav\.js)/, 'no root-page _kit/ path');
  assert.match(md, /\.\.\/_kit\/(tokens\.css|theme\.js|site-nav\.js)/, 'no sub-page ../_kit/ path');
});

test('pages.md names both named slots', () => {
  const md = PAGES_MD();
  assert.match(md, /slot="brand"/);
  assert.match(md, /slot="fallback"/);
});

test('pages.md names every shadow part of <site-nav>', () => {
  const parts = kitParts();
  assert.ok(parts.length >= 1, 'found no part in site-nav.js');
  const md = PAGES_MD();
  const missing = parts.filter((p) => !new RegExp(`::part\\(${p}\\)|\`${p}\``).test(md));
  assert.deepEqual(missing, [], `pages.md does not name these parts: ${missing.join(', ')}`);
  assert.match(md, /::part\(/, 'pages.md shows no ::part() selector');
});

test('pages.md names every CSS variable <site-nav> reads or sets', () => {
  const vars = kitCssVars();
  assert.ok(vars.includes('--site-accent'), 'found no --site-accent in site-nav.js');
  const md = PAGES_MD();
  const missing = vars.filter((v) => !md.includes(v));
  assert.deepEqual(missing, [], `pages.md does not name: ${missing.join(', ')}`);
});

test('pages.md covers the accessibility of <site-nav>', () => {
  const md = PAGES_MD();
  for (const re of [/aria-expanded/, /Escape/, /aria-current/, /role="navigation"/, /aria-label="Site"/]) {
    assert.match(md, re);
  }
});

test('pages.md documents the #theme hook and window.siteTheme', () => {
  const md = PAGES_MD();
  assert.match(md, /#theme\b|id="theme"/, 'no #theme hook');
  assert.match(md, /window\.siteTheme/, 'no window.siteTheme');
});

// ==================== pages.md: the other sections ====================

test('pages.md has a pages-site vs static-webapp-ci table of what runs, events and grants', () => {
  const found = tables(PAGES_MD()).some((t) => /pages-site/.test(t) && /static-webapp-ci/.test(t)
    && /pull_request/.test(t) && /(push|workflow_dispatch)/.test(t)
    && /id-token/.test(t) && /contents: read/.test(t));
  assert.ok(found, 'no table compares pages-site and static-webapp-ci by events and grants');
});

test('pages.md says pages-deploy is pinned separately and how that pin is updated', () => {
  const md = PAGES_MD();
  assert.ok(someParagraph(md, /pages-deploy/, /\bpin/i, /\bSHA\b/, /updat|bump|mov|releas/i),
    'no paragraph says how the pages-deploy SHA pin is kept up to date');
});

test('pages.md has migration notes for a repo leaving its own VitePress config', () => {
  const section = sections(PAGES_MD()).find((s) => /migrat/i.test(s.title) && /vitepress/i.test(s.body));
  assert.ok(section, 'no migration heading about leaving an own VitePress config');
  const want = { anchors: /anchor|heading id/i, sidebar: /sidebar/i, 'theme CSS': /\bcss\b/i,
    Dependabot: /dependabot/i, OSV: /\bOSV\b/ };
  const missing = Object.keys(want).filter((k) => !want[k].test(section.body));
  assert.deepEqual(missing, [], `the migration notes leave out: ${missing.join(', ')}`);
});

test('pages.md recommends keeping the pre-build command in a repo script', () => {
  assert.ok(someParagraph(PAGES_MD(), /pre_build_command|pre-build/i, /\bscript\b/i, /repo/i),
    'no paragraph recommends a repo script for the pre-build');
});

test('pages.md says the <site-nav> public API is semver-covered and a SHA pin holds the kit still', () => {
  const md = PAGES_MD();
  assert.ok(someParagraph(md, /semver|semantic versioning/i, /slot/i, /part/i, /attribute/i),
    'no paragraph puts slots, parts and attributes under semver');
  assert.ok(someParagraph(md, /semver|semantic versioning/i, /\bbar\b/i)
    || someParagraph(md, /\bbar\b/i, /box|height/i, /semver|major/i), 'the bar box is not named as covered');
  assert.ok(someParagraph(md, /\bSHA\b/, /kit/i), 'no paragraph says a SHA pin holds the kit still');
});

test('pages.md says an org-root site must reserve _kit', () => {
  assert.ok(someParagraph(PAGES_MD(), /org(anization)?[- ]root|\.github\.io/i, /`?_kit`?/, /reserv/i),
    'no paragraph tells an org-root site to reserve _kit');
});

// ==================== static-webapp.md links site-kit ====================

test('docs/flows/static-webapp.md links site-kit to a page that exists', () => {
  const md = STATIC_MD();
  const links = [...md.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)]
    .filter(([, text, href]) => /site-kit/.test(text) || /site-kit/.test(href));
  assert.ok(links.length >= 1, 'static-webapp.md has no link about site-kit');
  for (const [, , href] of links) {
    if (/^https?:/.test(href)) continue;
    const file = href.split('#')[0];
    if (!file) continue;
    assert.ok(fs.existsSync(path.join(REPO, 'docs', 'flows', file)), `link target ${href} does not exist`);
  }
});

// ==================== static-webapp-ci's site_kit input ====================

test('static-webapp-ci.yml declares site_kit as a boolean that defaults to false', () => {
  const def = staticInputs().site_kit;
  assert.ok(def, 'no site_kit input');
  assert.equal(def.type, 'boolean');
  assert.equal(def.default, false);
  assert.equal(def.required ?? false, false);
  assert.ok(String(def.description ?? '').trim().length > 0, 'site_kit has no description');
});

test('build-and-upload runs site-kit from the library checkout after build_command and before the upload', () => {
  const kit = siteKitIndex();
  assert.ok(kit >= 0, 'build-and-upload has no site-kit step');
  assert.match(usesOf(buildSteps()[kit]), /^\.\/\.hashira\/\.github\/actions\/site-kit$/);
  assert.ok(buildIndex() >= 0 && buildIndex() < kit, 'site-kit does not run after build_command');
  assert.ok(uploadIndex() > kit, 'site-kit does not run before pages-upload');
  assert.ok(buildSteps()[kit].with && 'dest' in buildSteps()[kit].with, 'site-kit gets no dest');
});

test('site_kit left out or false skips site-kit, true runs it', () => {
  const step = buildSteps()[siteKitIndex()];
  assert.ok(step, 'build-and-upload has no site-kit step');
  // Left out, the runner passes the input's declared default.
  const leftOut = { site_kit: staticInputs().site_kit?.default };
  assert.equal(evalIf(step.if, leftOut), false, 'site-kit runs with site_kit left out');
  assert.equal(evalIf(step.if, { site_kit: false }), false, 'site-kit runs with site_kit: false');
  assert.equal(evalIf(step.if, { site_kit: true }), true, 'site-kit does not run with site_kit: true');
});

test('build-and-upload still holds no id-token or pages with site-kit in it', () => {
  const perms = buildJob().permissions ?? {};
  assert.equal(typeof perms, 'object');
  assert.ok(!('id-token' in perms), 'build-and-upload holds id-token');
  assert.ok(!('pages' in perms), 'build-and-upload holds pages');
});

test('site_kit is in static-webapp.md and catalog.md with type boolean and default false', () => {
  const flowRow = rowOf(STATIC_MD(), 'site_kit');
  assert.ok(flowRow, 'static-webapp.md has no site_kit row');
  assert.equal(flowRow[1], 'boolean');
  assert.match(flowRow[2], /^`false`$/);
  const catalog = readRepo('docs', 'catalog.md');
  const section = sections(catalog).find((s) => s.title.trim() === 'static-webapp-ci.yml');
  assert.ok(section, 'catalog.md has no static-webapp-ci.yml section');
  const catRow = rowOf(section.body, 'site_kit');
  assert.ok(catRow, 'catalog.md has no site_kit row for static-webapp-ci.yml');
  assert.equal(catRow[1], 'no');
  assert.match(catRow[2], /^`false`$/);
});

test('static-webapp-ci shape-validate expects site_kit and passes, and so does the catalog check', () => {
  const src = readRepo('tests', 'static-webapp-ci', 'shape-validate.py');
  const list = /DOCUMENTED_INPUTS = \[([\s\S]*?)\]/.exec(src);
  assert.ok(list && /"site_kit"/.test(list[1]), 'DOCUMENTED_INPUTS does not list site_kit');
  for (const script of ['tests/static-webapp-ci/shape-validate.py', 'tests/catalog/shape-validate.py']) {
    const r = spawnSync('python3', [script], { cwd: REPO, encoding: 'utf8' });
    assert.equal(r.status, 0, `${script} failed:\n${r.stdout}\n${r.stderr}`);
  }
});

// ==================== CHANGELOG.md ====================

test('CHANGELOG.md follows Keep a Changelog with a linked 3.4.0 entry', () => {
  const md = readRepo('CHANGELOG.md');
  assert.match(md, /^# Changelog\b/m);
  assert.match(md, /keepachangelog\.com/);
  assert.match(md, /^\[3\.4\.0\]:\s*\S+/m, 'no link reference for [3.4.0]');
  const kinds = [...changelogEntry().matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
  assert.ok(kinds.length >= 1, 'the 3.4.0 entry has no sections');
  const allowed = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
  assert.deepEqual(kinds.filter((k) => !allowed.includes(k)), [], 'sections outside Keep a Changelog');
});

test('the 3.4.0 entry notes the actionlint default change and that callers may see new findings', () => {
  const entry = changelogEntry();
  assert.ok(someParagraph(entry, /actionlint/, /scan_disable/, /codeql,actionlint/, /finding/i),
    'no note on the scan_disable default and new actionlint findings');
  for (const flow of ['npm-package-ci', 'nuget-package-ci', 'static-webapp-ci']) assert.match(entry, new RegExp(flow));
});

// What each interface held at v3.3.0; any name added since is a change the entry must name.
const V330 = {
  '.github/workflows/pages-site.yml': ['docs', 'docs_pre_build_command', 'dotnet_version', 'node_version',
    'released', 'site_build_command', 'site_dir', 'site_output'],
  '.github/workflows/static-webapp-ci.yml': ['build_command', 'coverage_path', 'node_version', 'output_dir',
    'quality_gate', 'quality_level', 'scan_disable', 'scan_fail_on_findings', 'summary_comment', 'test_command',
    'library_sha'],
  '.github/workflows/npm-package-ci.yml': ['bump', 'coverage_path', 'node_version', 'quality_gate', 'quality_level',
    'scan_disable', 'scan_fail_on_findings', 'seed_version', 'summary_comment', 'test_command', 'library_sha',
    'resolved_version'],
  '.github/workflows/nuget-package-ci.yml': ['bump', 'coverage_path', 'dotnet_version', 'project_path',
    'quality_gate', 'quality_level', 'scan_disable', 'scan_fail_on_findings', 'seed_version', 'summary_comment',
    'test_filter', 'library_sha', 'resolved_version'],
  '.github/actions/docs-build/action.yml': ['output_dir', 'pre_build_command'],
  '.github/actions/site-kit/action.yml': ['dest', 'kit_path'],
};

function interfaceNames(rel) {
  const doc = yamlOf(rel);
  const call = callOf(doc);
  const groups = rel.includes('/workflows/') ? [call.inputs, call.secrets, call.outputs] : [doc.inputs, doc.outputs];
  return groups.flatMap((g) => Object.keys(g ?? {}));
}

test('the 3.4.0 entry names every input, secret and output added since v3.3.0', () => {
  const entry = changelogEntry();
  const missing = Object.entries(V330).flatMap(([rel, before]) => interfaceNames(rel)
    .filter((n) => !before.includes(n) && !entry.includes(`\`${n}\``)).map((n) => `${rel}: ${n}`));
  assert.deepEqual(missing, [], 'the 3.4.0 entry does not name these as code');
});

test('the 3.4.0 entry names each change the request lists', () => {
  const entry = changelogEntry();
  const want = {
    'build grants dropped': /id-token/, 'released approval': /released/,
    'pin comments lint': /pin-comments/, 'header menu': /aria-expanded|menu/i,
    'current link': /aria-current/, scrollspy: /scrollspy/, 'brand slot': /brand/,
    'fallback slot': /fallback/, 'ready event': /site-nav:ready/, 'theme cycle': /theme/i,
    'resolved theme': /data-theme-resolved/, 'accent pair': /accent_dark/, 'contrast warning': /4\.5/,
    'docs nav dropdown': /dropdown|activeMatch/i, 'grouped sidebar': /sidebar/,
    'issue 46': /#46/, 'folder links': /\btree\b/, 'local CLI': /cli\.js/, 'check mode': /--check/,
    'JSON Schema': /JSON Schema|\$schema/, 'anchor check': /anchor/i, 'page meta': /og:/,
    canonical: /canonical/, 'Guides for default': /Guides for/, SVG: /SVG/, 'image check': /\.bmp|\.ico/,
    'scan job': /OSV/, gitleaks: /gitleaks/, 'site-kit in static-webapp-ci': /`site_kit`/,
    'pages.md reference': /pages\.md/,
  };
  const missing = Object.keys(want).filter((k) => !want[k].test(entry));
  assert.deepEqual(missing, [], `the 3.4.0 entry leaves out: ${missing.join(', ')}`);
});

test('the changelog carries no audit or planning ids', () => {
  const md = readRepo('CHANGELOG.md');
  assert.doesNotMatch(md, /\b(rogue|somi|homepage|master)\s+(?:[A-Z]{1,2}\d+|\d+)\b/i);
  assert.doesNotMatch(md, /\.somi\//);
  assert.doesNotMatch(md, /\bmilestone\b/i);
});

// ==================== the project's conventions ====================

test('_self-ci.yml runs this test file', () => {
  const ci = yamlOf('.github/workflows/_self-ci.yml');
  const runs = Object.values(ci.jobs ?? {}).flatMap((j) => (j.steps ?? []).map((s) => String(s?.run ?? '')));
  assert.ok(runs.some((r) => r.includes(THIS_FILE) || /node --test tests\/pages-site\/(\s|$)/.test(r)),
    `no _self-ci.yml step runs ${THIS_FILE}`);
});
