// The user's rules for moving hashira's own site onto the new pieces (brief requirements 22-24,
// the acceptance lines for this milestone, and the earlier rules for hashira's site that carry
// over): site.yml calls pages-site.yml, .github/pages.json describes the docs, site/index.html
// uses the kit, docs-site/ is gone, every URL and anchor of today's /hashira/ and /hashira/docs/
// still resolves, the existing workflows and actions keep their inputs, and the docs and README
// cover the new pieces.
//
// The build cases build hashira's own site the way site.yml does: they read the `with:` that
// site.yml passes to pages-site.yml, run pages-site.yml's site step, then the run steps of
// site-kit and docs-build, on a copy of this repo in a temporary folder. The docs build installs
// VitePress from hashira's lockfile, so the first run needs network access once.
//
// Today's URLs and heading anchors were taken from the docs-site/ build of commit 7059e26, the
// last one before the move.
//
// Run with:
//   node --test tests/pages-site/hashira-site-rules.test.js
//
// Left to the builder, so not tested here: whether release.yml keeps building the docs and how,
// the landing's own markup and nav items beyond what pages.json gives, where the kit files are
// referenced from, and the theme toggle's id. A live run, the production approval, the real
// Pages deploy and the release itself belong to the maintainer.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const WORKFLOWS = path.join(REPO, '.github', 'workflows');
const ACTIONS = path.join(REPO, '.github', 'actions');
const SITE_YML = path.join(WORKFLOWS, 'site.yml');
const PAGES_SITE_YML = path.join(WORKFLOWS, 'pages-site.yml');
const PAGES_MD = path.join(REPO, 'docs', 'flows', 'pages.md');
const README = path.join(REPO, 'README.md');
const INDEX_HTML = path.join(REPO, 'site', 'index.html');
const BASELINE_TAG = 'v3.2.0';
const OWNER_REPO = 'skathio/hashira';
const ORIGIN = 'https://skathio.github.io';
const BUILD_TIMEOUT = 900_000;

// Today's files under /hashira/, apart from the docs' hashed assets.
const TODAY_FILES = [
  'index.html', 'mark.svg', 'theme.js',
  'users/hinokami.svg', 'users/maneki.svg', 'users/rogue.svg', 'users/skathio.svg', 'users/somi.svg',
  'docs/index.html', 'docs/404.html', 'docs/usage.html', 'docs/catalog.html', 'docs/migration-v2-to-v3.html',
  'docs/flows/npm.html', 'docs/flows/nuget.html', 'docs/flows/static-webapp.html',
];

// The landing page's section anchors and its Docs links today.
const LANDING_ANCHORS = ['flows', 'use', 'security', 'users', 'docs'];
const LANDING_DOCS_LINKS = [
  'docs/', 'docs/usage.html', 'docs/flows/npm.html', 'docs/flows/nuget.html', 'docs/flows/static-webapp.html',
  'docs/catalog.html', 'docs/migration-v2-to-v3.html',
];

// Today's sidebar order (docs-site/.vitepress/config.mts).
const TODAY_SIDEBAR = [
  'getting-started.md', 'usage.md', 'flows/npm.md', 'flows/nuget.md', 'flows/static-webapp.md', 'catalog.md',
  'migration-v2-to-v3.md',
];
const PUBLISHED_TODAY = {
  'getting-started.md': 'index.html', 'usage.md': 'usage.html', 'catalog.md': 'catalog.html',
  'migration-v2-to-v3.md': 'migration-v2-to-v3.html', 'flows/npm.md': 'flows/npm.html',
  'flows/nuget.md': 'flows/nuget.html', 'flows/static-webapp.md': 'flows/static-webapp.html',
};

