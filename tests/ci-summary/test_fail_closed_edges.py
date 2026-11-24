#!/usr/bin/env python3
"""The places where the `ci / passed` contract must fail closed, or hold
whatever the runner does.

- A scanner whose tool cannot be installed, or whose visibility detection
  breaks, is a scanner error like any other: every enabled scanner still
  runs, the combined summary is written, and then the scan-suite job fails.
  With `fail_on_findings` left at its default it still fails the action, as
  it did before that input existed.
- The `ci-summary` action called without any job result fails: a required
  check that judged nothing is not a pass.
- The commitlint report cannot stop the `passed` job however the runner
  writes JSON: the `needs` value stays under the kernel's 128 KiB limit for
  one environment string even with every character written as `\\uXXXX`.
- The comment says "1 violation", not "1 violations".
- The maintainer checklist tells whoever adds a CI workflow to give it the
  `passed` job.

Run: python3 tests/ci-summary/test_fail_closed_edges.py
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "tests", "scan-suite"))
from test_fail_on_findings import ACTION, CLEAN, SCANNERS, Runner  # noqa: E402
from test_request_edges import (  # noqa: E402
    HOSTILE_REPORTS, LIB, MAX_ENV_STRING, SELF_CI, node, read, run_lint)

RENDER_JS = os.path.join(LIB, "render.js")
CONTRIBUTING = os.path.join(REPO, "docs", "contributing.md")


# --- a scanner that cannot start ---------------------------------------------

class BrokenToolRunner(Runner):
    """The local runner, with a scanner's install or detection step failing."""

    def stub_for(self, step, scanner):
        broken = self.stubs.get(scanner, {}).get("broken")
        if broken == "install" and str(step.get("name", "")).startswith("Install"):
            return "failure", {}
        if broken == "detect" and step.get("id") == "detect":
            return "failure", {}
        return super().stub_for(step, scanner)


def run_scan_suite(inputs, stubs):
    with tempfile.TemporaryDirectory() as tmp:
        runner = BrokenToolRunner(tmp, "pull_request", False, stubs)
        failed, outputs = runner.run_action(os.path.dirname(ACTION), inputs)
        summary = read(runner.summary)
    return {"failed": failed, "outputs": outputs, "summary": summary, "ran": runner.scanners_run}


BROKEN = {"gitleaks": "install", "actionlint": "install",
          "codeql": "detect", "dependency-review": "detect"}


def broken(name):
    stubs = dict(CLEAN)
    stubs[name] = dict(CLEAN.get(name, {}), broken=BROKEN[name])
    return stubs


class ScannerThatCannotStart(unittest.TestCase):
    def assert_failed_after_all_ran(self, name, inputs):
        result = run_scan_suite(inputs, broken(name))
        self.assertTrue(result["failed"], result["summary"])
        self.assertEqual(sorted(result["ran"]), sorted(SCANNERS))
        combined = result["summary"].split("### scan-suite combined", 1)
        self.assertEqual(len(combined), 2, "job summary lacks the combined section")
        for scanner in SCANNERS:
            self.assertIn("- %s:" % scanner, combined[1])
        rows = result["outputs"]["summary"].splitlines()
        self.assertEqual([r for r in rows if r.startswith(name + "\t")][0].split("\t")[1], "error", rows)
        self.assertEqual(len([r for r in rows if r.startswith(name + "\t")]), 1, rows)
        verdicts = result["outputs"]["verdicts"].splitlines()
        self.assertIn(name + "\tfail", verdicts)
        for other in SCANNERS:
            if other != name:
                self.assertIn(other + "\tpass", verdicts)

    def test_it_fails_the_job_after_every_scanner_ran(self):
        for name in BROKEN:
            with self.subTest(scanner=name):
                self.assert_failed_after_all_ran(name, {"scan_disable": "", "fail_on_findings": "true"})

    def test_at_the_default_it_still_fails_the_action_as_before(self):
        for name in BROKEN:
            for inputs in ({"scan_disable": ""}, {"scan_disable": "", "fail_on_findings": "false"}):
                with self.subTest(scanner=name, inputs=inputs):
                    self.assert_failed_after_all_ran(name, inputs)

    def test_a_disabled_scanner_cannot_fail_it(self):
        for name in BROKEN:
            with self.subTest(scanner=name):
                result = run_scan_suite({"scan_disable": name, "fail_on_findings": "true"}, broken(name))
                self.assertFalse(result["failed"], result["summary"])

    def test_a_failed_detection_is_never_recorded_as_a_skip(self):
        for name in ("codeql", "dependency-review"):
            with self.subTest(scanner=name):
                result = run_scan_suite({"scan_disable": ""}, broken(name))
                self.assertNotIn(name + "\tskipped", result["outputs"]["verdicts"].splitlines())

    def test_working_tools_still_pass(self):
        result = run_scan_suite({"scan_disable": "", "fail_on_findings": "true"}, CLEAN)
        self.assertFalse(result["failed"], result["summary"])
        self.assertEqual(result["outputs"]["verdicts"].count("\tpass"), len(SCANNERS))


# --- the action called without job results -----------------------------------

