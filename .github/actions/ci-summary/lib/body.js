// The body of the one hashira summary comment on a pull request. Pure
// function: comment.js writes it.
//
// Layout: a headline with the verdict, the head commit and run, a table of
// the checks that ran (failures first), one line per reason for the checks
// that were skipped, and npm's commitlint report folded away when it has
// findings.
//
// `needs` is `toJSON(needs)` as verdict.js takes it. The fields come from the
// job outputs: quality-gate `result` and `violations`, scan-suite `verdicts`
// and `scan_summary`, test `lines_pct`, `branches_pct` and `coverage_files`,
// and npm's lint `commitlint_result` and `commitlint_report`.
'use strict';

const { evaluate } = require('./verdict');

const MARKER = '<!-- hashira:ci-summary -->';
// GitHub refuses a comment body over 65,536 characters; the margin leaves
// room for the job summary's own framing when the body falls back there.
const MAX_BODY = 60000;
const SCANNERS = [
  ['codeql', 'CodeQL'],
  ['osv', 'OSV'],
  ['gitleaks', 'gitleaks'],
  ['dependency-review', 'Dependency review'],
  ['actionlint', 'actionlint'],
];
const STATUSES = new Set(['pass', 'fail', 'skipped']);
const MAX_REASON = 100;
const TRUNCATED = '\n_The commitlint report was truncated to fit the 60,000-character comment limit._\n';

// Rows sort by this order, so a failure is the first thing a reader sees.
const STATE = {
  fail: { icon: '❌', word: 'Failed', rank: 0 },
  warn: { icon: '⚠️', word: 'Findings', rank: 1 },
  notrun: { icon: '⚪', word: 'Not run', rank: 2 },
  pass: { icon: '✅', word: 'Passed', rank: 3 },
};

// Every value below comes from job outputs, and the commitlint report holds
// commit messages from the pull request, so values are checked against the
// shape they must have, and free text is stripped of control characters.
const CONTROL = /[\u0000-\u001f\u007f]/g;
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '`': '&#96;' };

