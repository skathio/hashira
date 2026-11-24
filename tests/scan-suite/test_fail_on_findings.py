#!/usr/bin/env python3
"""scan-suite fails its job on scanner findings or errors.

The contract under test: `scan-suite` gains an input `fail_on_findings`
(default 'false', so a standalone caller keeps today's behaviour). With it set
to 'true', a scanner whose result is findings or an error fails the action,
after every enabled scanner has run and after the job summary is written.
Scanners skipped by `scan_disable`, or by the private-repo/no-GHAS rule, do
not fail it. The three reusable CI workflows pass `fail_on_findings: 'true'`.

The composite has no off-runner entry point, so these tests run the real
action.yml steps (and the real scanner sub-composites) with a small local
runner. Only the third-party tool calls are stubbed: the stub decides the
tool's outcome or exit code, and the sub-composite's own shell records the
result exactly as it does on a runner.

Run: python3 tests/scan-suite/test_fail_on_findings.py
"""

import json
import os
import re
import subprocess
import tempfile
import unittest

import yaml

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ACTION = os.path.join(REPO, ".github", "actions", "scan-suite", "action.yml")
WORKFLOWS = ["npm-package-ci.yml", "nuget-package-ci.yml", "static-webapp-ci.yml"]
SCANNERS = ["codeql", "osv", "gitleaks", "dependency-review", "actionlint"]
STATUS_FUNCS = ("success()", "failure()", "always()", "cancelled()")

# Tool results the stubs hand to each scanner's own recording step.
CLEAN = {"osv": {"outcome": "success"}, "gitleaks": {"rc": "0"},
         "dependency-review": {"outcome": "success"}, "actionlint": {"rc": "0"}}
FINDINGS = {"osv": {"outcome": "failure"}, "gitleaks": {"rc": "1"},
            "dependency-review": {"outcome": "failure"}, "actionlint": {"rc": "1"}}
ERRORS = {"osv": {"outcome": "cancelled"}, "gitleaks": {"rc": "2"},
          "dependency-review": {"outcome": "cancelled"}}

TOKEN = re.compile(r"\s*('(?:[^']|'')*'|==|!=|&&|\|\||!|\(|\)|,|"
                   r"[A-Za-z_][\w\-]*(?:\.[A-Za-z_][\w\-]*)*|\d+)")


# --- a minimal GitHub Actions expression evaluator ---------------------------

def tokenize(text):
    tokens, pos = [], 0
    text = text.strip()
    while pos < len(text):
        match = TOKEN.match(text, pos)
        if not match:
            raise ValueError("cannot parse expression: %r" % text)
        tokens.append(match.group(1))
        pos = match.end()
    return tokens


def truthy(value):
    return value not in ("", None, False, 0)


def as_str(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, indent=2)
    return "" if value is None else str(value)


class Expr:
    def __init__(self, text, ctx):
        self.tokens, self.ctx = tokenize(text), ctx

    def peek(self):
        return self.tokens[0] if self.tokens else None

    def take(self, expected=None):
        token = self.tokens.pop(0)
        if expected and token != expected:
            raise ValueError("expected %s, got %s" % (expected, token))
        return token

    def parse(self):
        value = self.parse_or()
        if self.tokens:
            raise ValueError("trailing tokens: %r" % self.tokens)
        return value

    def parse_or(self):
        value = self.parse_and()
        while self.peek() == "||":
            self.take()
            right = self.parse_and()
            value = value if truthy(value) else right
        return value

    def parse_and(self):
        value = self.parse_unary()
        while self.peek() == "&&":
            self.take()
            right = self.parse_unary()
            value = right if truthy(value) else value
        return value

    def parse_unary(self):
        if self.peek() == "!":
            self.take()
            return not truthy(self.parse_unary())
        left = self.parse_primary()
        if self.peek() in ("==", "!="):
            negate = self.take() == "!="
            right = self.parse_primary()
            same = as_str(left).lower() == as_str(right).lower()
            return same != negate
        return left

    def parse_primary(self):
        token = self.take()
        if token == "(":
            value = self.parse_or()
            self.take(")")
            return value
        if token.startswith("'"):
            return token[1:-1].replace("''", "'")
        if token in ("true", "false"):
            return token == "true"
        if token.isdigit():
            return int(token)
        if self.peek() == "(":
            return self.call(token)
        return self.lookup(token)

    def call(self, name):
        self.take("(")
        args = []
        while self.peek() != ")":
            args.append(self.parse_or())
            if self.peek() == ",":
                self.take()
        self.take(")")
        status = {"success": not self.ctx["failed"], "failure": self.ctx["failed"],
                  "always": True, "cancelled": False}
        if name in status:
            return status[name]
        if name == "toJSON":
            return as_str(args[0])
        if name == "contains":
            return as_str(args[1]).lower() in as_str(args[0]).lower()
        raise ValueError("unsupported function %s()" % name)

    def lookup(self, path):
        value = self.ctx
        for part in path.split("."):
            value = value.get(part, "") if isinstance(value, dict) else ""
        return value