// Heading ids of each docs page today, by built page under /hashira/docs/.
const DOCS_ANCHORS = {
  "index.html": [
    "getting-started", "1-choose-a-flow", "2-copy-the-caller", "3-pin-the-library",
    "4-set-up-the-gate-and-the-registry", "packages-the-production-environment",
    "packages-oidc-trusted-publishing", "static-sites-pages-and-the-github-pages-environment",
    "5-cut-the-first-release", "next-steps",
  ],
  "usage.html": [
    "using-hashira", "versioning-model", "how-a-release-version-is-determined",
    "stamp-only--no-commit-back", "what-this-replaces", "gate-model",
    "why-a-composite-action-not-a-reusable-workflow-for-cd",
    "atomicity--tagrelease-creation-happens-only-after-a-successful-publish", "release-notes",
    "environment-reviewer-gate--what-the-library-can-and-cannot-verify", "not-workflow_run",
    "auth-model--auth-oidc--token--auto", "pin-policy",
    "recommended-pin-shapes-in-increasing-order-of-integrity-tightness",
    "the-library-self-checkout", "secret-passing-model", "permissions-baseline",
    "extension-contract", "maintainer-axis--adding-a-new-flow",
    "consumer-composition-axis--custom-jobs-alongside-the-shared-ci",
    "required-check--path-filter-deadlock", "the-ci--passed-check", "the-ci-summary-comment",
    "additive-only-v1x-evolution-rule", "x_-prefix-experimental-input-convention",
    "environment-configuration-adoption-checklist", "oidc-trust-onboarding", "scan-suite-toggles",
    "default-value", "enabling-everything", "disabling-additional-scans",
    "findings-fail-the-scan-suite-job", "permissions-asymmetry-note", "coverage-reporting",
    "supported-formats", "coverage_path-input", "sticky-comment-mechanism",
    "codecov--external-coverage-services",
  ],
  "catalog.html": [
    "catalog", "reusable-workflows", "npm-package-ciyml", "nuget-package-ciyml",
    "static-webapp-ciyml", "composite-actions", "npm-release", "nuget-push", "pages-deploy",
    "pages-upload", "scan-suite", "run-tests-js", "run-tests-dotnet", "coverage-report",
    "quality-gate", "ci-summary", "version-resolver", "dotnet-pack-version",
  ],
  "migration-v2-to-v3.html": [
    "migrating-from-v2-to-v3", "1-the-uses-ref", "2-library_ref-is-removed-all-three-ci-workflows",
    "3-coverage_path-defaults-to--all-three-ci-workflows",
    "4-project_path-is-optional-nuget-package-ciyml",
    "5-bump-and-seed_version-come-from-the-dispatch-npm-and-nuget",
    "6-somis-quality-gate-is-on-by-default-all-three-ci-workflows", "7-permissions",
    "8-static-webapp-one-caller-file",
  ],
  "flows/npm.html": [
    "npm-package-flow--adoption-walk-through", "what-changed-from-v1",
    "release-notes-content-change-d13", "1-caller-workflow-template",
    "2-why-publish-is-a-job-in-your-own-file", "3-input-table", "ci-inputs-npm-package-ciyml",
    "ci-output-npm-package-ciyml", "publish-inputs-npm-release-composite-action",
    "publish-outputs-npm-release", "4-secret-table", "5-permissions-table", "ci-permissions",
    "publish-permissions", "6-oidc-trusted-publisher-onboarding-npm",
    "auth-model--auth-oidc--token--auto", "7-production-environment-setup-checklist",
    "one-time-gh-api-setup-require-a-reviewer-d12", "8-release-walk-through", "release-notes-d13",
    "9-common-failure-modes", "10-pointer-to-docsusagemd",
  ],
  "flows/nuget.html": [
    "nuget-package-flow--adoption-walk-through", "what-changed-from-v1",
    "1-caller-workflow-template", "2-why-publish-is-a-job-in-your-own-file",
    "3-minver-packagereference-snippet", "4-input-table", "ci-inputs-nuget-package-ciyml",
    "ci-output-nuget-package-ciyml", "publish-inputs-nuget-push-composite-action",
    "publish-outputs-nuget-push", "5-secret-table", "6-permissions-table", "ci-permissions",
    "publish-permissions", "7-nuget-trusted-publishing-onboarding-walk-through",
    "71-nugetorg-trusted-publisher-setup-one-time", "72-auth-model--auth-oidc--token--auto",
    "73-api-key-alternative", "8-production-environment-setup-checklist",
    "one-time-gh-api-setup-require-a-reviewer-d12", "9-release-walk-through", "release-notes-d13",
    "10-common-failure-modes", "11-pointer-to-docsusagemd",
  ],
  "flows/static-webapp.html": [
    "static-webapp-flow--adoption-walk-through", "what-changed-from-v1",
    "1-main-caller-workflow-template", "security-callout--pin-uses-to-a-sha",
    "3-github-pages-enablement-one-time-consumer-setup", "4-input-table",
    "ci-inputs-static-webapp-ciyml", "ci-output-static-webapp-ciyml",
    "deploy-inputs-pages-deploy-composite-action", "deploy-output-pages-deploy",
    "5-fork-pr-guard-b8", "6-permissions-table", "7-github-pages-environment-setup-checklist",
    "one-time-gh-api-setup-require-a-reviewer-d12", "8-supported-framework-guidance",
    "9-common-failure-modes", "10-pointer-to-docsusagemd",
  ],
};

const temps = [];
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const read = (file) => fs.readFileSync(file, 'utf8');

// ---------- YAML, through PyYAML (the shape lints' own parser) ----------

