#!/usr/bin/env python3
"""
Contract tests for the v3 CI workflow inputs.

- An input that exists in more than one flow has the same name, type,
  default and description in every flow.
- `bump` and `seed_version` fall back to the caller's `workflow_dispatch`
  inputs; an explicit `with:` value wins.
- `nuget-package-ci.yml`'s `project_path` is optional; empty means the
  single non-test `.csproj` in the repo, and zero or several candidates
  fail with an error listing them.
- Each CI workflow runs the `quality-gate` action as a job by default,
  switched by `quality_gate` and levelled by `quality_level`, which the
  `setup` job validates against strict, standard and relaxed.
- `_self-ci.yml` runs the gate on hashira's own pull requests at strict.
- Every artifact `_self-ci.yml` uploads has a name no other job in the run
  uses, so a download by name can only find the one it was meant for.

Conditions are read with a small evaluator of GitHub's expression syntax.
A value it cannot know offline (a step or job output) counts as unknown,
so a test asserts only what the workflow text decides. Steps that resolve
`project_path` or validate `quality_level` are run with bash in a scratch
workspace, with hashira's `.github/` copied to `.hashira/` as in CI.

Run from the repo root: python3 tests/ci-workflow-inputs/test_ci_workflow_inputs.py
Needs python3, bash, node and PyYAML, as the other shape lints do.
"""

import ast
import glob
import itertools
import math
import os
import re
import shutil
import subprocess
import tempfile
import unittest

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORKFLOW_DIR = os.path.join(ROOT, ".github", "workflows")
SELF_CI = os.path.join(WORKFLOW_DIR, "_self-ci.yml")
THIS_FILE = "tests/ci-workflow-inputs/test_ci_workflow_inputs.py"
FLOWS = {
    "npm-package-ci.yml": "npm",
    "nuget-package-ci.yml": "nuget",
    "static-webapp-ci.yml": "static-webapp",
}
RELEASE_FLOWS = ("npm-package-ci.yml", "nuget-package-ci.yml")
SHARED = ("test_command", "coverage_path", "scan_disable", "node_version",
          "bump", "seed_version", "quality_gate", "quality_level")
QUALITY_INPUTS = {"quality_gate": ("boolean", True), "quality_level": ("string", "strict")}
LEVELS = ("strict", "standard", "relaxed")
BAD_LEVELS = ("", "bogus", "Strict", "strict ", " standard", "relaxed\n")
GATE_ACTION = re.compile(r"(^|/)\.github/actions/quality-gate/?$")
EXPR = re.compile(r"\$\{\{(.*?)\}\}", re.S)
STRING = re.compile(r"('(?:[^']|'')*')")
WORDS = {"true": "True", "false": "False", "null": "None"}


class Unknown:
    """A value only a live run knows, such as a step or job output."""

    def __repr__(self):
        return "UNKNOWN"


UNKNOWN = Unknown()


