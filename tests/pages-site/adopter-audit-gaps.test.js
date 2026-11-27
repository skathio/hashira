// Gaps found when the v3.4.0 Pages work was read against its request, clause by clause:
//
// - docs-build's local CLI took `--pre-build` with `--check` and dropped it without a word, and
//   `--check` did not print the accent contrast warnings a build prints, so a local check and CI
//   could disagree about the same pages.json.
// - The docs showed a `deploy: false` call of pages-site.yml whose job granted `contents: read`
//   alone. GitHub checks, before a run starts, that the calling job grants what every job of the
//   called workflow asks for, the skipped `deploy` job included, so that run would never start.
//
// Run with:
//   node --test tests/pages-site/adopter-audit-gaps.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const CLI = path.join(REPO, '.github', 'actions', 'docs-build', 'lib', 'cli.js');
const { parseArgs } = require(CLI);

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ---------------------------------------------------------------- the docs-build CLI

function fixtureRepo(pages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gaps-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.github'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, '.github', 'pages.json'), JSON.stringify(pages));
  fs.writeFileSync(path.join(root, 'docs', 'getting-started.md'), '# Start\n');
  return root;
}

function check(root, args = ['--check']) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'owner/site' } });
}

test('parseArgs refuses --pre-build with --check, in either order, and an empty one too', () => {
  for (const argv of [['--check', '--pre-build', 'make docs'], ['--pre-build', 'make docs', '--check'], ['--check', '--pre-build', '']]) {
    assert.throws(() => parseArgs(argv), /--pre-build goes with --out/, JSON.stringify(argv));
  }
});

test('parseArgs still takes --out with --pre-build, an empty one included (action.yml always passes it)', () => {
  assert.deepEqual(parseArgs(['--out', 'o', '--pre-build', '']), { check: false, out: 'o', preBuild: '' });
  assert.deepEqual(parseArgs(['--pre-build', 'x', '--out', 'o']), { check: false, out: 'o', preBuild: 'x' });
});

test('--check with --pre-build exits non-zero and runs nothing', () => {
  const root = fixtureRepo({ name: 'site' });
  const marker = path.join(root, 'ran');
  const run = check(root, ['--check', '--pre-build', `touch ${JSON.stringify(marker)}`]);
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(run.stderr, /::error::docs-build: --pre-build goes with --out/);
  assert.ok(!fs.existsSync(marker), 'the pre-build command ran');
});