function parseYaml(text, label) {
  const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))';
  const run = spawnSync('python3', ['-c', py], { input: text, encoding: 'utf8' });
  assert.equal(run.status, 0, `could not read ${label}: ${run.stderr}`);
  return JSON.parse(run.stdout) ?? {};
}

const loadYaml = (file) => parseYaml(read(file), file);
const triggersOf = (spec) => spec.on ?? spec.true ?? {};

// ---------- the baseline release, for the inputs that must stay ----------

function gitAt(args) {
  return spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// A shallow CI checkout may lack the tag; it is fetched from the public repo then.
function baselineTree() {
  if (gitAt(['rev-parse', '--verify', '-q', `${BASELINE_TAG}^{commit}`]).status !== 0) {
    gitAt(['fetch', '-q', '--depth=1', `https://github.com/${OWNER_REPO}.git`, `+refs/tags/${BASELINE_TAG}:refs/tags/${BASELINE_TAG}`]);
  }
  const list = gitAt(['ls-tree', '-r', '--name-only', BASELINE_TAG, '.github/workflows', '.github/actions']);
  assert.equal(list.status, 0, `cannot read ${BASELINE_TAG}: ${list.stderr}`);
  return list.stdout.split('\n').filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$|^\.github\/actions\/[^/]+\/action\.ya?ml$/.test(f));
}

const baselineYaml = (rel) => parseYaml(gitAt(['show', `${BASELINE_TAG}:${rel}`]).stdout, `${BASELINE_TAG}:${rel}`);

// Every input, output and secret a file declared at the baseline, keyed by where it sits.
function interfaceOf(spec, isAction) {
  if (isAction) return { inputs: spec.inputs ?? {}, outputs: spec.outputs ?? {} };
  const on = triggersOf(spec);
  return {
    'workflow_call.inputs': on.workflow_call?.inputs ?? {},
    'workflow_call.outputs': on.workflow_call?.outputs ?? {},
    'workflow_call.secrets': on.workflow_call?.secrets ?? {},
    'workflow_dispatch.inputs': on.workflow_dispatch?.inputs ?? {},
  };
}

const norm = (v) => (v === undefined || v === null ? '' : String(v));

// ---------- site.yml and its call of pages-site.yml ----------

const isPagesSiteRef = (ref) => /(^|\/)\.github\/workflows\/pages-site\.yml(@|$)/.test(String(ref ?? ''));

function pagesSiteCall() {
  const jobs = Object.entries(loadYaml(SITE_YML).jobs ?? {}).filter(([, j]) => isPagesSiteRef(j.uses));
  assert.equal(jobs.length, 1, 'site.yml has no single job that calls pages-site.yml');
  return jobs[0][1];
}

// The inputs pages-site.yml sees from site.yml on a hand run: its defaults, then site.yml's with.
function pagesSiteInputs() {
  const declared = triggersOf(loadYaml(PAGES_SITE_YML)).workflow_call?.inputs ?? {};
  const inputs = Object.fromEntries(Object.entries(declared).map(([k, d]) => [k, d.default ?? '']));
  const siteCtx = { inputs: { released: false } };
  for (const [k, v] of Object.entries(pagesSiteCall().with ?? {})) inputs[k] = evaluate(String(v), siteCtx);
  return inputs;
}

// ---------- running workflow and composite steps the way a runner does ----------

function lookup(expr, ctx) {
  const [scope, ...keys] = expr.trim().split('.');
  return keys.reduce((obj, key) => obj?.[key], ctx[scope]);
}

// The expression forms these files use: a context path, a comparison with a quoted string, and
// a ${{ }} inside a longer string.
function exprValue(expr, ctx) {
  const cmp = expr.trim().match(/^([\w.-]+)\s*(==|!=)\s*'([^']*)'$/);
  if (cmp) return (norm(lookup(cmp[1], ctx)) === cmp[3]) === (cmp[2] === '==');
  return lookup(expr, ctx);
}

function evaluate(text, ctx) {
  const whole = text.match(/^\s*\$\{\{([^}]*)\}\}\s*$/);
  if (whole) return exprValue(whole[1], ctx);
  return text.replace(/\$\{\{([^}]*)\}\}/g, (_, expr) => norm(exprValue(expr, ctx)));
}

function stepRuns(step, ctx) {
  if (step.if === undefined) return true;
  const value = evaluate(String(step.if).includes('${{') ? String(step.if) : `\${{ ${step.if} }}`, ctx);
  return value === true || value === 'true';
}

function readOutputs(file) {
  if (!fs.existsSync(file)) return {};
  const pairs = read(file).split('\n').map((l) => l.match(/^([\w-]+)=(.*)$/)).filter(Boolean);
  return Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
}

