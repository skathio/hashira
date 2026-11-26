// Defences added on top of the docs-build rules: homepage.json must be a small JSON object,
// a header href holds no backslash or control character, the built docs drop markdown-it-attrs
// attributes and a front matter `head:`, a config error is one annotation line, and the pages
// flow guide says to protect the `production` environment before the first run.
//
// The two build cases run the action's steps against a fixture repo, so they install VitePress
// from hashira's lockfile and need network access once.
//
// Run with:
//   node --test tests/docs-build/config-hardening.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ACTION_DIR = path.join(REPO, '.github', 'actions', 'docs-build');
const { loadPagesConfig } = require(path.join(ACTION_DIR, 'lib', 'pages-config'));

const temps = [];
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function makeRepo(files) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-build-hardening-'));
  temps.push(outer);
  const root = path.join(outer, 'site');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const repoWith = (pages, extra = {}) =>
  makeRepo({ 'docs/getting-started.md': '# Hi\n', '.github/pages.json': JSON.stringify(pages), ...extra });

// ---------- homepage.json ----------

test('a homepage.json that holds a list fails instead of being ignored', () => {
  const root = repoWith({}, { '.github/homepage.json': '["x"]' });
  assert.throws(() => loadPagesConfig(root), /homepage\.json: must hold a JSON object, got array/);
});

test('a homepage.json that holds a string or null fails naming the type', () => {
  for (const [body, type] of [['"x"', 'string'], ['null', 'null'], ['3', 'number']]) {
    const root = repoWith({}, { '.github/homepage.json': body });
    assert.throws(() => loadPagesConfig(root), new RegExp(`homepage\\.json: must hold a JSON object, got ${type}`), body);
  }
});

test('a homepage.json over 64 KB fails before it is parsed', () => {
  const big = JSON.stringify({ name: 'x', pad: 'a'.repeat(64 * 1024) });
  const root = repoWith({}, { '.github/homepage.json': big });
  assert.throws(() => loadPagesConfig(root), /homepage\.json: is \d+ bytes; the limit is 64 KB/);
});

// ---------- header hrefs ----------

test('a nav href with a backslash fails: a browser reads /\\host as another host', () => {
  const root = repoWith({ nav: [{ label: 'x', href: '/\\evil.example/x' }] });
  assert.throws(() => loadPagesConfig(root), /nav\[0\]\.href must not contain a backslash/);
});

test('a home_link href with a control character or DEL fails', () => {
  for (const href of ['/a\nb', '/a\tb', 'https://x.example/\u0000', '#a\u007f', '/\r/evil.example']) {
    const root = repoWith({ home_link: { label: 'x', href } });
    assert.throws(() => loadPagesConfig(root), /home_link\.href must not contain a backslash or a control character/, JSON.stringify(href));
  }
});

test('ordinary hrefs still pass', () => {
  const nav = ['https://x.example/a?b=1#c', '/up/', './blog/', '../x/', '#flows'].map((href) => ({ label: 'x', href }));
  assert.equal(loadPagesConfig(repoWith({ nav })).nav.length, 5);
});

// ---------- the action's steps, run the way a runner does ----------

function actionSteps() {
  const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))';
  const run = spawnSync('python3', ['-c', py, path.join(ACTION_DIR, 'action.yml')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

function lookup(expr, ctx) {
  const [scope, ...keys] = expr.trim().split('.');
  const scopes = { inputs: ctx.inputs, github: { action_path: ACTION_DIR }, steps: ctx.steps };
  return keys.reduce((obj, key) => obj?.[key], scopes[scope]) ?? '';
}

const substitute = (text, ctx) => String(text ?? '').replace(/\$\{\{([^}]*)\}\}/g, (_, expr) => lookup(expr, ctx));

function readOutputs(file) {
  if (!fs.existsSync(file)) return {};
  const pairs = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.match(/^([\w-]+)=(.*)$/)).filter(Boolean);
  return Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
}