def read_text(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def load_yaml(path):
    return yaml.safe_load(read_text(path))


def flow(name):
    return load_yaml(os.path.join(WORKFLOW_DIR, name))


def call_inputs(doc):
    # PyYAML reads the bare `on:` key as boolean True.
    trigger = doc.get("on", doc.get(True)) or {}
    return (trigger.get("workflow_call") or {}).get("inputs") or {}


def jobs_of(doc):
    return doc.get("jobs") or {}


def steps_of(job):
    return job.get("steps") or []


# --- GitHub expressions ---------------------------------------------------

def to_python(expr):
    """GitHub expression syntax to a Python expression, outside string literals."""
    parts = STRING.split(expr.strip())
    for i in range(0, len(parts), 2):
        code = parts[i].replace("&&", " and ").replace("||", " or ")
        code = re.sub(r"!(?!=)", " not ", code)
        code = re.sub(r"(?<=\w)-(?=[A-Za-z_])", "_", code)
        parts[i] = re.sub(r"\b(true|false|null)\b", lambda m: WORDS[m.group(1)], code)
    return "".join(parts).strip()


def as_number(value):
    if value is None or isinstance(value, bool):
        return int(bool(value))
    try:
        return float(value) if str(value).strip() else 0
    except ValueError:
        return math.nan


def loose_eq(left, right):
    if isinstance(left, str) and isinstance(right, str):
        return left.lower() == right.lower()
    if type(left) is type(right):
        return left == right
    return as_number(left) == as_number(right)


def lookup(base, key):
    if base is UNKNOWN:
        return UNKNOWN
    return base.get(key) if isinstance(base, dict) else None


def ev_bool(node, ctx):
    result = None
    for value in node.values:
        result = ev(value, ctx)
        if isinstance(node.op, ast.Or) == bool(result):
            return result
    return result


def ev_compare(node, ctx):
    left, right = ev(node.left, ctx), ev(node.comparators[0], ctx)
    if UNKNOWN in (left, right) or not isinstance(node.ops[0], (ast.Eq, ast.NotEq)):
        return UNKNOWN
    return loose_eq(left, right) == isinstance(node.ops[0], ast.Eq)


FUNCTIONS = {"success": lambda: True, "always": lambda: True,
             "failure": lambda: False, "cancelled": lambda: False}


def ev_call(node, ctx):
    args = [ev(arg, ctx) for arg in node.args]
    function = FUNCTIONS.get(getattr(node.func, "id", ""))
    return function(*args) if function and UNKNOWN not in args else UNKNOWN


HANDLERS = {
    "Expression": lambda n, c: ev(n.body, c),
    "Constant": lambda n, c: n.value,
    "Name": lambda n, c: c.get(n.id),
    "Attribute": lambda n, c: lookup(ev(n.value, c), n.attr),
    "Subscript": lambda n, c: lookup(ev(n.value, c), ev(n.slice, c)),
    "UnaryOp": lambda n, c: (lambda v: UNKNOWN if v is UNKNOWN else not v)(ev(n.operand, c)),
    "BoolOp": ev_bool,
    "Compare": ev_compare,
    "Call": ev_call,
}


def ev(node, ctx):
    handler = HANDLERS.get(type(node).__name__)
    return handler(node, ctx) if handler else UNKNOWN


def evaluate(value, ctx):
    """A YAML value as GitHub reads it: an `if:` or a single `${{ }}`."""
    if not isinstance(value, str):
        return value
    whole = re.fullmatch(r"\s*\$\{\{(.*)\}\}\s*", value, re.S)
    if not whole and "${{" in value:
        return render(value, ctx)
    return ev(ast.parse(to_python(whole.group(1) if whole else value), mode="eval"), ctx)


def as_text(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    return "" if value is None or value is UNKNOWN else str(value)


def render(text, ctx):
    return EXPR.sub(lambda m: as_text(evaluate("${{" + m.group(1) + "}}", ctx)), str(text))


def context(doc, inputs=None, event_name="pull_request", event=None, extra=None):
    values = {k: (v or {}).get("default") for k, v in call_inputs(doc).items()}
    values.update(inputs or {})
    needs = {j.replace("-", "_"): {"result": "success", "outputs": UNKNOWN} for j in jobs_of(doc)}
    github = {"event_name": event_name, "event": event or {}}
    github.update(extra or {})
    return {"inputs": values, "github": github, "needs": needs, "steps": UNKNOWN,
            "job": UNKNOWN, "env": {}, "vars": {}, "secrets": {}, "runner": {}}


def known_false(value):
    return value is not UNKNOWN and not value


# --- running steps offline -------------------------------------------------

def local_action_dir(step, ws):
    uses = str(step.get("uses", ""))
    return os.path.join(ws, uses[2:]) if uses.startswith("./.hashira/") else None


def step_body(step):
    """The step's text plus every hashira file it runs."""
    action_dir = local_action_dir(step, ROOT)
    action_dir = action_dir and action_dir.replace("/.hashira/", "/", 1)
    names = set(re.findall(r"([\w.-]+\.(?:c|m)?js)\b", str(step.get("run", ""))))
    patterns = [os.path.join(action_dir, "**", "*.*")] if action_dir else [
        os.path.join(ROOT, ".github", "actions", "*", "lib", name) for name in names]
    paths = itertools.chain.from_iterable(glob.glob(p, recursive=True) for p in patterns)
    return yaml.safe_dump(step) + "".join(read_text(p) for p in paths)


def workspace():
    base = tempfile.mkdtemp(prefix="ci-inputs-")
    ws = os.path.join(base, "ws")
    shutil.copytree(os.path.join(ROOT, ".github"), os.path.join(ws, ".hashira", ".github"))
    shutil.copy(os.path.join(ROOT, "package.json"), os.path.join(ws, ".hashira", "package.json"))
    os.makedirs(os.path.join(base, "temp"))
    return base, ws


def run_shell(step, ws, ctx):
    base = os.path.dirname(ws)
    env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", base),
           "GITHUB_WORKSPACE": ws, "RUNNER_TEMP": os.path.join(base, "temp"),
           "GITHUB_OUTPUT": os.path.join(base, "output"), "GITHUB_ENV": os.path.join(base, "env"),
           "GITHUB_STEP_SUMMARY": os.path.join(base, "summary"),
           "GITHUB_EVENT_NAME": ctx["github"]["event_name"],
           "GITHUB_ACTION_PATH": ctx["github"].get("action_path", "")}
    env.update({k: render(v, ctx) for k, v in (step.get("env") or {}).items()})
    done = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", render(step["run"], ctx)],
                          cwd=ws, env=env, capture_output=True, text=True, timeout=120, check=False)
    return done.returncode, done.stdout + done.stderr


