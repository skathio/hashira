// The user's rules for docs-build's local entry point, the pages.json JSON Schema, the in-page
// anchor check, the page metadata, and the SVG and image checks:
//
// - action.yml itself calls lib/cli.js, so CI and a local run cannot drift, and the action stays
//   about 80 lines with its logic in lib/.
// - `node .github/actions/docs-build/lib/cli.js --check` validates pages.json with no install and
//   no output; `--out <dir> [--pre-build <cmd>]` is a full local build.
// - A JSON Schema for pages.json is published, pages.json may name it in `$schema`, and the
//   schema and pages-config.js agree on what they accept.
// - The built docs are checked for in-page #anchors with no matching id: each one warns, and
//   none fails the build. Heading ids follow GitHub's slug rule.
// - Each page's <head> holds og:title, og:description, og:url and a canonical link. An empty
//   pages.json description defaults to `Guides for <name>`.
// - An SVG under docs/ (public/ included) that holds <script>, an on* handler or a javascript:
//   URL is refused. The built-page check accepts .bmp images and small .ico images.
// - pages.md notes that heading ids follow GitHub's slug rule, and documents local preview,
//   with one command that copies the kit at a ref. The new test runs in _self-ci.yml.
//
// The built cases run docs-build's action.yml steps with bash the way a runner does, or cli.js,
// against fixture repos in a temporary folder; each build installs VitePress from the action's
// lockfile, so the first one needs network access once.
//
// Left to the builder, so not tested here: where the schema file lives and its name (any JSON
// Schema in the repo that describes pages.json is checked), what --check prints, the CLI's
// handling of a missing or unknown flag, the exact og:title text, the site origin in og:url,
// the wording of each error and warning, and where in the build each check runs.
//
// Run with:
//   node --test tests/docs-build/cli-schema-meta.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ACTION_DIR = path.join(REPO, '.github', 'actions', 'docs-build');
const CLI = path.join(ACTION_DIR, 'lib', 'cli.js');
const PAGES_MD = path.join(REPO, 'docs', 'flows', 'pages.md');
const SELF_CI = path.join(REPO, '.github', 'workflows', '_self-ci.yml');
const THIS_FILE = 'tests/docs-build/cli-schema-meta.test.js';
const { loadPagesConfig } = require(path.join(ACTION_DIR, 'lib', 'pages-config'));
const { checkBuiltPage } = require(path.join(ACTION_DIR, 'lib', 'html-safety'));

const BUILD_TIMEOUT = 600_000;
const OWNER_REPO = 'octo/site';
const BASE = '/site/docs/';
const SITE_NAME = 'Octo Site';
const FAKE_SHA = 'e'.repeat(40);
const ACTION_LINE_LIMIT = 85;

const temps = [];
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

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

// A fresh caller repo, named site, in a folder of its own next to an empty runner temp folder.
function fixtureRepo(files) {
  const outer = tempDir('docs-cli-');
  const workspace = writeTree(path.join(outer, 'site'), files);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  fs.mkdirSync(path.join(outer, 'tmp'));
  return { workspace, outer, tmp: path.join(outer, 'tmp') };
}

const pagesJson = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
const outputOf = (run) => `${run.stdout ?? ''}\n${run.stderr ?? ''}${run.error ? `\n${run.error.message}` : ''}`;

// Every file under dir, relative, so a run that writes or changes nothing leaves the same list.
function listFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)))
    .sort();
}

// ---------------------------------------------------------------- running action.yml