function runStep(step, ctx, index) {
  const output = path.join(ctx.outer, `output-${index}`);
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GITHUB_') && k !== 'NODE_TEST_CONTEXT'));
  const env = {
    ...base, GITHUB_REPOSITORY: 'octo/site', GITHUB_SERVER_URL: 'https://github.com', GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: path.join(ctx.outer, 'summary'), RUNNER_TEMP: ctx.outer,
    ...Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, substitute(v, ctx)])),
  };
  const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', substitute(step.run, ctx)], { cwd: ctx.workspace, env, encoding: 'utf8', timeout: 600_000 });
  if (step.id) ctx.steps[step.id] = { outputs: readOutputs(output) };
  return run;
}

// Runs action.yml's run steps in order and stops at the first failure.
function runAction(workspace, inputs) {
  const spec = actionSteps();
  const defaults = Object.fromEntries(Object.entries(spec.inputs).map(([name, def]) => [name, def.default ?? '']));
  const ctx = { outer: path.dirname(workspace), workspace, inputs: { ...defaults, ...inputs }, steps: {} };
  const result = { status: 0, stderr: '' };
  for (const [i, step] of spec.runs.steps.entries()) {
    if (step.if && /pre_build_command/.test(step.if) && !ctx.inputs.pre_build_command) continue;
    const run = runStep(step, ctx, i);
    result.stderr += `${run.stderr ?? ''}${run.error ? `\n${run.error.message}` : ''}`;
    if (run.status !== 0) return { ...result, status: run.status ?? 1 };
  }
  return result;
}

// ---------- the built docs ----------

const ATTRS_MD = [
  '# Attrs', '',
  'para {onmouseover="alert(2)"}', '',
  '[a link](https://x.example/){onclick="alert(3)"}', '',
].join('\n');

