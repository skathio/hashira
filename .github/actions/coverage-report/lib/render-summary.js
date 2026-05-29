// Renders the coverage parser's output as:
//   (a) a one-line $GITHUB_STEP_SUMMARY entry + a per-file markdown table
//   (b) the markdown body for the sticky PR comment (returned to stdout
//       in marker form so the calling step can pass it to github-script)
//
// Invoked from action.yml as a Node process. Inputs come from env vars
// to keep the action.yml simple:
//   COVERAGE_INPUT_PATH   - file path to the coverage report
//   COVERAGE_INPUT_FORMAT - explicit format or empty for auto-detect
//   GITHUB_STEP_SUMMARY   - standard GitHub env (write target)
//   COVERAGE_OUTPUT_FILE  - file path to write the rendered comment body
//
// Exit code 0 always (unless parser throws). Errors bubble up via throw.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseCoverage } = require('./parse-coverage');

const COMMENT_MARKER = '<!-- hashira:coverage-report -->';

function renderMarkdown(result, coveragePath) {
  const lines = [];
  lines.push(COMMENT_MARKER);
  lines.push('## Coverage report');
  lines.push('');
  lines.push(`- Lines: **${result.lines_pct.toFixed(1)}%**`);
  lines.push(`- Branches: **${result.branches_pct.toFixed(1)}%**`);
  lines.push(`- Source: \`${path.basename(coveragePath)}\``);
  if (result.files && result.files.length > 0) {
    lines.push('');
    lines.push('<details><summary>Per-file lines coverage</summary>');
    lines.push('');
    lines.push('| File | Lines % |');
    lines.push('| --- | ---: |');
    const sorted = result.files.slice().sort((a, b) => a.path.localeCompare(b.path));
    for (const f of sorted) {
      lines.push(`| \`${f.path}\` | ${f.lines_pct.toFixed(1)}% |`);
    }
    lines.push('');
    lines.push('</details>');
  }
  return lines.join('\n');
}

function main() {
  const coveragePath = process.env.COVERAGE_INPUT_PATH;
  const format = process.env.COVERAGE_INPUT_FORMAT || undefined;
  if (!coveragePath) {
    throw new Error('coverage-report: COVERAGE_INPUT_PATH env var is required.');
  }
  const result = parseCoverage({ path: coveragePath, format });
  const markdown = renderMarkdown(result, coveragePath);

  const summaryLine = `coverage-report: lines ${result.lines_pct.toFixed(1)}% / branches ${result.branches_pct.toFixed(1)}% (source ${path.basename(coveragePath)})`;

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, `${summaryLine}\n\n${markdown}\n`);
  }

  // Accumulator for self-CI assertions: each invocation appends one line so
  // the assertion step (a separate GitHub Actions step) can grep it after the
  // composite action step completes.
  const accPath = process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/hashira-coverage-report.txt` : null;
  if (accPath) {
    fs.appendFileSync(accPath, `${summaryLine}\n`);
  }

  const outFile = process.env.COVERAGE_OUTPUT_FILE;
  if (outFile) {
    fs.writeFileSync(outFile, markdown);
  }

  // Stdout is one structured line consumers can grep in self-CI.
  process.stdout.write(
    `coverage-report: lines=${result.lines_pct.toFixed(1)}% branches=${result.branches_pct.toFixed(1)}% files=${result.files.length}\n`
  );
}

if (require.main === module) {
  main();
}

module.exports = { renderMarkdown, COMMENT_MARKER };