function loadYaml(file) {
  const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))';
  const run = spawnSync('python3', ['-c', py, file], { encoding: 'utf8' });
  assert.equal(run.status, 0, `could not read ${file}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

const ACTION_FILE = path.join(ACTION_DIR, 'action.yml');
const runSteps = () => (loadYaml(ACTION_FILE).runs?.steps ?? []).filter((s) => s.run);

function githubContext(ctx) {
  return {
    action_path: ACTION_DIR, workspace: ctx.workspace, sha: FAKE_SHA, workflow_sha: FAKE_SHA, action_ref: 'v3',
    action_repository: 'skathio/hashira', repository: OWNER_REPO, repository_owner: 'octo', ref: 'refs/heads/main',
    ref_name: 'main', server_url: 'https://github.com', event_name: 'push',
  };
}

function lookup(expr, ctx) {
  const [scope, ...keys] = expr.trim().split('.');
  const scopes = { inputs: ctx.inputs, github: githubContext(ctx), runner: { temp: ctx.tmp, os: 'Linux' }, steps: ctx.steps, env: {} };
  return keys.reduce((obj, key) => obj?.[key], scopes[scope]) ?? '';
}

const substitute = (text, ctx) => String(text ?? '').replace(/\$\{\{([^}]*)\}\}/g, (_, expr) => lookup(expr, ctx));

// The `if:` forms a composite action uses: always(), failure(), success() and a comparison of a
// context value with a quoted string. Anything else runs while nothing failed.
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
    GITHUB_REF_NAME: 'main', GITHUB_SHA: FAKE_SHA, GITHUB_OUTPUT: outputFile, GITHUB_ENV: path.join(ctx.tmp, 'env'),
    GITHUB_STEP_SUMMARY: path.join(ctx.tmp, 'summary'), RUNNER_TEMP: ctx.tmp, CI: 'true',
  };
}

function readOutputs(file) {
  if (!fs.existsSync(file)) return {};
  const pairs = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.match(/^([\w-]+)=(.*)$/)).filter(Boolean);
  return Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
}

function runStep(step, ctx, index) {
  const outputFile = path.join(ctx.tmp, `output-${index}`);
  const stepEnv = Object.entries(step.env ?? {}).map(([k, v]) => [k, substitute(v, ctx)]);
  const env = { ...runnerEnv(ctx, outputFile), ...Object.fromEntries(stepEnv) };
  const cwd = path.resolve(ctx.workspace, substitute(step['working-directory'], ctx));
  const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', substitute(step.run, ctx)], { cwd, env, encoding: 'utf8', timeout: BUILD_TIMEOUT });
  if (step.id) ctx.steps[step.id] = { outputs: readOutputs(outputFile) };
  return run;
}

function inputsWithDefaults(given) {
  const spec = loadYaml(ACTION_FILE);
  return { ...Object.fromEntries(Object.entries(spec.inputs ?? {}).map(([name, def]) => [name, def.default ?? ''])), ...given };
}

// Runs action.yml's `run:` steps in order, as a runner does; the status is the first failing step's.
function runAction(repo, given = {}) {
  const ctx = { ...repo, inputs: inputsWithDefaults(given), steps: {}, failed: false };
  const result = { status: 0, stdout: '', stderr: '' };
  runSteps().forEach((step, i) => {
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

// ---------------------------------------------------------------- running cli.js locally

// A local shell: none of the runner's GITHUB_* files, temp files kept in the repo's temp folder.
function localEnv(repo, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GITHUB_') && !k.startsWith('RUNNER_') && k !== 'NODE_TEST_CONTEXT' && k !== 'CI'));
  return { ...env, GITHUB_REPOSITORY: OWNER_REPO, TMPDIR: repo.tmp, TMP: repo.tmp, TEMP: repo.tmp, ...extra };
}

function runCli(repo, args, extraEnv) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo.workspace, env: localEnv(repo, extraEnv), encoding: 'utf8', timeout: BUILD_TIMEOUT });
}

// A PATH that holds node and nothing else, so neither npm nor any other installer can run.
function nodeOnlyPath(repo) {
  const bin = path.join(repo.outer, 'node-only-bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  return bin;
}

// ---------------------------------------------------------------- images and SVGs

// A 24-bit BMP of w x h pixels.
function bmp(w, h) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * h, 34);
  return buf;
}

// A 1 x 1 32-bit ICO, far below Vite's 4 KB inline limit.
function ico() {
  const image = Buffer.alloc(40 + 4 + 4);
  image.writeUInt32LE(40, 0);
  image.writeInt32LE(1, 4);
  image.writeInt32LE(2, 8);
  image.writeUInt16LE(1, 12);
  image.writeUInt16LE(32, 14);
  const head = Buffer.alloc(6 + 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head.writeUInt8(1, 6);
  head.writeUInt8(1, 7);
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(image.length, 14);
  head.writeUInt32LE(head.length, 18);
  return Buffer.concat([head, image]);
}

const svg = (inner, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 8 8"${attrs}>${inner}</svg>\n`;
const SAFE_SVG = svg('<title>Onboarding map</title><path d="M0 0h8v8z" fill="none" stroke="#000" stroke-linejoin="round"/><text x="1" y="6">onboarding</text>');

// ---------------------------------------------------------------- the builds

const GUIDE_MD = [
  '# Guide & co', '',
  '- [first](#first-steps)',
  '- [hello](#hello-world--co)',
  '- [nowhere](#no-such-heading)', '',
  '## First steps', '',
  'Text.', '',
  '## Hello, World & Co.', '',
  'More.', '',
].join('\n');

const OTHER_MD = '# Other page\n\n[gone](#missing-part)\n\n[guide part](guide.md#first-steps)\n';

const IMAGES_MD = [
  '# Images', '',
  '![small icon](./img/small.ico)', '',
  '![small bitmap](./img/small.bmp)', '',
  '![big bitmap](./img/big.bmp)', '',
  '![safe drawing](./img/safe.svg)', '',
  '![public drawing](/safe-public.svg)', '',
].join('\n');

const DOCS = {
  'docs/getting-started.md': '# Welcome\n\nHello.\n',
  'docs/guide.md': GUIDE_MD,
  'docs/other.md': OTHER_MD,
};

const IMAGE_FILES = {
  'docs/images.md': IMAGES_MD,
  'docs/img/small.ico': ico(),
  'docs/img/small.bmp': bmp(2, 2),
  'docs/img/big.bmp': bmp(64, 64),
  'docs/img/safe.svg': SAFE_SVG,
  'docs/public/safe-public.svg': SAFE_SVG,
};

const PRE_BUILD = 'mkdir -p "$DOCS_STAGE/gen" && printf "# Generated page\\n\\nMade.\\n" > "$DOCS_STAGE/gen/made.md"';
const SPECIAL_DESCRIPTION = 'Docs & "tools" <here>';

const builds = {};

test.before(() => {
  const main = fixtureRepo({ '.github/pages.json': pagesJson({ name: SITE_NAME }), ...DOCS });
  builds.main = { ...main, run: runAction(main) };
  const images = fixtureRepo({ '.github/pages.json': pagesJson({ name: SITE_NAME }), ...DOCS, ...IMAGE_FILES });
  builds.images = { ...images, run: runAction(images) };
  const described = fixtureRepo({ '.github/pages.json': pagesJson({ name: SITE_NAME, description: SPECIAL_DESCRIPTION }), ...DOCS });
  builds.described = { ...described, run: runAction(described) };
  const local = fixtureRepo({ '.github/pages.json': pagesJson({ $schema: 'https://example.com/pages.schema.json', name: SITE_NAME, description: '' }), ...DOCS });
  builds.local = { ...local, run: runCli(local, ['--out', 'out/site', '--pre-build', PRE_BUILD]) };
});

function builtDir(name) {
  const b = builds[name];
  assert.equal(b.run.status, 0, `the ${name} build failed:\n${outputOf(b.run)}`);
  return name === 'local' ? path.join(b.workspace, 'out', 'site') : path.join(b.workspace, 'artifacts', 'pages', 'docs');
}

function readBuilt(name, rel) {
  const out = builtDir(name);
  const file = [`${rel}.html`, path.join(rel, 'index.html'), rel].map((c) => path.join(out, c)).find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  assert.ok(file, `no built page ${rel} in ${out}`);
  return fs.readFileSync(file, 'utf8');
}

// ---------------------------------------------------------------- reading the HTML

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntity(match, body) {
  if (body[0] !== '#') return ENTITIES[body.toLowerCase()] ?? match;
  const hex = body[1].toLowerCase() === 'x';
  return String.fromCodePoint(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
}

const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity);
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function attrs(text) {
  return Object.fromEntries([...text.matchAll(ATTR)].map((m) => [m[1].toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? '')]));
}

