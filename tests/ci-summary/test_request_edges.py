#!/usr/bin/env python3
"""Edges of the `ci / passed` contract that the main tests leave open.

- The CI summary comment stays within its 60,000-character cap whatever the
  commitlint report holds, a long run of backticks included, and is never cut
  in the middle of a character.
- The verdict judges any job id, also one that names a built-in object
  property, and the lib functions accept being called with nothing.
- commitlint warns and never blocks: no commit message in the pull request
  may make the `passed` job crash. The report reaches `passed` through an
  environment variable, which the kernel limits to 128 KiB.
- A CodeQL error fails the scan-suite job like any other scanner's error:
  after every enabled scanner ran and the summary was written. With
  `fail_on_findings` left at its default it still fails the action, as it did
  before that input existed.

Run: python3 tests/ci-summary/test_request_edges.py
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

import yaml

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LIB = os.path.join(REPO, ".github", "actions", "ci-summary", "lib")
NPM_WORKFLOW = os.path.join(REPO, ".github", "workflows", "npm-package-ci.yml")
SELF_CI = os.path.join(REPO, ".github", "workflows", "_self-ci.yml")
MARKER = "<!-- hashira:ci-summary -->"
MAX_BODY = 60000
# Linux refuses one environment string over 128 KiB (MAX_ARG_STRLEN).
MAX_ENV_STRING = 131072

sys.path.insert(0, os.path.join(REPO, "tests", "scan-suite"))
from test_fail_on_findings import CLEAN, SCANNERS, run_scan_suite  # noqa: E402


def read(path, mode="r"):
    with open(path, mode, encoding=None if "b" in mode else "utf-8") as fh:
        return fh.read()


def node(script, payload=None):
    """Run `script` in node with `payload` as JSON on stdin; return its JSON output."""
    proc = subprocess.run(["node", "-e", script], input=json.dumps(payload), cwd=LIB,
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise AssertionError("node failed:\n" + proc.stderr)
    return json.loads(proc.stdout)


RENDER = """
const { renderBody } = require('./body.js');
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const report = input.prefix + input.unit.repeat(input.count);
const needs = { lint: { result: 'success', outputs: { commitlint_result: 'findings', commitlint_report: report } } };
const body = renderBody({ needs });
console.log(JSON.stringify({
  length: body.length,
  start: body.slice(0, 40),
  end: body.slice(-200),
  loneSurrogate: /[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]/.test(body),
  fences: body.split('\\n').filter((line) => /^`{3,}$/.test(line)).length,
}));
"""


def render(unit, count, prefix=""):
    return node(RENDER, {"unit": unit, "count": count, "prefix": prefix})


class CommentBodyCap(unittest.TestCase):
    def test_a_report_of_backticks_stays_within_the_cap(self):
        for count in (21000, 30000, 70000):
            with self.subTest(backticks=count):
                body = render("`", count)
                self.assertLessEqual(body["length"], MAX_BODY)
                self.assertTrue(body["start"].startswith(MARKER))
                self.assertIn("truncated", body["end"])

    def test_a_run_of_backticks_that_fits_is_kept_whole_inside_a_longer_fence(self):
        self.assertNotIn("truncated", render("`", 19000)["end"])
        body = render("`", 10)
        self.assertNotIn("truncated", body["end"])
        self.assertIn("`" * 11 + "\n" + "`" * 10 + "\n" + "`" * 11, body["end"])

    def test_a_truncated_report_still_ends_in_a_closed_code_block(self):
        body = render("x\n", 40000)
        self.assertEqual(body["length"], MAX_BODY)
        self.assertEqual(body["fences"], 2)

    def test_truncation_never_splits_a_character(self):
        # Two-unit characters at an even and an odd offset: one of the two
        # puts the cut in the middle of a character.
        for prefix in ("", "a"):
            with self.subTest(prefix=prefix):
                body = render("\U0001F600", 40000, prefix)
                self.assertLessEqual(body["length"], MAX_BODY)
                self.assertFalse(body["loneSurrogate"])


EVALUATE = """
const { evaluate } = require('./verdict.js');
const { renderBody } = require('./body.js');
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = {};
if (input.mode === 'nothing') {
  out.verdict = evaluate();
  out.body = renderBody({ needs: null, inputs: null, event: null });
} else {
  out.verdict = evaluate({ needs: input.needs, inputs: {}, event: {} });
  out.body = renderBody({ needs: input.needs });
}
console.log(JSON.stringify(out));
"""


class VerdictOverAnyJobId(unittest.TestCase):
    def test_a_skipped_job_named_like_a_built_in_property_fails_without_a_crash(self):
        for job in ("constructor", "toString", "hasOwnProperty", "__proto__"):
            with self.subTest(job=job):
                # Built as text: a Python dict would not carry "__proto__" as
                # an own key through every JSON reader the same way.
                needs = json.loads('{"%s": {"result": "skipped"}}' % job)
                out = node(EVALUATE, {"needs": needs})
                self.assertEqual(out["verdict"]["conclusion"], "failure")
                self.assertEqual(out["verdict"]["lines"], ["FAIL %s: skipped" % job])
                self.assertIn("### ❌ hashira CI failed", out["body"])

    def test_a_successful_job_named_like_a_built_in_property_passes(self):
        out = node(EVALUATE, {"needs": {"constructor": {"result": "success"}}})
        self.assertEqual(out["verdict"]["conclusion"], "success")

    def test_called_with_nothing_the_functions_do_not_throw(self):
        out = node(EVALUATE, {"mode": "nothing"})
        self.assertEqual(out["verdict"], {"conclusion": "success", "lines": []})
        self.assertTrue(out["body"].startswith(MARKER))


# --- npm's lint step against a hostile commitlint report ---------------------

NPM_STUB = """#!/usr/bin/env bash
# Stands in for `npm install --prefix <dir> ...`: leaves a commitlint that
# prints the report under test and exits like commitlint with findings.
set -euo pipefail
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then prefix="$2"; fi
  shift
done
mkdir -p "${prefix}/node_modules/.bin"
cat > "${prefix}/node_modules/.bin/commitlint" <<'EOF'
#!/usr/bin/env bash
cat "${STUB_REPORT}"
exit "${STUB_STATUS}"
EOF
chmod +x "${prefix}/node_modules/.bin/commitlint"
"""


def lint_script():
    steps = yaml.safe_load(read(NPM_WORKFLOW))["jobs"]["lint"]["steps"]
    return next(s for s in steps if s.get("id") == "commitlint")["run"]


def read_outputs(path):
    """GITHUB_OUTPUT as the runner reads it: invalid UTF-8 becomes U+FFFD."""
    lines = read(path, "rb").decode("utf-8", errors="replace").split("\n")
    outputs = {}
    while lines:
        line = lines.pop(0)
        if "<<" in line:
            name, delim = line.split("<<", 1)
            body = []
            while lines and lines[0] != delim:
                body.append(lines.pop(0))
            lines.pop(0)
            outputs[name] = "\n".join(body)
        elif "=" in line:
            name, value = line.split("=", 1)
            outputs[name] = value
    return outputs


def run_lint(tmp, report, status="1"):
    """Run the workflow's real commitlint step over `report` (bytes)."""
    bin_dir = os.path.join(tmp, "bin")
    os.makedirs(bin_dir)
    stub = os.path.join(bin_dir, "npm")
    with open(stub, "w", encoding="utf-8") as fh:
        fh.write(NPM_STUB)
    os.chmod(stub, 0o755)
    report_file = os.path.join(tmp, "report.bin")
    with open(report_file, "wb") as fh:
        fh.write(report)
    out_file = os.path.join(tmp, "output")
    open(out_file, "w").close()
    env = {"PATH": bin_dir + os.pathsep + os.environ["PATH"], "RUNNER_TEMP": tmp,
           "GITHUB_OUTPUT": out_file, "GITHUB_STEP_SUMMARY": os.path.join(tmp, "summary.md"),
           "BASE_SHA": "a" * 40, "HEAD_SHA": "b" * 40,
           "STUB_REPORT": report_file, "STUB_STATUS": status}
    proc = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", lint_script()],
                          env=env, capture_output=True, text=True)
    return proc, read_outputs(out_file)


def run_passed(tmp, lint_outputs):
    """Run ci-summary's render step with the lint outputs in `needs`, as the
    passed job does. Non-ASCII is escaped, the longest form a JSON writer may
    choose."""
    needs = {"setup": {"result": "success", "outputs": {}},
             "lint": {"result": "success", "outputs": lint_outputs}}
    encoded = json.dumps(needs, ensure_ascii=True)
    out_file = os.path.join(tmp, "render-output")
    env = {"PATH": os.environ["PATH"], "RUNNER_TEMP": tmp, "GITHUB_OUTPUT": out_file,
           "GITHUB_STEP_SUMMARY": os.path.join(tmp, "render-summary.md"),
           "CI_SUMMARY_NEEDS": encoded, "CI_SUMMARY_INPUTS": "{}"}
    try:
        proc = subprocess.run(["node", os.path.join(LIB, "render.js")], env=env,
                              capture_output=True, text=True)
    except OSError as err:
        raise AssertionError("the passed job could not start with a %d-byte needs value: %s"
                             % (len(encoded), err))
    return proc, len(encoded), read(out_file) if os.path.exists(out_file) else ""


HOSTILE_REPORTS = {
    "control characters": b"\x01" * 200000,
    "escape sequences": b"\x1b[31m" * 40000,
    "quotes": b'"' * 200000,
    "backslashes": b"\\" * 200000,
    "newlines": b"\n" * 200000,
    "two-byte characters": "é".encode() * 100000,
    "three-byte characters": "✖".encode() * 70000,
    "four-byte characters": "\U0001F600".encode() * 50000,
}


class CommitlintNeverBlocks(unittest.TestCase):
    def test_no_report_content_stops_the_passed_job(self):
        for label, report in HOSTILE_REPORTS.items():
            with self.subTest(report=label), tempfile.TemporaryDirectory() as tmp:
                lint, outputs = run_lint(tmp, report)
                self.assertEqual(lint.returncode, 0, lint.stderr)
                self.assertEqual(outputs.get("result"), "findings")
                proc, size, written = run_passed(tmp, {"commitlint_result": outputs["result"],
                                                       "commitlint_report": outputs["report"]})
                self.assertLess(size, MAX_ENV_STRING)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertIn("conclusion=success", written)

    def test_the_report_output_holds_no_control_characters_but_newline_and_tab(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, outputs = run_lint(tmp, b"feat: ok\x01\x07\x1b[31m\x7f\r\n\tbody line\n")
        report = outputs["report"]
        self.assertEqual([c for c in report if (ord(c) < 32 and c not in "\n\t") or ord(c) == 127], [])
        self.assertIn("feat: ok[31m", report)
        self.assertIn("\tbody line", report)

    def test_a_short_report_passes_through_whole(self):
        text = "✖   subject may not be empty [subject-empty]\n✖   found 1 problems, 0 warnings\n"
        with tempfile.TemporaryDirectory() as tmp:
            _, outputs = run_lint(tmp, text.encode())
        self.assertEqual(outputs["report"].rstrip("\n"), text.rstrip("\n"))
        self.assertNotIn("truncated", outputs["report"])

    def test_an_over_long_report_says_it_was_truncated(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, outputs = run_lint(tmp, b"x" * 200000)
        self.assertIn("truncated", outputs["report"])

    def test_a_clean_run_reports_clean_with_an_empty_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            lint, outputs = run_lint(tmp, b"", status="0")
        self.assertEqual(lint.returncode, 0, lint.stderr)
        self.assertEqual((outputs.get("result"), outputs.get("report")), ("clean", ""))


# --- a CodeQL error ----------------------------------------------------------

CODEQL_ERROR = dict(CLEAN, codeql={"outcome": "failure"})


class CodeqlErrorFailsAfterEveryScannerRan(unittest.TestCase):
    def assert_failed_after_all_ran(self, inputs):
        result = run_scan_suite(inputs, CODEQL_ERROR)
        self.assertTrue(result["failed"], result["summary"])
        self.assertEqual(sorted(result["ran"]), sorted(SCANNERS))
        combined = result["summary"].split("### scan-suite combined", 1)
        self.assertEqual(len(combined), 2, "job summary lacks the combined section")
        for name in SCANNERS:
            self.assertIn("- %s:" % name, combined[1])
        rows = result["outputs"]["summary"].splitlines()
        self.assertTrue(any(r.startswith("codeql\terror\t") for r in rows), rows)
        self.assertIn("osv\tran\tno vulnerabilities found", rows)
        self.assertIn("codeql\tfail", result["outputs"]["verdicts"].splitlines())
        return result

    def test_with_fail_on_findings_true(self):
        self.assert_failed_after_all_ran({"scan_disable": "", "fail_on_findings": "true"})

    def test_at_the_default_it_still_fails_the_action_as_before(self):
        self.assert_failed_after_all_ran({"scan_disable": ""})
        self.assert_failed_after_all_ran({"scan_disable": "", "fail_on_findings": "false"})

    def test_a_disabled_codeql_cannot_fail_it(self):
        result = run_scan_suite({"scan_disable": "codeql", "fail_on_findings": "true"}, CODEQL_ERROR)
        self.assertFalse(result["failed"], result["summary"])

    def test_a_clean_codeql_keeps_its_ran_row(self):
        result = run_scan_suite({"scan_disable": ""})
        self.assertFalse(result["failed"], result["summary"])
        self.assertIn("codeql\tran\tlanguages=autodetect", result["outputs"]["summary"].splitlines())
        self.assertIn("codeql\tpass", result["outputs"]["verdicts"].splitlines())


class RunsInSelfCi(unittest.TestCase):
    def test_self_ci_runs_this_file(self):
        text = read(SELF_CI)
        self.assertTrue("python3 tests/ci-summary/test_request_edges.py" in text,
                        "_self-ci.yml does not run tests/ci-summary/test_request_edges.py")


if __name__ == "__main__":
    unittest.main()