def run_composite(action_dir, step, ws, ctx):
    action = load_yaml(os.path.join(action_dir, "action.yml"))
    inputs = {k: (v or {}).get("default", "") for k, v in (action.get("inputs") or {}).items()}
    inputs.update({k: evaluate(v, ctx) for k, v in (step.get("with") or {}).items()})
    inner = dict(ctx, inputs=inputs, github=dict(ctx["github"], action_path=action_dir))
    return run_steps(action["runs"]["steps"], ws, inner)


def run_step(step, ws, ctx):
    if known_false(evaluate(step.get("if", True), ctx)):
        return 0, ""
    action_dir = local_action_dir(step, ws)
    if action_dir:
        return run_composite(action_dir, step, ws, ctx)
    return run_shell(step, ws, ctx) if "run" in step else (0, "")


def run_steps(steps, ws, ctx):
    log = ""
    for step in steps:
        code, out = run_step(step, ws, ctx)
        log += out
        if code:
            return code, log
    return 0, log


def run_in_workspace(steps, ctx, files=()):
    """Runs steps in a fresh workspace: (exit code, logs + summary, GITHUB_OUTPUT)."""
    base, ws = workspace()
    try:
        for name in files:
            os.makedirs(os.path.dirname(os.path.join(ws, name)), exist_ok=True)
            with open(os.path.join(ws, name), "w", encoding="utf-8") as handle:
                handle.write('<Project Sdk="Microsoft.NET.Sdk"></Project>\n')
        ctx["github"]["workspace"] = ws
        code, log = run_steps(steps, ws, ctx)
        extra = [os.path.join(base, n) for n in ("summary", "output")]
        written = [read_text(p) if os.path.exists(p) else "" for p in extra]
        return code, log + written[0], written[1]
    finally:
        shutil.rmtree(base, ignore_errors=True)


# --- finders ---------------------------------------------------------------

def gate_jobs(doc):
    return [(job_id, job, step) for job_id, job in jobs_of(doc).items()
            for step in steps_of(job) if GATE_ACTION.search(str(step.get("uses", "")))]


def flow_gate_jobs():
    return [(name, flow(name)) + found for name in FLOWS for found in gate_jobs(flow(name))]