test('the build drops markdown-it-attrs attributes and a front matter head', () => {
  const workspace = makeRepo({
    '.github/pages.json': '{}\n',
    'docs/getting-started.md': `---\nhead: [[script, {}, "window.FM_HEAD=1"]]\n---\n\n${ATTRS_MD}`,
  });
  const run = runAction(workspace, {});
  assert.equal(run.status, 0, run.stderr);
  const html = fs.readFileSync(path.join(workspace, 'artifacts', 'pages', 'docs', 'index.html'), 'utf8');
  // As an attribute the value keeps its quotes; as text they are &quot;.
  assert.doesNotMatch(html, /\sonmouseover="/);
  assert.doesNotMatch(html, /\sonclick="/);
  assert.doesNotMatch(html, /FM_HEAD/);
  assert.match(html, /para \{onmouseover=&quot;alert\(2\)&quot;\}/, 'the attrs block renders as text');
});

test('a config error that names a file with a newline is one annotation line', () => {
  const name = 'a\n::warning::x.md';
  const workspace = makeRepo({
    '.github/pages.json': JSON.stringify({ sidebar: [{ file: name, label: 'A' }] }),
    'docs/getting-started.md': '# Hi\n',
    [`docs/${name}`]: '# A\n',
  });
  const run = runAction(workspace, { pre_build_command: 'rm -f "$DOCS_STAGE"/a*' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^::error::docs-build: sidebar files missing from the docs after pre_build_command: a ::warning::x\.md$/m);
  assert.doesNotMatch(run.stderr, /^::warning::/m, 'no line of the output starts an annotation of its own');
});

// ---------- the flow guide ----------

test('the pages flow guide says to give production a required reviewer before the first run', () => {
  const guide = fs.readFileSync(path.join(REPO, 'docs', 'flows', 'pages.md'), 'utf8');
  assert.match(guide, /`production`[^]*required\s+reviewer/i);
  assert.match(guide, /`github-pages`[^]*branch policy[^]*`main`/i);
});

// ---------- paths are written one way ----------

test('a path with a ./ or empty segment fails, so a later exact comparison cannot miss it', () => {
  const cases = [
    [{ unpublished: ['./secret.md'] }, /unpublished\[0\] must be a normalized path/],
    [{ unpublished: ['a//b.md'] }, /unpublished\[0\] must be a normalized path/],
    [{ unpublished: ['a/./b.md'] }, /unpublished\[0\] must be a normalized path/],
    [{ home_page: './getting-started.md' }, /home_page must be a normalized path/],
    [{ sidebar: [{ file: 'a//b.md', label: 'A' }] }, /sidebar\[0\]\.file must be a normalized path/],
  ];
  for (const [pages, error] of cases) {
    assert.throws(() => loadPagesConfig(repoWith(pages)), error, JSON.stringify(pages));
  }
});

test('an unpublished folder may still end in one slash', () => {
  assert.deepEqual(loadPagesConfig(repoWith({ unpublished: ['drafts/', 'x.md'] })).unpublished, ['drafts/', 'x.md']);
});

// ---------- front matter, includes and snippets ----------

test('front matter cannot put HTML into the page, and a front matter title builds', () => {
  const workspace = makeRepo({
    '.github/pages.json': '{}\n',
    'docs/getting-started.md': [
      '---',
      'title: "T</title><script>window.FM_TITLE=1</script>"',
      'layout: home',
      'hero: { name: "<img src=x onerror=window.FM_HERO=1>" }',
      'features: [{ title: "<img src=x onerror=window.FM_FEAT=1>" }]',
      'prev: { text: "<img src=x onerror=window.FM_PREV=1>", link: "/" }',
      '---',
      '',
      '# Front matter',
      '',
    ].join('\n'),
  });
  const run = runAction(workspace, {});
  assert.equal(run.status, 0, run.stderr);
  const html = fs.readFileSync(path.join(workspace, 'artifacts', 'pages', 'docs', 'index.html'), 'utf8');
  for (const mark of ['FM_HERO', 'FM_FEAT', 'FM_PREV']) assert.doesNotMatch(html, new RegExp(mark), mark);
  assert.doesNotMatch(html, /<script>window\.FM_TITLE/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('a page with an @include fails the build naming the page', () => {
  const workspace = makeRepo({
    '.github/pages.json': '{}\n',
    'docs/getting-started.md': '# Hi\n\n<!-- @include: ../../../../../../../etc/hostname -->\n',
  });
  const run = runAction(workspace, {});
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^::error::docs-build: getting-started\.md: <!--@include--> is not supported/m);
});

test('a <<< snippet line renders as text and reads no file', () => {
  const workspace = makeRepo({
    '.github/pages.json': '{}\n',
    'docs/getting-started.md': '# Hi\n\n<<< ../secret.txt\n',
    'secret.txt': 'SNIPPET_SECRET\n',
  });
  const run = runAction(workspace, {});
  assert.equal(run.status, 0, run.stderr);
  const html = fs.readFileSync(path.join(workspace, 'artifacts', 'pages', 'docs', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /SNIPPET_SECRET/);
  assert.match(html, /&lt;&lt;&lt; \.\.\/secret\.txt/);
});

test('the pages flow guide says a released run reads the tags of a public repo', () => {
  const guide = fs.readFileSync(path.join(REPO, 'docs', 'flows', 'pages.md'), 'utf8');
  assert.match(guide, /`released: true`[^]*public repo/i);
});

// ---------- nothing in a page is compiled as a Vue template ----------

test('a -vue fence and a code-group title render their braces as text', () => {
  const workspace = makeRepo({
    '.github/pages.json': '{}\n',
    'docs/getting-started.md': [
      '# Vue', '',
      '```js-vue', 'FENCE {{ 6*7 }}', '```', '',
      '::: code-group', '', '```js [T{{ 5*5 }}T]', 'x', '```', '', ':::', '',
    ].join('\n'),
  });
  const run = runAction(workspace, {});
  assert.equal(run.status, 0, run.stderr);
  const html = fs.readFileSync(path.join(workspace, 'artifacts', 'pages', 'docs', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /FENCE 42/);
  assert.doesNotMatch(html, /T25T/);
  assert.match(html, /6\*7/);
});

test('an image path cannot pull in a file from outside the docs, and an image inside them still shows', () => {
  const workspace = makeRepo({
    '.github/pages.json': '{}\n',
    'docs/getting-started.md': '# Img\n\n![out](../../../outside.txt?url)\n\n![in](img/in.svg)\n',
    'docs/img/in.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n',
  });
  fs.writeFileSync(path.join(path.dirname(workspace), 'outside.txt'), 'OUTSIDE_SECRET\n');
  const run = runAction(workspace, {});
  if (run.status === 0) {
    const html = fs.readFileSync(path.join(workspace, 'artifacts', 'pages', 'docs', 'index.html'), 'utf8');
    assert.doesNotMatch(html, new RegExp(Buffer.from('OUTSIDE_SECRET\n').toString('base64')));
    assert.doesNotMatch(html, /OUTSIDE_SECRET/);
    const src = html.match(/<img src="([^"]+)" alt="in"/);
    assert.ok(src, 'the image inside the docs is on the page');
    const built = src[1].startsWith('data:') || fs.existsSync(path.join(workspace, 'artifacts', 'pages', src[1].replace(/^\/site\//, '')));
    assert.ok(built, `the image inside the docs is published: ${src[1]}`);
  } else {
    assert.match(run.stderr, /^::error::docs-build: getting-started\.md: .*outside the docs/m);
  }
});

test('a symlink under docs/ to a file under .git/ is not staged', () => {
  const workspace = makeRepo({ '.github/pages.json': '{}\n', 'docs/getting-started.md': '# Hi\n', '.git/config': 'TOKEN_LINE\n' });
  fs.mkdirSync(path.join(workspace, 'docs', 'public'), { recursive: true });
  fs.symlinkSync('../../.git/config', path.join(workspace, 'docs', 'public', 'x.txt'));
  const run = runAction(workspace, {});
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /docs\/public\/x\.txt.*\.git/);
});

test('an image in the docs, by relative path or from public/, is published', () => {
  const workspace = makeRepo({
    '.github/pages.json': '{}\n',
    'docs/getting-started.md': '# Img\n\n![in](img/in.svg)\n\n![pub](/pub.svg)\n\n![web](https://x.example/a.png)\n',
    'docs/img/in.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n',
    'docs/public/pub.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>\n',
  });
  const run = runAction(workspace, {});
  assert.equal(run.status, 0, run.stderr);
  const pages = path.join(workspace, 'artifacts', 'pages');
  const html = fs.readFileSync(path.join(pages, 'docs', 'index.html'), 'utf8');
  for (const alt of ['in', 'pub']) {
    const src = html.match(new RegExp(`<img src="([^"]+)" alt="${alt}"`));
    assert.ok(src, `${alt} is on the page`);
    const ok = src[1].startsWith('data:image/') || fs.existsSync(path.join(pages, src[1].replace(/^\/site\//, '')));
    assert.ok(ok, `${alt} is published: ${src[1]}`);
  }
  assert.match(html, /src="https:\/\/x\.example\/a\.png"/);
});

test('a path that is outside the docs or carries a query fails naming the image', () => {
  for (const src of ['../../outside.txt', 'img/in.svg?raw', '/@fs/etc/hostname', '//evil.example/a.png']) {
    const workspace = makeRepo({ '.github/pages.json': '{}\n', 'docs/getting-started.md': `# Img\n\n![x](${src})\n` });
    const run = runAction(workspace, {});
    assert.notEqual(run.status, 0, src);
    assert.match(run.stderr, /^::error::docs-build: getting-started\.md: image .* must be a URL or a path to a file in the docs/m, src);
  }
});

// ---------- a fence's language and title are text ----------

test('a fence language or code-group title holding a tag renders as text, not markup', () => {
  const workspace = makeRepo({
    '.github/pages.json': '{}\n',
    'docs/getting-started.md': [
      '# Fence', '',
      '```x=<img\tsrc=https://x.invalid/a\tonerror=window.FENCE_LANG=1>', 'a', '```', '',
      '```js"\tdata-x="1', 'b', '```', '',
      '::: code-group', '', '```js [T<img src=x onerror=window.FENCE_TITLE=1>]', 'c', '```', '', ':::', '',
    ].join('\n'),
  });
  const run = runAction(workspace, {});
  assert.equal(run.status, 0, run.stderr);
  const html = fs.readFileSync(path.join(workspace, 'artifacts', 'pages', 'docs', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<img[^>]*onerror/i);
  assert.doesNotMatch(html, /\sdata-x=/);
});

test('a fence language that names a file outside the docs inlines nothing', () => {
  const workspace = makeRepo({
    '.github/pages.json': '{}\n',
    'docs/getting-started.md': '# Fence\n\n```x=<img\tsrc=../../../outside.txt?url>\na\n```\n',
  });
  fs.writeFileSync(path.join(path.dirname(workspace), 'outside.txt'), 'FENCE_OUTSIDE\n');
  const run = runAction(workspace, {});
  const dist = path.join(workspace, 'artifacts', 'pages', 'docs', 'index.html');
  if (run.status === 0) {
    const html = fs.readFileSync(dist, 'utf8');
    assert.doesNotMatch(html, new RegExp(Buffer.from('FENCE_OUTSIDE\n').toString('base64')));
    assert.doesNotMatch(html, /<img[^>]*outside/);
  }
});

test('a logo or theme_css symlinked into .git fails naming the field', () => {
  for (const field of ['logo', 'theme_css']) {
    const name = field === 'logo' ? 'site/mark.svg' : 'site/theme.css';
    const root = repoWith({ [field]: name }, { '.git/config': 'TOKEN_LINE\n' });
    fs.mkdirSync(path.join(root, 'site'), { recursive: true });
    fs.symlinkSync('../.git/config', path.join(root, name));
    assert.throws(() => loadPagesConfig(root), new RegExp(`${field}: ${name.replace('.', '\\.')} resolves into \\.git`), field);
  }
});

test('a logo under .github/ passes, and a symlink to a file of another kind fails', () => {
  const ok = repoWith({ logo: '.github/logo.svg' }, { '.github/logo.svg': '<svg/>' });
  assert.equal(loadPagesConfig(ok).logo, '.github/logo.svg');
  const root = repoWith({ logo: 'site/mark.svg' }, { 'notes.txt': 'x\n' });
  fs.mkdirSync(path.join(root, 'site'), { recursive: true });
  fs.symlinkSync('../notes.txt', path.join(root, 'site', 'mark.svg'));
  assert.throws(() => loadPagesConfig(root), /logo: site\/mark\.svg resolves to a file of another kind/);
});

// ---------- a plugin that writes raw HTML ----------

test('an alert title that closes the page wrapper renders nothing as code', () => {
  const workspace = makeRepo({
    '.github/pages.json': '{}\n',
    'docs/getting-started.md': '# Alert\n\n> [!NOTE] </p></div></div><div><div><p>ALERT {{ 6*7 }}\n> body\n\n> [!TIP] A <b>bold</b> title\n> tip\n',
  });
  const run = runAction(workspace, {});
  if (run.status === 0) {
    const html = fs.readFileSync(path.join(workspace, 'artifacts', 'pages', 'docs', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /ALERT 42/);
    assert.doesNotMatch(html, /<b>bold<\/b>/);
  } else {
    assert.match(run.stderr, /^::error::docs-build: /m);
  }
});

test('an ordinary alert keeps its title', () => {
  const workspace = makeRepo({ '.github/pages.json': '{}\n', 'docs/getting-started.md': '# Alert\n\n> [!WARNING] Mind the gap\n> body\n\n> [!NOTE]\n> plain\n' });
  const run = runAction(workspace, {});
  assert.equal(run.status, 0, run.stderr);
  const html = fs.readFileSync(path.join(workspace, 'artifacts', 'pages', 'docs', 'index.html'), 'utf8');
  assert.match(html, /Mind the gap/);
  assert.match(html, /NOTE/);
});

test('an alert title holding a media tag publishes no file from outside the docs', () => {
  const workspace = makeRepo({
    '.github/pages.json': '{}\n',
    'docs/getting-started.md': '# Alert\n\n> [!NOTE] <video poster="../../../outside.txt?url"></video>\n> body\n',
  });
  fs.writeFileSync(path.join(path.dirname(workspace), 'outside.txt'), `ALERT_OUTSIDE${'x'.repeat(6000)}\n`);
  const run = runAction(workspace, {});
  const assets = path.join(workspace, 'artifacts', 'pages', 'docs', 'assets');
  const leaked = fs.existsSync(assets) && fs.readdirSync(assets).some((f) => f.startsWith('outside'));
  assert.equal(leaked, false);
});

// ---------- theme_css reads nothing but the web ----------

test('theme_css is served as it is, so no path in it reaches a file outside the docs', () => {
  const css = [
    '.a{content:"/*"} .x{background:url(../../../creds)} .b{content:"*/"}',
    '@import"../../../leak.css";',
    '.y{background:url(\\2e\\2e/\\2e\\2e/\\2e\\2e/creds)}',
    ':root{--vp-c-brand-1:#abcdef}',
  ].join('\n');
  const workspace = makeRepo({ '.github/pages.json': JSON.stringify({ theme_css: 'site/t.css' }), 'docs/getting-started.md': '# Hi\n', 'site/t.css': css });
  const outer = path.dirname(workspace);
  fs.writeFileSync(path.join(outer, 'creds'), 'CREDS_OUTSIDE\n');
  fs.writeFileSync(path.join(outer, 'leak.css'), '.leak{content:"LEAK_OUTSIDE"}\n');
  const run = runAction(workspace, {});
  assert.equal(run.status, 0, run.stderr);
  const docs = path.join(workspace, 'artifacts', 'pages', 'docs');
  const all = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : all.push(fs.readFileSync(path.join(d, e.name)))));
  walk(docs);
  const text = Buffer.concat(all).toString('latin1');
  for (const secret of ['CREDS_OUTSIDE', 'LEAK_OUTSIDE']) {
    assert.ok(!text.includes(secret), secret);
    assert.ok(!text.includes(Buffer.from(`${secret}\n`).toString('base64').slice(0, 12)), `${secret} inlined`);
  }
  assert.equal(fs.readFileSync(path.join(docs, 'site-theme.css'), 'utf8'), css, 'theme_css is published byte for byte');
  const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8');
  const vp = html.indexOf('assets/style.');
  const site = html.indexOf('<link rel="stylesheet" href="/site/docs/site-theme.css">');
  assert.ok(vp > 0 && site > vp, 'theme_css is linked after VitePress\'s stylesheet');
});

test('a docs/public/site-theme.css next to a theme_css fails: CSS under docs/ is not published', () => {
  const workspace = makeRepo({
    '.github/pages.json': JSON.stringify({ theme_css: 'site/t.css' }),
    'docs/getting-started.md': '# Hi\n', 'site/t.css': 'a{}\n', 'docs/public/site-theme.css': 'b{}\n',
  });
  const run = runAction(workspace, {});
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /docs\/public\/site-theme\.css: only Markdown pages and static files/);
});

test('a theme_css with web and data URLs, or none, passes', () => {
  const css = [
    '@import url("https://fonts.example/a.css");',
    ':root{--x:#123}',
    '.q::before{content:"\\201C"}',
    '.a{background:url(https://x.example/a.png)}',
    '.b{background:url("data:image/svg+xml,%3Csvg%3E")}',
    '/* url(../not-read) in a comment */',
  ].join('\n');
  const root = repoWith({ theme_css: 'site/t.css' }, { 'site/t.css': css });
  assert.equal(loadPagesConfig(root).theme_css, 'site/t.css');
});

test('an image path with an encoded / or ? fails like the plain one', () => {
  for (const src of ['x%2F..%2F..%2F..%2Foutside.svg', 'x%2F..%2F..%2Fcreds%3Fraw', 'a%5Cb.png']) {
    const workspace = makeRepo({ '.github/pages.json': '{}\n', 'docs/getting-started.md': `# Img\n\n![x](${src})\n` });
    const run = runAction(workspace, {});
    assert.notEqual(run.status, 0, src);
    assert.match(run.stderr, /^::error::docs-build: getting-started\.md: image .* must be a URL or a path to a file in the docs/m, src);
  }
});

// ---------- docs/ holds pages and static files, never code ----------

test('a dynamic route with a .paths.js beside it fails before anything is installed', () => {
  const workspace = makeRepo({
    '.github/pages.json': '{}\n',
    'docs/getting-started.md': '# Hi\n',
    'docs/[id].md': '# {{ $params.id }}\n',
    'docs/[id].paths.js': 'require("fs").writeFileSync("/tmp/paths-ran", "x"); module.exports = { paths: () => [] };\n',
  });
  const run = runAction(workspace, {});
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^::error::docs-build: docs\/\[id\]\.md: a \[ or \] in a name/m);
  assert.equal(fs.existsSync(path.join(workspace, 'artifacts')), false, 'nothing is built');
});

test('a code file anywhere under docs/ fails naming it', () => {
  for (const name of ['helper.paths.js', 'x.ts', 'public/a.mjs', 'c.vue', 'd.cjs', 'e.mts', 'f.jsx', 'g.html', 'h.css']) {
    const workspace = makeRepo({ '.github/pages.json': '{}\n', 'docs/getting-started.md': '# Hi\n', [`docs/${name}`]: 'x\n' });
    const run = runAction(workspace, {});
    assert.notEqual(run.status, 0, name);
    assert.match(run.stderr, new RegExp(`docs/${name.replace(/\./g, '\\.')}: only Markdown pages and static files`), name);
  }
});

test('a code file that pre_build_command writes into the stage fails the build', () => {
  const workspace = makeRepo({ '.github/pages.json': '{}\n', 'docs/getting-started.md': '# Hi\n' });
  const run = runAction(workspace, { pre_build_command: 'printf "x" > "$DOCS_STAGE/gen.js"' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^::error::docs-build: gen\.js: only Markdown pages and static files/m);
});

test('pages, images, fonts and documents under docs/ still build', () => {
  const files = ['img/a.png', 'img/b.JPG', 'public/c.svg', 'public/f.woff2', 'files/g.pdf', 'files/h.txt', 'files/i.csv', 'public/favicon.ico'];
  const workspace = makeRepo({
    '.github/pages.json': '{}\n', 'docs/getting-started.md': '# Hi\n', 'docs/guide/more.md': '# More\n',
    ...Object.fromEntries(files.map((f) => [`docs/${f}`, 'x'])),
  });
  const run = runAction(workspace, {});
  assert.equal(run.status, 0, run.stderr);
});

test('an unpublished code file is not staged, so it does not fail the build', () => {
  const workspace = makeRepo({
    '.github/pages.json': JSON.stringify({ unpublished: ['internal'] }),
    'docs/getting-started.md': '# Hi\n', 'docs/internal/tool.js': 'x\n',
  });
  const run = runAction(workspace, {});
  assert.equal(run.status, 0, run.stderr);
});

// ---------- front matter is never code ----------

test('a page whose front matter names a language fails naming the page', () => {
  for (const open of ['---js', '--- javascript', '---json', '---coffee', '﻿---js']) {
    const marker = path.join(os.tmpdir(), `fm-ran-${process.pid}-${Date.now()}`);
    const workspace = makeRepo({
      '.github/pages.json': '{}\n',
      'docs/getting-started.md': `${open}\n{ x: (() => { process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); return 1 })() }\n---\n\n# Hi\n`,
    });
    const run = runAction(workspace, {});
    assert.notEqual(run.status, 0, open);
    assert.match(run.stderr, /^::error::docs-build: (docs\/)?getting-started\.md: front matter in .* is not supported/m, open);
    assert.equal(fs.existsSync(marker), false, `${open}: the front matter ran`);
  }
});

test('a front matter language that pre_build_command writes is refused before VitePress reads it', () => {
  const marker = path.join(os.tmpdir(), `fm-pre-${process.pid}-${Date.now()}`);
  const page = `---js\n{ x: (() => { process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); return 1 })() }\n---\n# Gen\n`;
  const workspace = makeRepo({ '.github/pages.json': '{}\n', 'docs/getting-started.md': '# Hi\n', 'gen-src.md': page });
  const run = runAction(workspace, { pre_build_command: 'cp gen-src.md "$DOCS_STAGE/gen.md"' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^::error::docs-build: gen\.md: front matter in js is not supported/m);
  assert.equal(fs.existsSync(marker), false, 'the front matter ran');
});

test('YAML front matter, written plain or as ---yaml, still builds', () => {
  for (const open of ['---', '---yaml', '--- yaml']) {
    const workspace = makeRepo({ '.github/pages.json': '{}\n', 'docs/getting-started.md': `${open}\ntitle: T\n---\n\n# Hi\n` });
    const run = runAction(workspace, {});
    assert.equal(run.status, 0, `${open}: ${run.stderr}`);
  }
});

// ---------- docs/public holds no pages ----------

test('a Markdown file under docs/public fails, in docs/ or written by pre_build_command', () => {
  const inDocs = makeRepo({ '.github/pages.json': '{}\n', 'docs/getting-started.md': '# Hi\n', 'docs/public/x.md': '# Pub\n' });
  const run = runAction(inDocs, {});
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^::error::docs-build: docs\/public\/x\.md: a Markdown file under public\/ would be built as a page/m);
  const generated = makeRepo({ '.github/pages.json': '{}\n', 'docs/getting-started.md': '# Hi\n' });
  const gen = runAction(generated, { pre_build_command: 'mkdir -p "$DOCS_STAGE/public/sub" && printf "# P\\n" > "$DOCS_STAGE/public/sub/y.md"' });
  assert.notEqual(gen.status, 0);
  assert.match(gen.stderr, /^::error::docs-build: public\/sub\/y\.md: a Markdown file under public\//m);
});

// ---------- every image is checked, whatever renders it ----------

test('an image in a container title must be a web URL', () => {
  for (const title of ['::: tip ![b](../../../outside/creds?raw)', '::: details ![c](../../../outside/secret.svg?url)', '::: warning ![d](img/in.svg)']) {
    const workspace = makeRepo({
      '.github/pages.json': '{}\n',
      'docs/getting-started.md': `# T\n\n${title}\nbody\n:::\n`,
      'docs/img/in.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    });
    const outside = path.join(path.dirname(workspace), 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'creds'), 'https://TITLE_CREDS@github.com\n');
    fs.writeFileSync(path.join(outside, 'secret.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><!--TITLE_SVG${'x'.repeat(6000)}--></svg>\n`);
    const run = runAction(workspace, {});
    assert.notEqual(run.status, 0, title);
    assert.match(run.stderr, /^::error::docs-build: a title: image .* must be a URL/m, title);
  }
});

test('an absolute image path outside the stage public/ fails, even when the file exists on the runner', () => {
  const workspace = makeRepo({ '.github/pages.json': '{}\n', 'docs/getting-started.md': '# T\n' });
  const secret = path.join(path.dirname(workspace), 'abs-secret.svg');
  fs.writeFileSync(secret, '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  fs.writeFileSync(path.join(workspace, 'docs', 'getting-started.md'), `# T\n\n![a](${secret})\n`);
  const run = runAction(workspace, {});
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^::error::docs-build: getting-started\.md: image .* must be a URL or a path to a file in the docs/m);
});
