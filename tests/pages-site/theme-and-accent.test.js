// The user's rules for the three-state theme and the accent pair, checked in a real headless
// Chrome where a rule is about what a page shows:
//
// - site-kit's theme.js cycles auto -> the opposite of the resolved theme -> the other -> auto,
//   so the first press from auto always changes what the page shows, and it keeps the choice
//   under the shared `theme` localStorage key.
// - theme.js sets data-theme-resolved="light|dark" on <html>, kept in sync with the
//   prefers-color-scheme media query.
// - The VitePress docs get the same three-state control through the theme bridge, on the same
//   `theme` key, so a docs page can go back to auto.
// - pages.json takes an optional `accent_dark` (#rgb or #rrggbb), validated like `accent`, with
//   the same unknown-field and wrong-type rules. docs-build maps `accent` to light mode and
//   `accent_dark` to dark mode, with the hover and soft shades mixed as today. The default green
//   pair stays as it is.
// - <site-nav>'s accent also sets --site-accent-dark.
// - docs-build warns (::warning, the build still succeeds) when an accent is below 4.5:1 against
//   the canvas as link text in its own mode, and only then.
//
// The docs cases run docs-build's action.yml steps with bash the way a runner does, against
// fixture repos in a temporary folder (the first build installs VitePress from the action's
// lockfile, so it needs network access once), then open the built pages in Chrome. Chrome is
// driven over the DevTools protocol on a pipe and found through CHROME_BIN, then google-chrome,
// chromium or a Playwright download.
//
// Left to the builder, so not tested here: the toggle's glyph or icon and its label text, the
// wording of the warning, what a press does when the system theme changed after the last
// press, whether data-theme-resolved is also set on the docs pages, the value accent_dark takes
// when it is left out, and which colour a custom accent with no accent_dark uses in dark mode.
//
// Run with:
//   node --test tests/pages-site/theme-and-accent.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const KIT_DIR = path.join(REPO, '.github', 'actions', 'site-kit', 'kit');
const ACTION_DIR = path.join(REPO, '.github', 'actions', 'docs-build');
const CUSTOM_CSS = path.join(ACTION_DIR, 'vitepress', '.vitepress', 'theme', 'custom.css');
const { loadPagesConfig } = require(path.join(ACTION_DIR, 'lib', 'pages-config'));

const KEY = 'theme';
const MIN_CONTRAST = 4.5;
const DESKTOP = 1440;
const HEIGHT = 900;
const BUILD_TIMEOUT = 600_000;
const WAIT_STEPS = 200;
const WAIT_STEP_MS = 50;
const COLOUR_TOLERANCE = 1.5;
const FAKE_SHA = 'c'.repeat(40);

const temps = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---------------------------------------------------------------- colours