test('--check warns, and still passes, when an accent is below 4.5:1 in its mode', () => {
  const run = check(fixtureRepo({ name: 'site', accent: '#ffff00', accent_dark: '#000033' }));
  assert.equal(run.status, 0, run.stderr);
  const warnings = run.stdout.split('\n').filter((l) => l.startsWith('::warning::'));
  assert.equal(warnings.length, 2, run.stdout);
  assert.match(warnings[0], /accent #ffff00 .*light canvas/);
  assert.match(warnings[1], /accent_dark #000033 .*dark canvas/);
});

test('--check prints no warning for the default accent pair or a readable pair', () => {
  for (const pages of [{ name: 'site' }, { name: 'site', accent: '#0b5d4d', accent_dark: '#7fe3cd' }]) {
    const run = check(fixtureRepo(pages));
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /::warning::/);
  }
});

// ---------------------------------------------------------------- caller grants in the docs

// The grants pages-site.yml's jobs ask for, from the workflow itself.
function grantsAsked() {
  const text = read('.github/workflows/pages-site.yml');
  const jobs = text.slice(text.indexOf('\njobs:'));
  return [...new Set([...jobs.matchAll(/^ {6}([a-z-]+): (read|write)\b/gm)].map((m) => `${m[1]}: ${m[2]}`))].sort();
}

// Each job of a fenced YAML example that calls pages-site.yml and states its grants, as text. A
// fragment that shows only `with:` or `secrets:` states none and is not a whole caller.
function callerJobs(markdown) {
  const jobs = [];
  for (const [, block] of markdown.matchAll(/```ya?ml\n([\s\S]*?)```/g)) {
    for (const job of block.split(/^(?= {2}[\w-]+:\s*$)/m)) {
      if (/^\s+uses:\s+\S*\/pages-site\.yml@/m.test(job) && /^\s+permissions:/m.test(job)) jobs.push(job);
    }
  }
  return jobs;
}

test('pages-site.yml asks for contents: read, pages: write and id-token: write across its jobs', () => {
  assert.deepEqual(grantsAsked(), ['contents: read', 'id-token: write', 'pages: write']);
});

for (const doc of ['docs/flows/pages.md', 'docs/catalog.md', 'README.md', 'docs/getting-started.md', 'docs/usage.md']) {
  test(`every pages-site.yml caller example in ${doc} grants what its jobs ask for, deploy: false included`, () => {
    for (const job of callerJobs(read(doc))) {
      for (const grant of grantsAsked()) {
        assert.ok(job.includes(grant), `a pages-site.yml caller job in ${doc} does not grant ${grant}; GitHub would refuse to start the run:\n${job}`);
      }
    }
  });
}

test('pages.md has a deploy: false example and says why it still names the deploy grants', () => {
  const md = read('docs/flows/pages.md');
  assert.ok(callerJobs(md).some((job) => /deploy: false/.test(job)), 'no deploy: false caller example');
  assert.match(md, /nested job/i, 'the startup check of a called workflow\'s grants is not explained');
  assert.doesNotMatch(md, /`contents: read` alone/);
  assert.doesNotMatch(read('docs/catalog.md'), /`contents: read` alone/);
});

// ---------------------------------------------------------------- pages-site.yml, read as YAML

function yamlOf(rel) {
  const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))';
  const r = spawnSync('python3', ['-c', py, path.join(REPO, rel)], { encoding: 'utf8' });
  assert.equal(r.status, 0, `PyYAML could not read ${rel}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const PAGES_SITE = '.github/workflows/pages-site.yml';
const stepsOf = (rel, job) => yamlOf(rel).jobs[job].steps;
const isSetupNode = (step) => /^actions\/setup-node@/.test(step.uses ?? '');
const condition = (step) => String(step.if ?? '').replace(/^\$\{\{\s*|\s*\}\}$/g, '');

// setup-node's post step saves the npm cache folder. Only the docs build is sure to fill it:
// with `docs: false` a missing folder fails the post step, and a near-empty one would be saved
// under the key the repo's docs builds share.
test('the build caches npm only when it builds the docs, and still sets Node up without them', () => {
  const nodes = stepsOf(PAGES_SITE, 'build').filter(isSetupNode);
  const cached = nodes.filter((s) => s.with && 'cache' in s.with);
  const plain = nodes.filter((s) => !(s.with && 'cache' in s.with));
  assert.equal(cached.length, 1, 'one setup-node step with a cache');
  assert.equal(condition(cached[0]), 'inputs.docs');
  assert.equal(plain.length, 1, 'one setup-node step with no cache');
  assert.equal(condition(plain[0]), '!inputs.docs');
  for (const step of nodes) assert.equal(step.with['node-version'], '${{ inputs.node_version }}');
  assert.equal(cached[0].uses, plain[0].uses, 'the two steps pin different setup-node commits');
});

// ---------------------------------------------------------------- the step summary line

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A repo with `commits` commits, the first tagged with `tag` when one is given.
function taggedRepo(commits, tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gaps-git-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  for (let i = 0; i < commits; i += 1) {
    git(root, 'commit', '-q', '--allow-empty', '-m', `c${i}`);
    if (i === 0 && tag) git(root, 'tag', tag);
  }
  return root;
}

// Runs the `source` job's own script with bash, the way a runner does, and returns the summary.
function summaryOf(root, env) {
  const step = stepsOf(PAGES_SITE, 'source').find((s) => s.id === 'pick');
  const summary = path.join(root, '.git', 'summary.md');
  const output = path.join(root, '.git', 'output.txt');
  fs.rmSync(summary, { force: true });
  const r = spawnSync('bash', ['-eo', 'pipefail', '-c', step.run], {
    cwd: root, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, SOURCE: 'main', DEPLOY: 'true', REF_NAME: 'main', SHA: git(root, 'rev-parse', 'HEAD'), GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, ...env },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return fs.readFileSync(summary, 'utf8');
}

const DEPLOYING = /deploying (\S+)@([0-9a-f]{40}), (\d+) commits? after (v\d+\.\d+\.\d+)\n/;

for (const [label, env, ref] of [
  ['a deploy', {}, 'main'],
  ['a deploy: false run', { DEPLOY: 'false' }, 'main'],
  ['a deploy: false run on a pull request ref', { DEPLOY: 'false', REF_NAME: '7/merge' }, '7/merge'],
  ['source: latest-release', { SOURCE: 'latest-release' }, 'v1.2.3'],
]) {
  test(`the summary of ${label} holds "deploying <ref>@<sha>, N commits after <tag>"`, () => {
    const root = taggedRepo(3, 'v1.2.3');
    const line = summaryOf(root, env).match(DEPLOYING);
    assert.ok(line, summaryOf(root, env));
    const released = env.SOURCE === 'latest-release';
    assert.deepEqual(line.slice(1), [ref, git(root, 'rev-parse', released ? 'v1.2.3^{commit}' : 'HEAD'), released ? '0' : '2', 'v1.2.3']);
  });
}

test('a deploy: false summary says in front of the line that nothing is deployed, and a deploy does not', () => {
  const root = taggedRepo(2, 'v1.2.3');
  assert.match(summaryOf(root, { DEPLOY: 'false' }), /build only \(deploy: false\), not deploying main@/);
  assert.doesNotMatch(summaryOf(root, {}), /not deploying|build only/);
});

test('a branch name cannot add Markdown or links to the summary', () => {
  const summary = summaryOf(taggedRepo(2, 'v1.2.3'), { DEPLOY: 'false', REF_NAME: 'x](https://example.test)`*' });
  assert.match(summary, /not deploying x__https_\/\/example\.test___@[0-9a-f]{40}, 1 commit after v1\.2\.3\n/);
  assert.doesNotMatch(summary, /\]\(|`/);
});

test('one commit after the tag is "1 commit", and a repo with no vX.Y.Z tag says so', () => {
  assert.match(summaryOf(taggedRepo(2, 'v1.2.3'), {}), /, 1 commit after v1\.2\.3\n/);
  assert.match(summaryOf(taggedRepo(2, 'nightly'), {}), /deploying main@[0-9a-f]{40}, no vX\.Y\.Z tag yet\n/);
});

// ---------------------------------------------------------------- the release's scan before any tag

const disabledScans = (text) => String(text).split(',').map((s) => s.trim()).filter(Boolean).sort();

// release.yml deploys the site through site.yml after the tags and the Release are pushed, and
// pages-site.yml's `scan` fails closed there. The same scan has to pass before `publish`, or a
// finding leaves a release published with its site not deployed.
test('release.yml runs the site deploy\'s scan, failing on findings, in a job publish waits for', () => {
  const release = yamlOf('.github/workflows/release.yml');
  const inputs = yamlOf(PAGES_SITE).on?.workflow_call?.inputs ?? yamlOf(PAGES_SITE).true.workflow_call.inputs;
  const siteCall = Object.values(yamlOf('.github/workflows/site.yml').jobs).find((j) => /pages-site\.yml$/.test(j.uses ?? ''));
  for (const name of ['scan_disable', 'scan_fail_on_findings', 'source']) {
    assert.ok(!(name in (siteCall.with ?? {})), `site.yml sets ${name}; the release's scan must follow it`);
  }
  assert.equal(inputs.scan_fail_on_findings.default, true);
  const siteScan = disabledScans(`codeql,${inputs.scan_disable.default}`);
  const before = [].concat(release.jobs.publish.needs);
  const scans = before.flatMap((job) => release.jobs[job].steps.filter((s) => /scan-suite$/.test(s.uses ?? '')).map((s) => ({ job, ...s.with })));
  const same = scans.filter((s) => JSON.stringify([...new Set(disabledScans(s.scan_disable))]) === JSON.stringify([...new Set(siteScan)]));
  assert.equal(same.length, 1, `no step before publish disables exactly ${siteScan}: ${JSON.stringify(scans)}`);
  assert.equal(same[0].fail_on_findings, 'true');
  assert.ok(!('osv_paths' in same[0]) && !('gitleaks_config' in same[0]), 'the scan must cover what the site deploy\'s scan covers');
  assert.equal(release.jobs[same[0].job].permissions.contents, 'read');
  assert.deepEqual(Object.keys(release.jobs[same[0].job].permissions), ['contents']);
});