def run_render(tmp, needs):
    """Run render.js as the action's first step does; `needs` None leaves it unset."""
    out_file = os.path.join(tmp, "output")
    env = {"PATH": os.environ["PATH"], "RUNNER_TEMP": tmp, "GITHUB_OUTPUT": out_file,
           "GITHUB_STEP_SUMMARY": os.path.join(tmp, "summary.md"), "CI_SUMMARY_INPUTS": "{}"}
    if needs is not None:
        env["CI_SUMMARY_NEEDS"] = needs
    proc = subprocess.run(["node", RENDER_JS], env=env, capture_output=True, text=True)
    return proc, read(out_file) if os.path.exists(out_file) else ""


class NoJobResultsIsNotAPass(unittest.TestCase):
    def test_the_step_fails_when_needs_holds_no_job(self):
        for label, needs in (("left out", None), ("empty", ""), ("an empty object", "{}"),
                             ("a padded empty object", " { } ")):
            with self.subTest(needs=label), tempfile.TemporaryDirectory() as tmp:
                proc, written = run_render(tmp, needs)
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn("::error", proc.stdout)
                self.assertIn("no job results", proc.stdout)
                self.assertNotIn("conclusion=success", written)

    def test_one_successful_job_is_enough_to_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, written = run_render(tmp, '{"setup": {"result": "success"}}')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("conclusion=success", written)

    def test_a_failed_job_still_reports_failure_through_the_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, written = run_render(tmp, '{"setup": {"result": "failure"}}')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("conclusion=failure", written)


# --- the needs value under any JSON writer -----------------------------------

def escape_all(value, depth=0):
    """`value` as JSON with every string character written as \\uXXXX, six
    bytes per UTF-16 unit, and indented: the longest form a JSON writer can
    give it."""
    pad = "  " * (depth + 1)
    if isinstance(value, dict):
        items = ["%s%s: %s" % (pad, escape_all(k), escape_all(v, depth + 1)) for k, v in value.items()]
        return "{\n" + ",\n".join(items) + "\n" + "  " * depth + "}"
    units = value.encode("utf-16-be")
    return '"' + "".join("\\u%02x%02x" % (units[i], units[i + 1]) for i in range(0, len(units), 2)) + '"'


def npm_needs(lint_outputs):
    """The npm workflow's needs context, every output filled in."""
    sha = "a" * 40
    scanners = "".join("%s\tskipped\n" % name for name in SCANNERS)
    return {
        "setup": {"result": "success", "outputs": {"library_sha": sha}},
        "version": {"result": "success", "outputs": {"version": "1.2.3-rc.1+build.20260101"}},
        "lint": {"result": "success", "outputs": lint_outputs},
        "test": {"result": "success", "outputs": {"lines_pct": "100.0000", "branches_pct": "100.0000"}},
        "scan-suite": {"result": "success", "outputs": {"verdicts": scanners}},
        "quality-gate": {"result": "success", "outputs": {"result": "pass", "violations": "0"}},
    }


ASCII_REPORTS = {
    "letters": b"x" * 200000,
    "angle brackets": b"<" * 200000,
    "ampersands": b"&" * 200000,
    "lines of text": b"feat: a subject line that is too long\n" * 6000,
}


class NeedsFitsOneEnvironmentString(unittest.TestCase):
    def test_under_full_escaping_the_passed_job_still_starts_and_passes(self):
        for label, report in dict(HOSTILE_REPORTS, **ASCII_REPORTS).items():
            with self.subTest(report=label), tempfile.TemporaryDirectory() as tmp:
                lint, outputs = run_lint(tmp, report)
                self.assertEqual(lint.returncode, 0, lint.stderr)
                encoded = escape_all(npm_needs({"commitlint_result": outputs["result"],
                                                "commitlint_report": outputs["report"]}))
                self.assertLess(len(encoded.encode()), MAX_ENV_STRING)
                proc, written = run_render(tmp, encoded)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertIn("conclusion=success", written)

    def test_the_escaped_form_decodes_to_the_same_value(self):
        needs = npm_needs({"commitlint_result": "findings", "commitlint_report": "✖ \U0001F600 <a>\n\t\"q\""})
        self.assertEqual(json.loads(escape_all(needs)), needs)


# --- the violation count -----------------------------------------------------

GATE_LINE = """
const { renderBody } = require('./body.js');
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const needs = { 'quality-gate': { result: 'failure', outputs: { result: 'fail', violations: input.count } } };
console.log(JSON.stringify(renderBody({ needs }).split('\\n').find((line) => line.startsWith('- quality-gate:'))));
"""


class ViolationCountReadsAsEnglish(unittest.TestCase):
    def test_one_is_singular_and_every_other_count_plural(self):
        for count, words in (("1", "1 violation"), ("0", "0 violations"), ("2", "2 violations"),
                             ("11", "11 violations"), ("01", "01 violations")):
            with self.subTest(count=count):
                self.assertEqual(node(GATE_LINE, {"count": count}), "- quality-gate: fail, " + words)


# --- the maintainer checklist and self-CI ------------------------------------

class MaintainerChecklist(unittest.TestCase):
    def test_adding_a_workflow_names_the_passed_job_and_its_lint(self):
        text = read(CONTRIBUTING)
        section = text.split("## Adding a new reusable workflow", 1)[1].split("\n## ", 1)[0]
        for needle in ("`passed`", "ci-summary", "tests/shape-lints/passed_job.py", "if: always()"):
            self.assertIn(needle, section)


class RunsInSelfCi(unittest.TestCase):
    def test_self_ci_runs_this_file(self):
        self.assertIn("python3 tests/ci-summary/test_fail_closed_edges.py", read(SELF_CI))


if __name__ == "__main__":
    unittest.main()