const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b((?:[^>"']|"[^"]*"|'[^']*')*)>`, 'gi'))].map((m) => attrs(m[1]));
const headOf = (html) => html.slice(0, Math.max(html.indexOf('</head>'), 0));

// The content of each <meta> in the head whose property or name is `key`.
function metaValues(html, key) {
  return tags(headOf(html), 'meta').filter((a) => a.property === key || a.name === key).map((a) => a.content);
}

function oneMeta(html, key) {
  const values = metaValues(html, key);
  assert.equal(values.length, 1, `the head holds ${values.length} ${key} tags, not 1`);
  return values[0];
}

function canonicals(html) {
  return tags(headOf(html), 'link').filter((a) => (a.rel ?? '').split(/\s+/).includes('canonical')).map((a) => a.href);
}

// A page URL's path with any index.html or .html ending dropped.
const pagePath = (url) => new URL(url).pathname.replace(/index\.html$/, '').replace(/\.html$/, '');
const warnings = (run) => outputOf(run).split('\n').filter((l) => l.includes('::warning'));

// ---------------------------------------------------------------- action.yml and the CLI

test('action.yml calls lib/cli.js, so CI and a local run go through the same entry point', () => {
  assert.ok(fs.existsSync(CLI), `${path.relative(REPO, CLI)} does not exist`);
  assert.ok(runSteps().some((s) => /lib\/cli\.js\b/.test(s.run)), 'no run step of action.yml calls lib/cli.js');
});

test(`action.yml stays about 80 lines (at most ${ACTION_LINE_LIMIT}), with its logic in lib/`, () => {
  const lines = fs.readFileSync(ACTION_FILE, 'utf8').replace(/\n$/, '').split('\n').length;
  assert.ok(lines <= ACTION_LINE_LIMIT, `action.yml has ${lines} lines`);
});

test('--check passes a valid pages.json with no install and writes nothing', () => {
  const repo = fixtureRepo({ '.github/pages.json': pagesJson({ name: SITE_NAME, sidebar: [{ file: 'guide.md', label: 'Guide' }] }), ...DOCS });
  const before = listFiles(repo.workspace);
  const run = runCli(repo, ['--check'], { PATH: nodeOnlyPath(repo) });
  assert.equal(run.status, 0, outputOf(run));
  assert.deepEqual(listFiles(repo.workspace), before, 'the repo changed');
  assert.deepEqual(listFiles(repo.tmp), [], 'files were written to the temp folder');
  assert.ok(!fs.existsSync(path.join(repo.workspace, 'artifacts')), 'a build output was written');
});

test('--check fails on an invalid pages.json, naming the field, and writes nothing', () => {
  const repo = fixtureRepo({ '.github/pages.json': pagesJson({ name: SITE_NAME, bogus: 1 }), ...DOCS });
  const before = listFiles(repo.workspace);
  const run = runCli(repo, ['--check'], { PATH: nodeOnlyPath(repo) });
  assert.notEqual(run.status, 0, 'an unknown field passed --check');
  assert.match(outputOf(run), /bogus/);
  assert.deepEqual(listFiles(repo.workspace), before);
});

test('--check fails when .github/pages.json is missing', () => {
  const repo = fixtureRepo(DOCS);
  const run = runCli(repo, ['--check'], { PATH: nodeOnlyPath(repo) });
  assert.notEqual(run.status, 0, 'a repo with no pages.json passed --check');
  assert.match(outputOf(run), /pages\.json/);
});

test('--check accepts a pages.json that names its schema in $schema', () => {
  const repo = fixtureRepo({ '.github/pages.json': pagesJson({ $schema: 'https://example.com/pages.schema.json', name: SITE_NAME }), ...DOCS });
  const run = runCli(repo, ['--check'], { PATH: nodeOnlyPath(repo) });
  assert.equal(run.status, 0, outputOf(run));
});

test('--out builds the whole site locally, with --pre-build output published', () => {
  const out = builtDir('local');
  assert.ok(fs.existsSync(path.join(out, 'index.html')), 'no docs index was built');
  assert.match(readBuilt('local', 'guide'), /First steps/);
  assert.match(readBuilt('local', 'gen/made'), /Generated page/);
});

test('--out refuses a folder that already exists, and keeps its contents', () => {
  const repo = fixtureRepo({ '.github/pages.json': pagesJson({ name: SITE_NAME }), ...DOCS, 'out/site/keep.txt': 'mine\n' });
  const run = runCli(repo, ['--out', 'out/site']);
  assert.notEqual(run.status, 0, 'an existing --out folder was written over');
  assert.equal(fs.readFileSync(path.join(repo.workspace, 'out', 'site', 'keep.txt'), 'utf8'), 'mine\n');
});

// ---------------------------------------------------------------- the JSON Schema

const SKIP_DIRS = new Set(['.git', 'node_modules', 'artifacts', '.somi', '.claude', '.playwright-mcp']);

// Every JSON Schema in the repo that describes pages.json: a .json file naming a json-schema.org
// dialect in $schema whose properties include home_page and sidebar.
const skipped = (name) => SKIP_DIRS.has(name) || name.startsWith('${');

function jsonFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !skipped(e.name));
  return entries.flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return jsonFiles(full);
    return e.name.endsWith('.json') ? [full] : [];
  });
}