const hexToRgb = (hex) => {
  const h = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const rgbToHex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
const channel = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const mix = (a, b, share) => a.map((c, i) => c * share + b[i] * (1 - share));

// A computed colour as 0-255 channels: Chrome writes rgb() for plain colours and color(srgb ...)
// for a color-mix().
function parseColour(text) {
  const rgb = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (rgb) return rgb.slice(1, 4).map(Number);
  const srgb = text.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (srgb) return srgb.slice(1, 4).map((v) => Number(v) * 255);
  assert.fail(`unreadable colour ${JSON.stringify(text)}`);
}

function assertColour(actual, expected, what) {
  const got = parseColour(actual);
  const off = got.some((c, i) => Math.abs(c - expected[i]) > COLOUR_TOLERANCE);
  assert.ok(!off, `${what}: got ${actual}, expected about rgb(${expected.map(Math.round).join(', ')})`);
}

// The docs' canvas in each mode, from the shared theme.
function canvases() {
  const css = fs.readFileSync(CUSTOM_CSS, 'utf8');
  const bg = (block) => hexToRgb(css.match(new RegExp(`${block}\\s*\\{[^}]*--vp-c-bg:\\s*(#[0-9a-fA-F]{3,6})`))[1]);
  return { light: bg(':root'), dark: bg('\\.dark') };
}
const CANVAS = canvases();

// The two neighbouring shades of one hue that sit on either side of 4.5:1 against a canvas:
// `at` reaches the limit and `past` is one step short of it.
function boundary(canvas, shade) {
  for (let v = 0; v < 255; v++) {
    const [a, b] = [shade(v), shade(v + 1)];
    const [okA, okB] = [contrast(a, canvas) >= MIN_CONTRAST, contrast(b, canvas) >= MIN_CONTRAST];
    if (okA !== okB) return okA ? { at: rgbToHex(a), past: rgbToHex(b) } : { at: rgbToHex(b), past: rgbToHex(a) };
  }
  throw new Error('no 4.5:1 boundary for this hue');
}
const LIGHT = boundary(CANVAS.light, (v) => [0, v, Math.round(v * 0.8)]);
const DARK = boundary(CANVAS.dark, (v) => [v, Math.round(v * 0.6), 0]);

// ---------------------------------------------------------------- finding Chrome

const PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const PLAYWRIGHT_BINS = [
  ['chromium_headless_shell-', 'chrome-headless-shell-linux64', 'chrome-headless-shell'],
  ['chromium-', 'chrome-linux64', 'chrome'],
  ['chromium-', 'chrome-linux', 'chrome'],
];

function onPath(name) {
  const run = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

function playwrightChrome() {
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : [];
  const found = PLAYWRIGHT_BINS.flatMap(([prefix, sub, bin]) => dirs
    .filter((d) => d.startsWith(prefix) && /^[a-z_]+-\d+$/.test(d))
    .map((d) => path.join(cache, d, sub, bin)));
  return found.find((p) => fs.existsSync(p)) ?? null;
}

function findChrome() {
  const fromEnv = process.env.CHROME_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return PATH_NAMES.map(onPath).find(Boolean) ?? playwrightChrome();
}

// ---------------------------------------------------------------- DevTools protocol over a pipe

class Browser {
  constructor(bin) {
    const args = ['--headless=new', '--remote-debugging-pipe', '--no-sandbox', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', '--hide-scrollbars', `--user-data-dir=${tempDir('theme-chrome-')}`];
    // Its own process group, so close() can stop Chrome's helper processes along with it.
    this.proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: true });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.proc.stdio[4].on('data', (chunk) => this.receive(chunk));
    this.proc.on('exit', () => this.pending.forEach(({ reject }) => reject(new Error('Chrome exited'))));
  }

  receive(chunk) {
    this.buffer += chunk.toString('utf8');
    const parts = this.buffer.split('\0');
    this.buffer = parts.pop();
    parts.forEach((raw) => this.dispatch(JSON.parse(raw)));
  }

  dispatch(message) {
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter.resolve(message.result);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const frame = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.proc.stdio[3].write(`${frame}\0`);
    });
  }

  // Each page gets a browser context of its own, so no test sees another's localStorage.
  async newPage(scheme) {
    const { browserContextId } = await this.send('Target.createBrowserContext');
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, browserContextId, sessionId);
    await page.send('Emulation.setDeviceMetricsOverride', { width: DESKTOP, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await page.system(scheme);
    return page;
  }

  // Asks Chrome to shut down (which ends its helpers and flushes the profile), and kills the
  // whole process group if it has not exited a few seconds later.
  close() {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = setTimeout(() => {
        try { process.kill(-this.proc.pid, 'SIGKILL'); } catch { this.proc.kill('SIGKILL'); }
      }, 5000);
      this.proc.once('exit', () => {
        clearTimeout(kill);
        try { process.kill(-this.proc.pid, 'SIGKILL'); } catch { /* the group is gone already */ }
        resolve();
      });
      this.send('Browser.close').catch(() => {});
    });
  }
}

class Page {
  constructor(browser, contextId, sessionId) {
    Object.assign(this, { browser, contextId, sessionId });
  }

  send(method, params) { return this.browser.send(method, params, this.sessionId); }