def all_steps(doc):
    return [step for job in jobs_of(doc).values() for step in steps_of(job)]


def project_path_step():
    """The nuget step that turns an empty project_path into the repo's .csproj."""
    for step in all_steps(flow("nuget-package-ci.yml")):
        body = step_body(step)
        resolves = "project_path" in yaml.safe_dump(step) and "csproj" in body and "Test" in body
        if resolves and not re.search(r"\bdotnet (restore|build|test|pack)\b", body):
            return step
    return None


def level_steps(name):
    setup = jobs_of(flow(name)).get("setup") or {}
    return [s for s in steps_of(setup) if "quality_level" in yaml.safe_dump(s)]


def doc_row(flow_name, input_name):
    for line in read_text(os.path.join(ROOT, "docs", "flows", flow_name + ".md")).splitlines():
        if line.startswith("| `%s` |" % input_name):
            return [cell.strip() for cell in line.strip().strip("|").split("|")]
    return None


# --- tests -----------------------------------------------------------------

class SharedInputsMatch(unittest.TestCase):
    def test_each_named_shared_input_exists_in_more_than_one_flow(self):
        for name in SHARED:
            found = [f for f in FLOWS if name in call_inputs(flow(f))]
            with self.subTest(input=name):
                self.assertGreaterEqual(len(found), 2, "found only in %s" % found)

    def test_an_input_in_several_flows_has_one_type_default_and_description(self):
        shapes = {}
        for name, (key, spec) in ((n, item) for n in FLOWS for item in call_inputs(flow(n)).items()):
            shapes.setdefault(key, {})[name] = tuple((spec or {}).get(f) for f in ("type", "default", "description"))
        for key, by_flow in shapes.items():
            with self.subTest(input=key):
                self.assertEqual(len(set(by_flow.values())), 1, by_flow)

    def test_quality_inputs_exist_in_every_flow_with_their_type_and_default(self):
        for name, (key, (kind, default)) in itertools.product(FLOWS, QUALITY_INPUTS.items()):
            with self.subTest(workflow=name, input=key):
                spec = call_inputs(flow(name)).get(key) or {}
                self.assertEqual((spec.get("type"), spec.get("default"), spec.get("required", False)),
                                 (kind, default, False))


class BumpFallsBackToDispatch(unittest.TestCase):
    DISPATCH = {"inputs": {"bump": "minor", "seed_version": "0.0.0"}}

    def test_release_flows_read_the_callers_dispatch_inputs(self):
        for name, key in itertools.product(RELEASE_FLOWS, ("bump", "seed_version")):
            with self.subTest(workflow=name, input=key):
                self.assertRegex(read_text(os.path.join(WORKFLOW_DIR, name)), r"github\.event\.inputs(\.%s\b|\[\s*'%s'\s*\])" % (key, key))

    def test_version_job_runs_on_a_dispatch_bump_without_with(self):
        for name in RELEASE_FLOWS:
            doc = flow(name)
            ctx = context(doc, event_name="workflow_dispatch", event=self.DISPATCH)
            with self.subTest(workflow=name):
                self.assertFalse(known_false(evaluate(jobs_of(doc)["version"].get("if", True), ctx)))

    def test_resolver_gets_the_dispatch_value_when_with_is_empty(self):
        self.check_resolver({}, {"bump": "minor", "seed_version": "0.0.0"})

    def test_an_explicit_with_value_wins_over_the_dispatch_input(self):
        self.check_resolver({"bump": "patch", "seed_version": "1.0.0"}, {"bump": "patch", "seed_version": "1.0.0"})

    def check_resolver(self, given, expected):
        for name, (key, want) in itertools.product(RELEASE_FLOWS, expected.items()):
            doc = flow(name)
            ctx = context(doc, inputs=given, event_name="workflow_dispatch", event=self.DISPATCH)
            resolvers = [s for s in all_steps(doc) if "version-resolver" in str(s.get("uses"))]
            with self.subTest(workflow=name, input=key):
                self.assertTrue(resolvers)
                self.assertIn(evaluate((resolvers[0].get("with") or {}).get(key), ctx), (want, UNKNOWN))