const pagesSchemas = () => jsonFiles(REPO).filter(isPagesSchema);

function isPagesSchema(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  return /json-schema\.org/.test(String(data?.$schema ?? '')) && Boolean(data.properties?.home_page && data.properties?.sidebar);
}

// A small JSON Schema validator for the keywords a schema of this size uses. A keyword it does
// not know fails the test by name rather than being skipped, so no rule is judged by accident.
const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'default', 'examples', 'markdownDescription', 'deprecated', 'readOnly', 'writeOnly', 'format', '$defs', 'definitions', 'then', 'else']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const TYPES = {
  object: isObject, array: Array.isArray, string: (v) => typeof v === 'string', boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null, number: (v) => typeof v === 'number', integer: (v) => Number.isInteger(v),
};

function regex(pattern) {
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return new RegExp(pattern);
  }
}

function resolveRef(ref, root) {
  assert.ok(ref.startsWith('#'), `the test's validator follows only local $refs, got ${ref}`);
  return ref.slice(1).split('/').filter(Boolean).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((s, key) => s?.[key], root);
}

function coveredKey(schema, key) {
  return Object.hasOwn(schema.properties ?? {}, key) || Object.keys(schema.patternProperties ?? {}).some((p) => regex(p).test(key));
}

const forObject = (check) => (arg, v, s, root) => !isObject(v) || check(arg, v, s, root);
const forArray = (check) => (arg, v, s, root) => !Array.isArray(v) || check(arg, v, s, root);
const forString = (check) => (arg, v) => typeof v !== 'string' || check(arg, v);
const forNumber = (check) => (arg, v) => typeof v !== 'number' || check(arg, v);