const escapeHtml = (text) => String(text).replace(/[&<>|`]/g, (c) => HTML[c]);
const outputOf = (needs, job, name) => String(needs[job]?.outputs?.[name] ?? '');
const percent = (value) => (/^\d{1,3}(\.\d{1,4})?$/.test(value) ? `${value}%` : null);

// Cuts `text` to `length` characters without leaving half of a surrogate pair.
function cut(text, length) {
  const end = /[\ud800-\udbff]/.test(text[length - 1] ?? '') ? length - 1 : length;
  return text.slice(0, Math.max(0, end));
}

function headLink(event) {
  const sha = String(event.pull_request?.head?.sha ?? '');
  if (!/^[0-9a-f]{40}$/.test(sha)) return 'commit unknown';
  const repoUrl = String(event.repository?.html_url ?? '');
  const short = `\`${sha.slice(0, 7)}\``;
  return /^https:\/\/[^\s()<>]+$/.test(repoUrl) ? `[${short}](${repoUrl}/commit/${sha})` : short;
}

function runLink(runUrl) {
  return /^https:\/\/[^\s()<>]+$/.test(String(runUrl ?? '')) ? `[View run](${runUrl})` : 'run unknown';
}

const jobState = (result) => (result === 'success' ? 'pass' : result === 'failure' ? 'fail' : 'notrun');
const notRun = (needs, job) => `job ${escapeHtml(needs[job]?.result ?? 'missing')}`;

// "skipped" is the gate turned off by its input or reporting a skip itself;
// "not run" is a gate that never produced a result, such as when setup failed.
function gateRow(needs, inputs) {
  const result = outputOf(needs, 'quality-gate', 'result');
  const count = outputOf(needs, 'quality-gate', 'violations');
  const off = inputs.quality_gate === false || inputs.quality_gate === 'false';
  if (result === 'skipped' || (!STATUSES.has(result) && off)) {
    return { skipped: true, name: 'Quality gate', why: 'turned off with `quality_gate: false`' };
  }
  if (!STATUSES.has(result)) return { name: 'Quality gate', state: 'notrun', detail: notRun(needs, 'quality-gate') };
  const detail = /^\d{1,9}$/.test(count) ? `${count} violation${count === '1' ? '' : 's'}` : '';
  return { name: 'Quality gate', state: result === 'fail' ? 'fail' : 'pass', detail };
}

function testRow(needs) {
  const state = jobState(needs.test?.result);
  if (state === 'notrun') return { name: 'Tests', state, detail: notRun(needs, 'test') };
  // A report that measured no file gives 0.0%, which is not a measurement.
  if (outputOf(needs, 'test', 'coverage_files') === '0') return { name: 'Tests', state, detail: 'no coverage data' };
  const lines = percent(outputOf(needs, 'test', 'lines_pct'));
  const branches = percent(outputOf(needs, 'test', 'branches_pct'));
  const detail = lines || branches
    ? `${lines ?? 'n/a'} lines · ${branches ?? 'n/a'} branches`
    : 'coverage n/a';
  return { name: 'Tests', state, detail };
}

// The scanner's own details from scan-suite's summary rows, so a skip or a
// failure says why. The text is the action's own, but it travels through a
// job output, so it is stripped, escaped and cut like any untrusted value.
function scannerReasons(needs) {
  const reasons = new Map();
  for (const line of outputOf(needs, 'scan-suite', 'scan_summary').split('\n')) {
    const [name, , ...rest] = line.split('\t');
    if (!SCANNERS.some(([id]) => id === name) || reasons.has(name)) continue;
    const text = rest.join(' ').replace(CONTROL, ' ').trim();
    if (!text) continue;
    if (text === 'consumer disabled') {
      reasons.set(name, 'disabled by `scan_disable`');
      continue;
    }
    reasons.set(name, escapeHtml(text.length > MAX_REASON ? `${cut(text, MAX_REASON)}...` : text));
  }
  return reasons;
}

function scannerRows(needs) {
  const found = new Map();
  for (const line of outputOf(needs, 'scan-suite', 'verdicts').split('\n')) {
    const [name, status] = line.trim().split('\t');
    if (SCANNERS.some(([id]) => id === name) && STATUSES.has(status)) found.set(name, status);
  }
  const reasons = scannerReasons(needs);
  return SCANNERS.map(([id, name]) => {
    const status = found.get(id);
    const why = reasons.get(id) ?? '';
    if (status === 'skipped') return { skipped: true, name, why };
    if (status === 'pass') return { name, state: 'pass', detail: '' };
    if (status === 'fail') return { name, state: 'fail', detail: why };
    const job = needs['scan-suite']?.result;
    return { name, state: 'notrun', detail: job === 'success' || job === 'failure' ? 'no result' : notRun(needs, 'scan-suite') };
  });
}

// commitlint warns and never blocks, so findings are a warning row.
function commitlint(needs) {
  if (!needs.lint) return { row: null, report: '' };
  const result = outputOf(needs, 'lint', 'commitlint_result');
  if (result === 'clean') return { row: { name: 'commitlint', state: 'pass', word: 'Clean', detail: '' }, report: '' };
  if (result !== 'findings') return { row: { name: 'commitlint', state: 'notrun', detail: 'no result' }, report: '' };
  const report = outputOf(needs, 'lint', 'commitlint_report').replace(/\r\n?/g, '\n').replace(CONTROL_BUT_NEWLINE, ' ');
  return { row: { name: 'commitlint', state: 'warn', detail: 'non-blocking, report below' }, report };
}

function headline(needs, inputs, event) {
  const { conclusion, lines } = evaluate({ needs, inputs, event });
  if (conclusion === 'success') return ['### ✅ hashira CI passed'];
  // Only the job names: the table below gives each result.
  const failing = lines.filter((line) => line.startsWith('FAIL '))
    .map((line) => `\`${escapeHtml(line.slice(5).split(':')[0])}\``);
  return ['### ❌ hashira CI failed', '', `**Failing:** ${failing.join(', ') || 'unknown'}`];
}

function table(rows) {
  const sorted = rows.slice().sort((a, b) => STATE[a.state].rank - STATE[b.state].rank);
  return [
    '| | Check | Details |',
    '|:-:|---|---|',
    // The word as well as the icon, so the row reads without the emoji.
    ...sorted.map(({ state, name, word, detail }) => {
      const result = [word || STATE[state].word, detail].filter(Boolean).join(' · ');
      return `| ${STATE[state].icon} | **${name}** | ${result} |`;
    }),
  ];
}

// One line per reason: "CodeQL, actionlint: disabled by `scan_disable`".
function skippedLine(skipped) {
  if (!skipped.length) return [];
  const byReason = new Map();
  for (const { name, why } of skipped) byReason.set(why, [...(byReason.get(why) ?? []), name]);
  const parts = [...byReason].map(([why, names]) => (why ? `${names.join(', ')} (${why})` : names.join(', ')));
  return ['', `⏭️ **Skipped:** ${parts.join('; ')}`];
}

// A fence longer than any backtick run in the report keeps it a code block.
function fenceFor(report) {
  const longest = Math.max(0, ...(report.match(/`+/g) || []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

// The fence grows with the longest backtick run in the report, so the size
// is measured again after each cut until the body fits the cap.
function assemble(head, report) {
  if (!report) return `${head}\n`;
  let text = report;
  let note = '';
  for (;;) {
    const fence = fenceFor(text);
    const body = `${head}\n\n<details><summary>commitlint findings</summary>\n\n${fence}\n${text}\n${fence}\n${note}\n</details>\n`;
    const over = body.length - MAX_BODY;
    if (over <= 0 || (note && !text)) return body;
    if (note) text = cut(text, text.length - over);
    note = TRUNCATED;
  }
}

function renderBody(args) {
  const { runUrl } = args || {};
  const [needs, inputs, event] = ['needs', 'inputs', 'event'].map((key) => (args && args[key]) || {});
  const lint = commitlint(needs);
  const all = [testRow(needs), gateRow(needs, inputs), ...scannerRows(needs), ...(lint.row ? [lint.row] : [])];
  const lines = [
    MARKER,
    ...headline(needs, inputs, event),
    '',
    `<sub>${headLink(event)} · ${runLink(runUrl)}</sub>`,
    '',
    ...table(all.filter((row) => !row.skipped)),
    ...skippedLine(all.filter((row) => row.skipped)),
  ];
  return assemble(lines.join('\n'), lint.report);
}

module.exports = { MARKER, MAX_BODY, renderBody };
