"""The summary_comment input: the ci-summary action gates its comment step on
`comment`, each CI workflow maps its boolean input to it, and _self-ci's
nested nuget call turns it off.

Run locally with:  python3 tests/ci-summary/test_comment_switch.py
"""
import os
import unittest

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FLOWS = ("npm-package-ci.yml", "nuget-package-ci.yml", "static-webapp-ci.yml")
MAPPING = "${{ inputs.summary_comment && 'true' || 'false' }}"


def load(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as handle:
        return yaml.safe_load(handle)


class ActionInput(unittest.TestCase):
    def setUp(self):
        self.action = load(".github/actions/ci-summary/action.yml")

    def test_comment_defaults_to_true(self):
        self.assertEqual(self.action["inputs"]["comment"]["default"], "true")

    def test_the_comment_step_runs_only_when_comment_is_true(self):
        step = next(s for s in self.action["runs"]["steps"] if "github-script" in str(s.get("uses", "")))
        self.assertIn("inputs.comment == 'true'", step["if"])
        self.assertIn("github.event_name == 'pull_request'", step["if"])

    def test_render_step_receives_the_comment_value(self):
        step = next(s for s in self.action["runs"]["steps"] if s.get("id") == "render")
        self.assertEqual(step["env"]["CI_SUMMARY_COMMENT"], "${{ inputs.comment }}")


class WorkflowMapping(unittest.TestCase):
    def test_each_workflow_has_a_boolean_input_defaulting_to_true(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                spec = load(f".github/workflows/{flow}")[True]["workflow_call"]["inputs"]["summary_comment"]
                self.assertEqual(spec["type"], "boolean")
                self.assertIs(spec["default"], True)

    def test_passed_maps_it_to_the_action(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                steps = load(f".github/workflows/{flow}")["jobs"]["passed"]["steps"]
                call = next(s for s in steps if str(s.get("uses", "")).endswith("/actions/ci-summary"))
                self.assertEqual(call["with"]["comment"], MAPPING)

    def test_passed_keeps_its_grant_whatever_the_input(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                grants = load(f".github/workflows/{flow}")["jobs"]["passed"]["permissions"]
                self.assertEqual(grants.get("pull-requests"), "write")


class SelfCi(unittest.TestCase):
    def test_the_nested_nuget_call_does_not_comment(self):
        call = load(".github/workflows/_self-ci.yml")["jobs"]["library-self-sha-call"]
        self.assertIs(call["with"]["summary_comment"], False)


if __name__ == "__main__":
    unittest.main()
