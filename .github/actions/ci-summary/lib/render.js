// The ci-summary action's first step: judge the needed jobs, write one line
// per job to the job summary, and write the pull request comment body to a
// file for the comment step.
//
// Reads from the environment:
//   CI_SUMMARY_NEEDS   `toJSON(needs)` of the calling job
//   CI_SUMMARY_INPUTS  `toJSON(inputs)` of the calling workflow
//   GITHUB_EVENT_PATH, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID,
//   GITHUB_STEP_SUMMARY, GITHUB_OUTPUT, RUNNER_TEMP (set by the runner)
// Writes the step outputs `conclusion` (success or failure), `body_file` and
// `lib_dir`. A needs or inputs value that is not a JSON object throws, so the
// step fails and the job fails with it: a verdict nobody could compute is
// not a pass. Run as the action's step, a needs value with no job in it fails
// the same way: a check that judged nothing is not a pass either.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluate } = require('./verdict');
const { renderBody } = require('./body');

function parseObject(text, what) {
  let value;
  try {
    value = JSON.parse(text === undefined || text === '' ? '{}' : text);
  } catch (err) {
    throw new Error(`ci-summary: ${what} is not valid JSON (${err.message})`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`ci-summary: ${what} is not a JSON object`);
  }
  return value;
}

// A missing or unreadable event file gives null: the comment shows the head
// as unknown, and the verdict cannot tell whether `github.event.inputs.bump`
// was set, so a skipped `version` job is not a documented skip.
function readEvent(eventPath) {
  if (!eventPath) return null;
  try {
    return parseObject(fs.readFileSync(eventPath, 'utf8'), 'the event payload');
  } catch {
    return null;
  }
}

function runUrl(env) {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: id } = env;
  return server && repo && id ? `${server}/${repo}/actions/runs/${id}` : '';
}

function summaryText(conclusion, lines) {
  const items = lines.map((line) => `- ${line}`);
  return ['### passed', '', `Verdict: ${conclusion}`, '', ...items, ''].join('\n');
}

/** Runs the step against `env`; returns { conclusion, body }. */
function run(env) {
  const needs = parseObject(env.CI_SUMMARY_NEEDS, 'the needs context');
  const inputs = parseObject(env.CI_SUMMARY_INPUTS, 'the inputs context');
  const event = readEvent(env.GITHUB_EVENT_PATH);
  const { conclusion, lines } = evaluate({ needs, inputs, event });
  const body = renderBody({ needs, inputs, event: event ?? {}, runUrl: runUrl(env) });
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${summaryText(conclusion, lines)}\n`);
  const bodyFile = path.join(env.RUNNER_TEMP || os.tmpdir(), 'ci-summary-body.md');
  fs.writeFileSync(bodyFile, body);
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, `conclusion=${conclusion}\nbody_file=${bodyFile}\nlib_dir=${__dirname}\n`);
  }
  return { conclusion, body };
}

// The step itself. A caller that left `needs` out, or whose job needs no
// other job, would otherwise get a green check that stands for nothing.
function main(env) {
  if (Object.keys(parseObject(env.CI_SUMMARY_NEEDS, 'the needs context')).length === 0) {
    process.stdout.write('::error title=passed::ci-summary got no job results: pass toJSON(needs) from a job that needs every other job\n');
    process.exitCode = 1;
    return;
  }
  run(env);
}

if (require.main === module) main(process.env);

module.exports = { run };
