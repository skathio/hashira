#!/usr/bin/env python3
"""
Contract tests for the aggregate `passed` job in the three reusable CI
workflows, and for what it depends on.

- `passed` has id and name `passed`, needs every other job of its workflow
  and nothing else, runs with `if: always()`, and is the only job holding
  `pull-requests: write`, with a why-comment on each grant.
- `passed` checks hashira out itself at `job.workflow_sha`, not through
  setup's `library_sha` output, and renders through the `ci-summary` action.
- The `test` jobs pass `comment: 'false'` to coverage-report and npm's
  `lint` drops to `contents: read` with no comment step. No step touches the
  old coverage or commitlint comments.
- The job outputs `passed` reads exist: test `lines_pct` and
  `branches_pct`, scan-suite `verdicts`, quality-gate `result` and
  `violations`, npm lint `commitlint_result` and `commitlint_report`.
- coverage-report gains the `comment` input (default 'true') and its two
  coverage outputs; quality-gate gains `result` and `violations`.
- The shape lints catch a missing `passed`, a dropped need, a weaker `if`
  and a second `pull-requests: write`; the catalog, identity, fixture-diff,
  v3 caller-docs and gate lints pass.
- Templates, fixtures and the README say the grant is for the CI summary
  comment; the flow docs and usage.md name `ci / passed`.

Run from the repo root: python3 tests/ci-summary/test_passed_job.py
Needs python3 and PyYAML, as the other shape lints do.
"""

import os
import re
import shutil
import subprocess
import tempfile
import unittest

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
THIS_FILE = "tests/ci-summary/test_passed_job.py"
FLOWS = {
    "npm": "npm-package-ci.yml",
    "nuget": "nuget-package-ci.yml",
    "static-webapp": "static-webapp-ci.yml",
}
CI_SUMMARY = ".github/actions/ci-summary"
OLD_MARKERS = ("hashira:coverage-report", "hashira:npm-package-ci:commitlint")
SUMMARY_GRANT = "CI summary comment on the pull request"
SHA_PIN = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")
VERSION_NOTE = re.compile(r"#\s*(\S+\s+)?v\d+(\.\d+)*")
COPIED_DIRS = (".github", "docs", "templates", "tests")
COPIED_FILES = ("README.md", "CLAUDE.md", "package.json")
IGNORED = shutil.ignore_patterns("node_modules", "__pycache__", ".git")


def path(rel, root=ROOT):
    return os.path.join(root, rel)


def read(rel, root=ROOT):
    with open(path(rel, root), encoding="utf-8") as handle:
        return handle.read()


def load(rel, root=ROOT):
    return yaml.safe_load(read(rel, root)) or {}


def workflow(flow):
    return f".github/workflows/{FLOWS[flow]}"


def jobs_of(flow, root=ROOT):
    return load(workflow(flow), root).get("jobs") or {}


def workflow_inputs_of(flow, root=ROOT):
    # PyYAML reads the bare key `on` as the boolean True.
    triggers = load(workflow(flow), root).get(True) or {}
    return (triggers.get("workflow_call") or {}).get("inputs") or {}


def job_text(flow, job_id, root=ROOT):
    """The raw lines of one job block, comments included."""
    lines, start, end = block_span(read(workflow(flow), root), job_id)
    return [line.rstrip("\n") for line in lines[start:end]]


def as_list(value):
    if value is None:
        return []
    return [value] if isinstance(value, str) else list(value)


def expression(value):
    text = str(value).strip()
    match = re.fullmatch(r"\$\{\{\s*(.*?)\s*\}\}", text)
    return (match.group(1) if match else text).replace(" ", "")


def grants(job):
    perms = job.get("permissions")
    return perms if isinstance(perms, dict) else {}


def steps_of(job):
    return job.get("steps") or []


def step_text(step):
    with_ = step.get("with") or {}
    return f"{step.get('run') or ''}\n{with_.get('script') or ''}"


def all_steps(flow):
    return [(job_id, step) for job_id, job in jobs_of(flow).items() for step in steps_of(job)]


def uses_lines(lines):
    return [(i, line) for i, line in enumerate(lines)
            if re.match(r"^\s*-?\s*uses:\s*\S", line)]


def is_third_party(ref):
    return not ref.startswith("./") and not ref.startswith("docker://")


def has_version_note(lines, index):
    above = lines[index - 1] if index > 0 else ""
    return bool(VERSION_NOTE.search(lines[index]) or VERSION_NOTE.search(above))


