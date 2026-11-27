// Unit tests, safe on Node 20, for the helpers behind docs-build's local entry point and page
// checks: lib/page-meta.js (og and canonical tags, the default description), lib/cli.js's
// argument parsing and origin remote, lib/html-safety.js's SVG check and image types, and
// lib/links.js's in-page anchor check. The built cases are in cli-schema-meta.test.js.
//
// Run with:
//   node --test tests/docs-build/page-meta-cli.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.resolve(__dirname, '..', '..', '.github', 'actions', 'docs-build', 'lib');
const { siteOrigin, siteDescription, pagePath, pageHead } = require(path.join(LIB, 'page-meta'));
const { parseArgs, originRepo, toolchainSummary } = require(path.join(LIB, 'cli'));
const { svgProblems, checkBuiltPage } = require(path.join(LIB, 'html-safety'));
const { missingAnchors } = require(path.join(LIB, 'links'));

// ---------- page-meta.js ----------

test('siteOrigin is the owner Pages origin, in lower case', () => {
  assert.equal(siteOrigin('Octo-Org/site'), 'https://octo-org.github.io');
  assert.equal(siteOrigin('a/b'), 'https://a.github.io');
});

test('siteOrigin is null for an owner GitHub would not allow, so no wrong URL is published', () => {
  for (const repo of [undefined, '', '/site', '-octo/site', 'octo-/site', 'oc--to/site', 'oc.to/site', 'evil.example#/x', `${'a'.repeat(40)}/x`]) {
    assert.equal(siteOrigin(repo), null, String(repo));
  }
  assert.equal(siteOrigin(`${'a'.repeat(39)}/x`), `https://${'a'.repeat(39)}.github.io`);
});

test('pageHead leaves out og:url and canonical when the origin is unknown', () => {
  const head = pageHead({ origin: null, base: '/site/docs/', relativePath: 'guide.md', title: 'T', description: 'D' });
  assert.deepEqual(head.map((t) => t[1].property ?? t[1].rel ?? t[1].name), ['description', 'og:title', 'og:description']);
});

test('siteDescription defaults a left-out or empty description to "Guides for <name>"', () => {
  assert.equal(siteDescription({ name: 'Octo', description: '' }), 'Guides for Octo');
  assert.equal(siteDescription({ name: 'Octo' }), 'Guides for Octo');
  assert.equal(siteDescription({ name: 'Octo', description: 'About.' }), 'About.');
});

test('pagePath serves an index.md as its folder and any other page as .html, encoded', () => {
  assert.equal(pagePath('/site/docs/', 'index.md'), '/site/docs/');
  assert.equal(pagePath('/site/docs/', 'api/index.md'), '/site/docs/api/');
  assert.equal(pagePath('/site/docs/', 'guide.md'), '/site/docs/guide.html');
  assert.equal(pagePath('/site/docs/', 'flows/a b.md'), '/site/docs/flows/a%20b.html');
  assert.equal(pagePath('/site/docs/', 'reindex.md'), '/site/docs/reindex.html');
});

test('pageHead gives one description, og:title, og:description, og:url and canonical, the URL twice', () => {
  const head = pageHead({ origin: 'https://octo.github.io', base: '/site/docs/', relativePath: 'guide.md', title: 'Guide | Octo', description: 'D' });
  assert.deepEqual(head, [
    ['meta', { name: 'description', content: 'D' }],
    ['meta', { property: 'og:title', content: 'Guide | Octo' }],
    ['meta', { property: 'og:description', content: 'D' }],
    ['meta', { property: 'og:url', content: 'https://octo.github.io/site/docs/guide.html' }],
    ['link', { rel: 'canonical', href: 'https://octo.github.io/site/docs/guide.html' }],
  ]);
});

test('the built-page check accepts an https canonical link and refuses any other', () => {
  const page = (href) => `<html><head><link rel="canonical" href="${href}"></head><body></body></html>`;
  assert.deepEqual(checkBuiltPage(page('https://octo.github.io/site/docs/guide.html'), { base: '/site/docs/', inlineScripts: [] }), []);
  for (const href of ['http://octo.github.io/x', 'javascript:alert(1)', '//evil.example/']) {
    assert.notDeepEqual(checkBuiltPage(page(href), { base: '/site/docs/', inlineScripts: [] }), [], href);
  }
});

// ---------- html-safety.js: images and SVGs ----------

test('the built-page check accepts inlined .ico and .bmp images and a .bmp file', () => {
  for (const src of ['data:image/x-icon;base64,AAAB', 'data:image/vnd.microsoft.icon;base64,AAAB', 'data:image/bmp;base64,Qk0=', '/d/assets/a.1.bmp', '/d/a.ICO']) {
    assert.deepEqual(checkBuiltPage(`<html><head></head><body><img src="${src}"></body></html>`, { base: '/d/', inlineScripts: [] }), [], src);
  }
});