def evaluate(text, ctx):
    return Expr(text, ctx).parse()


def expand(value, ctx):
    return re.sub(r"\$\{\{(.*?)\}\}", lambda m: as_str(evaluate(m.group(1), ctx)), str(value))


def should_run(step, ctx):
    cond = step.get("if")
    if cond is None:
        return not ctx["failed"]
    cond = str(cond).strip()
    if cond.startswith("${{") and cond.endswith("}}"):
        cond = cond[3:-2]
    if not any(func in cond for func in STATUS_FUNCS):
        cond = "success() && (%s)" % cond
    return truthy(evaluate(cond, ctx))


# --- a minimal composite-action runner ---------------------------------------

def read_outputs(path):
    outputs, lines = {}, open(path, encoding="utf-8").read().split("\n")
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


class Runner:
    def __init__(self, tmp, event, force_private, stubs):
        self.workspace = os.path.join(tmp, "ws")
        self.temp = os.path.join(tmp, "runner-temp")
        self.summary = os.path.join(tmp, "step-summary.md")
        os.makedirs(self.workspace)
        os.makedirs(self.temp)
        open(self.summary, "w").close()
        os.symlink(REPO, os.path.join(self.workspace, ".hashira"))
        self.stubs = stubs
        self.scanners_run = []
        self.env = {"HASHIRA_FORCE_PRIVATE_NO_GHAS": "1" if force_private else ""}
        repo = {"visibility": "public", "full_name": "octo/app"}
        self.github = {"event_name": event, "event": {"repository": repo},
                       "payload": {"repository": repo}, "repository": "octo/app",
                       "workspace": self.workspace}

    def run_action(self, action_dir, inputs, failed=False, scanner=None):
        spec = yaml.safe_load(open(os.path.join(action_dir, "action.yml"), encoding="utf-8"))
        merged = {k: as_str(v.get("default", "")) for k, v in (spec.get("inputs") or {}).items()}
        merged.update(inputs)
        ctx = {"inputs": merged, "steps": {}, "env": self.env, "failed": failed,
               "github": dict(self.github, action_path=action_dir)}
        for index, step in enumerate(spec["runs"]["steps"]):
            if should_run(step, ctx):
                self.run_step(step, ctx, action_dir, scanner, index)
        outputs = {k: expand(v.get("value", ""), ctx) for k, v in (spec.get("outputs") or {}).items()}
        return ctx["failed"], outputs

    def run_step(self, step, ctx, action_dir, scanner, index):
        outcome, outputs = self.execute(step, ctx, action_dir, scanner)
        if outcome != "success" and not step.get("continue-on-error"):
            ctx["failed"] = True
        ctx["steps"][step.get("id", "__step%d" % index)] = {"outputs": outputs, "outcome": outcome}

    def execute(self, step, ctx, action_dir, scanner):
        stub = self.stub_for(step, scanner)
        if stub is not None:
            return stub
        if "uses" in step:
            return self.run_uses(step, ctx)
        return self.run_shell(step, ctx, action_dir)

    def stub_for(self, step, scanner):
        if scanner is None:
            return None
        tool = self.stubs.get(scanner, {})
        if "@" in str(step.get("uses", "")):
            return tool.get("outcome", "success"), {}
        if str(step.get("name", "")).startswith("Install"):
            return "success", {}
        if "run" in step and step.get("id") == "run" and "rc" in tool:
            return "success", {"rc": tool["rc"]}
        return None

    def run_uses(self, step, ctx):
        target = str(step["uses"])
        if not target.startswith("./"):
            raise AssertionError("scan-suite step uses an action this runner cannot run: " + target)
        action_dir = os.path.join(self.workspace, target[2:])
        with_inputs = {k: expand(v, ctx) for k, v in (step.get("with") or {}).items()}
        scanner = os.path.basename(action_dir) if "/scans/" in target else None
        if scanner:
            self.scanners_run.append(scanner)
        failed, outputs = self.run_action(action_dir, with_inputs, ctx["failed"], scanner)
        return ("failure" if failed and not ctx["failed"] else "success"), outputs

    def run_shell(self, step, ctx, action_dir):
        out_file = os.path.join(self.temp, "out-%d" % len(os.listdir(self.temp)))
        open(out_file, "w").close()
        env = {k: v for k, v in os.environ.items() if not k.startswith(("GITHUB_", "HASHIRA_"))}
        env.update({"GITHUB_OUTPUT": out_file, "GITHUB_STEP_SUMMARY": self.summary,
                    "RUNNER_TEMP": self.temp, "GITHUB_WORKSPACE": self.workspace,
                    "GITHUB_ACTION_PATH": action_dir, "GITHUB_EVENT_NAME": self.github["event_name"]})
        env.update({k: v for k, v in self.env.items() if v})
        env.update({k: expand(v, ctx) for k, v in (step.get("env") or {}).items()})
        script = expand(step["run"], ctx)
        shell = str(step.get("shell", "bash"))
        argv = ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script]
        if shell == "sh":
            argv = ["sh", "-e", "-c", script]
        proc = subprocess.run(argv, cwd=self.workspace, env=env, capture_output=True, text=True)
        return ("success" if proc.returncode == 0 else "failure"), read_outputs(out_file)