function runnerEnv(build, outputFile) {
  const keep = Object.entries(process.env).filter(([k]) => !k.startsWith('GITHUB_') && k !== 'NODE_TEST_CONTEXT');
  return {
    ...Object.fromEntries(keep), GITHUB_WORKSPACE: build.ws, GITHUB_REPOSITORY: OWNER_REPO,
    GITHUB_REPOSITORY_OWNER: 'skathio', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_NAME: 'main', GITHUB_SHA: 'c'.repeat(40), GITHUB_OUTPUT: outputFile,
    GITHUB_ENV: path.join(build.outer, 'env'), GITHUB_STEP_SUMMARY: path.join(build.outer, 'summary'),
    RUNNER_TEMP: build.outer, CI: 'true',
  };
}

function runStep(step, ctx, build) {
  const outputFile = path.join(build.outer, `output-${build.count++}`);
  const env = { ...runnerEnv(build, outputFile) };
  for (const [k, v] of Object.entries(step.env ?? {})) env[k] = norm(evaluate(String(v), ctx));
  const script = evaluate(String(step.run), ctx);
  const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script],
    { cwd: build.ws, env, encoding: 'utf8', timeout: BUILD_TIMEOUT });
  build.log += `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.status, 0, `step "${step.name ?? step.id}" failed:\n${build.log.slice(-4000)}`);
  if (step.id) ctx.steps[step.id] = { outputs: readOutputs(outputFile) };
}

function runAction(name, withValues, build) {
  const dir = path.join(ACTIONS, name);
  const spec = loadYaml(path.join(dir, 'action.yml'));
  const inputs = Object.fromEntries(Object.entries(spec.inputs ?? {}).map(([k, d]) => [k, d.default ?? '']));
  Object.assign(inputs, withValues);
  const ctx = { inputs, steps: {}, github: { action_path: dir, workspace: build.ws, repository: OWNER_REPO } };
  for (const step of spec.runs?.steps ?? []) {
    if (step.run && stepRuns(step, ctx)) runStep(step, ctx, build);
  }
}

// A copy of this repo's files (tracked and new, not ignored), as a checkout of main would hold.
function copyRepo(ws) {
  const list = gitAt(['ls-files', '-z', '-co', '--exclude-standard']).stdout.split('\0').filter(Boolean);
  for (const rel of list) {
    const from = path.join(REPO, rel);
    if (!fs.existsSync(from) || !fs.lstatSync(from).isFile()) continue;
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(ws, rel));
  }
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: ws });
}

// Builds hashira's site as site.yml does through pages-site.yml's build job, and returns the
// folder that would be uploaded.
function buildSite() {
  const outer = tempDir('hashira-site-');
  const build = { outer, ws: path.join(outer, 'ws'), count: 0, log: '' };
  fs.mkdirSync(build.ws);
  copyRepo(build.ws);
  const ctx = { inputs: pagesSiteInputs(), steps: {}, github: { workspace: build.ws, repository: OWNER_REPO } };
  const steps = loadYaml(PAGES_SITE_YML).jobs?.build?.steps ?? [];
  const site = steps.find((s) => s.id === 'site');
  assert.ok(site?.run, "pages-site.yml's build job has no `site` step");
  runStep(site, ctx, build);
  for (const step of steps) {
    const name = String(step.uses ?? '').match(/\.github\/actions\/(site-kit|docs-build)$/)?.[1];
    if (!name || !stepRuns(step, ctx)) continue;
    const withValues = Object.fromEntries(Object.entries(step.with ?? {}).map(([k, v]) => [k, norm(evaluate(String(v), ctx))]));
    runAction(name, withValues, build);
  }
  return path.join(build.ws, ctx.steps.site.outputs.output);
}

let cachedBuild;
const built = () => (cachedBuild ??= buildSite());
const builtHtml = (rel) => read(path.join(built(), rel));
const idsOf = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const hrefsOf = (html) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

// The built file a URL on the published site opens, or null when it leaves /hashira/.
function builtFileFor(href, pageRel) {
  const url = new URL(href, `${ORIGIN}/hashira/${pageRel}`);
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/hashira/')) return null;
  const rel = decodeURIComponent(url.pathname.slice('/hashira/'.length));
  return rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel;
}

// ---------- pages.json, through the docs-build loader ----------

function hashiraConfig() {
  const { loadPagesConfig } = require(path.join(ACTIONS, 'docs-build', 'lib', 'pages-config.js'));
  const saved = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = OWNER_REPO;
  try {
    return loadPagesConfig(REPO);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = saved;
  }
}

// ---------- site/index.html ----------

const headOf = (html) => html.match(/<head\b[\s\S]*?<\/head>/i)?.[0] ?? '';
const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
  .slice(1).map((m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']));
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// The <site-nav> items as the element reads them: its inline JSON child, then its attributes.
function siteNavConfig(html) {
  const el = html.match(/<site-nav\b([^>]*)>([\s\S]*?)<\/site-nav>/i);
  assert.ok(el, 'site/index.html has no <site-nav> element');
  const script = el[2].match(/<script\b[^>]*type=["']?application\/json["']?[^>]*>([\s\S]*?)<\/script>/i);
  const config = script ? JSON.parse(script[1]) : {};
  for (const [k, v] of Object.entries(attrsOf(`<x ${el[1]}>`))) {
    const value = unescape(v);
    config[k] = ['nav', 'home_link'].includes(k) ? JSON.parse(value) : value;
  }
  return config;
}

const pick = (entry) => (entry ? { label: entry.label, href: entry.href } : null);

// ==================================================================== requirement 22

// The one setting change v3 allows, by the maintainer's v3.4.0 decision: actionlint runs by
// default in the three CI workflows. Each entry names the exact old and new value, so any
// other change to these inputs still fails.
const DECIDED_CHANGES = Object.fromEntries(
  ['npm-package-ci.yml', 'nuget-package-ci.yml', 'static-webapp-ci.yml'].map((w) => [
    `.github/workflows/${w} workflow_call.inputs scan_disable default`,
    { from: 'codeql,actionlint', to: 'codeql' },
  ]),
);

// Each input and secret `where` held at the baseline is still there, with the same settings.
function assertKept(rel, where, before, after) {
  for (const [name, old] of Object.entries(before ?? {})) {
    const cur = after?.[name];
    assert.ok(cur, `${rel}: ${where} '${name}' was removed`);
    for (const key of ['type', 'default', 'required']) {
      const decided = DECIDED_CHANGES[`${rel} ${where} ${name} ${key}`];
      const expected = decided && norm(old?.[key]) === norm(decided.from) ? decided.to : old?.[key];
      assert.equal(norm(cur[key]), norm(expected), `${rel}: ${where} '${name}' changed its ${key}`);
    }
  }
}

test('every workflow and action of v3.2.0 keeps each input with its type, default and required flag', () => {
  for (const rel of baselineTree()) {
    const isAction = rel.startsWith('.github/actions/');
    assert.ok(fs.existsSync(path.join(REPO, rel)), `${rel} is gone`);
    const before = interfaceOf(baselineYaml(rel), isAction);
    const after = interfaceOf(loadYaml(path.join(REPO, rel)), isAction);
    for (const where of Object.keys(before).filter((w) => !w.endsWith('outputs'))) {
      assertKept(rel, where, before[where], after[where]);
    }
  }
});

test('every workflow and action of v3.2.0 keeps each output', () => {
  for (const rel of baselineTree()) {
    const isAction = rel.startsWith('.github/actions/');
    const before = interfaceOf(baselineYaml(rel), isAction);
    const after = interfaceOf(loadYaml(path.join(REPO, rel)), isAction);
    for (const where of Object.keys(before).filter((w) => w.endsWith('outputs'))) {
      for (const name of Object.keys(before[where] ?? {})) {
        assert.ok(after[where]?.[name], `${rel}: ${where} '${name}' was removed`);
      }
    }
  }
});

test('release.yml still deploys the site through site.yml with released: true', () => {
  const jobs = Object.values(loadYaml(path.join(WORKFLOWS, 'release.yml')).jobs ?? {});
  const call = jobs.find((j) => /(^|\/)\.github\/workflows\/site\.yml(@|$)/.test(String(j.uses ?? '')));
  assert.ok(call, 'release.yml no longer calls site.yml');
  assert.equal(call.with?.released, true, 'release.yml does not pass released: true to site.yml');
});

// ==================================================================== requirement 23: site.yml

test('site.yml calls pages-site.yml from one job', () => {
  assert.ok(isPagesSiteRef(pagesSiteCall().uses));
});

test('site.yml names pages-site.yml in this repo, or in skathio/hashira, never at @main', () => {
  const ref = String(pagesSiteCall().uses);
  assert.ok(ref.startsWith('./.github/workflows/') || ref.startsWith(`${OWNER_REPO}/.github/workflows/`), `${ref} is not hashira's`);
  assert.doesNotMatch(ref, /@main$/);
});

