// The body of the one hashira summary comment on a pull request. Pure
// function: comment.js writes it.
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
const SCANNERS = ['codeql', 'osv', 'gitleaks', 'dependency-review', 'actionlint'];
const STATUSES = new Set(['pass', 'fail', 'skipped']);
const MAX_REASON = 100;
const TRUNCATED = '\n_The commitlint report was truncated to fit the 60,000-character comment limit._\n';

// Every value below comes from job outputs, and the commitlint report holds
// commit messages from the pull request, so values are checked against the
// shape they must have, and free text is stripped of control characters.
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '`': '&#96;' };

const escapeHtml = (text) => String(text).replace(/[&<>|`]/g, (c) => HTML[c]);
const outputOf = (needs, job, name) => String(needs[job]?.outputs?.[name] ?? '');
const percent = (value) => (/^\d{1,3}(\.\d{1,4})?$/.test(value) ? `${value}%` : 'n/a');

function headLink(event) {
  const sha = String(event.pull_request?.head?.sha ?? '');
  if (!/^[0-9a-f]{40}$/.test(sha)) return 'unknown';
  const repoUrl = String(event.repository?.html_url ?? '');
  const short = `\`${sha.slice(0, 7)}\``;
  return /^https:\/\/[^\s()<>]+$/.test(repoUrl) ? `[${short}](${repoUrl}/commit/${sha})` : short;
}

function runLink(runUrl) {
  return /^https:\/\/[^\s()<>]+$/.test(String(runUrl ?? '')) ? `[workflow run](${runUrl})` : 'workflow run: unknown';
}

function verdictLine(needs, inputs, event) {
  const { conclusion, lines } = evaluate({ needs, inputs, event });
  if (conclusion === 'success') return '### hashira CI: pass';
  // Only the job names: the list below already gives each job's result.
  const failing = lines.filter((line) => line.startsWith('FAIL '))
    .map((line) => escapeHtml(line.slice(5).split(':')[0]));
  return `### hashira CI: fail\n\nFailing: ${failing.join(', ')}`;
}

// "skipped" is the gate turned off by its input or reporting a skip itself;
// "not run" is a gate that never produced a result, such as when setup failed.
function gateLine(needs, inputs) {
  const result = outputOf(needs, 'quality-gate', 'result');
  const count = outputOf(needs, 'quality-gate', 'violations');
  const off = inputs.quality_gate === false || inputs.quality_gate === 'false';
  if (result === 'skipped' || (!STATUSES.has(result) && off)) return '- quality-gate: skipped';
  if (!STATUSES.has(result)) return `- quality-gate: not run (job ${escapeHtml(needs['quality-gate']?.result ?? 'missing')})`;
  if (!/^\d{1,9}$/.test(count)) return `- quality-gate: ${result}`;
  return `- quality-gate: ${result}, ${count} violation${count === '1' ? '' : 's'}`;
}

// The scanner's own details from scan-suite's summary rows, so a skip or a
// failure says why. The text is the action's own, but it travels through a
// job output, so it is stripped, escaped and cut like any untrusted value.
function scannerReasons(needs) {
  const reasons = new Map();
  for (const line of outputOf(needs, 'scan-suite', 'scan_summary').split('\n')) {
    const [name, , ...rest] = line.split('\t');
    if (!SCANNERS.includes(name) || reasons.has(name)) continue;
    const text = rest.join(' ').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!text) continue;
    const reason = text === 'consumer disabled' ? 'disabled by scan_disable' : text;
    reasons.set(name, escapeHtml(reason.length > MAX_REASON ? `${cut(reason, MAX_REASON)}...` : reason));
  }
  return reasons;
}

function scannerLines(needs) {
  const found = new Map();
  for (const line of outputOf(needs, 'scan-suite', 'verdicts').split('\n')) {
    const [name, status] = line.trim().split('\t');
    if (SCANNERS.includes(name) && STATUSES.has(status)) found.set(name, status);
  }
  const reasons = scannerReasons(needs);
  return SCANNERS.map((name) => {
    const status = found.get(name) ?? 'not run';
    const why = status !== 'pass' && reasons.get(name);
    return `  - ${name}: ${status}${why ? ` — ${why}` : ''}`;
  });
}

function testLine(needs) {
  const result = needs.test?.result;
  const status = result === 'success' ? 'pass' : result === 'failure' ? 'fail' : `not run (job ${escapeHtml(result ?? 'missing')})`;
  // A report that measured no file gives 0.0%, which is not a measurement.
  if (outputOf(needs, 'test', 'coverage_files') === '0') return `- test: ${status}, no coverage data`;
  const lines = percent(outputOf(needs, 'test', 'lines_pct'));
  const branches = percent(outputOf(needs, 'test', 'branches_pct'));
  return `- test: ${status}, line coverage ${lines}, branch coverage ${branches}`;
}

// commitlint warns and never blocks, so findings are reported, not failed.
function commitlint(needs) {
  if (!needs.lint) return { line: null, report: '' };
  const result = outputOf(needs, 'lint', 'commitlint_result');
  if (result === 'clean') return { line: '- commitlint: clean', report: '' };
  if (result !== 'findings') return { line: '- commitlint: no result', report: '' };
  const report = outputOf(needs, 'lint', 'commitlint_report').replace(/\r\n?/g, '\n').replace(CONTROL_BUT_NEWLINE, ' ');
  return { line: '- commitlint: findings (warn-only, does not block the merge)', report };
}

// A fence longer than any backtick run in the report keeps it a code block.
function fenceFor(report) {
  const longest = Math.max(0, ...(report.match(/`+/g) || []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

// Cuts `text` to `length` characters without leaving half of a surrogate pair.
function cut(text, length) {
  const end = /[\ud800-\udbff]/.test(text[length - 1] ?? '') ? length - 1 : length;
  return text.slice(0, Math.max(0, end));
}

// The fence grows with the longest backtick run in the report, so the size
// is measured again after each cut until the body fits the cap.
function assemble(head, report) {
  if (!report) return `${head}\n`;
  let text = report;
  let note = '';
  for (;;) {
    const fence = fenceFor(text);
    const body = `${head}\n\n${fence}\n${text}\n${fence}\n${note}`;
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
  const lines = [
    MARKER,
    verdictLine(needs, inputs, event),
    '',
    `Head commit ${headLink(event)}, ${runLink(runUrl)}.`,
    '',
    gateLine(needs, inputs),
    '- scan-suite:',
    ...scannerLines(needs),
    testLine(needs),
    ...(lint.line ? [lint.line] : []),
  ];
  return assemble(lines.join('\n'), lint.report);
}

module.exports = { MARKER, MAX_BODY, renderBody };