// ---------------------------------------------------------------- data-theme-resolved on the docs pages

const { themeFromLanding } = require(path.join(REPO, '.github', 'actions', 'docs-build', 'lib', 'theme-bridge.js'));
const vm = require('node:vm');

// A stand-in <html>, storage and media query, enough to run the docs' inline head script.
function runBridge({ stored, systemDark, storage = true, observer = true }) {
  const attrs = {};
  const classes = new Set();
  const observers = [];
  const root = {
    classList: {
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); observers.forEach((fn) => fn()); },
      contains: (name) => classes.has(name),
    },
    setAttribute: (name, value) => { attrs[name] = value; },
  };
  const store = { theme: stored };
  const localStorage = {
    getItem: (key) => { if (!storage) throw new Error('blocked'); return store[key] ?? null; },
    setItem: (key, value) => { if (!storage) throw new Error('blocked'); store[key] = value; },
  };
  class MutationObserver {
    constructor(fn) { this.fn = fn; }
    observe(target, options) {
      assert.equal(target, root);
      assert.equal(JSON.stringify(options), JSON.stringify({ attributes: true, attributeFilter: ['class'] }));
      observers.push(this.fn);
    }
  }
  const window = { matchMedia: () => ({ matches: systemDark }), ...(observer ? { MutationObserver } : {}) };
  vm.runInNewContext(themeFromLanding, { document: { documentElement: root }, window, localStorage, ...(observer ? { MutationObserver } : {}) });
  return { attrs, root, store };
}

