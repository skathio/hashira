// Defences added after a review of the v3.4.0 Pages work, one test group each:
//
// - docs-build's output_dir is written to GITHUB_OUTPUT and the step summary as one line, so a
//   control character in it (a newline above all) must be refused before anything is written.
// - pages-site.yml's `source: latest-release` builds the highest vX.Y.Z tag, and a tag can sit
//   on any commit: the tag's commit must be on main, and a run that cannot find main fails.
// - An SVG under docs/ must not reach script through a DOCTYPE or ENTITY declaration, an
//   embedded document (<foreignObject>, <iframe>, <embed>, <object>) or a srcdoc attribute.
// - The kit-reference check reads src and href only inside real tags, so escaped text such as
//   a code sample of `<script src="_kit/...">` never fails a build.
// - The Playwright MCP folder of browser snapshots is ignored by git.
// - A scrollspy <site-nav> whose nav holds a hash that does not decode ('#100%') still renders,
//   sets `ready`, fires `site-nav:ready` and marks the section in view. Checked in a headless
//   Chrome (CHROME_BIN, google-chrome, chromium or a Playwright download), since scrollspy
//   needs a page that lays out and scrolls.
//
// Run with:
//   node --test tests/pages-site/pages-hardening.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const CLI = path.join(REPO, '.github', 'actions', 'docs-build', 'lib', 'cli.js');
const { svgProblems } = require(path.join(REPO, '.github', 'actions', 'docs-build', 'lib', 'html-safety'));
const { kitReferences } = require(path.join(REPO, '.github', 'pages-site', 'lib', 'kit-refs.cjs'));

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- docs-build output_dir

function fixtureRepo() {
  const root = tempDir('pages-hardening-');
  fs.mkdirSync(path.join(root, '.github'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, '.github', 'pages.json'), JSON.stringify({ name: 'site' }));
  fs.writeFileSync(path.join(root, 'docs', 'getting-started.md'), '# Start\n');
  return root;
}

for (const [label, out] of [['a newline', 'site\ninjected=1'], ['a carriage return', 'site\rinjected=1'], ['a tab', 'site\tx'], ['DEL', 'site\x7f']]) {
  test(`--out with ${label} exits non-zero, names output_dir and writes nothing to GITHUB_OUTPUT or the summary`, () => {
    const root = fixtureRepo();
    const output = path.join(root, 'output.txt');
    const summary = path.join(root, 'summary.md');
    const run = spawnSync(process.execPath, [CLI, '--out', out], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, GITHUB_REPOSITORY: 'owner/site', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    });
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(run.stderr, /::error::docs-build: output_dir must not hold a control character/);
    for (const file of [output, summary]) {
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      assert.doesNotMatch(text, /injected=1/);
      assert.doesNotMatch(text, /output_dir=/);
    }
    assert.deepEqual(fs.readdirSync(root).filter((f) => f.startsWith('site')), [], 'an output folder was made');
  });
}

// ---------------------------------------------------------------- source: latest-release

