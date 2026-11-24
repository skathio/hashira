#!/usr/bin/env python3
"""scan-suite's `verdicts` output, and OSV skipping hashira's own checkout.

- `verdicts` holds one '<name>\\t<pass|fail|skipped>' line per scanner, the
  data the CI summary comment shows per scanner. It is set whether or not
  `fail_on_findings` fails the action, and `summary` keeps its rows.
- OSV-Scanner never scans `.hashira/`, the library checkout in a consumer's
  workspace: an advisory against hashira's own lockfiles would otherwise
  fail every consumer's scan-suite job with nothing for them to fix.

Run: python3 tests/scan-suite/test_verdicts_output.py
"""

import os
import sys
import unittest

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_fail_on_findings import (  # noqa: E402
    ACTION, CLEAN, FINDINGS, REPO, SCANNERS, run_scan_suite, with_tool)

OSV_ACTION = os.path.join(REPO, ".github", "actions", "scan-suite", "scans", "osv", "action.yml")


def verdicts(result):
    lines = [line for line in result["outputs"].get("verdicts", "").split("\n") if line]
    return dict(line.split("\t") for line in lines), lines


class VerdictsOutput(unittest.TestCase):
    def test_declared_and_mapped_from_the_summarize_step(self):
        spec = yaml.safe_load(open(ACTION, encoding="utf-8"))
        self.assertIn("steps.summarize.outputs.verdicts", spec["outputs"]["verdicts"]["value"])

    def test_one_line_per_scanner_when_all_enabled_and_clean(self):
        found, lines = verdicts(run_scan_suite({"scan_disable": ""}, CLEAN))
        self.assertEqual(len(lines), len(SCANNERS))
        self.assertEqual(set(found), set(SCANNERS))
        self.assertEqual({found[name] for name in ("osv", "gitleaks", "dependency-review", "actionlint")},
                         {"pass"})

    def test_disabled_scanners_are_skipped(self):
        found, _ = verdicts(run_scan_suite({"scan_disable": "codeql,actionlint"}, CLEAN))
        self.assertEqual(found["codeql"], "skipped")
        self.assertEqual(found["actionlint"], "skipped")
        self.assertEqual(found["osv"], "pass")

    def test_findings_show_as_fail_and_the_output_survives_the_failure(self):
        result = run_scan_suite({"scan_disable": "", "fail_on_findings": "true"}, with_tool("osv", FINDINGS["osv"]))
        self.assertTrue(result["failed"])
        found, _ = verdicts(result)
        self.assertEqual(found["osv"], "fail")
        self.assertEqual(found["gitleaks"], "pass")

    def test_findings_are_fail_even_when_advisory(self):
        found, _ = verdicts(run_scan_suite({"scan_disable": ""}, FINDINGS))
        self.assertEqual(found["osv"], "fail")
        self.assertEqual(found["gitleaks"], "fail")

    def test_summary_output_keeps_its_three_column_rows(self):
        result = run_scan_suite({"scan_disable": ""}, CLEAN)
        rows = [row for row in result["outputs"]["summary"].split("\n") if row]
        self.assertEqual(len(rows), len(SCANNERS))
        self.assertTrue(all(len(row.split("\t")) == 3 for row in rows), rows)


class OsvSkipsTheLibraryCheckout(unittest.TestCase):
    def test_osv_excludes_the_hashira_directory(self):
        steps = yaml.safe_load(open(OSV_ACTION, encoding="utf-8"))["runs"]["steps"]
        scan = next(s for s in steps if str(s.get("uses", "")).startswith("google/osv-scanner-action"))
        args = str(scan["with"]["scan-args"]).split("\n")
        self.assertIn("--experimental-exclude=.hashira", args)
        self.assertLess(args.index("--experimental-exclude=.hashira"), args.index("${{ inputs.paths }}"))


if __name__ == "__main__":
    unittest.main()