const KEYWORDS = {
  type: (t, v) => [].concat(t).some((name) => TYPES[name](v)),
  enum: (list, v) => list.some((x) => JSON.stringify(x) === JSON.stringify(v)),
  const: (x, v) => JSON.stringify(x) === JSON.stringify(v),
  $ref: (ref, v, s, root) => valid(resolveRef(ref, root), v, root),
  allOf: (list, v, s, root) => list.every((sub) => valid(sub, v, root)),
  anyOf: (list, v, s, root) => list.some((sub) => valid(sub, v, root)),
  oneOf: (list, v, s, root) => list.filter((sub) => valid(sub, v, root)).length === 1,
  not: (sub, v, s, root) => !valid(sub, v, root),
  if: (sub, v, s, root) => {
    const branch = valid(sub, v, root) ? s.then : s.else;
    return branch === undefined || valid(branch, v, root);
  },
  properties: forObject((props, v, s, root) => Object.entries(props).every(([k, sub]) => !Object.hasOwn(v, k) || valid(sub, v[k], root))),
  patternProperties: forObject((pats, v, s, root) => Object.entries(pats).every(([p, sub]) => Object.keys(v).filter((k) => regex(p).test(k)).every((k) => valid(sub, v[k], root)))),
  additionalProperties: forObject((sub, v, s, root) => Object.keys(v).filter((k) => !coveredKey(s, k)).every((k) => valid(sub, v[k], root))),
  propertyNames: forObject((sub, v, s, root) => Object.keys(v).every((k) => valid(sub, k, root))),
  required: forObject((req, v) => req.every((k) => Object.hasOwn(v, k))),
  minProperties: forObject((n, v) => Object.keys(v).length >= n),
  maxProperties: forObject((n, v) => Object.keys(v).length <= n),
  dependentRequired: forObject((deps, v) => Object.entries(deps).every(([k, req]) => !Object.hasOwn(v, k) || req.every((r) => Object.hasOwn(v, r)))),
  items: forArray((sub, v, s, root) => v.every((x) => valid(sub, x, root))),
  minItems: forArray((n, v) => v.length >= n),
  maxItems: forArray((n, v) => v.length <= n),
  uniqueItems: forArray((on, v) => !on || new Set(v.map((x) => JSON.stringify(x))).size === v.length),
  minLength: forString((n, v) => [...v].length >= n),
  maxLength: forString((n, v) => [...v].length <= n),
  pattern: forString((p, v) => regex(p).test(v)),
  minimum: forNumber((n, v) => v >= n),
  maximum: forNumber((n, v) => v <= n),
};

function valid(schema, value, root) {
  if (typeof schema === 'boolean') return schema;
  assert.ok(isObject(schema), `a sub-schema is not an object or a boolean: ${JSON.stringify(schema)}`);
  return Object.entries(schema).every(([key, arg]) => {
    if (ANNOTATIONS.has(key)) return true;
    assert.ok(KEYWORDS[key], `the schema uses the keyword ${key}, which this test's validator does not know`);
    return KEYWORDS[key](arg, value, schema, root);
  });
}

// A repo where every file the samples name exists, so pages-config.js judges only their shape.
const SCHEMA_REPO_FILES = {
  'docs/getting-started.md': '# Start\n', 'docs/guide.md': '# Guide\n', 'docs/guide.txt': 'text\n', 'docs/api/a.md': '# A\n',
  'site/mark.svg': SAFE_SVG, 'site/mark.gif': 'GIF89a', 'site/theme.css': ':root {}\n', 'site/theme.txt': 'x\n',
};