  // The system theme, as prefers-color-scheme reports it; a change fires the media query.
  async system(scheme) {
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await this.settle();
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`page error: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value;
  }

  // Polls a page expression until it is truthy; the step count bounds the wait, not an assertion.
  async waitFor(expression, what) {
    for (let i = 0; i < WAIT_STEPS; i++) {
      if (await this.eval(`!!(${expression})`)) return;
      await pause(WAIT_STEP_MS);
    }
    assert.fail(`timed out waiting for ${what}`);
  }

  // The marker tells the new document from the old one when the same URL loads again.
  async navigate(url) {
    await this.eval('window.__leaving = true');
    await this.send('Page.navigate', { url });
    await this.waitFor(`!window.__leaving && location.href === ${JSON.stringify(url)} && document.readyState === "complete"`, `${url} to load`);
    await this.settle();
  }

  // Two animation frames: lets media-query listeners, observers and renders run.
  settle() {
    return this.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  }

  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await this.settle();
  }

  storage() { return this.eval(`localStorage.getItem(${JSON.stringify(KEY)})`); }

  close() { return this.browser.send('Target.disposeBrowserContext', { browserContextId: this.contextId }); }
}

const state = { browser: null, error: null };

function needBrowser() {
  assert.ok(state.browser, state.error ?? 'Chrome did not start');
}

// Opens url on a fresh page with the system theme set and, when given, `theme` stored first.
async function openPage(url, { scheme = 'light', stored } = {}) {
  needBrowser();
  const page = await state.browser.newPage(scheme);
  await page.navigate(url);
  if (stored !== undefined) {
    await page.eval(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(stored)})`);
    await page.navigate(url);
  }
  return page;
}

