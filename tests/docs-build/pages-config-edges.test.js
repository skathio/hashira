// Edges of the pages.json loader that pages-config.test.js leaves open: where a JSON parse
// error is, how the repo name is read, strict sub-fields, and homepage.json values that are bad.
//
// Run with:
//   node --test tests/docs-build/pages-config-edges.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadPagesConfig, parseError, repoName } = require('../../.github/actions/docs-build/lib/pages-config');
const { errorOffset, lineColumn } = require('../../.github/actions/docs-build/lib/json-error');

const temps = [];
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function makeRepo(name, files) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-config-edges-'));
  temps.push(outer);
  const root = path.join(outer, name);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const repoWith = (pages, extra = {}) =>
  makeRepo('edge-site', { 'docs/getting-started.md': '# Hi\n', '.github/pages.json': JSON.stringify(pages), ...extra });

function withRepoEnv(value, fn) {
  const saved = process.env.GITHUB_REPOSITORY;
  if (value === undefined) delete process.env.GITHUB_REPOSITORY;
  else process.env.GITHUB_REPOSITORY = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = saved;
  }
}

test('a parse message gets the line and column of the error, whatever the message says', () => {
  const text = '{\n  "name": "x",\n  oops\n}\n';
  assert.match(parseError(text, new Error('Unexpected token o in JSON at position 19')), /^line 3 column 3: /);
  assert.match(parseError(text, new Error('Unexpected token \'o\'')), /^line 3 column 3: Unexpected token/);
});

test('a parse message for text the scan finds valid is passed on unchanged', () => {
  assert.equal(parseError('{}', new Error('odd')), 'odd');
});

const ERRORS = [
  ['', 0, 'empty text'],
  ['{', 1, 'unclosed object'],
  ['{"a":1,}', 7, 'trailing comma in an object'],
  ['[1,]', 3, 'trailing comma in an array'],
  ['[,]', 1, 'leading comma'],
  ['{"a" 1}', 5, 'missing colon'],
  ['{a:1}', 1, 'unquoted key'],
  ['"\\x"', 0, 'bad escape'],
  ['"a\nb"', 0, 'raw newline in a string'],
  ['01', 1, 'leading zero'],
  ['1.', 1, 'number with no fraction digits'],
  ['tru', 0, 'cut-off literal'],
  ['{} x', 3, 'text after the value'],
  ['\ufeff{}', 0, 'byte order mark'],
];
for (const [text, offset, what] of ERRORS) {
  test(`errorOffset finds the ${what}`, () => {
    assert.throws(() => JSON.parse(text));
    assert.equal(errorOffset(text), offset);
  });
}

const VALID = ['{}', '[]', ' {"a": [1, -2.5e3, "x\\n\\u00e9", true, false, null, {"b": {}}]} ', '"s"', '0', '-0.1E+2'];
for (const text of VALID) {
  test(`errorOffset returns -1 for valid ${JSON.stringify(text)}`, () => {
    JSON.parse(text);
    assert.equal(errorOffset(text), -1);
  });
}

test('lineColumn counts lines and columns from 1', () => {
  assert.equal(lineColumn('ab\ncd', 0), 'line 1 column 1');
  assert.equal(lineColumn('ab\ncd', 4), 'line 2 column 2');
});

test('the repo name comes from GITHUB_REPOSITORY when it is set', () => {
  withRepoEnv('octo/from-env', () => assert.equal(repoName('/x/folder-name'), 'from-env'));
});

test('the repo name falls back to the checkout folder without GITHUB_REPOSITORY', () => {
  const root = repoWith({});
  withRepoEnv(undefined, () => {
    const c = loadPagesConfig(root);
    assert.equal(c.name, 'edge-site');
    assert.equal(c.base, '/edge-site/docs/');
  });
});

test('a pages.json that is not an object fails', () => {
  const root = makeRepo('edge-site', { 'docs/getting-started.md': '#\n', '.github/pages.json': '[]' });
  assert.throws(() => loadPagesConfig(root), /object/);
});

test('an unknown field inside a nav entry fails naming it', () => {
  assert.throws(() => loadPagesConfig(repoWith({ nav: [{ label: 'A', href: '/', target: '_blank' }] })), /nav\[0\]\.target/);
});

test('an unknown field inside a sidebar entry fails naming it', () => {
  const root = repoWith({ sidebar: [{ file: 'getting-started.md', label: 'A', icon: 'x' }] });
  assert.throws(() => loadPagesConfig(root), /sidebar\[0\]\.icon/);
});

test('home_link: null fails naming home_link and object (absent is the way to have none)', () => {
  assert.throws(() => loadPagesConfig(repoWith({ home_link: null })), /home_link.*object/);
});

test('a bad homepage.json colour fails naming accent', () => {
  const root = repoWith({}, { '.github/homepage.json': JSON.stringify({ colour: 'teal' }) });
  assert.throws(() => loadPagesConfig(root), /accent/);
});

test('a homepage.json name over 40 chars fails naming name', () => {
  const root = repoWith({}, { '.github/homepage.json': JSON.stringify({ name: 'a'.repeat(41) }) });
  assert.throws(() => loadPagesConfig(root), /name.*40/);
});

test('a homepage.json that is not JSON fails naming it', () => {
  const root = repoWith({}, { '.github/homepage.json': '{' });
  assert.throws(() => loadPagesConfig(root), /homepage\.json/);
});

test('a missing default home page fails naming home_page', () => {
  const root = makeRepo('edge-site', { '.github/pages.json': '{}' });
  assert.throws(() => loadPagesConfig(root), /home_page/);
});

test('a home_page that is a folder fails naming home_page', () => {
  const root = repoWith({ home_page: 'flows' }, { 'docs/flows/npm.md': '# npm\n' });
  assert.throws(() => loadPagesConfig(root), /home_page.*not a file/);
});

test('an unpublished entry that is a symlink leaving the repo fails naming unpublished', () => {
  const root = repoWith({ unpublished: ['out.md'] });
  const outside = path.join(path.dirname(root), 'outside.md');
  fs.writeFileSync(outside, '# Out\n');
  fs.symlinkSync(outside, path.join(root, 'docs/out.md'));
  assert.throws(() => loadPagesConfig(root), /unpublished/);
});

test('a backslash in a path fails naming the field', () => {
  assert.throws(() => loadPagesConfig(repoWith({ home_page: '..\\README.md' })), /home_page/);
});

test('an uppercase extension is accepted for logo', () => {
  const root = repoWith({ logo: 'site/L.SVG' }, { 'site/L.SVG': '<svg/>' });
  assert.equal(loadPagesConfig(root).logo, 'site/L.SVG');
});