const page = (file = 'guide.md', label = 'Guide') => ({ file, label });
const group = (depth) => (depth === 0 ? page() : { label: `Level ${depth}`, items: [group(depth - 1)] });
const link = (label = 'Blog', href = 'https://example.com/') => ({ label, href });
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));

const SAMPLES = {
  'an empty object': {},
  '$schema alone': { $schema: 'https://example.com/pages.schema.json' },
  'every field': {
    $schema: 'https://example.com/pages.schema.json', name: 'Octo', description: 'About.', base: '/octo/docs/', home_page: 'guide.md',
    sidebar: [page(), { label: 'API', dir: 'api/', collapsed: true }, { label: 'Group', items: [page()], collapsed: false }],
    unpublished: ['getting-started.md'], nav: [link(), link('Top', '#top'), link('Up', '../up/'), link('Here', './x/'), link('Root', '/r/')],
    home_link: link('Home', 'https://octo.example/'), accent: '#abc', accent_dark: '#AABBCC', logo: 'site/mark.svg', theme_css: 'site/theme.css',
  },
  'a root array': [],
  'an unknown field': { bogus: 1 },
  'a 40-character name': { name: 'n'.repeat(40) },
  'a 41-character name': { name: 'n'.repeat(41) },
  'an empty name': { name: '' },
  'a number as name': { name: 5 },
  'an empty description': { description: '' },
  'a 200-character description': { description: 'd'.repeat(200) },
  'a 201-character description': { description: 'd'.repeat(201) },
  'a null description': { description: null },
  "a base without a leading '/'": { base: 'x/' },
  "a base without a trailing '/'": { base: '/x' },
  "a base with a '..' segment": { base: '/../' },
  'a .txt home_page': { home_page: 'guide.txt' },
  'no nav entries': { nav: [] },
  '8 nav entries': { nav: many(8, (i) => link(`L${i}`)) },
  '9 nav entries': { nav: many(9, (i) => link(`L${i}`)) },
  'a 30-character nav label': { nav: [link('l'.repeat(30))] },
  'a 31-character nav label': { nav: [link('l'.repeat(31))] },
  'an empty nav label': { nav: [link('')] },
  'a nav entry with an unknown field': { nav: [{ ...link(), icon: 'x' }] },
  'nav as an object': { nav: link() },
  'a javascript: href': { nav: [link('X', 'javascript:alert(1)')] },
  'a mailto: href': { nav: [link('X', 'mailto:a@b.c')] },
  'an href with a backslash': { nav: [link('X', '/\\evil.example/')] },
  'a home_link without href': { home_link: { label: 'Home' } },
  'a null home_link': { home_link: null },
  'a #rgb accent': { accent: '#abc' },
  'a #rgba accent': { accent: '#abcd' },
  'a named accent': { accent: 'green' },
  'a 5-digit accent_dark': { accent_dark: '#12345' },
  'a .gif logo': { logo: 'site/mark.gif' },
  'a .txt theme_css': { theme_css: 'site/theme.txt' },
  'no sidebar entries': { sidebar: [] },
  'a sidebar page with a 60-character label': { sidebar: [page('guide.md', 'l'.repeat(60))] },
  'a sidebar page with a 61-character label': { sidebar: [page('guide.md', 'l'.repeat(61))] },
  'a .txt sidebar file': { sidebar: [page('guide.txt')] },
  'a sidebar entry with file and dir': { sidebar: [{ ...page(), dir: 'api/' }] },
  'a sidebar entry with no file, items or dir': { sidebar: [{ label: 'Nothing' }] },
  'a group with no items': { sidebar: [{ label: 'Empty', items: [] }] },
  'groups 3 levels deep': { sidebar: [group(3)] },
  'groups 4 levels deep': { sidebar: [group(4)] },
  'a string collapsed': { sidebar: [{ label: 'API', dir: 'api/', collapsed: 'yes' }] },
  '100 sidebar entries': { sidebar: many(100, () => page()) },
  '101 sidebar entries': { sidebar: many(101, () => page()) },
  '100 unpublished paths': { unpublished: many(100, (i) => `u${i}.md`) },
  '101 unpublished paths': { unpublished: many(101, (i) => `u${i}.md`) },
  "an unpublished path with '..'": { unpublished: ['../x.md'] },
  'an absolute unpublished path': { unpublished: ['/x.md'] },
};