async function withPage(url, opts, fn) {
  const page = await openPage(url, opts);
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------- serving the pages

const site = { dir: null, server: null, origin: null };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function servedFile(pathname) {
  const rel = path.normalize(decodeURIComponent(pathname));
  const base = path.join(site.dir, rel);
  const candidates = rel.endsWith(path.sep) ? [path.join(base, 'index.html')] : [base, `${base}.html`, path.join(base, 'index.html')];
  return candidates.find((f) => f.startsWith(site.dir) && fs.existsSync(f) && fs.statSync(f).isFile()) ?? null;
}

function serve(req, res) {
  const file = servedFile(new URL(req.url, 'http://x').pathname);
  if (!file) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}

function startServer() {
  site.dir = tempDir('theme-pages-');
  fs.cpSync(KIT_DIR, path.join(site.dir, '_kit'), { recursive: true });
  site.server = http.createServer(serve);
  return new Promise((resolve) => {
    site.server.listen(0, '127.0.0.1', () => {
      site.origin = `http://127.0.0.1:${site.server.address().port}`;
      resolve();
    });
  });
}

let pageCount = 0;

// A landing page that loads the kit the way site/ does: tokens.css and theme.js in <head>, with
// a plain <button id="theme"> toggle and, optionally, a <site-nav>.
function landingPage({ nav = '' } = {}) {
  const rel = `landing-${++pageCount}/index.html`;
  const navScript = nav ? '<script src="/_kit/site-nav.js"></script>' : '';
  fs.mkdirSync(path.join(site.dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(site.dir, rel), `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="/_kit/tokens.css"><script src="/_kit/theme.js"></script></head>
<body>${nav}<button id="theme" type="button" hidden></button><main><p>Landing</p></main>${navScript}</body></html>`);
  return `${site.origin}/${path.dirname(rel)}/`;
}

test.before(async () => {
  const bin = findChrome();
  if (!bin) {
    state.error = 'no Chrome found: set CHROME_BIN, or install google-chrome or chromium';
    return;
  }
  await startServer();
  state.browser = new Browser(bin);
  await state.browser.send('Browser.getVersion');
});

test.after(async () => {
  if (state.browser) await state.browser.close();
  if (site.server) site.server.close();
  // A temp folder left behind is not a test failure: report it and go on.
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (err) {
      console.warn(`could not remove ${dir}: ${err.message}`);
    }
  }
});

// ---------------------------------------------------------------- running docs-build's action.yml

function loadYaml(file) {
  const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))';
  const run = spawnSync('python3', ['-c', py, file], { encoding: 'utf8' });
  assert.equal(run.status, 0, `could not read ${file}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

function githubContext(ctx) {
  return {
    action_path: ACTION_DIR, workspace: ctx.workspace, sha: FAKE_SHA, workflow_sha: FAKE_SHA, action_ref: 'v3',
    action_repository: 'skathio/hashira', repository: `octo/${ctx.name}`, repository_owner: 'octo',
    ref: 'refs/heads/main', ref_name: 'main', server_url: 'https://github.com', event_name: 'push',
  };
}

function lookup(expr, ctx) {
  const [scope, ...keys] = expr.trim().split('.');
  const scopes = { inputs: ctx.inputs, github: githubContext(ctx), runner: { temp: ctx.outer, os: 'Linux' }, steps: ctx.steps, env: {} };
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
    ...env, GITHUB_WORKSPACE: ctx.workspace, GITHUB_ACTION_PATH: ACTION_DIR, GITHUB_REPOSITORY: `octo/${ctx.name}`,
    GITHUB_REPOSITORY_OWNER: 'octo', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_NAME: 'main', GITHUB_SHA: FAKE_SHA, GITHUB_OUTPUT: outputFile, GITHUB_ENV: path.join(ctx.outer, 'env'),
    GITHUB_STEP_SUMMARY: path.join(ctx.outer, 'summary'), RUNNER_TEMP: ctx.outer, CI: 'true',
  };
}

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
  const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', substitute(step.run, ctx)],
    { cwd, env, encoding: 'utf8', timeout: BUILD_TIMEOUT });
  if (step.id) ctx.steps[step.id] = { outputs: readOutputs(outputFile) };
  return run;
}

// Runs action.yml's `run:` steps in order, with every input at its default. After a failure
// only always() and failure() steps run, and the result carries the first failing exit code.
function runAction(workspace, name) {
  const spec = loadYaml(path.join(ACTION_DIR, 'action.yml'));
  const inputs = Object.fromEntries(Object.entries(spec.inputs ?? {}).map(([k, def]) => [k, def.default ?? '']));
  const ctx = { name, outer: path.dirname(workspace), workspace, inputs, steps: {}, failed: false };
  const result = { status: 0, output: '' };
  (spec.runs?.steps ?? []).filter((s) => s.run).forEach((step, i) => {
    if (!stepRuns(step, ctx)) return;
    const run = runStep(step, ctx, i);
    result.output += `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? `\n${run.error.message}` : ''}`;
    if (run.status !== 0 && !ctx.failed) {
      ctx.failed = true;
      result.status = run.status ?? 1;
    }
  });
  return result;
}

// ---------------------------------------------------------------- the fixture docs sites

// Each fixture repo is octo/<name>, so its docs build for /<name>/docs/ and are served there.
const FIXTURES = {
  pair: { accent: LIGHT.at, accent_dark: DARK.at },
  lightlow: { accent: LIGHT.past, accent_dark: DARK.at },
  darklow: { accent: LIGHT.at, accent_dark: DARK.past },
  plain: {},
};
const builds = {};

function buildDocs(name) {
  if (builds[name]) return builds[name];
  const workspace = path.join(tempDir(`theme-docs-${name}-`), name);
  fs.mkdirSync(path.join(workspace, '.github'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'docs'));
  fs.writeFileSync(path.join(workspace, '.github', 'pages.json'), JSON.stringify({ name: 'Octo', ...FIXTURES[name] }));
  fs.writeFileSync(path.join(workspace, 'docs', 'getting-started.md'), '# Getting started\n\nSee [the guide](guide.md).\n');
  fs.writeFileSync(path.join(workspace, 'docs', 'guide.md'), '# Guide\n\nWords.\n');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  const run = runAction(workspace, name);
  const out = path.join(workspace, 'artifacts', 'pages', 'docs');
  if (run.status === 0 && fs.existsSync(out)) fs.cpSync(out, path.join(site.dir, name, 'docs'), { recursive: true });
  builds[name] = { ...run, out, url: `${site.origin}/${name}/docs/` };
  return builds[name];
}

function builtDocs(name) {
  needBrowser();
  const build = buildDocs(name);
  assert.equal(build.status, 0, `docs-build failed for ${JSON.stringify(FIXTURES[name])}:\n${build.output}`);
  assert.ok(fs.existsSync(build.out), 'docs-build wrote no site');
  return build;
}

// The ::warning lines a build printed about an accent or its contrast.
const accentWarnings = (build) => build.output.split('\n').filter((l) => /::warning/.test(l) && /accent|contrast/i.test(l));

// ---------------------------------------------------------------- pages.json accent_dark

function pagesRepo(pages) {
  const root = path.join(tempDir('theme-config-'), 'octo-site');
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'getting-started.md'), '# Getting started\n');
  fs.writeFileSync(path.join(root, '.github', 'pages.json'), JSON.stringify(pages));
  return root;
}

test('pages.json takes accent_dark as #rgb or #rrggbb', () => {
  for (const value of ['#abc', '#ABC', '#a1b2c3', '#A1B2C3']) {
    const config = loadPagesConfig(pagesRepo({ accent: '#123456', accent_dark: value }));
    assert.equal(config.accent_dark, value, `accent_dark ${value}`);
  }
});

test('pages.json without accent_dark still loads', () => {
  assert.doesNotThrow(() => loadPagesConfig(pagesRepo({})));
  assert.doesNotThrow(() => loadPagesConfig(pagesRepo({ accent: '#123456' })));
});

test('an accent_dark that is not #rgb or #rrggbb fails naming accent_dark', () => {
  const bad = ['', '#', '#ab', '#abcd', '#abcde', '#abcdefa', 'abcdef', '#ggg', '#12345g', 'red', ' #abc', '#abc ', '#abc;x:y'];
  for (const value of bad) {
    assert.throws(() => loadPagesConfig(pagesRepo({ accent_dark: value })), /accent_dark/, `accent_dark ${JSON.stringify(value)}`);
  }
});

test('an accent_dark of the wrong type fails naming accent_dark', () => {
  for (const value of [null, 123, true, ['#abc'], { hex: '#abc' }]) {
    assert.throws(() => loadPagesConfig(pagesRepo({ accent_dark: value })), /accent_dark/, `accent_dark ${JSON.stringify(value)}`);
  }
});

test('the unknown-field rule still holds next to accent_dark', () => {
  assert.throws(() => loadPagesConfig(pagesRepo({ accent_dark: '#abc', accent_darker: '#abc' })), /accent_darker/);
});

// ---------------------------------------------------------------- theme.js: the three-state cycle

const landingState = (page) => page.eval(`({
  theme: window.siteTheme.get(), dataTheme: document.documentElement.getAttribute('data-theme'),
  resolved: document.documentElement.getAttribute('data-theme-resolved'), stored: localStorage.getItem('theme') })`);

// The resolved theme each press shows, from auto, on a system in `scheme`.
async function landingCycle(scheme, press) {
  return withPage(landingPage(), { scheme }, async (page) => {
    const seen = [await landingState(page)];
    for (let i = 0; i < 3; i++) {
      await press(page);
      seen.push(await landingState(page));
    }
    return seen;
  });
}

const callNext = async (page) => { await page.eval('window.siteTheme.next()'); await page.settle(); };
const clickButton = async (page) => { await page.eval('document.getElementById("theme").click()'); await page.settle(); };

[['light', ['auto', 'dark', 'light', 'auto']], ['dark', ['auto', 'light', 'dark', 'auto']]].forEach(([scheme, order]) => {
  test(`theme.js on a ${scheme} system cycles ${order.join(' -> ')}`, async () => {
    const seen = await landingCycle(scheme, callNext);
    assert.deepEqual(seen.map((s) => s.theme), order);
  });

  test(`theme.js on a ${scheme} system: the first press from auto changes the theme shown`, async () => {
    const [before, after] = await landingCycle(scheme, callNext);
    assert.equal(before.resolved, scheme);
    assert.notEqual(after.resolved, scheme, 'the first press from auto left the page in the same theme');
  });

  test(`theme.js on a ${scheme} system: the page's #theme button follows the same cycle`, async () => {
    const seen = await landingCycle(scheme, clickButton);
    assert.deepEqual(seen.map((s) => s.theme), order);
  });

  test(`theme.js on a ${scheme} system stores each step under the theme key`, async () => {
    const seen = await landingCycle(scheme, callNext);
    assert.deepEqual(seen.slice(1, 3).map((s) => s.stored), order.slice(1, 3));
    assert.ok(!['light', 'dark'].includes(seen[3].stored), `back at auto the key still holds ${seen[3].stored}`);
  });
});

