// Builds hashira's own Pages site locally the way site.yml does in GitHub Actions: it reads the
// `with:` site.yml passes to pages-site.yml, runs pages-site.yml's `site` step, then the run
// steps of the site-kit and docs-build actions, on a copy of this repo's files (tracked and new,
// not ignored) in a temporary folder. The docs build installs VitePress from docs-build's
// lockfile, so the first run needs network access once.
//
//   node tests/pages-site/build-site.js     writes the site to artifacts/pages (gitignored)
//
// The tests in this folder call buildSite() and read the folder it returns. Runner contexts are
// stood in for: github.ref is refs/heads/main and GITHUB_REPOSITORY is skathio/hashira.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const WORKFLOWS = path.join(REPO, '.github', 'workflows');
const ACTIONS = path.join(REPO, '.github', 'actions');
const OWNER_REPO = 'skathio/hashira';
const STEP_TIMEOUT = 900_000;

function loadYaml(file) {
  const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))';
  const run = spawnSync('python3', ['-c', py], { input: fs.readFileSync(file, 'utf8'), encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`could not read ${file} (needs python3 with PyYAML): ${run.stderr}`);
  return JSON.parse(run.stdout) ?? {};
}

const norm = (v) => (v === undefined || v === null ? '' : String(v));
const lookup = (expr, ctx) => expr.trim().split('.').slice(1).reduce((obj, key) => obj?.[key], ctx[expr.trim().split('.')[0]]);

// The expression forms these files use: a context path, and a comparison with a quoted string.
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
  const cond = String(step.if);
  const value = evaluate(cond.includes('${{') ? cond : `\${{ ${cond} }}`, ctx);
  return value === true || value === 'true';
}

function readOutputs(file) {
  if (!fs.existsSync(file)) return {};
  const pairs = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.match(/^([\w-]+)=(.*)$/)).filter(Boolean);
  return Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
}

function runnerEnv(build, outputFile) {
  const keep = Object.entries(process.env).filter(([k]) => !k.startsWith('GITHUB_') && k !== 'NODE_TEST_CONTEXT');
  return {
    ...Object.fromEntries(keep), GITHUB_WORKSPACE: build.ws, GITHUB_REPOSITORY: OWNER_REPO,
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_REF: 'refs/heads/main', GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: path.join(build.outer, 'summary'), RUNNER_TEMP: build.outer, CI: 'true',
  };
}

function runStep(step, ctx, build) {
  const outputFile = path.join(build.outer, `output-${build.count++}`);
  const env = runnerEnv(build, outputFile);
  for (const [k, v] of Object.entries(step.env ?? {})) env[k] = norm(evaluate(String(v), ctx));
  const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', evaluate(String(step.run), ctx)],
    { cwd: build.ws, env, encoding: 'utf8', timeout: STEP_TIMEOUT });
  build.log += `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.status !== 0) throw new Error(`step "${step.name ?? step.id}" failed:\n${build.log.slice(-4000)}`);
  if (step.id) ctx.steps[step.id] = { outputs: readOutputs(outputFile) };
}

function runAction(name, withValues, build) {
  const dir = path.join(ACTIONS, name);
  const spec = loadYaml(path.join(dir, 'action.yml'));
  const inputs = Object.fromEntries(Object.entries(spec.inputs ?? {}).map(([k, d]) => [k, d.default ?? '']));
  const ctx = { inputs: { ...inputs, ...withValues }, steps: {}, github: { action_path: dir, workspace: build.ws } };
  for (const step of spec.runs?.steps ?? []) {
    if (step.run && stepRuns(step, ctx)) runStep(step, ctx, build);
  }
}

// The inputs pages-site.yml gets from site.yml on a hand run: its defaults, then site.yml's with.
function pagesSiteInputs(pagesSite) {
  const on = pagesSite.on ?? pagesSite.true ?? {};
  const inputs = Object.fromEntries(Object.entries(on.workflow_call?.inputs ?? {}).map(([k, d]) => [k, d.default ?? '']));
  const site = loadYaml(path.join(WORKFLOWS, 'site.yml'));
  const call = Object.values(site.jobs ?? {}).find((j) => /\.github\/workflows\/pages-site\.yml$/.test(String(j.uses ?? '')));
  if (!call) throw new Error('site.yml has no job that calls pages-site.yml');
  for (const [k, v] of Object.entries(call.with ?? {})) inputs[k] = evaluate(String(v), { inputs: { released: false } });
  return inputs;
}

function copyRepo(ws) {
  const listed = spawnSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (const rel of listed.stdout.split('\0').filter(Boolean)) {
    const from = path.join(REPO, rel);
    if (!fs.existsSync(from) || !fs.lstatSync(from).isFile()) continue;
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(ws, rel));
  }
}

// Builds the site in a new temporary folder and returns { site, outer }: `site` is the folder
// pages-site.yml would upload, `outer` the temporary folder to remove when done.
function buildSite() {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'hashira-site-'));
  const build = { outer, ws: path.join(outer, 'ws'), count: 0, log: '' };
  fs.mkdirSync(build.ws);
  copyRepo(build.ws);
  const pagesSite = loadYaml(path.join(WORKFLOWS, 'pages-site.yml'));
  const ctx = { inputs: pagesSiteInputs(pagesSite), steps: {}, github: { workspace: build.ws } };
  const steps = pagesSite.jobs?.build?.steps ?? [];
  runStep(steps.find((s) => s.id === 'site'), ctx, build);
  for (const step of steps) {
    const name = String(step.uses ?? '').match(/\.github\/actions\/(site-kit|docs-build)$/)?.[1];
    if (!name || !stepRuns(step, ctx)) continue;
    const withValues = Object.fromEntries(Object.entries(step.with ?? {}).map(([k, v]) => [k, norm(evaluate(String(v), ctx))]));
    runAction(name, withValues, build);
  }
  const site = path.join(build.ws, ctx.steps.site.outputs.output);
  // pages-site.yml's build checks the kit references before the upload; so does this build.
  const broken = require(path.join(REPO, '.github', 'pages-site', 'lib', 'kit-refs.cjs')).check(site);
  if (broken.length) throw new Error(`the site's kit references are broken:\n${broken.join('\n')}`);
  return { site, outer, log: build.log };
}

function main() {
  const out = path.join(REPO, 'artifacts', 'pages');
  const { site, outer } = buildSite();
  try {
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.cpSync(site, out, { recursive: true });
    process.stdout.write(`build-site: wrote hashira's Pages site to ${path.relative(REPO, out)}\n`);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`build-site: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { buildSite, REPO };