function configAccepts(sample) {
  const root = writeTree(path.join(tempDir('docs-schema-'), 'site'), { ...SCHEMA_REPO_FILES, '.github/pages.json': JSON.stringify(sample) });
  try {
    loadPagesConfig(root);
    return true;
  } catch {
    return false;
  }
}

test('a JSON Schema for pages.json is in the repo', () => {
  assert.ok(pagesSchemas().length > 0, 'no .json file with a json-schema.org $schema describes pages.json (home_page, sidebar)');
});

test('the pages.json schema and pages-config.js accept and refuse the same files', () => {
  const schemas = pagesSchemas();
  assert.ok(schemas.length > 0, 'no pages.json schema found');
  assert.equal(configAccepts(SAMPLES['every field']), true, 'pages-config.js refuses the sample with every field');
  for (const file of schemas) {
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    const disagree = Object.entries(SAMPLES)
      .map(([what, sample]) => ({ what, config: configAccepts(sample), schema: valid(schema, sample, schema) }))
      .filter((r) => r.config !== r.schema)
      .map((r) => `${r.what}: pages-config.js ${r.config ? 'accepts' : 'refuses'}, the schema ${r.schema ? 'accepts' : 'refuses'}`);
    assert.deepEqual(disagree, [], `${path.relative(REPO, file)} disagrees with pages-config.js`);
  }
});

// ---------------------------------------------------------------- the in-page anchor check

test('an in-page #anchor with no matching id warns and the build still passes', () => {
  builtDir('main');
  const lines = warnings(builds.main.run);
  assert.ok(lines.some((l) => l.includes('no-such-heading')), `no warning names #no-such-heading:\n${lines.join('\n')}`);
  assert.ok(lines.some((l) => l.includes('missing-part')), `no warning names #missing-part:\n${lines.join('\n')}`);
});

test("in-page #anchors that match a heading's GitHub slug do not warn", () => {
  builtDir('main');
  const lines = warnings(builds.main.run);
  for (const id of ['first-steps', 'hello-world--co']) {
    assert.ok(!lines.some((l) => l.includes(id)), `#${id} has a matching id but warned:\n${lines.join('\n')}`);
  }
  assert.match(readBuilt('main', 'guide'), /id="hello-world--co"/);
});

// ---------------------------------------------------------------- og and canonical tags

test('each page head holds og:title, og:description, og:url and one canonical link for that page', () => {
  for (const [rel, h1] of [['index', 'Welcome'], ['guide', 'Guide & co'], ['other', 'Other page']]) {
    const html = readBuilt('main', rel);
    assert.ok(oneMeta(html, 'og:title').includes(h1), `${rel}: og:title does not name ${h1}`);
    assert.ok(oneMeta(html, 'og:description').length > 0, `${rel}: og:description is empty`);
    const url = oneMeta(html, 'og:url');
    const links = canonicals(html);
    assert.equal(links.length, 1, `${rel}: ${links.length} canonical links`);
    assert.equal(links[0], url, `${rel}: canonical and og:url differ`);
    assert.equal(new URL(url).protocol, 'https:', `${rel}: og:url is not an absolute https URL`);
    assert.equal(pagePath(url), rel === 'index' ? BASE : `${BASE}${rel}`, `${rel}: og:url names another page`);
  }
});

test('a left-out description defaults to "Guides for <name>" in the description and og:description', () => {
  const html = readBuilt('main', 'guide');
  assert.equal(oneMeta(html, 'description'), `Guides for ${SITE_NAME}`);
  assert.equal(oneMeta(html, 'og:description'), `Guides for ${SITE_NAME}`);
});

test('an empty description defaults to "Guides for <name>" too', () => {
  const html = readBuilt('local', 'guide');
  assert.equal(oneMeta(html, 'description'), `Guides for ${SITE_NAME}`);
  assert.equal(oneMeta(html, 'og:description'), `Guides for ${SITE_NAME}`);
});

test('a given description reaches og:description escaped, as written', () => {
  const html = readBuilt('described', 'guide');
  assert.equal(oneMeta(html, 'description'), SPECIAL_DESCRIPTION);
  assert.equal(oneMeta(html, 'og:description'), SPECIAL_DESCRIPTION);
  assert.ok(!headOf(html).includes('<here>'), 'the description reached the head unescaped');
});

// ---------------------------------------------------------------- SVGs and images

