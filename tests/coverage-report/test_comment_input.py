#!/usr/bin/env python3
"""coverage-report's `comment` input and its `lines_pct`/`branches_pct` outputs.

Runs the action's real parse step (bash + node) against the lcov fixture:
  - `comment` left out defaults to 'true', so the sticky comment step still
    runs on pull_request events, as before the input existed;
  - 'false' skips the comment step; any other value fails the parse step;
  - the parse step writes the totals with one decimal to GITHUB_OUTPUT, and
    the action maps them to its outputs.

Run from the repo root: python3 tests/coverage-report/test_comment_input.py
Needs python3, PyYAML and node.
"""

import os
import subprocess
import tempfile
import unittest

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ACTION_DIR = os.path.join(ROOT, ".github", "actions", "coverage-report")
LCOV = os.path.join(ROOT, "tests", "fixtures", "coverage-samples", "lcov.info")


def spec():
    with open(os.path.join(ACTION_DIR, "action.yml"), encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def step(name):
    return next(s for s in spec()["runs"]["steps"] if s.get("name") == name)


def run_parse(comment):
    """Run the parse step with `comment` as inputs.comment; return (rc, outputs, stdout)."""
    script = step("Parse coverage + write summary")["run"]
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "output")
        open(out, "w").close()
        env = {
            "PATH": os.environ["PATH"],
            "GITHUB_ACTION_PATH": ACTION_DIR,
            "GITHUB_OUTPUT": out,
            "GITHUB_STEP_SUMMARY": os.path.join(tmp, "summary"),
            "RUNNER_TEMP": tmp,
            "COVERAGE_INPUT_PATH": LCOV,
            "COVERAGE_INPUT_FORMAT": "",
            "COVERAGE_OUTPUT_FILE": os.path.join(tmp, "comment.md"),
            "COVERAGE_COMMENT": comment,
        }
        proc = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
                              env=env, capture_output=True, text=True)
        lines = open(out, encoding="utf-8").read().splitlines()
    outputs = dict(line.split("=", 1) for line in lines if "=" in line)
    return proc.returncode, outputs, proc.stdout


class CommentInput(unittest.TestCase):
    def test_declared_optional_with_default_true(self):
        comment = spec()["inputs"]["comment"]
        self.assertEqual(comment.get("default"), "true")
        self.assertFalse(comment.get("required", False))

    def test_comment_step_runs_only_on_pull_requests_with_comment_true(self):
        condition = str(step("Post sticky PR comment").get("if", "")).replace(" ", "")
        self.assertIn("github.event_name=='pull_request'", condition)
        self.assertIn("inputs.comment=='true'", condition)

    def test_true_and_false_are_accepted(self):
        for value in ("true", "false"):
            with self.subTest(value=value):
                rc, _outputs, out = run_parse(value)
                self.assertEqual(rc, 0, out)

    def test_other_values_fail_the_action(self):
        for value in ("", "yes", "TRUE", "true "):
            with self.subTest(value=value):
                rc, _outputs, out = run_parse(value)
                self.assertNotEqual(rc, 0)
                self.assertIn("comment must be 'true' or 'false'", out)


class CoverageOutputs(unittest.TestCase):
    def test_parse_step_writes_the_totals_with_one_decimal(self):
        rc, outputs, out = run_parse("false")
        self.assertEqual(rc, 0, out)
        # The lcov fixture holds 8/10 lines and 3/4 branches over two files.
        self.assertEqual(outputs.get("lines_pct"), "80.0")
        self.assertEqual(outputs.get("branches_pct"), "75.0")
        self.assertEqual(outputs.get("files"), "2")  # two SF: records

    def test_action_maps_the_parse_step_outputs(self):
        outputs = spec()["outputs"]
        self.assertIn("steps.parse.outputs.lines_pct", outputs["lines_pct"]["value"])
        self.assertIn("steps.parse.outputs.branches_pct", outputs["branches_pct"]["value"])
        self.assertIn("steps.parse.outputs.files", outputs["files"]["value"])


if __name__ == "__main__":
    unittest.main()
