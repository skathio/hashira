#!/usr/bin/env python3
"""scan-suite's fail_on_findings guards: a bad value and a missing verdict.

`test_fail_on_findings.py` holds the main contract. These cases cover the two
ways the new input fails closed: a value other than 'true' or 'false' stops
the action before any scanner runs, and an enabled scanner that recorded no
verdict fails the final check instead of counting as a pass.

Run: python3 tests/scan-suite/test_fail_on_findings_guards.py
"""

import os
import subprocess
import sys
import tempfile
import unittest

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_fail_on_findings import ACTION, FINDINGS, run_scan_suite  # noqa: E402


def fail_step_script():
    steps = yaml.safe_load(open(ACTION, encoding="utf-8"))["runs"]["steps"]
    return next(s for s in steps if s.get("name") == "Fail on findings")["run"]


def run_fail_step(verdict_lines):
    """Run the final check against a verdicts file holding `verdict_lines`."""
    with tempfile.TemporaryDirectory() as tmp:
        with open(os.path.join(tmp, "scan-suite-verdicts.tsv"), "w", encoding="utf-8") as fh:
            fh.write("".join(line + "\n" for line in verdict_lines))
        env = {"PATH": os.environ["PATH"], "RUNNER_TEMP": tmp}
        return subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c",
                               fail_step_script()], env=env, capture_output=True, text=True)


ALL_PASS = ["codeql\tskipped", "osv\tpass", "gitleaks\tpass",
            "dependency-review\tpass", "actionlint\tskipped"]


class BadValueFailsClosed(unittest.TestCase):
    def test_values_other_than_true_or_false_fail_before_any_scanner(self):
        for value in ("yes", "1", "", "true "):
            with self.subTest(value=value):
                result = run_scan_suite({"scan_disable": "", "fail_on_findings": value}, FINDINGS)
                self.assertTrue(result["failed"], result["summary"])
                self.assertEqual(result["ran"], [])


class FinalCheck(unittest.TestCase):
    def test_passes_when_every_scanner_passed_or_skipped(self):
        proc = run_fail_step(ALL_PASS)
        self.assertEqual(proc.returncode, 0, proc.stdout)

    def test_fails_when_a_scanner_recorded_no_verdict(self):
        proc = run_fail_step([line for line in ALL_PASS if not line.startswith("osv\t")])
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("osv recorded no result", proc.stdout)

    def test_fails_on_an_unknown_verdict(self):
        proc = run_fail_step([l if not l.startswith("gitleaks\t") else "gitleaks\tmaybe"
                              for l in ALL_PASS])
        self.assertNotEqual(proc.returncode, 0)

    def test_names_every_failing_scanner(self):
        lines = ["osv\tfail" if l.startswith("osv\t") else
                 "actionlint\tfail" if l.startswith("actionlint\t") else l for l in ALL_PASS]
        proc = run_fail_step(lines)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("osv reported findings or an error", proc.stdout)
        self.assertIn("actionlint reported findings or an error", proc.stdout)


if __name__ == "__main__":
    unittest.main()
