#!/usr/bin/env python3
"""Hardening of the `ci / passed` check beyond the request's own rules.

- An event payload nobody could read (no GITHUB_EVENT_PATH, a missing file,
  or a file that is not a JSON object) leaves `github.event.inputs.bump`
  unknown. A skipped `version` job is a documented skip only when no bump is
  set, so with the bump unknown that skip fails `passed` instead of passing.
- The `passed` job in each of the three CI workflows sets
  `timeout-minutes: 10` and runs no actions/setup-node, and the shared shape
  lint (tests/shape-lints/passed_job.py) catches each of those regressions.

Run: python3 tests/ci-summary/test_hardening.py
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
RENDER_JS = os.path.join(REPO, ".github", "actions", "ci-summary", "lib", "render.js")
WORKFLOWS = [os.path.join(REPO, ".github", "workflows", f"{name}.yml")
             for name in ("npm-package-ci", "nuget-package-ci", "static-webapp-ci")]
SELF_CI = os.path.join(REPO, ".github", "workflows", "_self-ci.yml")
sys.path.insert(0, os.path.join(REPO, "tests", "shape-lints"))
import passed_job  # noqa: E402

VERSION_SKIPPED = {"setup": {"result": "success"}, "version": {"result": "skipped"}}
NO_BUMP = {"bump": "", "quality_gate": True}


def run_render(tmp, event):
    """Run render.js as the action's first step does. `event` is a dict to
    write as the payload, a string to write raw, "MISSING" to point at a file
    that does not exist, or None to leave GITHUB_EVENT_PATH unset."""
    out_file = os.path.join(tmp, "output")
    env = {"PATH": os.environ["PATH"], "RUNNER_TEMP": tmp, "GITHUB_OUTPUT": out_file,
           "GITHUB_STEP_SUMMARY": os.path.join(tmp, "summary.md"),
           "CI_SUMMARY_NEEDS": json.dumps(VERSION_SKIPPED), "CI_SUMMARY_INPUTS": json.dumps(NO_BUMP)}
    if event == "MISSING":
        env["GITHUB_EVENT_PATH"] = os.path.join(tmp, "no-such-event.json")
    elif event is not None:
        path = os.path.join(tmp, "event.json")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(event if isinstance(event, str) else json.dumps(event))
        env["GITHUB_EVENT_PATH"] = path
    proc = subprocess.run(["node", RENDER_JS], env=env, capture_output=True, text=True)
    with open(out_file, encoding="utf-8") as fh:
        written = fh.read()
    with open(env["GITHUB_STEP_SUMMARY"], encoding="utf-8") as fh:
        summary = fh.read()
    return proc, written, summary


class UnreadableEventFailsTheVersionSkip(unittest.TestCase):
    def test_a_readable_event_with_no_bump_is_a_documented_skip(self):
        for label, event in (("empty", {}), ("empty bump", {"inputs": {"bump": ""}})):
            with self.subTest(event=label), tempfile.TemporaryDirectory() as tmp:
                proc, written, summary = run_render(tmp, event)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertIn("conclusion=success", written)
                self.assertIn("ok version: skipped (documented skip", summary)

    def test_an_unreadable_event_leaves_the_bump_unknown_so_the_skip_fails(self):
        for label, event in (("path unset", None), ("file missing", "MISSING"),
                             ("not JSON", "{oops"), ("an array", "[]"), ("null", "null")):
            with self.subTest(event=label), tempfile.TemporaryDirectory() as tmp:
                proc, written, summary = run_render(tmp, event)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertIn("conclusion=failure", written)
                self.assertIn("FAIL version: skipped", summary)
                self.assertNotIn("documented skip", summary)


def load(path):
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


class PassedJobIsBoundedAndSelfContained(unittest.TestCase):
    def test_each_passed_job_sets_a_ten_minute_timeout(self):
        for path in WORKFLOWS:
            with self.subTest(workflow=os.path.basename(path)):
                self.assertEqual(load(path)["jobs"]["passed"].get("timeout-minutes"), 10)

    def test_no_passed_job_runs_setup_node(self):
        for path in WORKFLOWS:
            with self.subTest(workflow=os.path.basename(path)):
                uses = [str(s.get("uses", "")) for s in load(path)["jobs"]["passed"]["steps"]]
                self.assertFalse([u for u in uses if u.startswith("actions/setup-node@")], uses)

    def test_the_shape_lint_catches_each_regression(self):
        for path in WORKFLOWS:
            doc = load(path)
            self.assertEqual(passed_job.check(doc), [], path)
            ok, messages = passed_job.self_test(doc)
            self.assertTrue(ok, messages)
            for name in ("passed runs setup-node", "passed timeout removed", "passed timeout raised to 360"):
                with self.subTest(workflow=os.path.basename(path), mutation=name):
                    self.assertTrue(any(m.startswith(f"{name}: correctly failed") for m in messages), messages)

    def test_self_ci_runs_this_file(self):
        with open(SELF_CI, encoding="utf-8") as fh:
            self.assertIn("python3 tests/ci-summary/test_hardening.py", fh.read())


if __name__ == "__main__":
    unittest.main()