def lint_path(flow):
    return f"tests/{FLOWS[flow][:-len('.yml')]}/shape-validate.py"


def run(args, cwd=ROOT):
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=300)
    return proc.returncode, proc.stdout + proc.stderr


def copy_repo():
    copy = tempfile.mkdtemp(prefix="hashira-passed-")
    for rel in [d for d in COPIED_DIRS if os.path.isdir(path(d))]:
        shutil.copytree(path(rel), path(rel, copy), symlinks=True, ignore=IGNORED)
    for rel in [f for f in COPIED_FILES if os.path.isfile(path(f))]:
        shutil.copy2(path(rel), path(rel, copy))
    return copy


def write(rel, text, root):
    with open(path(rel, root), "w", encoding="utf-8") as handle:
        handle.write(text)


class PassedJobShape(unittest.TestCase):
    """The aggregate check consumers' rulesets require as `ci / passed`."""

    def test_passed_exists_with_that_name(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                jobs = jobs_of(flow)
                self.assertIn("passed", jobs)
                self.assertEqual(jobs["passed"].get("name"), "passed")

    def test_passed_needs_exactly_every_other_job(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                jobs = jobs_of(flow)
                needs = as_list(jobs["passed"].get("needs"))
                self.assertEqual(len(needs), len(set(needs)), "a need is listed twice")
                self.assertEqual(set(needs), set(jobs) - {"passed"})

    def test_passed_needs_the_jobs_named_in_the_request(self):
        expected = {
            "npm": {"setup", "version", "lint", "test", "scan-suite", "quality-gate"},
            "nuget": {"setup", "version", "restore-build", "test", "scan-suite", "quality-gate"},
            "static-webapp": {"setup", "build-and-upload", "test", "scan-suite", "quality-gate"},
        }
        for flow, names in expected.items():
            with self.subTest(flow=flow):
                self.assertLessEqual(names, set(as_list(jobs_of(flow)["passed"].get("needs"))))

    def test_passed_runs_always_even_when_setup_fails_or_the_run_is_cancelled(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                self.assertEqual(expression(jobs_of(flow)["passed"].get("if")), "always()")

    def test_top_level_permissions_stay_deny_all(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                top = load(workflow(flow)).get("permissions")
                self.assertIn(top, ({}, {"contents": "read"}))

    def test_passed_is_the_only_job_with_pull_requests_write(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                writers = [job_id for job_id, job in jobs_of(flow).items()
                           if grants(job).get("pull-requests") == "write"]
                self.assertEqual(writers, ["passed"])

    def test_each_passed_grant_says_why(self):
        for flow in FLOWS:
            lines = job_text(flow, "passed")
            for key in grants(jobs_of(flow)["passed"]):
                with self.subTest(flow=flow, grant=key):
                    index = next(i for i, line in enumerate(lines)
                                 if re.match(rf"^\s+{re.escape(key)}:\s*\S", line))
                    self.assertTrue("#" in lines[index] or lines[index - 1].strip().startswith("#"),
                                    f"no why-comment on the {key} grant")

    def test_passed_checks_the_library_out_itself_at_its_own_commit(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                text = "\n".join(job_text(flow, "passed"))
                self.assertIn("job.workflow_sha", text)
                self.assertNotIn("library_sha", text)
                checkouts = [s for s in steps_of(jobs_of(flow)["passed"])
                             if str(s.get("uses", "")).startswith("actions/checkout@")
                             and (s.get("with") or {}).get("repository") == "skathio/hashira"]
                self.assertEqual(len(checkouts), 1)
                self.assertEqual((checkouts[0].get("with") or {}).get("path"), ".hashira")

    def test_passed_renders_through_the_ci_summary_action(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                refs = [str(s.get("uses", "")) for s in steps_of(jobs_of(flow)["passed"])]
                self.assertIn("./.hashira/.github/actions/ci-summary", refs)

    def test_passed_pins_third_party_actions_by_sha_with_a_version(self):
        for flow in FLOWS:
            lines = job_text(flow, "passed")
            for index, line in uses_lines(lines):
                ref = line.split("uses:", 1)[1].split("#")[0].strip()
                if is_third_party(ref):
                    with self.subTest(flow=flow, ref=ref):
                        self.assertRegex(ref, SHA_PIN)
                        self.assertTrue(has_version_note(lines, index))

    def test_scan_suite_findings_reach_passed(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                jobs = jobs_of(flow)
                self.assertIn("scan-suite", as_list(jobs["passed"].get("needs")))
                suite = [s for s in steps_of(jobs["scan-suite"])
                         if str(s.get("uses", "")).endswith("/actions/scan-suite")]
                self.assertEqual(len(suite), 1)
                self.assertEqual(str((suite[0].get("with") or {}).get("fail_on_findings")),
                                 "${{ inputs.scan_fail_on_findings && 'true' || 'false' }}")
                spec = workflow_inputs_of(flow)["scan_fail_on_findings"]
                self.assertEqual(spec.get("type"), "boolean")
                self.assertIs(spec.get("default"), True)


class CommentStepsMoveToPassed(unittest.TestCase):
    """`passed` writes the one comment; test and lint no longer do."""

    def test_test_jobs_turn_the_coverage_comment_off(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                test = jobs_of(flow)["test"]
                reports = [s for s in steps_of(test)
                           if str(s.get("uses", "")).endswith("/actions/coverage-report")]
                self.assertEqual(len(reports), 1)
                self.assertEqual(str((reports[0].get("with") or {}).get("comment")).lower(), "false")
                self.assertNotIn("pull-requests", grants(test))

    def test_npm_lint_drops_to_contents_read_with_no_comment_step(self):
        lint = jobs_of("npm")["lint"]
        self.assertEqual(grants(lint), {"contents": "read"})
        self.assertFalse([s for s in steps_of(lint)
                          if str(s.get("uses", "")).startswith("actions/github-script@")])

    def test_only_passed_uses_github_script_in_the_workflows(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                users = [job_id for job_id, job in jobs_of(flow).items()
                         if any(str(s.get("uses", "")).startswith("actions/github-script@")
                                for s in steps_of(job)) and job_id != "passed"]
                self.assertEqual(users, [])

    def test_no_workflow_step_touches_the_old_comments(self):
        for flow in FLOWS:
            for job_id, step in all_steps(flow):
                with self.subTest(flow=flow, job=job_id, step=step.get("name")):
                    named = [m for m in OLD_MARKERS if m in step_text(step)]
                    self.assertEqual(named, [], "a step names an old comment marker")

    def test_ci_summary_leaves_the_old_comments_alone(self):
        for dirpath, _dirs, files in os.walk(path(CI_SUMMARY)):
            for name in files:
                rel = os.path.relpath(os.path.join(dirpath, name), ROOT)
                with self.subTest(file=rel):
                    for marker in OLD_MARKERS:
                        self.assertFalse(marker in read(rel), f"{rel} names {marker}")


class JobOutputsCarryTheData(unittest.TestCase):
    """The fields ci-summary reads from `needs.<job>.outputs`."""

    def assert_outputs(self, flow, job_id, names):
        outputs = jobs_of(flow)[job_id].get("outputs") or {}
        for name in names:
            with self.subTest(flow=flow, job=job_id, output=name):
                self.assertIn(name, outputs)
                self.assertIn("${{", str(outputs[name]))

    def test_test_job_outputs_coverage_percentages(self):
        for flow in FLOWS:
            self.assert_outputs(flow, "test", ("lines_pct", "branches_pct"))

    def test_scan_suite_job_outputs_verdicts(self):
        for flow in FLOWS:
            self.assert_outputs(flow, "scan-suite", ("verdicts",))

    def test_quality_gate_job_outputs_result_and_violations(self):
        for flow in FLOWS:
            self.assert_outputs(flow, "quality-gate", ("result", "violations"))

    def test_npm_lint_outputs_the_commitlint_result_and_report(self):
        self.assert_outputs("npm", "lint", ("commitlint_result", "commitlint_report"))


class ActionContracts(unittest.TestCase):
    """Additive changes to the composite actions, and the new ci-summary."""

    def test_coverage_report_comment_input_defaults_to_true(self):
        spec = load(".github/actions/coverage-report/action.yml")
        comment = (spec.get("inputs") or {}).get("comment") or {}
        self.assertEqual(str(comment.get("default")).lower(), "true")
        self.assertFalse(comment.get("required", False))
        self.assertIn("inputs.comment", read(".github/actions/coverage-report/action.yml"))

    def test_coverage_report_outputs_coverage_percentages(self):
        outputs = load(".github/actions/coverage-report/action.yml").get("outputs") or {}
        self.assertLessEqual({"lines_pct", "branches_pct"}, set(outputs))

    def test_coverage_report_keeps_its_other_inputs(self):
        inputs = load(".github/actions/coverage-report/action.yml").get("inputs") or {}
        self.assertLessEqual({"coverage_path", "format", "artifact_name", "artifact_retention_days"}, set(inputs))

    def test_quality_gate_outputs_result_and_violations(self):
        outputs = load(".github/actions/quality-gate/action.yml").get("outputs") or {}
        self.assertLessEqual({"result", "violations"}, set(outputs))

    def test_ci_summary_is_a_composite_action(self):
        spec = load(f"{CI_SUMMARY}/action.yml")
        self.assertEqual((spec.get("runs") or {}).get("using"), "composite")

    def test_ci_summary_uses_the_github_script_pin_the_repo_already_has(self):
        pinned = re.search(r"actions/github-script@([0-9a-f]{40})",
                           read(".github/actions/coverage-report/action.yml")).group(1)
        lines = read(f"{CI_SUMMARY}/action.yml").splitlines()
        refs = [(i, line.split("uses:", 1)[1].split("#")[0].strip()) for i, line in uses_lines(lines)]
        scripts = [(i, ref) for i, ref in refs if ref.startswith("actions/github-script@")]
        self.assertTrue(scripts, "ci-summary writes the comment through actions/github-script")
        for index, ref in scripts:
            self.assertEqual(ref, f"actions/github-script@{pinned}")
            self.assertTrue(has_version_note(lines, index))

    def test_ci_summary_pins_every_third_party_action(self):
        lines = read(f"{CI_SUMMARY}/action.yml").splitlines()
        for index, line in uses_lines(lines):
            ref = line.split("uses:", 1)[1].split("#")[0].strip()
            with self.subTest(ref=ref):
                self.assertNotIn(".github/workflows/", ref, "a composite never calls a reusable workflow")
                if is_third_party(ref):
                    self.assertRegex(ref, SHA_PIN)
                    self.assertTrue(has_version_note(lines, index))


class ShapeLintsGuardPassed(unittest.TestCase):
    """Each flow's shape-validate fails on a broken `passed` job."""

    @classmethod
    def setUpClass(cls):
        cls.copy = copy_repo()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.copy, ignore_errors=True)

    def setUp(self):
        self.saved = {flow: read(workflow(flow), self.copy) for flow in FLOWS}

    def tearDown(self):
        for flow, text in self.saved.items():
            write(workflow(flow), text, self.copy)

    def lint(self, flow):
        return run(["python3", lint_path(flow)], cwd=self.copy)

    def mutate(self, flow, edit):
        text = self.saved[flow]
        changed = edit(text)
        self.assertNotEqual(changed, text, "the mutation did not apply; update this test")
        write(workflow(flow), changed, self.copy)
        return yaml.safe_load(changed).get("jobs") or {}

    def assert_lint_fails(self, flow):
        code, output = self.lint(flow)
        self.assertNotEqual(code, 0, f"{flow} shape-validate passed a broken workflow:\n{output}")

    def test_the_real_workflows_pass(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                code, output = self.lint(flow)
                self.assertEqual(code, 0, output)

    def test_self_test_mode_passes(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                code, output = run(["python3", lint_path(flow), "--self-test"])
                self.assertEqual(code, 0, output)

    def test_a_missing_passed_job_fails(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                jobs = self.mutate(flow, lambda t: drop_block(t, "passed"))
                self.assertNotIn("passed", jobs)
                self.assert_lint_fails(flow)
                write(workflow(flow), self.saved[flow], self.copy)

    def test_a_dropped_need_fails(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                jobs = self.mutate(flow, lambda t: drop_need(t, "scan-suite"))
                self.assertNotIn("scan-suite", as_list(jobs["passed"].get("needs")))
                self.assert_lint_fails(flow)
                write(workflow(flow), self.saved[flow], self.copy)

    def test_a_weaker_if_fails(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                jobs = self.mutate(flow, weaken_if)
                self.assertEqual(expression(jobs["passed"].get("if")), "!cancelled()")
                self.assert_lint_fails(flow)
                write(workflow(flow), self.saved[flow], self.copy)

    def test_a_second_pull_requests_write_fails(self):
        for flow in FLOWS:
            with self.subTest(flow=flow):
                jobs = self.mutate(flow, lambda t: in_block(
                    t, "test", "    permissions:\n", "    permissions:\n      pull-requests: write\n"))
                self.assertEqual(grants(jobs["test"]).get("pull-requests"), "write")
                self.assert_lint_fails(flow)
                write(workflow(flow), self.saved[flow], self.copy)


def block_span(text, job_id):
    lines = text.splitlines(keepends=True)
    header = re.compile(rf"^  {re.escape(job_id)}:\s*(#.*)?$")
    start = next(i for i, line in enumerate(lines) if header.match(line))
    end = next((i for i in range(start + 1, len(lines))
                if re.match(r"^ {0,2}\S", lines[i])), len(lines))
    return lines, start, end


def drop_block(text, job_id):
    lines, start, end = block_span(text, job_id)
    return "".join(lines[:start] + lines[end:])


def in_block(text, job_id, old, new):
    lines, start, end = block_span(text, job_id)
    block = "".join(lines[start:end]).replace(old, new, 1)
    return "".join(lines[:start]) + block + "".join(lines[end:])


def weaken_if(text):
    lines, start, end = block_span(text, "passed")
    block = re.sub(r"(?m)^(    if:.*)always\(\)", r"\1!cancelled()", "".join(lines[start:end]), count=1)
    return "".join(lines[:start]) + block + "".join(lines[end:])


def drop_need(text, need):
    lines, start, end = block_span(text, job_id="passed")
    block = "".join(lines[start:end])
    block = re.sub(rf"(?m)^\s+-\s*{re.escape(need)}\s*(#.*)?\n", "", block, count=1)
    block = re.sub(rf"(\[[^\]]*?)\s*{re.escape(need)}\s*,?", r"\1", block, count=1)
    return "".join(lines[:start]) + block + "".join(lines[end:])


class RelatedLintsPass(unittest.TestCase):
    """The repo-wide lints the acceptance names pass with docs updated."""

    LINTS = (
        "tests/catalog/shape-validate.py",
        "tests/templates/identity-lint.py",
        "tests/shape-lints/fixture-diff.py",
        "tests/v3-callers-docs/test_v3_callers_docs.py",
        "tests/shape-lints/gate-lints.py",
        "tests/shape-lints/no-nested-reusable-workflow.py",
    )

    def test_lints_pass(self):
        for lint in self.LINTS:
            with self.subTest(lint=lint):
                code, output = run(["python3", lint])
                self.assertEqual(code, 0, output)

    def test_this_file_runs_in_self_ci(self):
        self.assertTrue(THIS_FILE in read(".github/workflows/_self-ci.yml"), "no _self-ci job runs this file")


class CallersAndDocs(unittest.TestCase):
    """Templates, fixtures, README and docs describe the new comment."""

    def grant_lines(self, rel):
        return [line for line in read(rel).splitlines()
                if re.match(r"^\s*pull-requests:\s*write\b", line)]

    def test_caller_grant_comment_names_the_ci_summary_comment(self):
        files = [f"templates/{flow}/ci.yml" for flow in FLOWS]
        files += [f"tests/consumers/{flow}/.github/workflows/ci.yml" for flow in FLOWS]
        for rel in files:
            with self.subTest(file=rel):
                lines = self.grant_lines(rel)
                self.assertEqual(len(lines), 1, "the ci job still grants pull-requests: write")
                self.assertIn(SUMMARY_GRANT, lines[0])
                self.assertFalse("coverage comment" in read(rel), f"{rel} still names the coverage comment")

    def test_readme_callers_name_the_ci_summary_comment(self):
        lines = self.grant_lines("README.md")
        self.assertEqual(len(lines), len(FLOWS))
        for line in lines:
            self.assertIn(SUMMARY_GRANT, line)

    def test_docs_name_the_ci_passed_check(self):
        docs = [f"docs/flows/{name}.md" for name in ("npm", "nuget", "static-webapp")]
        for rel in docs + ["docs/usage.md"]:
            with self.subTest(file=rel):
                self.assertTrue("ci / passed" in read(rel), f"{rel} does not name `ci / passed`")

    def test_catalog_lists_the_new_inputs_and_outputs(self):
        catalog = read("docs/catalog.md")
        for name in ("ci-summary", "lines_pct", "branches_pct", "verdicts",
                     "fail_on_findings", "violations"):
            with self.subTest(name=name):
                self.assertTrue(f"`{name}`" in catalog, f"docs/catalog.md does not name `{name}`")


if __name__ == "__main__":
    unittest.main()