class NugetProjectPathDetection(unittest.TestCase):
    TESTS = ["Widget.Tests.csproj", "WidgetTest.csproj", "IntegrationTests.csproj", "TestHelpers.csproj"]

    def run_detection(self, files):
        step = project_path_step()
        self.assertIsNotNone(step, "no nuget-package-ci.yml step resolves an empty project_path")
        return run_in_workspace([step], context(flow("nuget-package-ci.yml")), files)

    def test_project_path_is_optional_and_defaults_to_empty(self):
        spec = call_inputs(flow("nuget-package-ci.yml")).get("project_path") or {}
        self.assertEqual((spec.get("type"), spec.get("required", False), spec.get("default")), ("string", False, ""))

    def test_empty_project_path_uses_the_single_non_test_csproj(self):
        code, log, output = self.run_detection(["Widget.csproj"] + self.TESTS)
        self.assertEqual(code, 0, log)
        self.assertIn("Widget.csproj", output)
        self.assertFalse([t for t in self.TESTS if t in output], output)

    def test_no_non_test_csproj_fails_with_an_error(self):
        code, log, _ = self.run_detection(self.TESTS)
        self.assertNotEqual(code, 0, log)
        self.assertIn("::error", log)

    def test_two_non_test_csproj_fail_listing_both(self):
        code, log, _ = self.run_detection(["Widget.csproj", "Gadget.csproj"] + self.TESTS)
        self.assertNotEqual(code, 0, log)
        self.assertIn("::error", log)
        self.assertEqual([n for n in ("Widget.csproj", "Gadget.csproj") if n not in log], [], log)

    def test_a_detected_csproj_with_a_quote_fails_before_any_output(self):
        # The test job single-quotes the path in a shell command.
        code, log, output = self.run_detection(["x';id;'.csproj"] + self.TESTS)
        self.assertNotEqual(code, 0, log)
        self.assertIn("single quote", log)
        self.assertNotIn("path=", output)

    def test_a_newline_in_one_of_several_names_fails_without_printing_any_name(self):
        code, log, output = self.run_detection(["Widget.csproj", "x\n::add-mask::y.csproj"] + self.TESTS)
        self.assertNotEqual(code, 0, log)
        self.assertIn("control character", log)
        self.assertNotIn("::add-mask::", log)
        self.assertNotIn("Widget.csproj", log)
        self.assertNotIn("path=", output)

    def test_an_apostrophe_in_a_folder_name_also_fails(self):
        code, log, output = self.run_detection(["it's/Widget.csproj"] + self.TESTS)
        self.assertNotEqual(code, 0, log)
        self.assertIn("single quote", log)
        self.assertNotIn("path=", output)


class QualityGateWiring(unittest.TestCase):
    def test_each_flow_runs_the_quality_gate_action_in_a_job(self):
        for name in FLOWS:
            with self.subTest(workflow=name):
                self.assertTrue(list(gate_jobs(flow(name))), "no job uses the quality-gate action")

    def test_quality_gate_false_skips_the_job(self):
        for name, doc, job_id, job, _ in flow_gate_jobs():
            with self.subTest(workflow=name, job=job_id):
                result = evaluate(job.get("if", True), context(doc, {"quality_gate": False}))
                self.assertTrue(result is UNKNOWN or not result, "the gate job still runs")

    def test_the_gate_job_runs_by_default_on_pull_request_push_and_dispatch(self):
        events = ("pull_request", "push", "workflow_dispatch")
        for (name, doc, job_id, job, _), event in itertools.product(flow_gate_jobs(), events):
            with self.subTest(workflow=name, job=job_id, event=event):
                self.assertFalse(known_false(evaluate(job.get("if", True), context(doc, event_name=event))))

    def test_the_gate_gets_the_callers_quality_level(self):
        for name, doc, job_id, _, step in flow_gate_jobs():
            with self.subTest(workflow=name, job=job_id):
                level = (step.get("with") or {}).get("level")
                self.assertIn(evaluate(level, context(doc, {"quality_level": "relaxed"})), ("relaxed", UNKNOWN))

    def test_the_gate_job_declares_its_own_permissions(self):
        for name, _, job_id, job, _ in flow_gate_jobs():
            with self.subTest(workflow=name, job=job_id):
                self.assertIn("permissions", job)