test('site.yml still runs by hand and from release.yml, with released defaulting to false', () => {
  const on = triggersOf(loadYaml(SITE_YML));
  assert.ok('workflow_dispatch' in on, 'site.yml lost its workflow_dispatch trigger');
  const released = on.workflow_call?.inputs?.released;
  assert.ok(released, 'site.yml lost its released input');
  assert.equal(released.type, 'boolean');
  assert.equal(released.default, false);
});

test('site.yml passes its released input on to pages-site.yml', () => {
  const value = String(pagesSiteCall().with?.released ?? '');
  assert.match(value, /^\$\{\{\s*inputs\.released\s*\}\}$/, `released is passed as '${value}'`);
});

test('site.yml is deny-all at the top', () => {
  const perms = loadYaml(SITE_YML).permissions;
  const denyAll = (perms && typeof perms === 'object' && Object.keys(perms).length === 0)
    || (perms && typeof perms === 'object' && Object.keys(perms).length === 1 && perms.contents === 'read');
  assert.ok(denyAll, `site.yml's top-level permissions are ${JSON.stringify(perms)}`);
});

// ==================================================================== requirement 23: pages.json

test('.github/pages.json loads without an error', () => {
  assert.ok(fs.existsSync(path.join(REPO, '.github', 'pages.json')), '.github/pages.json is missing');
  hashiraConfig();
});