// From an explicit choice the cycle goes on in the same order: the system's own theme is the
// last step before auto.
[['light', 'light', 'auto'], ['light', 'dark', 'light'], ['dark', 'dark', 'auto'], ['dark', 'light', 'dark']].forEach(([scheme, stored, next]) => {
  test(`theme.js on a ${scheme} system with ${stored} stored: the next press gives ${next}`, async () => {
    const theme = await withPage(landingPage(), { scheme, stored }, async (page) => {
      assert.equal((await landingState(page)).theme, stored);
      await callNext(page);
      return (await landingState(page)).theme;
    });
    assert.equal(theme, next);
  });
});

// ---------------------------------------------------------------- theme.js: data-theme-resolved

test('data-theme-resolved names the system theme in auto, and follows the media query', async () => {
  await withPage(landingPage(), { scheme: 'light' }, async (page) => {
    assert.equal((await landingState(page)).resolved, 'light');
    await page.system('dark');
    assert.equal((await landingState(page)).resolved, 'dark');
    await page.system('light');
    assert.equal((await landingState(page)).resolved, 'light');
  });
});

test('data-theme-resolved names an explicit choice, whatever the system theme', async () => {
  for (const [stored, scheme] of [['light', 'dark'], ['dark', 'light']]) {
    await withPage(landingPage(), { scheme, stored }, async (page) => {
      assert.equal((await landingState(page)).resolved, stored, `${stored} stored on a ${scheme} system`);
      await page.system(stored);
      await page.system(scheme);
      assert.equal((await landingState(page)).resolved, stored, `${stored} after the system flipped`);
    });
  }
});