def run_scan_suite(inputs, stubs=None, event="pull_request", force_private=False):
    """Run scan-suite with the given `with:` inputs; return what a job would see."""
    with tempfile.TemporaryDirectory() as tmp:
        runner = Runner(tmp, event, force_private, CLEAN if stubs is None else stubs)
        failed, outputs = runner.run_action(os.path.dirname(ACTION), inputs)
        summary = open(runner.summary, encoding="utf-8").read()
    return {"failed": failed, "outputs": outputs, "summary": summary, "ran": runner.scanners_run}


def with_tool(name, result):
    stubs = dict(CLEAN)
    stubs[name] = result
    return stubs


# --- the tests ---------------------------------------------------------------

class FailOnFindingsInput(unittest.TestCase):
    def test_input_is_declared_optional_with_default_false(self):
        spec = yaml.safe_load(open(ACTION, encoding="utf-8"))
        self.assertIn("fail_on_findings", spec["inputs"])
        declared = spec["inputs"]["fail_on_findings"]
        self.assertFalse(declared.get("required", False))
        self.assertEqual(as_str(declared.get("default")), "false")

    def test_summary_output_is_still_declared(self):
        spec = yaml.safe_load(open(ACTION, encoding="utf-8"))
        self.assertIn("summary", spec["outputs"])


class DefaultKeepsTodaysBehaviour(unittest.TestCase):
    def test_findings_in_every_scanner_pass_when_input_left_out(self):
        result = run_scan_suite({"scan_disable": ""}, FINDINGS)
        self.assertFalse(result["failed"], result["summary"])

    def test_errors_pass_when_input_left_out(self):
        result = run_scan_suite({"scan_disable": ""}, dict(CLEAN, **ERRORS))
        self.assertFalse(result["failed"], result["summary"])

    def test_findings_pass_when_input_is_false(self):
        result = run_scan_suite({"scan_disable": "", "fail_on_findings": "false"}, FINDINGS)
        self.assertFalse(result["failed"], result["summary"])


class CleanAndSkippedScansPass(unittest.TestCase):
    def test_every_scanner_clean_passes(self):
        result = run_scan_suite({"scan_disable": "", "fail_on_findings": "true"})
        self.assertFalse(result["failed"], result["summary"])
        self.assertEqual(sorted(result["ran"]), sorted(SCANNERS))

    def test_no_scanner_enabled_passes(self):
        result = run_scan_suite({"scan_disable": ",".join(SCANNERS), "fail_on_findings": "true"},
                                FINDINGS)
        self.assertFalse(result["failed"], result["summary"])
        self.assertEqual(result["ran"], [])

    def test_only_one_scanner_enabled_and_clean_passes(self):
        others = [s for s in SCANNERS if s != "gitleaks"]
        result = run_scan_suite({"scan_disable": ",".join(others), "fail_on_findings": "true"})
        self.assertFalse(result["failed"], result["summary"])
        self.assertEqual(result["ran"], ["gitleaks"])

    def test_default_disable_list_with_clean_scanners_passes(self):
        result = run_scan_suite({"fail_on_findings": "true"})
        self.assertFalse(result["failed"], result["summary"])

    def test_scanner_disabled_by_scan_disable_does_not_fail(self):
        for name, findings in FINDINGS.items():
            with self.subTest(scanner=name):
                result = run_scan_suite({"scan_disable": name, "fail_on_findings": "true"},
                                        with_tool(name, findings))
                self.assertFalse(result["failed"], result["summary"])
                self.assertNotIn(name, result["ran"])

    def test_private_repo_without_ghas_skips_do_not_fail(self):
        stubs = with_tool("dependency-review", FINDINGS["dependency-review"])
        result = run_scan_suite({"scan_disable": "", "fail_on_findings": "true"},
                                stubs, force_private=True)
        self.assertFalse(result["failed"], result["summary"])
        rows = result["outputs"]["summary"].splitlines()
        self.assertTrue(any(r.startswith("codeql\tskipped\t") for r in rows), rows)
        self.assertTrue(any(r.startswith("dependency-review\tskipped\t") for r in rows), rows)


