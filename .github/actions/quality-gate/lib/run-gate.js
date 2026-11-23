// The quality-gate action's entry point. Two commands:
//   node run-gate.js event   decide whether this event is gated; outside a
//                            pull_request, write the skip line and stop.
//   node run-gate.js check   run `somi quality --scope pr` against the PR base
//                            and fail on a violation or on any failure to check.
// Every failure to check fails the job: a missing base, a bad level, a crash
// and a timeout each write their cause to the job summary.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { interpret, renderSummary, annotations, escapeData } = require('./report.js');

const SKIP_MESSAGE = 'skipped: quality gate runs on pull requests';
const LEVELS = ['strict', 'standard', 'relaxed'];
// SoMi's own default time for the gate; its CLI leaves enforcing it to the caller.
const DEFAULT_TIMEOUT_SECONDS = 300;
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function appendSummary(env, text) {
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text);
}

/** true when the event is a pull_request; otherwise writes the skip line. */
function decideEvent(env) {
  const gated = env.GITHUB_EVENT_NAME === 'pull_request';
  if (!gated) appendSummary(env, `${SKIP_MESSAGE}\n`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `run=${gated}\n`);
  return gated;
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A shallow checkout may not hold the base commit, so fetch just that commit.
function ensureBase(cwd, base) {
  if (!OBJECT_ID.test(base)) return false;
  const has = () => git(cwd, ['cat-file', '-e', `${base}^{commit}`]).status === 0;
  if (has()) return true;
  git(cwd, ['fetch', '--no-tags', '--depth=1', 'origin', base]);
  return has();
}

// SoMi reads the level from its user config, so give it one of its own.
function configHome(level) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hashira-somi-config-'));
  fs.mkdirSync(path.join(home, 'somi'));
  fs.writeFileSync(path.join(home, 'somi', 'config.json'), JSON.stringify({ quality: { level } }));
  return home;
}

function runSomi({ cli, cwd, base, level, timeoutSeconds }) {
  const env = { ...process.env, XDG_CONFIG_HOME: configHome(level), SOMI_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'hashira-somi-state-')) };
  const r = spawnSync(process.execPath, [cli, 'quality', '--scope', 'pr', '--from', base], {
    cwd, env, encoding: 'utf8', timeout: timeoutSeconds * 1000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status, signal: r.signal, error: r.error, stdout: r.stdout, stderr: r.stderr, timeoutSeconds };
}

function precheck({ cwd, base, level }) {
  if (!LEVELS.includes(level)) return `quality level "${level}" is not one of ${LEVELS.join(', ')}`;
  if (!ensureBase(cwd, base)) return `missing base ref: the pull request base "${base}" is not in the checkout and could not be fetched`;
  return null;
}

/** Runs the gate and returns the exit code. options: { env, cli, cwd, base, level, timeoutSeconds, log }. */
function check(options) {
  const { env, log = (line) => process.stdout.write(`${line}\n`) } = options;
  const settings = { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, ...options };
  const problem = precheck(settings);
  const verdict = problem ? { passed: false, cause: problem, report: null } : interpret(runSomi(settings));
  appendSummary(env, renderSummary(verdict, settings));
  for (const line of annotations(verdict.report)) log(line);
  log(`quality-gate: ${verdict.passed ? 'passed' : 'failed'}: ${escapeData(verdict.cause)}`);
  return verdict.passed ? 0 : 1;
}

function main(argv, env) {
  if (argv[0] === 'event') {
    decideEvent(env);
    return 0;
  }
  if (argv[0] !== 'check') throw new Error('run-gate.js takes event or check');
  return check({ env, cli: env.SOMI_CLI, cwd: env.GITHUB_WORKSPACE || process.cwd(), base: env.GATE_BASE_SHA || '', level: env.GATE_LEVEL ?? '' });
}

if (require.main === module) process.exitCode = main(process.argv.slice(2), process.env);

module.exports = { SKIP_MESSAGE, LEVELS, decideEvent, ensureBase, check, main };