test('data-theme-resolved changes with each press', async () => {
  const seen = await landingCycle('light', callNext);
  assert.deepEqual(seen.map((s) => s.resolved), ['light', 'dark', 'light', 'light']);
});

test('data-theme-resolved follows the system again after a press returns to auto', async () => {
  await withPage(landingPage(), { scheme: 'dark', stored: 'dark' }, async (page) => {
    await callNext(page);
    assert.equal((await landingState(page)).theme, 'auto');
    await page.system('light');
    assert.equal((await landingState(page)).resolved, 'light');
  });
});

test('any other stored value means auto, and data-theme-resolved names the system theme', async () => {
  for (const stored of ['sepia', '', 'Dark']) {
    const s = await withPage(landingPage(), { scheme: 'dark', stored }, landingState);
    assert.equal(s.theme, 'auto', `theme=${JSON.stringify(stored)}`);
    assert.equal(s.resolved, 'dark', `theme=${JSON.stringify(stored)}`);
  }
});

// ---------------------------------------------------------------- the docs: the same three states

// The docs page's theme control: the one visible button whose name, title or text speaks of the
// theme or appearance, found once the page has hydrated.
const DOCS_CONTROL = `(() => {
  const shown = (n) => { const r = n.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right < 0 || r.left > innerWidth || r.bottom < 0 || r.top > innerHeight) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && (hit === n || n.contains(hit)); };
  const named = (b) => /theme|appearance/i.test([b.getAttribute('aria-label'), b.title, b.textContent].join(' '));
  return Array.from(document.querySelectorAll('button')).filter(shown).find(named) || null; })()`;

const docsShown = async (page) => page.eval(`({ bg: getComputedStyle(document.body).backgroundColor, stored: localStorage.getItem('theme') })`);
const shownMode = (bg) => {
  const rgb = parseColour(bg);
  const near = (canvas) => rgb.every((c, i) => Math.abs(c - canvas[i]) <= COLOUR_TOLERANCE);
  if (near(CANVAS.light)) return 'light';
  return near(CANVAS.dark) ? 'dark' : `neither canvas (${bg})`;
};