test('the docs stay at /hashira/docs/ and open on getting-started.md', () => {
  const config = hashiraConfig();
  assert.equal(config.base, '/hashira/docs/');
  assert.equal(config.home_page, 'getting-started.md');
});

test('contributing.md stays unpublished', () => {
  assert.ok(hashiraConfig().unpublished.includes('contributing.md'));
});

test("the sidebar starts with today's seven guides in today's order", () => {
  const files = hashiraConfig().sidebar.map((e) => e.file);
  assert.deepEqual(files.slice(0, TODAY_SIDEBAR.length), TODAY_SIDEBAR);
});

test("the homepage tile's Docs link is the base the docs are built for", () => {
  const tile = JSON.parse(read(path.join(REPO, '.github', 'homepage.json')));
  assert.equal(tile.links?.Docs, `${ORIGIN}${hashiraConfig().base}`);
});

// ==================================================================== requirement 23: site/index.html

test('site/index.html loads tokens.css, theme.js and site-nav.js from the kit', () => {
  const html = read(INDEX_HTML);
  const sheets = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => attrsOf(m[0])).filter((a) => /stylesheet/i.test(a.rel ?? ''));
  assert.ok(sheets.some((a) => /(^|\/)_kit\/tokens\.css$/.test(a.href ?? '')), 'no stylesheet link to _kit/tokens.css');
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => attrsOf(m[0]).src ?? '');
  assert.ok(scripts.some((s) => /(^|\/)_kit\/theme\.js$/.test(s)), 'no script from _kit/theme.js');
  assert.ok(scripts.some((s) => /(^|\/)_kit\/site-nav\.js$/.test(s)), 'no script from _kit/site-nav.js');
});

test('the landing sets its theme from a script in <head> that blocks first paint', () => {
  const tags = [...headOf(read(INDEX_HTML)).matchAll(/<script\b[^>]*>/gi)].map((m) => attrsOf(m[0]));
  const theme = tags.find((a) => /(^|\/)_kit\/theme\.js$/.test(a.src ?? ''));
  assert.ok(theme, '_kit/theme.js is not loaded in <head>');
  assert.ok(!('defer' in theme) && !('async' in theme) && theme.type !== 'module', '_kit/theme.js does not block first paint');
});

test('the landing header is a <site-nav> with the brand, nav and home link of pages.json, and Docs', () => {
  const config = hashiraConfig();
  const nav = siteNavConfig(read(INDEX_HTML));
  assert.equal(nav.name, config.name);
  assert.deepEqual((nav.nav ?? []).map(pick), config.nav.map(pick));
  assert.deepEqual(pick(nav.home_link), pick(config.home_link));
  assert.ok(nav.docs === true || (typeof nav.docs === 'string' && nav.docs !== 'false'), '<site-nav> shows no Docs link');
});

test('no rule in the landing hides the header Docs link', () => {
  const css = [...read(INDEX_HTML).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const rules = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)];
  const hiding = rules.filter(([, sel, body]) => /::part\(\s*docs\s*\)/.test(sel) && /display\s*:\s*none|visibility\s*:\s*hidden/.test(body));
  assert.deepEqual(hiding.map((r) => r[1].trim()), []);
});

test('site/ holds no _kit or docs folder of its own, which the Pages build reserves', () => {
  assert.equal(fs.existsSync(path.join(REPO, 'site', '_kit')), false);
  assert.equal(fs.existsSync(path.join(REPO, 'site', 'docs')), false);
});

test('each Docs link of the landing today is still there', () => {
  const hrefs = new Set(hrefsOf(read(INDEX_HTML)));
  const raw = read(INDEX_HTML);
  for (const href of LANDING_DOCS_LINKS) {
    assert.ok(hrefs.has(href) || raw.includes(`"${href}"`), `the landing no longer links ${href}`);
  }
});