const BRIDGE_CASES = [
  [{ stored: undefined, systemDark: false }, 'light'],
  [{ stored: undefined, systemDark: true }, 'dark'],
  [{ stored: 'light', systemDark: true }, 'light'],
  [{ stored: 'dark', systemDark: false }, 'dark'],
  [{ stored: 'sepia', systemDark: true }, 'dark'],
  [{ stored: 'dark', systemDark: false, storage: false }, 'light'],
  [{ stored: undefined, systemDark: true, observer: false }, 'dark'],
];

for (const [given, want] of BRIDGE_CASES) {
  test(`the docs head script sets data-theme-resolved="${want}" for ${JSON.stringify(given)}`, () => {
    const page = runBridge(given);
    assert.equal(page.attrs['data-theme-resolved'], want);
    assert.equal(page.root.classList.contains('dark'), want === 'dark', 'the attribute and the dark class disagree');
  });
}

test('on the docs data-theme-resolved follows the dark class as VitePress moves it', () => {
  const page = runBridge({ stored: undefined, systemDark: false });
  page.root.classList.toggle('dark', true);
  assert.equal(page.attrs['data-theme-resolved'], 'dark');
  page.root.classList.toggle('dark', false);
  assert.equal(page.attrs['data-theme-resolved'], 'light');
});

test('the docs head script still stores the choice under VitePress\'s key', () => {
  assert.equal(runBridge({ stored: 'dark', systemDark: false }).store['vitepress-theme-appearance'], 'dark');
  assert.equal(runBridge({ stored: 'sepia', systemDark: false }).store['vitepress-theme-appearance'], 'auto');
});

// ---------------------------------------------------------------- what the docs say about them

test('pages.md says a fork or Dependabot pull request may not start a deploy: false call, and what to use', () => {
  const md = read('docs/flows/pages.md');
  const para = md.split(/\n\n/).find((p) => /fork/.test(p) && /Dependabot/.test(p));
  assert.ok(para, 'no paragraph on fork and Dependabot pull requests');
  assert.match(para, /read-only token/);
  assert.match(para, /\(#your-own-build\)/);
  assert.match(md, /^#+ .*Your own build/m);
});

test('pages.md and the changelog name the build-only summary text and the docs\' data-theme-resolved', () => {
  for (const doc of ['docs/flows/pages.md', 'CHANGELOG.md']) {
    const text = read(doc).replace(/\s+/g, ' ');
    assert.match(text, /build only \(deploy: false\), not/, doc);
    assert.match(text, /docs pages set/, doc);
  }
});
