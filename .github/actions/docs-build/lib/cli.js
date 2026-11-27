// docs-build's one entry point. action.yml runs it, and so does a maintainer on their own
// machine, so a local check or build is the one CI runs. From the repo root:
//
//   node <hashira>/.github/actions/docs-build/lib/cli.js --check
//     checks .github/pages.json and the files under docs/ it would publish. Nothing is
//     installed and nothing is written.
//   node <hashira>/.github/actions/docs-build/lib/cli.js --out <dir> [--pre-build <cmd>]
//     builds the docs into <dir>, a repo-relative folder that must not exist yet: it stages
//     the docs (lib/prepare.js), runs <cmd> with DOCS_STAGE set, installs VitePress from this
//     action's lockfile and builds. Needs npm, and network access the first time.
//
// The page URLs name the repo's GitHub Pages address: GITHUB_REPOSITORY (owner/name) when it
// is set, as in Actions, else the GitHub repo of the checkout's `origin` remote.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { prepare, inspect, checkOutputDir } = require('./prepare');

// The toolchain is installed from the action's lockfile, never resolved anew. --ignore-scripts:
// no dependency runs an install script. --include=dev keeps NODE_ENV=production in a caller's
// job from skipping VitePress.
const NPM_CI = ['ci', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund'];

const USAGE = 'usage: cli.js --check | cli.js --out <dir> [--pre-build <cmd>]';

class CliError extends Error {
  constructor(message, code = 1) {
    super(message.startsWith('docs-build:') ? message : `docs-build: ${message}`);
    this.code = code;
  }
}

function parseArgs(argv) {
  const args = { check: false, out: null, preBuild: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--check') args.check = true;
    else if (flag === '--out' || flag === '--pre-build') {
      if (i + 1 >= argv.length) throw new CliError(`${flag} needs a value. ${USAGE}`);
      args[flag === '--out' ? 'out' : 'preBuild'] = argv[(i += 1)];
    } else throw new CliError(`unknown argument ${JSON.stringify(flag)}. ${USAGE}`);
  }
  if (args.check === (args.out !== null)) throw new CliError(`give either --check or --out. ${USAGE}`);
  return args;
}

// owner/name of the checkout's origin remote on github.com, or null.
function originRepo(root) {
  const run = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
  const match = run.status === 0 && run.stdout.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return match ? match[1] : null;
}

function run(what, cmd, args, opts) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.error) throw new CliError(`${what} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new CliError(`${what} exited with code ${result.status ?? 1}.`, result.status ?? 1);
}

// The build's last step: the built site goes to output_dir, which pre_build_command may have
// created since the first check, so it is checked again.
function publishSite(root, work, out) {
  const full = checkOutputDir(root, out);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.cpSync(path.join(work, 'dist'), full, { recursive: true });
}

// What the build installs, for the step summary: the VitePress version the action's lockfile
// pins and the lockfile's sha256, so a run says exactly which toolchain built the docs.
function toolchainSummary(lockfile = path.join(__dirname, '..', 'vitepress', 'package-lock.json')) {
  const bytes = fs.readFileSync(lockfile);
  const version = JSON.parse(bytes.toString('utf8')).packages?.['node_modules/vitepress']?.version ?? 'unknown';
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return `docs-build: VitePress ${version}, installed from vitepress/package-lock.json (sha256 ${sha256})\n`;
}

function build(root, { out, preBuild }) {
  const { work, stage, warnings } = prepare(root, out);
  for (const w of warnings) process.stdout.write(`::warning::${w}\n`);
  process.stdout.write(`docs-build: staged the docs in ${stage}\n`);
  if (preBuild) run('pre_build_command', 'bash', ['-eo', 'pipefail', '-c', preBuild], { cwd: root, env: { ...process.env, DOCS_STAGE: stage } });
  const vitepress = path.join(work, 'vitepress');
  run('npm ci', 'npm', NPM_CI, { cwd: vitepress });
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, toolchainSummary());
  run('VitePress', process.execPath, [path.join(vitepress, 'node_modules', 'vitepress', 'bin', 'vitepress.js'), 'build', vitepress], { cwd: vitepress });
  publishSite(root, work, out);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `output_dir=${out}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `docs-build: wrote the docs site to '${out}'\n`);
  // A local build leaves no work folder behind; on a runner RUNNER_TEMP is cleaned up for it.
  if (!process.env.RUNNER_TEMP) fs.rmSync(work, { recursive: true, force: true });
  process.stdout.write(`docs-build: wrote the docs site to '${out}'\n`);
}

function main(argv) {
  const root = process.cwd();
  try {
    const args = parseArgs(argv);
    if (!process.env.GITHUB_REPOSITORY) {
      const repo = originRepo(root);
      if (repo) process.env.GITHUB_REPOSITORY = repo;
    }
    if (args.check) {
      inspect(root);
      process.stdout.write('docs-build: .github/pages.json and docs/ pass the checks.\n');
    } else {
      build(root, args);
    }
  } catch (err) {
    const message = err.message.startsWith('docs-build:') ? err.message : `docs-build: ${err.message}`;
    process.stderr.write(`::error::${message.replace(/\r?\n/g, ' ')}\n`);
    process.exit(err instanceof CliError ? err.code : 1);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseArgs, originRepo, main, toolchainSummary, NPM_CI };