test('svgProblems passes a plain SVG, text that reads "on" or "script" included', () => {
  assert.deepEqual(svgProblems('<svg xmlns="http://www.w3.org/2000/svg"><title>onboarding</title><text>scripted javascript: notes</text><a href="https://x/">x</a></svg>'), []);
});

test('svgProblems refuses a script element, a handler and a javascript: URL in any spelling', () => {
  const cases = {
    '<svg><script>x()</script></svg>': /<script>/,
    '<svg><SCRIPT src="x.js"/></svg>': /<script>/,
    '<svg><svg:script>x()</svg:script></svg>': /<script>/,
    '<svg><!-- <script> --></svg>': /<script>/,
    '<svg onload="x()"></svg>': /handler onload/,
    '<svg><rect ONCLICK="x()"/></svg>': /handler onclick/,
    '<svg><rect ev:onclick="x()"/></svg>': /handler ev:onclick/,
    '<svg><a href="javascript:x()"/></svg>': /javascript:/,
    '<svg><a xlink:href="  JavaScript:x()"/></svg>': /javascript:/,
    '<svg><a href="java&#x09;script:x()"/></svg>': /javascript:/,
    '<svg><a href="&#106;avascript:x()"/></svg>': /javascript:/,
    '<svg><set attributeName="href" to="javascript:x()"/></svg>': /javascript:/,
    '<\0s\0v\0g\0>': /not UTF-8/,
  };
  for (const [text, problem] of Object.entries(cases)) {
    const problems = svgProblems(text);
    assert.ok(problems.some((p) => problem.test(p)), `${JSON.stringify(text)}: ${problems.join('; ')}`);
  }
});

// ---------- links.js: in-page anchors ----------

test('missingAnchors lists each in-page #anchor with no id on the page, decoded, once', () => {
  const html = [
    '<h2 id="first-steps">First</h2><h2 id="hello-world--co">Hello</h2><h2 id="café">Café</h2>',
    '<a href="#first-steps">a</a><a href="#hello-world--co">b</a><a href="#caf%C3%A9">c</a>',
    '<a href="#gone">d</a><a href="#gone">e</a><a href="#100%">f</a><a href="guide.html#gone-too">g</a><a href="#">h</a>',
  ].join('');
  assert.deepEqual(missingAnchors(html), ['gone', '100%']);
});

// ---------- cli.js: arguments and the origin remote ----------

test('parseArgs takes --check, or --out with an optional --pre-build', () => {
  assert.deepEqual(parseArgs(['--check']), { check: true, out: null, preBuild: '' });
  assert.deepEqual(parseArgs(['--out', 'o/d']), { check: false, out: 'o/d', preBuild: '' });
  assert.deepEqual(parseArgs(['--out', 'o/d', '--pre-build', 'make docs']), { check: false, out: 'o/d', preBuild: 'make docs' });
  assert.deepEqual(parseArgs(['--pre-build', '', '--out', 'o']), { check: false, out: 'o', preBuild: '' });
});

test('parseArgs refuses no mode, both modes, a missing value and an unknown flag', () => {
  for (const argv of [[], ['--check', '--out', 'o'], ['--out'], ['--out', 'o', '--pre-build'], ['--check', '--verbose'], ['check']]) {
    assert.throws(() => parseArgs(argv), /docs-build: .*usage: cli\.js/, JSON.stringify(argv));
  }
});

test('originRepo reads owner/name from a github.com origin remote, and null otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-cli-origin-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    assert.equal(originRepo(dir), null);
    for (const [url, repo] of [['https://github.com/octo/site.git', 'octo/site'], ['git@github.com:octo/my.site', 'octo/my.site'], ['https://gitlab.com/octo/site', null]]) {
      spawnSync('git', ['remote', 'remove', 'origin'], { cwd: dir });
      spawnSync('git', ['remote', 'add', 'origin', url], { cwd: dir });
      assert.equal(originRepo(dir), repo, url);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- cli.js: the toolchain line of the step summary ----------

test('toolchainSummary names the lockfile\'s VitePress version and the lockfile\'s sha256', () => {
  const lock = path.join(LIB, '..', 'vitepress', 'package-lock.json');
  const bytes = fs.readFileSync(lock);
  const line = toolchainSummary();
  assert.ok(line.includes(`VitePress ${JSON.parse(bytes).packages['node_modules/vitepress'].version}`), line);
  assert.ok(line.includes(require('node:crypto').createHash('sha256').update(bytes).digest('hex')), line);
});

test('toolchainSummary says unknown for a lockfile with no VitePress, and fails on one that is not JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-cli-lock-'));
  try {
    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, '{"packages":{}}');
    assert.match(toolchainSummary(empty), /VitePress unknown, .*sha256 [0-9a-f]{64}/);
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, 'not json');
    assert.throws(() => toolchainSummary(broken), SyntaxError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