async function openDocs(opts) {
  const page = await openPage(builtDocs('plain').url, opts);
  await page.waitFor(`document.getElementById('app') && document.getElementById('app').__vue_app__ && ${DOCS_CONTROL}`, 'the docs theme control');
  return page;
}

async function pressDocsControl(page) {
  const { x, y } = await page.eval(`(() => { const r = ${DOCS_CONTROL}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(x, y);
  return docsShown(page);
}

async function docsCycle(opts) {
  const page = await openDocs(opts);
  try {
    const seen = [await docsShown(page)];
    for (let i = 0; i < 3; i++) seen.push(await pressDocsControl(page));
    return seen;
  } finally {
    await page.close();
  }
}

[['light', ['dark', 'light']], ['dark', ['light', 'dark']]].forEach(([scheme, explicit]) => {
  test(`the docs control on a ${scheme} system cycles auto -> ${explicit.join(' -> ')} -> auto on the theme key`, async () => {
    const seen = await docsCycle({ scheme });
    assert.deepEqual(seen.slice(1, 3).map((s) => s.stored), explicit);
    assert.ok(!['light', 'dark'].includes(seen[3].stored), `the third press left theme=${seen[3].stored}, not auto`);
  });

  test(`the docs control on a ${scheme} system shows ${scheme} -> ${explicit.join(' -> ')} -> ${scheme}`, async () => {
    const seen = await docsCycle({ scheme });
    assert.deepEqual(seen.map((s) => shownMode(s.bg)), [scheme, ...explicit, scheme]);
  });
});

test('the docs control returns to auto, and the docs then follow the system theme', async () => {
  const page = await openDocs({ scheme: 'light', stored: 'light' });
  try {
    const after = await pressDocsControl(page);
    assert.ok(!['light', 'dark'].includes(after.stored), `light on a light system went to theme=${after.stored}, not auto`);
    await page.system('dark');
    assert.equal(shownMode((await docsShown(page)).bg), 'dark');
  } finally {
    await page.close();
  }
});

test('the docs control goes on from a choice stored by the landing page', async () => {
  const page = await openDocs({ scheme: 'light', stored: 'dark' });
  try {
    assert.equal((await pressDocsControl(page)).stored, 'light');
  } finally {
    await page.close();
  }
});

test('auto chosen in the docs opens the landing page in auto', async () => {
  const page = await openDocs({ scheme: 'dark', stored: 'dark' });
  try {
    await pressDocsControl(page);
    const stored = await page.storage();
    const landing = await withPage(landingPage(), { scheme: 'light', stored: stored ?? '' }, landingState);
    assert.equal(landing.theme, 'auto');
    assert.equal(landing.resolved, 'light');
  } finally {
    await page.close();
  }
});

// ---------------------------------------------------------------- the docs: the accent pair

// The brand colours a docs page resolves in the mode the stored theme picks.
async function docsBrand(name, mode) {
  return withPage(builtDocs(name).url, { stored: mode }, (page) => page.eval(`(() => {
    const out = {};
    for (const v of ['--vp-c-brand-1', '--vp-c-brand-2', '--vp-c-brand-soft']) {
      const s = document.createElement('span'); s.style.color = 'var(' + v + ')'; document.body.append(s);
      out[v] = getComputedStyle(s).color; s.remove();
    }
    return out; })()`));
}

test('docs-build uses accent as the light brand colour and accent_dark as the dark one', async () => {
  const light = await docsBrand('pair', 'light');
  const dark = await docsBrand('pair', 'dark');
  assertColour(light['--vp-c-brand-1'], hexToRgb(LIGHT.at), 'light --vp-c-brand-1');
  assertColour(dark['--vp-c-brand-1'], hexToRgb(DARK.at), 'dark --vp-c-brand-1');
});

test('the hover and soft shades are mixed from each mode\'s own accent, as today', async () => {
  const light = await docsBrand('pair', 'light');
  const dark = await docsBrand('pair', 'dark');
  const [l, d] = [hexToRgb(LIGHT.at), hexToRgb(DARK.at)];
  assertColour(light['--vp-c-brand-2'], mix(l, [0, 0, 0], 0.85), 'light hover (--vp-c-brand-2)');
  assertColour(dark['--vp-c-brand-2'], mix(d, [255, 255, 255], 0.85), 'dark hover (--vp-c-brand-2)');
  assertColour(light['--vp-c-brand-soft'], mix(l, CANVAS.light, 0.15), 'light --vp-c-brand-soft');
  assertColour(dark['--vp-c-brand-soft'], mix(d, CANVAS.dark, 0.18), 'dark --vp-c-brand-soft');
});

test('with no accent and no accent_dark the docs keep the default green pair', async () => {
  const light = await docsBrand('plain', 'light');
  const dark = await docsBrand('plain', 'dark');
  assertColour(light['--vp-c-brand-1'], hexToRgb('#1e7d69'), 'light --vp-c-brand-1');
  assertColour(light['--vp-c-brand-2'], hexToRgb('#19695a'), 'light --vp-c-brand-2');
  assertColour(dark['--vp-c-brand-1'], hexToRgb('#4fd1b5'), 'dark --vp-c-brand-1');
  assertColour(dark['--vp-c-brand-2'], hexToRgb('#3cbfa3'), 'dark --vp-c-brand-2');
});

// ---------------------------------------------------------------- the docs: the contrast warning

test(`an accent pair at ${MIN_CONTRAST}:1 against each mode's canvas builds with no accent warning`, () => {
  assert.deepEqual(accentWarnings(builtDocs('pair')), []);
});