// ==================================================================== requirement 23: docs-site/ is gone

test('docs-site/ is removed', () => {
  assert.equal(fs.existsSync(path.join(REPO, 'docs-site')), false);
});

test('no workflow, Dependabot entry or CLAUDE.md command still uses docs-site/', () => {
  const files = [
    ...fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(WORKFLOWS, f)),
    path.join(REPO, '.github', 'dependabot.yml'), path.join(REPO, 'CLAUDE.md'),
  ];
  for (const file of files) assert.ok(!read(file).includes('docs-site'), `${path.relative(REPO, file)} still names docs-site`);
});

test("_self-ci.yml runs the tests of docs-build, site-kit and pages-site", () => {
  const ci = read(path.join(WORKFLOWS, '_self-ci.yml'));
  for (const dir of ['tests/docs-build/', 'tests/site-kit/', 'tests/pages-site/']) {
    assert.ok(ci.includes(dir), `_self-ci.yml does not run ${dir}`);
  }
});

// ==================================================================== requirement 23: the built site

test("every file of today's /hashira/ and /hashira/docs/ is in the new build", { timeout: BUILD_TIMEOUT }, () => {
  const missing = TODAY_FILES.filter((rel) => !fs.existsSync(path.join(built(), rel)));
  assert.deepEqual(missing, []);
});

test("every heading anchor of today's docs pages is in the new build", { timeout: BUILD_TIMEOUT }, () => {
  for (const [page, anchors] of Object.entries(DOCS_ANCHORS)) {
    const ids = idsOf(builtHtml(path.join('docs', page)));
    const missing = anchors.filter((id) => !ids.has(id));
    assert.deepEqual(missing, [], `docs/${page} lost anchors`);
  }
});

test("every section anchor of today's landing is in the new build", { timeout: BUILD_TIMEOUT }, () => {
  const ids = idsOf(builtHtml('index.html'));
  assert.deepEqual(LANDING_ANCHORS.filter((id) => !ids.has(id)), []);
});

test('every Docs link of the built landing opens a built page', { timeout: BUILD_TIMEOUT }, () => {
  const hrefs = hrefsOf(builtHtml('index.html'));
  for (const href of LANDING_DOCS_LINKS.filter((h) => hrefs.includes(h))) {
    const file = builtFileFor(href, 'index.html');
    assert.ok(file && fs.existsSync(path.join(built(), file)), `${href} opens no built page`);
  }
});

test('/hashira/docs/ opens Getting started', { timeout: BUILD_TIMEOUT }, () => {
  assert.match(builtHtml('docs/index.html'), /<h1\b[^>]*\sid="getting-started"/);
});

test('the kit is in the uploaded site under _kit/', { timeout: BUILD_TIMEOUT }, () => {
  for (const f of ['tokens.css', 'theme.js', 'site-nav.js']) {
    assert.ok(fs.existsSync(path.join(built(), '_kit', f)), `_kit/${f} is missing`);
  }
});

test('docs/flows/pages.md is published', { timeout: BUILD_TIMEOUT }, () => {
  assert.ok(fs.existsSync(path.join(built(), 'docs', 'flows', 'pages.html')));
});

test('contributing.md gets no page and is not in the search index', { timeout: BUILD_TIMEOUT }, () => {
  assert.equal(fs.existsSync(path.join(built(), 'docs', 'contributing.html')), false);
  assert.equal(fs.existsSync(path.join(built(), 'docs', 'contributing', 'index.html')), false);
  const chunks = path.join(built(), 'docs', 'assets', 'chunks');
  const files = fs.existsSync(chunks) ? fs.readdirSync(chunks).filter((f) => f.startsWith('@localSearchIndex')) : [];
  assert.ok(files.length > 0, 'no local search index was built');
  for (const f of files) assert.doesNotMatch(read(path.join(chunks, f)), /\/hashira\/docs\/contributing/);
});

test('the docs logo and favicon are site/mark.svg', { timeout: BUILD_TIMEOUT }, () => {
  const mark = fs.readFileSync(path.join(REPO, 'site', 'mark.svg'));
  const same = (src, page) => {
    const file = builtFileFor(src, page);
    return Boolean(file) && fs.existsSync(path.join(built(), file)) && fs.readFileSync(path.join(built(), file)).equals(mark);
  };
  for (const page of ['docs/usage.html', 'docs/flows/npm.html']) {
    const html = builtHtml(page);
    const logos = [...html.matchAll(/<img\b[^>]*class="[^"]*\blogo\b[^"]*"[^>]*>/g)].map((m) => attrsOf(m[0]).src);
    assert.ok(logos.length > 0 && logos.every((src) => same(src, page)), `${page}: the logo is not site/mark.svg`);
    const icons = [...html.matchAll(/<link\b[^>]*>/g)].map((m) => attrsOf(m[0])).filter((a) => /(^|\s)icon$/.test(a.rel ?? ''));
    assert.ok(icons.some((a) => same(a.href, page)), `${page}: the favicon is not site/mark.svg`);
  }
});