class SetupValidatesQualityLevel(unittest.TestCase):
    def run_setup(self, name, level):
        steps = level_steps(name)
        self.assertTrue(steps, "setup in %s never reads quality_level" % name)
        return run_in_workspace(steps, context(flow(name), {"quality_level": level}))

    def test_each_allowed_level_passes_setup(self):
        for name, level in itertools.product(FLOWS, LEVELS):
            with self.subTest(workflow=name, level=level):
                code, log, _ = self.run_setup(name, level)
                self.assertEqual(code, 0, log)

    def test_any_other_level_fails_setup_naming_the_three(self):
        for name, level in itertools.product(FLOWS, BAD_LEVELS):
            with self.subTest(workflow=name, level=level):
                code, log, _ = self.run_setup(name, level)
                self.assertNotEqual(code, 0, log)
                self.assertEqual([v for v in LEVELS if v not in log], [], log)


class SelfCiRunsTheGate(unittest.TestCase):
    def test_self_ci_gates_its_own_pull_requests_at_strict(self):
        doc = load_yaml(SELF_CI)
        ctx = context(doc)
        runs = [job_id for job_id, job, step in gate_jobs(doc)
                if (step.get("with") or {}).get("level", "strict") == "strict"
                and not known_false(evaluate(job.get("if", True), ctx))]
        self.assertTrue(runs, "no _self-ci.yml job runs quality-gate at strict on pull_request")

    def test_self_ci_runs_this_file(self):
        self.assertIn(THIS_FILE, read_text(SELF_CI))



class SelfCiArtifactNamesAreUnique(unittest.TestCase):
    # npm-release downloads `npm-tarball` by name, and with several artifacts of one name in a
    # run it takes the highest ID, which need not be the job's own upload.
    def test_no_two_self_ci_uploads_share_a_name(self):
        names = {}
        for job_id, job in load_yaml(SELF_CI)["jobs"].items():
            for step in job.get("steps") or []:
                if "actions/upload-artifact@" in str(step.get("uses", "")):
                    names.setdefault((step.get("with") or {}).get("name"), []).append(job_id)
        self.assertTrue(names, "no upload-artifact step found in _self-ci.yml")
        shared = {name: jobs for name, jobs in names.items() if len(jobs) > 1}
        self.assertEqual(shared, {}, "artifact names uploaded by more than one job")

class DocsAndShapeValidate(unittest.TestCase):
    def test_flow_docs_list_the_quality_inputs_with_their_defaults(self):
        wanted = (("quality_gate", "true"), ("quality_level", "strict"))
        for flow_name, (key, want) in itertools.product(FLOWS.values(), wanted):
            with self.subTest(doc=flow_name, input=key):
                row = doc_row(flow_name, key) or ["", "", ""]
                self.assertIn(want, row[2], "no input table row for %s with default %s" % (key, want))

    def test_nuget_doc_shows_project_path_optional_with_empty_default(self):
        row = doc_row("nuget", "project_path") or ["", "", "no row"]
        self.assertEqual(row[2].strip("`'\""), "")

    def test_ci_shape_validate_scripts_pass(self):
        for flow_dir in ("npm-package-ci", "nuget-package-ci", "static-webapp-ci"):
            script = os.path.join(ROOT, "tests", flow_dir, "shape-validate.py")
            done = subprocess.run(["python3", script], cwd=ROOT, capture_output=True, text=True, check=False)
            with self.subTest(script=flow_dir):
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