test('the default accent builds with no accent warning', () => {
  assert.deepEqual(accentWarnings(builtDocs('plain')), []);
});

test(`a light accent just below ${MIN_CONTRAST}:1 on the light canvas warns, and the build still succeeds`, () => {
  const build = builtDocs('lightlow');
  assert.ok(accentWarnings(build).length > 0, `no ::warning about ${LIGHT.past} on the light canvas:\n${build.output}`);
});

test(`an accent_dark just below ${MIN_CONTRAST}:1 on the dark canvas warns, and the build still succeeds`, () => {
  const build = builtDocs('darklow');
  assert.ok(accentWarnings(build).length > 0, `no ::warning about ${DARK.past} on the dark canvas:\n${build.output}`);
});

// ---------------------------------------------------------------- <site-nav>: --site-accent-dark

function siteNav(config) {
  const json = JSON.stringify({ name: 'Octo', ...config }).replace(/</g, '\\u003c');
  return `<site-nav><script type="application/json">${json}</script></site-nav>`;
}

const rootAccent = (page) => page.eval(`({
  light: document.documentElement.style.getPropertyValue('--site-accent').trim(),
  dark: document.documentElement.style.getPropertyValue('--site-accent-dark').trim() })`);

async function navAccent(config) {
  const url = landingPage({ nav: siteNav(config) });
  return withPage(url, {}, async (page) => {
    await page.waitFor('document.querySelector("site-nav").shadowRoot', 'site-nav to render');
    return rootAccent(page);
  });
}

test('<site-nav> sets --site-accent-dark from accent_dark, next to --site-accent', async () => {
  for (const [accent, dark] of [['#c0392b', '#ff8877'], ['#123', '#abc']]) {
    const got = await navAccent({ accent, accent_dark: dark });
    assert.equal(got.light.toLowerCase(), accent, 'accent');
    assert.equal(got.dark.toLowerCase(), dark, 'accent_dark');
  }
});

test('<site-nav> sets no --site-accent-dark from a value that is not #rgb or #rrggbb', async () => {
  for (const dark of ['red', '#abcd', 'url(x)', '#abc;color:red', 12]) {
    const got = await navAccent({ accent: '#c0392b', accent_dark: dark });
    assert.equal(got.dark, '', `accent_dark ${JSON.stringify(dark)}`);
  }
});
