// Turns one run of `somi quality --scope pr` into the gate's verdict, its job
// summary and its annotations. Pure functions: run-gate.js does the I/O.
//
// SoMi's report is JSON on stdout: { ok, violations: [{ rule, file, line,
// value, limit }], unanalyzed: [{ file, reason }], ... }. It exits 0 when the
// change passes and 1 when it reports a violation; anything else, or output
// that is not that JSON, is a crash, and a crash fails the gate.
'use strict';

// File names and rule text come from the pull request, so every value is
// escaped before it reaches markdown or a workflow command, and the output
// is bounded however many findings SoMi reports.
const MAX_ROWS = 100;
const MAX_ANNOTATIONS = 50;
const MAX_CELL = 200;
const MAX_STDERR = 1000;

const CONTROL = /[\u0000-\u001f\u007f]/g;
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '`': '&#96;' };

function escapeHtml(text) {
  return text.replace(/[&<>|`]/g, (c) => HTML[c]);
}

function escapeCell(value) {
  const text = String(value ?? '').replace(CONTROL, ' ');
  const cut = text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}...` : text;
  return escapeHtml(cut);
}

// GitHub workflow command escaping: data escapes %, CR and LF; a property
// also escapes the : and , that would end it.
function escapeData(value) {
  return String(value ?? '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function parseReport(stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return null;
  }
  const valid = report && typeof report.ok === 'boolean' && Array.isArray(report.violations);
  if (!valid) return null;
  const unanalyzed = Array.isArray(report.unanalyzed) ? report.unanalyzed : [];
  // A file the PR marks as generated or minified is skipped, not scored, so
  // the summary must show it: otherwise the marker hides code from the gate.
  const skipped = Array.isArray(report.skipped) ? report.skipped : [];
  return { ok: report.ok, violations: report.violations, unanalyzed, skipped };
}

function crashCause(run) {
  if (run.error && run.error.code === 'ETIMEDOUT') {
    return `SoMi timed out: it did not finish within ${run.timeoutSeconds} s`;
  }
  if (run.error) return `SoMi could not run: ${run.error.message}`;
  if (run.signal) return `SoMi crashed: it was killed by ${run.signal}`;
  return `SoMi crashed: it exited with code ${run.status} without a readable report`;
}

function cleanCause(report) {
  const n = report.skipped.length;
  if (n === 0) return 'no violations';
  return `no violations in scored files, ${n} file${n === 1 ? '' : 's'} not scored (listed below)`;
}

/** { passed, cause, report } for one run: { status, signal, error, stdout, stderr, timeoutSeconds }. */
function interpret(run) {
  const report = run.error || run.signal ? null : parseReport(run.stdout);
  const clean = report && run.status === 0 && report.ok && report.violations.length === 0;
  if (clean) return { passed: true, cause: cleanCause(report), report };
  const reported = report && run.status === 1 && !report.ok;
  if (reported) {
    const n = report.violations.length;
    return { passed: false, cause: `SoMi reported ${n} violation${n === 1 ? '' : 's'}`, report };
  }
  return { passed: false, cause: crashCause(run), report: null, stderr: run.stderr };
}

function violationTable(violations) {
  const rows = violations.slice(0, MAX_ROWS).map((v) =>
    `| ${[v.rule, v.file, v.line, v.value, v.limit].map(escapeCell).join(' | ')} |`);
  const more = violations.length > MAX_ROWS ? [`\n${violations.length - MAX_ROWS} more not shown.`] : [];
  return ['| Rule | File | Line | Value | Limit |', '| --- | --- | --- | --- | --- |', ...rows, ...more];
}

function unanalyzedList(unanalyzed) {
  const items = unanalyzed.slice(0, MAX_ROWS).map((u) => `- ${escapeCell(u.file)}: ${escapeCell(u.reason)}`);
  return ['### Unanalyzed files', '', 'SoMi could not analyze these files. They do not fail the gate.', '', ...items];
}

function skippedList(skipped) {
  const items = skipped.slice(0, MAX_ROWS).map((u) => `- ${escapeCell(u.file)}: ${escapeCell(u.reason)}`);
  const more = skipped.length > MAX_ROWS ? [`\n${skipped.length - MAX_ROWS} more not shown.`] : [];
  const note = 'SoMi skipped these files as generated, minified or in a skipped folder. They were not scored: check them in review.';
  return ['### Files not scored', '', note, '', ...items, ...more];
}

/** Markdown for the job summary. */
function renderSummary(verdict, { level, base }) {
  const lines = ['## SoMi quality gate', '', `**${verdict.passed ? 'Passed' : 'Failed'}:** ${escapeCell(verdict.cause)}`];
  lines.push('', `Level \`${escapeCell(level)}\`, compared with base \`${escapeCell(base)}\`.`);
  const report = verdict.report;
  if (report && report.violations.length) lines.push('', ...violationTable(report.violations));
  if (report && report.unanalyzed.length) lines.push('', ...unanalyzedList(report.unanalyzed));
  if (report && report.skipped.length) lines.push('', ...skippedList(report.skipped));
  if (verdict.stderr) {
    const tail = String(verdict.stderr).slice(-MAX_STDERR).replace(CONTROL_BUT_NEWLINE, ' ');
    lines.push('', 'SoMi\'s error output:', '', '<pre>', escapeHtml(tail), '</pre>');
  }
  return `${lines.join('\n')}\n`;
}

/** One `::error` workflow command per violation that names a file and line. */
function annotations(report) {
  if (!report) return [];
  const located = report.violations.filter((v) => typeof v.file === 'string' && Number.isInteger(v.line) && v.line > 0);
  return located.slice(0, MAX_ANNOTATIONS).map((v) => {
    const props = `file=${escapeProperty(v.file)},line=${v.line},title=${escapeProperty(`SoMi ${v.rule}`)}`;
    return `::error ${props}::${escapeData(`${v.rule}: ${v.value} is over the limit of ${v.limit}`)}`;
  });
}

module.exports = { escapeCell, escapeData, escapeProperty, parseReport, interpret, renderSummary, annotations };
