// The verdict of the aggregate `passed` job and its one-line-per-job summary.
// Pure function: the action does the I/O.
//
// `needs` is `toJSON(needs)`: { <job-id>: { result, outputs } }. `inputs` and
// `event` are the workflow's `inputs` and `github.event` contexts; `event`
// null means the event payload could not be read.
'use strict';

// A required check that passes while a job it stands for never ran would let
// a broken change merge, so a skip passes only when an input explains it.
// Each rule mirrors the `if:` that skips its job in the three CI workflows.
const DOCUMENTED_SKIPS = {
  // `if: (inputs.bump || github.event.inputs.bump) != '' && ... != 'none'`:
  // the input wins when set, as `||` does there, and 'none' (the templates'
  // "no release" choice) counts as no bump. A null event is one nobody could
  // read: the bump is unknown, so the skip is unexplained.
  version: {
    applies: ({ inputs, event }) => {
      if (event === null) return false;
      const bump = isSet(inputs.bump) ? inputs.bump : event.inputs?.bump;
      return !isSet(bump) || bump === 'none';
    },
    reason: "no bump set (inputs.bump and github.event.inputs.bump are empty or 'none')",
  },
  // `if: inputs.quality_gate`. Only an explicit false counts: a missing value
  // means the input's default (true), so that skip is unexplained and fails.
  'quality-gate': {
    applies: ({ inputs }) => inputs.quality_gate === false || inputs.quality_gate === 'false',
    reason: 'inputs.quality_gate is false',
  },
};

const PASSING = new Set(['success']);

function isSet(value) {
  return typeof value === 'string' ? value !== '' : value !== undefined && value !== null;
}

// Job ids and results come from the workflow, not from the pull request, but
// they are still bounded and stripped of control characters before they reach
// the job summary.
function clean(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100);
}

function judge(job, result, context) {
  if (PASSING.has(result)) return { ok: true, note: '' };
  // Own keys only: a job id such as `constructor` names no rule.
  const skip = Object.hasOwn(DOCUMENTED_SKIPS, job) ? DOCUMENTED_SKIPS[job] : undefined;
  if (result === 'skipped' && skip && skip.applies(context)) {
    return { ok: true, note: ` (documented skip: ${skip.reason})` };
  }
  return { ok: false, note: '' };
}

function evaluate({ needs, inputs, event } = {}) {
  const context = { inputs: inputs || {}, event: event === null ? null : event || {} };
  const lines = [];
  let ok = true;
  for (const [job, data] of Object.entries(needs || {})) {
    const result = clean(data && data.result);
    const verdict = judge(job, result, context);
    ok = ok && verdict.ok;
    lines.push(`${verdict.ok ? 'ok' : 'FAIL'} ${clean(job)}: ${result || 'unknown'}${verdict.note}`);
  }
  return { conclusion: ok ? 'success' : 'failure', lines };
}

module.exports = { evaluate, DOCUMENTED_SKIPS };