function yamlOf(rel) {
  const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))';
  const r = spawnSync('python3', ['-c', py, path.join(REPO, rel)], { encoding: 'utf8' });
  assert.equal(r.status, 0, `PyYAML could not read ${rel}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// main with v1.0.0 on its first commit and a second commit; a side branch off it holds v9.0.0,
// never merged. `remote` adds refs/remotes/origin/main the way checkout's full fetch does.
function sideTaggedRepo({ branch = 'main', remote = true } = {}) {
  const root = tempDir('pages-hardening-git-');
  git(root, 'init', '-q', '-b', branch);
  git(root, 'commit', '-q', '--allow-empty', '-m', 'c0');
  git(root, 'tag', 'v1.0.0');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'c1');
  git(root, 'checkout', '-q', '-b', 'side');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'side');
  git(root, 'tag', 'v9.0.0');
  git(root, 'checkout', '-q', branch);
  if (remote) git(root, 'update-ref', `refs/remotes/origin/${branch}`, branch);
  return root;
}

function pickSource(root) {
  const step = yamlOf('.github/workflows/pages-site.yml').jobs.source.steps.find((s) => s.id === 'pick');
  const output = path.join(root, '.git', 'output.txt');
  const summary = path.join(root, '.git', 'summary.md');
  const r = spawnSync('bash', ['-eo', 'pipefail', '-c', step.run], {
    cwd: root, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, SOURCE: 'latest-release', DEPLOY: 'true', REF_NAME: 'main', SHA: git(root, 'rev-parse', 'HEAD'), GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
  });
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  return { status: r.status, log: `${r.stdout}${r.stderr}`, output: read(output) };
}

test('source: latest-release refuses the highest tag when it sits on a side branch, not on main', () => {
  for (const remote of [true, false]) {
    const run = pickSource(sideTaggedRepo({ remote }));
    assert.notEqual(run.status, 0, run.log);
    assert.match(run.log, /::error::pages-site: source: latest-release: v9\.0\.0 \([0-9a-f]{40}\) is not on main/);
    assert.doesNotMatch(run.output, /sha=/, 'a commit was picked');
  }
});

test('source: latest-release fails closed when the clone has no main to check the tag against', () => {
  const run = pickSource(sideTaggedRepo({ branch: 'trunk', remote: true }));
  assert.notEqual(run.status, 0, run.log);
  assert.match(run.log, /::error::pages-site: source: latest-release cannot find main/);
  assert.doesNotMatch(run.output, /sha=/);
});

test('source: latest-release still builds the highest tag once it is merged to main', () => {
  const root = sideTaggedRepo();
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'main');
  const run = pickSource(root);
  assert.equal(run.status, 0, run.log);
  assert.equal(run.output.trim(), `sha=${git(root, 'rev-parse', 'v9.0.0^{commit}')}`);
});

// ---------------------------------------------------------------- SVGs under docs/

test('svgProblems refuses an entity that spells a script, and an embedded document', () => {
  const entity = '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "&#60;script&#62;alert(1)&#60;/script&#62;">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>';
  const embedded = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="10" height="10"><iframe xmlns="http://www.w3.org/1999/xhtml" srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe></foreignObject></svg>';
  assert.ok(svgProblems(entity).some((p) => /DOCTYPE/.test(p)), JSON.stringify(svgProblems(entity)));
  assert.ok(svgProblems('<svg><!ENTITY y "z"></svg>').some((p) => /ENTITY/.test(p)));
  const problems = svgProblems(embedded);
  assert.ok(problems.some((p) => /foreignObject/.test(p)), JSON.stringify(problems));
  assert.ok(problems.some((p) => /iframe/.test(p)), JSON.stringify(problems));
  assert.ok(problems.some((p) => /srcdoc/.test(p)), JSON.stringify(problems));
});

test('svgProblems refuses <embed>, <object> and a srcdoc attribute under any namespace prefix', () => {
  for (const text of ['<svg><embed src="x.svg"/></svg>', '<svg><OBJECT data="x"></OBJECT></svg>', '<svg><h:iframe src="x"/></svg>', '<svg><x:foreignobject/></svg>', '<svg><g x:srcdoc="a"/></svg>']) {
    assert.ok(svgProblems(text).length > 0, text);
  }
});

test('svgProblems still passes a plain SVG with paths and a <title>', () => {
  const plain = '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>Object storage embed diagram</title><path d="M0 0h24v24H0z" fill="#1e7d69"/><g><path d="M4 4l16 16"/></g></svg>';
  assert.deepEqual(svgProblems(plain), []);
});

// ---------------------------------------------------------------- the kit-reference check

test('kitReferences reads src and href only inside real tags, never in escaped text', () => {
  assert.deepEqual(kitReferences('<pre><code>&lt;script src="_kit/nope.js"&gt;&lt;/script&gt;</code></pre>'), []);
  assert.deepEqual(kitReferences('<p title="a src=_kit/x.js">text href=_kit/y.css</p>'), []);
  assert.deepEqual(kitReferences('<img data-src="_kit/z.png" alt="">'), []);
  assert.deepEqual(kitReferences('<code>&lt;x&gt;</code><script src="_kit/nope.js"></script><link title=">" href=\'../_kit/tokens.css\'>'), ['_kit/nope.js', '../_kit/tokens.css']);
});

// ---------------------------------------------------------------- the Playwright MCP folder

test('git ignores the Playwright MCP snapshot folder', () => {
  // The trailing slash names a folder, so the directory-only pattern matches on a fresh
  // checkout where the folder does not exist yet.
  const r = spawnSync('git', ['check-ignore', '-q', '.playwright-mcp/'], { cwd: REPO });
  assert.equal(r.status, 0, '.playwright-mcp is not ignored');
});

// ---------------------------------------------------------------- <site-nav> scrollspy

const PLAYWRIGHT_BINS = [
  ['chromium_headless_shell-', 'chrome-headless-shell-linux64', 'chrome-headless-shell'],
  ['chromium-', 'chrome-linux64', 'chrome'],
  ['chromium-', 'chrome-linux', 'chrome'],
];

function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.trim();
  }
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : [];
  const found = PLAYWRIGHT_BINS.flatMap(([prefix, sub, bin]) => dirs.filter((d) => d.startsWith(prefix)).map((d) => path.join(cache, d, sub, bin)));
  return found.find((p) => fs.existsSync(p)) ?? null;
}

// The page scrolls #intro under the bar and fires the scroll event itself (a --dump-dom run
// with virtual time does not), then writes what it saw into #out, which --dump-dom prints (the
// shadow root itself is not serialised).
const SPY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="_kit/tokens.css"><script src="_kit/theme.js"></script></head>
<body style="margin:0"><site-nav scrollspy><script type="application/json">{"name":"T","nav":[{"label":"Bad","href":"#100%"},{"label":"Intro","href":"#intro"}]}</script></site-nav>
<main><div style="height:3000px"></div><h2 id="intro">Intro</h2><div style="height:3000px"></div></main><pre id="out">pending</pre>
<script>
document.addEventListener('site-nav:ready', function () { window.fired = true; });
window.addEventListener('error', function (e) { window.failed = String(e.message); });
setTimeout(function () {
  document.getElementById('intro').scrollIntoView();
  window.dispatchEvent(new Event('scroll'));
  setTimeout(function () {
    var host = document.querySelector('site-nav');
    var links = host.shadowRoot ? Array.from(host.shadowRoot.querySelectorAll('a[href^="#"]')) : [];
    var current = {};
    links.forEach(function (a) { current[a.getAttribute('href')] = a.getAttribute('aria-current'); });
    document.getElementById('out').textContent = JSON.stringify({ ready: host.hasAttribute('ready'), fired: !!window.fired, error: window.failed || null, current: current });
  }, 300);
}, 300);
</script><script src="_kit/site-nav.js"></script></body></html>`;

test('a scrollspy <site-nav> with a nav hash that does not decode still renders and marks the section in view', () => {
  const chrome = findChrome();
  assert.ok(chrome, 'no Chrome found: set CHROME_BIN, or install google-chrome or chromium');
  const dir = tempDir('pages-hardening-spy-');
  fs.cpSync(path.join(REPO, '.github', 'actions', 'site-kit', 'kit'), path.join(dir, '_kit'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), SPY_PAGE);
  const r = spawnSync(chrome, ['--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${tempDir('pages-hardening-chrome-')}`,
    '--allow-file-access-from-files', '--virtual-time-budget=5000', '--dump-dom', `file://${path.join(dir, 'index.html')}`], { encoding: 'utf8' });
  const out = (r.stdout.match(/<pre id="out">([^<]*)<\/pre>/) ?? [])[1];
  assert.ok(out && out !== 'pending', `the page did not report: ${r.stderr}`);
  const seen = JSON.parse(out.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.equal(seen.error, null);
  assert.equal(seen.ready, true);
  assert.equal(seen.fired, true);
  assert.equal(seen.current['#intro'], 'location');
  assert.equal(seen.current['#100%'] ?? null, null);
});