class FindingsAndErrorsFail(unittest.TestCase):
    def assert_fails_after_all_ran(self, stubs):
        result = run_scan_suite({"scan_disable": "", "fail_on_findings": "true"}, stubs)
        self.assertTrue(result["failed"], result["summary"])
        self.assertEqual(sorted(result["ran"]), sorted(SCANNERS))
        combined = result["summary"].split("### scan-suite combined", 1)
        self.assertEqual(len(combined), 2, "job summary lacks the combined section")
        for name in SCANNERS:
            self.assertIn("- %s:" % name, combined[1])
        return result

    def test_findings_from_each_scanner_fail(self):
        for name, findings in FINDINGS.items():
            with self.subTest(scanner=name):
                self.assert_fails_after_all_ran(with_tool(name, findings))

    def test_error_from_each_scanner_fails(self):
        for name, error in ERRORS.items():
            with self.subTest(scanner=name):
                result = self.assert_fails_after_all_ran(with_tool(name, error))
                rows = result["outputs"]["summary"].splitlines()
                self.assertTrue(any(r.startswith(name + "\terror\t") for r in rows), rows)

    def test_findings_in_every_scanner_fail(self):
        self.assert_fails_after_all_ran(FINDINGS)

    def test_first_scanner_findings_still_let_later_scanners_run(self):
        result = self.assert_fails_after_all_ran(with_tool("osv", FINDINGS["osv"]))
        rows = result["outputs"]["summary"].splitlines()
        for name in ("gitleaks", "dependency-review", "actionlint"):
            self.assertTrue(any(r.startswith(name + "\tran\t") for r in rows), rows)

    def test_summary_output_keeps_its_existing_rows(self):
        result = self.assert_fails_after_all_ran(with_tool("gitleaks", FINDINGS["gitleaks"]))
        rows = result["outputs"]["summary"].splitlines()
        self.assertIn("gitleaks\tran\tleaks found (see gitleaks-report.json)", rows)
        self.assertIn("osv\tran\tno vulnerabilities found", rows)


class WorkflowsTurnItOn(unittest.TestCase):
    def scan_suite_step(self, workflow):
        path = os.path.join(REPO, ".github", "workflows", workflow)
        job = yaml.safe_load(open(path, encoding="utf-8"))["jobs"]["scan-suite"]
        steps = [s for s in job["steps"]
                 if str(s.get("uses", "")).endswith("/.github/actions/scan-suite")]
        self.assertEqual(len(steps), 1, workflow)
        return job, steps[0]

    # Findings fail by default; the workflow input scan_fail_on_findings
    # (boolean, default true) is the only switch, mapped to the action's
    # string input.
    def test_each_workflow_maps_its_input_to_fail_on_findings(self):
        for workflow in WORKFLOWS:
            with self.subTest(workflow=workflow):
                _, step = self.scan_suite_step(workflow)
                self.assertEqual(as_str(step.get("with", {}).get("fail_on_findings")),
                                 "${{ inputs.scan_fail_on_findings && 'true' || 'false' }}")
                path = os.path.join(REPO, ".github", "workflows", workflow)
                spec = yaml.safe_load(open(path, encoding="utf-8"))[True]["workflow_call"]["inputs"]
                self.assertEqual(spec["scan_fail_on_findings"]["type"], "boolean")
                self.assertIs(spec["scan_fail_on_findings"]["default"], True)

    def test_no_workflow_masks_the_scan_suite_failure(self):
        for workflow in WORKFLOWS:
            with self.subTest(workflow=workflow):
                job, step = self.scan_suite_step(workflow)
                self.assertFalse(job.get("continue-on-error", False))
                self.assertFalse(step.get("continue-on-error", False))


if __name__ == "__main__":
    unittest.main()