const UNSAFE_SVGS = {
  'a <script> element': ['docs/img/scripted.svg', svg('<script>alert(1)</script><rect width="8" height="8"/>')],
  'an onload handler, in public/': ['docs/public/handler.svg', svg('<rect width="8" height="8"/>', ' onload="alert(1)"')],
  'an onclick handler on a child': ['docs/img/click.svg', svg('<rect width="8" height="8" onclick="alert(1)"/>')],
  'a javascript: href': ['docs/img/jslink.svg', svg('<a href="javascript:alert(1)"><rect width="8" height="8"/></a>')],
  'a JavaScript: xlink:href with spaces': ['docs/public/xlink.svg', svg('<a xlink:href="  JavaScript:alert(1)"><rect width="8" height="8"/></a>')],
};

for (const [what, [rel, body]] of Object.entries(UNSAFE_SVGS)) {
  test(`an SVG under docs/ with ${what} fails the build, naming the file`, () => {
    const repo = fixtureRepo({ '.github/pages.json': pagesJson({ name: SITE_NAME }), ...DOCS, [rel]: body });
    const run = runAction(repo);
    assert.notEqual(run.status, 0, `${rel} was published`);
    assert.match(outputOf(run), new RegExp(path.posix.basename(rel).replace('.', '\\.')));
  });
}

test('a local --out build refuses an unsafe SVG as the action does', () => {
  const [rel, body] = UNSAFE_SVGS['a <script> element'];
  const repo = fixtureRepo({ '.github/pages.json': pagesJson({ name: SITE_NAME }), ...DOCS, [rel]: body });
  const run = runCli(repo, ['--out', 'out/site']);
  assert.notEqual(run.status, 0, `${rel} was published by the local build`);
  assert.match(outputOf(run), /scripted\.svg/);
});

test('SVGs with no script, handler or javascript: URL are published, in public/ too', () => {
  const out = builtDir('images');
  assert.ok(fs.existsSync(path.join(out, 'safe-public.svg')), 'docs/public/safe-public.svg was not published');
  const imgs = tags(readBuilt('images', 'images'), 'img');
  for (const alt of ['safe drawing', 'public drawing']) assert.ok(imgs.some((a) => a.alt === alt && a.src), `no <img> for ${alt}`);
});

test('a page with a small .ico, a small .bmp and a large .bmp image builds and shows them', () => {
  const imgs = tags(readBuilt('images', 'images'), 'img');
  for (const alt of ['small icon', 'small bitmap', 'big bitmap']) {
    assert.ok(imgs.some((a) => a.alt === alt && a.src), `no <img> with a src for ${alt}`);
  }
});

test('the built-page check accepts a .bmp file under the docs base', () => {
  const html = `<html><head></head><body><img src="${BASE}assets/big.Ab12Cd34.bmp" alt="b"></body></html>`;
  assert.deepEqual(checkBuiltPage(html, { base: BASE, inlineScripts: [] }), []);
});

test('the built-page check still refuses an <img> that is not an image', () => {
  for (const src of ['data:text/html,<b>x</b>', `${BASE}assets/page.html`, 'javascript:alert(1)']) {
    const html = `<html><head></head><body><img src="${src}" alt="x"></body></html>`;
    assert.notDeepEqual(checkBuiltPage(html, { base: BASE, inlineScripts: [] }), [], `${src} passed the built-page check`);
  }
});

// ---------------------------------------------------------------- pages.md and CI

const paragraphs = () => fs.readFileSync(PAGES_MD, 'utf8').split(/\n\s*\n/);

test("pages.md has a migration note that heading ids follow GitHub's slug rule", () => {
  assert.ok(paragraphs().some((p) => /migrat/i.test(p) && /slug/i.test(p) && /GitHub/.test(p)), 'no pages.md paragraph is a migration note on GitHub slugs');
});

test('pages.md documents local preview with cli.js --check and --out', () => {
  const text = fs.readFileSync(PAGES_MD, 'utf8');
  assert.match(text, /lib\/cli\.js --check/);
  assert.match(text, /lib\/cli\.js --out /);
});

test('pages.md gives one command that copies the kit at a ref', () => {
  const lines = fs.readFileSync(PAGES_MD, 'utf8').split('\n');
  assert.ok(lines.some((l) => /skathio\/hashira/.test(l) && /site-kit\/kit/.test(l)), 'no pages.md line copies site-kit/kit from skathio/hashira');
});

test('_self-ci.yml runs this test file', () => {
  assert.ok(fs.readFileSync(SELF_CI, 'utf8').includes(THIS_FILE), `${THIS_FILE} is not run by _self-ci.yml`);
});