test('every docs page links back to the landing at /hashira/', { timeout: BUILD_TIMEOUT }, () => {
  for (const page of Object.values(PUBLISHED_TODAY)) {
    const rel = `docs/${page}`;
    const home = hrefsOf(builtHtml(rel)).map((h) => builtFileFor(h, rel)).filter((f) => f === 'index.html');
    assert.ok(home.length > 0, `${rel}: no link to /hashira/`);
  }
});

test('the docs link to the hashira repository on GitHub', { timeout: BUILD_TIMEOUT }, () => {
  const hrefs = hrefsOf(builtHtml('docs/usage.html'));
  assert.ok(hrefs.some((h) => /^https:\/\/github\.com\/skathio\/hashira\/?$/.test(h)), 'no link to the repository');
});

// ==================================================================== requirement 24

const PAGES_FIELDS = ['name', 'description', 'base', 'home_page', 'sidebar', 'unpublished', 'nav', 'home_link', 'accent', 'logo', 'theme_css'];

test('docs/flows/pages.md names every pages.json field', () => {
  const md = read(PAGES_MD);
  for (const field of PAGES_FIELDS) assert.ok(md.includes(`\`${field}\``), `pages.md does not name \`${field}\``);
});

test('docs/flows/pages.md gives the limits of the schema', () => {
  const md = read(PAGES_MD);
  for (const n of ['40', '200', '100', '60', '8', '30', '64']) assert.match(md, new RegExp(`\\b${n}\\b`), `pages.md gives no limit ${n}`);
});

test('docs/flows/pages.md gives the defaults', () => {
  const md = read(PAGES_MD);
  for (const want of ['homepage.json', '#1e7d69', 'getting-started.md', '/docs/']) assert.ok(md.includes(want), `pages.md lacks ${want}`);
});

test('docs/flows/pages.md lists the errors, the missing file among them', () => {
  const md = read(PAGES_MD);
  assert.ok(md.includes('.github/pages.json not found'), 'pages.md does not give the missing-file error');
  assert.match(md, /64\s?KB/i, 'pages.md does not give the size limit error');
});

test('docs/flows/pages.md warns that the build commands are trusted input', () => {
  const md = read(PAGES_MD);
  assert.match(md, /trusted input/i);
  for (const name of ['docs_pre_build_command', 'site_build_command', 'pre_build_command']) assert.ok(md.includes(name), `pages.md does not name ${name}`);
});

test('docs/flows/pages.md documents every input and output of pages-site.yml, docs-build and site-kit', () => {
  const md = read(PAGES_MD);
  const call = triggersOf(loadYaml(PAGES_SITE_YML)).workflow_call ?? {};
  const names = [...Object.keys(call.inputs ?? {}), ...Object.keys(call.outputs ?? {})];
  for (const action of ['docs-build', 'site-kit']) {
    const spec = loadYaml(path.join(ACTIONS, action, 'action.yml'));
    names.push(...Object.keys(spec.inputs ?? {}), ...Object.keys(spec.outputs ?? {}));
  }
  for (const name of names) assert.ok(md.includes(`\`${name}\``), `pages.md does not document \`${name}\``);
});

test('every uses: ref in pages.md and README.md names skathio/hashira and none pins @main', () => {
  for (const file of [PAGES_MD, README]) {
    const refs = [...read(file).matchAll(/uses:\s*['"]?([^\s'"#]+)/g)].map((m) => m[1]);
    for (const ref of refs.filter((r) => /hashira/.test(r))) {
      assert.ok(ref.startsWith(`${OWNER_REPO}/`), `${path.basename(file)}: ${ref} does not name ${OWNER_REPO}`);
    }
    assert.deepEqual(refs.filter((r) => /@main$/.test(r)), [], `${path.basename(file)} pins @main`);
  }
});

test('README.md covers pages-site.yml, docs-build, site-kit and .github/pages.json', () => {
  const md = read(README);
  for (const want of ['pages-site.yml', 'docs-build', 'site-kit', 'pages.json']) assert.ok(md.includes(want), `README.md does not mention ${want}`);
});

test('the new and moved files make no reference to the planning folder', () => {
  const files = [PAGES_MD, README, SITE_YML, PAGES_SITE_YML, INDEX_HTML, path.join(REPO, '.github', 'pages.json')];
  for (const file of files) assert.ok(!read(file).includes('.somi/'), `${path.relative(REPO, file)} names the planning folder`);
});
