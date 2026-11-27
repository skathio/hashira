// pages-site.yml's check that a built site loads only kit files that exist, in
// .github/pages-site/lib/kit-refs.cjs. The workflow-level cases are in
// pages-site-features.test.js.
//
// Run with:
//   node --test tests/pages-site/kit-refs.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { kitReferences, check, main } = require(
  path.join(__dirname, '..', '..', '.github', 'pages-site', 'lib', 'kit-refs.cjs'));

function site(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-refs-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const KIT = { '_kit/tokens.css': '', '_kit/theme.js': '', '_kit/site-nav.js': '' };

test('kitReferences finds relative _kit values in src and href, quoted or bare, without query or hash', () => {
  const html = '<link href="_kit/tokens.css?v=1"><script src=\'../_kit/theme.js#x\'></script><script src=./_kit/site-nav.js></script>';
  assert.deepEqual(kitReferences(html), ['_kit/tokens.css', '../_kit/theme.js', './_kit/site-nav.js']);
});

test('kitReferences skips absolute paths, URLs, fragments and names that only contain _kit', () => {
  const html = '<a href="/repo/_kit/x.css"></a><a href="https://e.org/_kit/x.js"></a><a href="#_kit"></a><img src="my_kit/a.png"><a href="_kits/a">';
  assert.deepEqual(kitReferences(html), []);
});

test('check accepts root and sub-page references to kit files, and a site with none', () => {
  assert.deepEqual(check(site({ ...KIT, 'index.html': '<link href="_kit/tokens.css">', 'a/b/index.html': '<script src="../../_kit/theme.js"></script>' })), []);
  assert.deepEqual(check(site({ 'index.html': '<h1>plain</h1>' })), []);
});

test('check names each missing kit file, at the root and in a sub-page', () => {
  const problems = check(site({ ...KIT, 'index.html': '<script src="_kit/nope.js"></script>', 'guide/index.html': '<link href="../_kit/gone.css">' }));
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /index\.html: _kit\/nope\.js names no kit file \(site-kit copies site-nav\.js, theme\.js, tokens\.css\)/);
  assert.match(problems.join('\n'), /guide[/\\]index\.html: \.\.\/_kit\/gone\.css names no kit file/);
});

test('check refuses a reference that leaves the site, and a _kit folder named as a file', () => {
  const root = site({ ...KIT, 'index.html': '<link href="../_kit/tokens.css"><script src="_kit"></script>' });
  const problems = check(root);
  assert.match(problems[0], /resolves outside the site/);
  assert.match(problems[1], /_kit names no kit file/);
});

test('check says there is no _kit folder when site-kit did not run', () => {
  assert.match(check(site({ 'index.html': '<link href="_kit/tokens.css">' }))[0], /there is no _kit folder/);
});

test('main exits 0 for a good site, 1 for a broken one or a missing folder', () => {
  const write = process.stderr.write;
  const out = process.stdout.write;
  process.stderr.write = () => true;
  process.stdout.write = () => true;
  try {
    assert.equal(main([site({ ...KIT, 'index.html': '<link href="_kit/tokens.css">' })]), 0);
    assert.equal(main([site({ 'index.html': '<link href="_kit/tokens.css">' })]), 1);
    assert.equal(main([path.join(os.tmpdir(), 'kit-refs-no-such-folder')]), 1);
    assert.equal(main([]), 1);
  } finally {
    process.stderr.write = write;
    process.stdout.write = out;
  }
});
