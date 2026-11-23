#!/usr/bin/env python3
"""
Contract tests for the fixture consumer sources, the fixture-diff lint and
the three public fixture repos.

- `tests/consumers/<flow>/` holds what is pushed to the fixture repo
  `skathio/hashira-fixture-<npm|nuget|static>`. Its caller is
  `.github/workflows/ci.yml`, the flow's `templates/<flow>/ci.yml` with
  only these differences: the publish target (a Verdaccio service for npm
  with `auth: token`, a BaGetter service for NuGet), the `services:` block
  for that registry, the environment's settings, and verification steps
  after the hashira action.
- After publishing, the npm and NuGet jobs install the package just
  published and compare its version with the resolved version; the static
  job checks the `page_url` the deploy reports.
- A lint (found through the job that runs it in `_self-ci.yml`) passes on
  the repo, has a `--self-test` mode, and fails on any other difference.
- The three fixture repos exist and are public, the static one has Pages,
  and each has its gated job's environment with no required reviewer.

Refs to `skathio/hashira` are compared without their `@<ref>`: the
integration job rewrites every one of them to the commit under test.

Run from the repo root: python3 tests/fixture-consumers/test_fixture_consumers.py
Needs python3, PyYAML and an authenticated `gh` for the repo checks.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
THIS_FILE = "tests/fixture-consumers/test_fixture_consumers.py"
SELF_CI = ".github/workflows/_self-ci.yml"
OWNER = "skathio"
# flow -> (fixture repo, gated job, environment, CD action, registry image or None)
FLOWS = {
    "npm": ("hashira-fixture-npm", "publish", "production", "npm-release", "verdaccio"),
    "nuget": ("hashira-fixture-nuget", "publish", "production", "nuget-push", "bagetter"),
    "static-webapp": ("hashira-fixture-static", "deploy", "github-pages", "pages-deploy", None),
}
COPIED_DIRS = (".github", "docs", "templates", "tests")
COPIED_FILES = ("README.md", "CLAUDE.md", "package.json")

HASHIRA_REF = re.compile(r"(skathio/hashira/[^@\s'\"]+)@[^\s'\"]+")
DIGEST_PIN = re.compile(r"@sha256:[0-9a-f]{64}$")
SHA_PIN = re.compile(r"@[0-9a-f]{40}(\s|$)")
USES_LINE = re.compile(r"^(?:([ \t]*#[^\n]*)\n)?[ \t]*-?[ \t]*uses:[ \t]*(\S+)([^\n]*)", re.M)
PERM_BLOCK = re.compile(r"^ {4,}permissions:[^\n]*\n((?:[ \t]*\n| {6,}[^\n]*(?:\n|$))*)", re.M)
LINT_CMD = re.compile(r"\b(python3|node)\s+(tests/\S+\.(?:py|js|mjs|cjs))")
VERSION_REF = re.compile(r"resolved_version|outputs\.version")
NPM_INSTALL = re.compile(r"\bnpm\s+(install|i|add)\b")
LOCAL_HOST = re.compile(r"localhost|127\.0\.0\.1")


def path(rel, root=ROOT):
    return os.path.join(root, rel)


def read(rel, root=ROOT):
    with open(path(rel, root), encoding="utf-8") as handle:
        return handle.read()


def write(rel, text, root):
    with open(path(rel, root), "w", encoding="utf-8") as handle:
        handle.write(text)


def normalized(value):
    """The YAML value with every `skathio/hashira/...@<ref>` cut at the `@`."""
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalized(item) for item in value]
    return HASHIRA_REF.sub(r"\1", value) if isinstance(value, str) else value


def load(rel, root=ROOT):
    return normalized(yaml.safe_load(read(rel, root)))


def caller_rel(flow):
    return f"tests/consumers/{flow}/.github/workflows/ci.yml"


def template_rel(flow):
    return f"templates/{flow}/ci.yml"


def env_name(environment):
    return environment.get("name") if isinstance(environment, dict) else environment


def cd_index(steps, action):
    target = f"skathio/hashira/.github/actions/{action}"
    return next((i for i, step in enumerate(steps) if step.get("uses") == target), None)


def run(args, cwd=ROOT):
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=300)
    return proc.returncode, proc.stdout + proc.stderr


def copy_repo(prefix):
    copy = tempfile.mkdtemp(prefix=prefix)
    for rel in [d for d in COPIED_DIRS if os.path.isdir(path(d))]:
        shutil.copytree(path(rel), path(rel, copy), symlinks=True)
    for rel in [f for f in COPIED_FILES if os.path.isfile(path(f))]:
        shutil.copy2(path(rel), path(rel, copy))
    return copy


def grant_lines_without_why(text):
    lines = "".join(PERM_BLOCK.findall(text)).splitlines()
    return [line.strip() for i, line in enumerate(lines)
            if line.strip() and not line.strip().startswith("#") and "#" not in line
            and not (i and lines[i - 1].strip().startswith("#"))]


def unpinned_third_party(text):
    return [ref for above, ref, rest in USES_LINE.findall(text)
            if not ref.startswith(("skathio/hashira/", "./"))
            and not (SHA_PIN.search(ref + " ") and (above or re.search(r"#.*\bv\d", rest)))]


def gated_parts(flow):
    """(template gated job, fixture gated job, index of the CD step in each)."""
    _, gated, _, action, _ = FLOWS[flow]
    want, have = load(template_rel(flow))["jobs"][gated], load(caller_rel(flow))["jobs"][gated]
    return want, have, cd_index(want.get("steps") or [], action), cd_index(have.get("steps") or [], action)


def step_text(step):
    return json.dumps(step)


def later_steps(flow):
    _, have, _, at = gated_parts(flow)
    return (have.get("steps") or [])[at + 1:] if at is not None else []


# --- the fixture-diff lint, found through its _self-ci.yml job -------------

def self_ci_commands():
    jobs = (yaml.safe_load(read(SELF_CI)).get("jobs") or {}).values()
    return [line for job in jobs for step in job.get("steps") or []
            for line in str(step.get("run") or "").splitlines()]


def is_fixture_lint(rel):
    if rel == THIS_FILE or not os.path.isfile(path(rel)):
        return False
    source = read(rel)
    return "tests/consumers" in source and "templates" in source


def find_fixture_lint():
    found = [m.groups() for m in map(LINT_CMD.search, self_ci_commands()) if m]
    return next(((runner, rel) for runner, rel in found if is_fixture_lint(rel)), (None, None))


def job_bounds(lines, job):
    """(first, end) line indexes of a top-level job under `jobs:`."""
    first = next(i for i, line in enumerate(lines) if re.match(rf"^  {re.escape(job)}:\s*$", line))
    end = next((i for i in range(first + 1, len(lines)) if re.match(r"^ {0,2}\S", lines[i])), len(lines))
    return first, end


def step_start(lines, at):
    """Index of the line opening the step (`- `) that holds line `at`."""
    return next(i for i in range(at, -1, -1) if lines[i].lstrip().startswith("- "))


def cd_step_line(lines, action):
    at = next(i for i, line in enumerate(lines) if f"skathio/hashira/.github/actions/{action}@" in line)
    return step_start(lines, at)


def indent_of(line):
    return line[:len(line) - len(line.lstrip())]


# --- tests ----------------------------------------------------------------

class FixtureCallerShape(unittest.TestCase):

    def test_each_flow_has_a_caller(self):
        for flow in FLOWS:
            self.assertTrue(os.path.isfile(path(caller_rel(flow))), f"{caller_rel(flow)} is missing")

    def test_top_level_keys_equal_the_template(self):
        for flow in FLOWS:
            want, have = load(template_rel(flow)), load(caller_rel(flow))
            strip = lambda doc: {k: v for k, v in doc.items() if k != "jobs"}
            self.assertEqual(strip(have), strip(want), caller_rel(flow))
            self.assertEqual(set(have["jobs"]), set(want["jobs"]), f"{caller_rel(flow)}: job names")

    def test_ci_job_equals_the_template(self):
        for flow in FLOWS:
            self.assertEqual(load(caller_rel(flow))["jobs"]["ci"], load(template_rel(flow))["jobs"]["ci"],
                             f"{caller_rel(flow)}: job ci")

    def test_gated_job_keys_equal_the_template_except_services_and_steps(self):
        for flow, (_, gated, _, _, registry) in FLOWS.items():
            want, have, _, _ = gated_parts(flow)
            allowed = {"steps", "environment"} | ({"services"} if registry else set())
            keep = lambda job: {k: v for k, v in job.items() if k not in allowed}
            self.assertEqual(keep(have), keep(want), f"{caller_rel(flow)}: job {gated}")
            self.assertEqual(env_name(have.get("environment")), env_name(want.get("environment")),
                             f"{caller_rel(flow)}: {gated}.environment")

    def test_steps_up_to_the_cd_action_equal_the_template(self):
        for flow, (_, gated, _, action, _) in FLOWS.items():
            want, have, want_at, have_at = gated_parts(flow)
            self.assertIsNotNone(have_at, f"{caller_rel(flow)}: {gated} does not run {action}")
            self.assertEqual(have["steps"][:have_at], want["steps"][:want_at], f"{caller_rel(flow)}: steps before {action}")

    def test_cd_step_differs_only_in_id_and_publish_target(self):
        for flow, (_, _, _, action, registry) in FLOWS.items():
            want, have, want_at, have_at = gated_parts(flow)
            allowed = {"id", "with"} if registry else {"id"}
            keep = lambda step: {k: v for k, v in step.items() if k not in allowed}
            self.assertEqual(keep(have["steps"][have_at]), keep(want["steps"][want_at]), f"{caller_rel(flow)}: {action} step")

    def test_verification_steps_follow_the_cd_action(self):
        for flow in FLOWS:
            self.assertGreater(len(later_steps(flow)), 0, f"{caller_rel(flow)}: no verification step after the hashira action")

    def test_no_services_on_static(self):
        _, have, _, _ = gated_parts("static-webapp")
        self.assertNotIn("services", have, caller_rel("static-webapp"))

    def test_each_grant_has_a_why_comment(self):
        for flow in FLOWS:
            self.assertEqual(grant_lines_without_why(read(caller_rel(flow))), [], f"{caller_rel(flow)}: grants without a why-comment")

    def test_third_party_actions_pinned_to_sha_with_version_comment(self):
        for flow in FLOWS:
            self.assertEqual(unpinned_third_party(read(caller_rel(flow))), [], f"{caller_rel(flow)}: not SHA-pinned")


class FakeRegistries(unittest.TestCase):

    def registry_image(self, flow):
        _, have, _, _ = gated_parts(flow)
        images = [str((svc or {}).get("image", "")) for svc in (have.get("services") or {}).values()]
        name = FLOWS[flow][4]
        return next((image for image in images if name in image.lower()), None)

    def test_registry_service_pinned_by_digest(self):
        for flow in ("npm", "nuget"):
            image = self.registry_image(flow)
            self.assertIsNotNone(image, f"{caller_rel(flow)}: no {FLOWS[flow][4]} service")
            self.assertRegex(image, DIGEST_PIN, f"{caller_rel(flow)}: {image} not pinned by digest")

    def test_publish_target_is_the_local_service(self):
        for flow in ("npm", "nuget"):
            _, have, _, at = gated_parts(flow)
            target = str((have["steps"][at].get("with") or {}).get("target", ""))
            self.assertRegex(target, LOCAL_HOST, f"{caller_rel(flow)}: target {target!r}")

    def test_npm_publishes_with_token_auth(self):
        _, have, _, at = gated_parts("npm")
        self.assertEqual((have["steps"][at].get("with") or {}).get("auth"), "token", caller_rel("npm"))


class VerificationSteps(unittest.TestCase):

    def test_npm_installs_the_published_version(self):
        texts = [step_text(step) for step in later_steps("npm")]
        self.assertTrue(any(NPM_INSTALL.search(t) and VERSION_REF.search(t) for t in texts),
                        f"{caller_rel('npm')}: no step installs the package and checks the resolved version")

    def test_nuget_installs_the_published_version(self):
        texts = [step_text(step) for step in later_steps("nuget")]
        self.assertTrue(any("dotnet" in t and VERSION_REF.search(t) for t in texts),
                        f"{caller_rel('nuget')}: no step installs the package and checks the resolved version")

    def test_static_checks_the_page_url(self):
        _, have, _, at = gated_parts("static-webapp")
        step_id = have["steps"][at].get("id")
        self.assertIsNotNone(step_id, f"{caller_rel('static-webapp')}: the deploy step has no id to read page_url from")
        texts = [step_text(step) for step in later_steps("static-webapp")]
        self.assertTrue(any(f"steps.{step_id}.outputs.page_url" in t for t in texts),
                        f"{caller_rel('static-webapp')}: no step reads page_url")


class FixtureSources(unittest.TestCase):

    def test_npm_fixture_is_a_package(self):
        self.assertTrue(os.path.isfile(path("tests/consumers/npm/package.json")), "npm fixture has no package.json")

    def test_nuget_fixture_has_one_non_test_project(self):
        found = [os.path.join(d, f) for d, _, files in os.walk(path("tests/consumers/nuget"))
                 for f in files if f.endswith(".csproj")]
        packable = [f for f in found if not re.search(r"Test.*\.csproj$|\.Tests\.csproj$", os.path.basename(f))]
        self.assertEqual(len(packable), 1, f"non-test .csproj files: {packable}")


class FixtureDiffLint(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.runner, cls.lint = find_fixture_lint()
        cls.copy = copy_repo("fixture-consumers-")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.copy, ignore_errors=True)

    def setUp(self):
        self.assertIsNotNone(self.lint, "no _self-ci.yml job runs a fixture-diff lint over tests/consumers/")

    def lint_with(self, flow, change):
        rel = caller_rel(flow)
        original = read(rel, self.copy)
        lines = original.splitlines(keepends=True)
        write(rel, "".join(change(lines)), self.copy)
        try:
            return run([self.runner, self.lint], cwd=self.copy)
        finally:
            write(rel, original, self.copy)

    def assert_rejects(self, flow, change, what):
        code, out = self.lint_with(flow, change)
        self.assertNotEqual(code, 0, f"lint passed with {what} in {caller_rel(flow)}:\n{out}")

    def test_passes_on_the_repo(self):
        code, out = run([self.runner, self.lint])
        self.assertEqual(code, 0, out)

    def test_self_test_passes(self):
        code, out = run([self.runner, self.lint, "--self-test"])
        self.assertEqual(code, 0, out)

    def test_self_ci_runs_the_lint_and_its_self_test(self):
        commands = [line.strip() for line in self_ci_commands()]
        self.assertTrue(any(line.endswith(self.lint) for line in commands), "no job runs the lint itself")
        self.assertTrue(any(f"{self.lint} --self-test" in line for line in commands), "no job runs --self-test")

    def test_rejects_a_renamed_workflow(self):
        rename = lambda lines: [re.sub(r"^name:(\s*)(\S+)", r"name:\1\2x", line) for line in lines]
        for flow in FLOWS:
            self.assert_rejects(flow, rename, "a changed top-level name")

    def test_rejects_an_input_added_to_ci(self):
        def change(lines):
            at = next(i for i, line in enumerate(lines) if "skathio/hashira/.github/workflows/" in line)
            pad = indent_of(lines[at])
            return lines[:at + 1] + [f"{pad}with:\n", f"{pad}  quality_gate: false\n"] + lines[at + 1:]
        for flow in FLOWS:
            self.assert_rejects(flow, change, "an input added to job ci")

    def test_rejects_a_grant_added_to_the_gated_job(self):
        for flow, (_, gated, _, _, _) in FLOWS.items():
            def change(lines, gated=gated):
                first, end = job_bounds(lines, gated)
                at = next(i for i in range(first, end) if re.match(r"^    permissions:\s*$", lines[i]))
                return lines[:at + 1] + ["      actions: write # injected\n"] + lines[at + 1:]
            self.assert_rejects(flow, change, "a grant added to the gated job")

    def test_rejects_a_removed_gated_condition(self):
        for flow, (_, gated, _, _, _) in FLOWS.items():
            def change(lines, gated=gated):
                first, end = job_bounds(lines, gated)
                return [line for i, line in enumerate(lines) if not (first < i < end and re.match(r"^    if:", line))]
            self.assert_rejects(flow, change, "the gated job's if: removed")

    def test_rejects_a_step_before_the_cd_action(self):
        for flow, (_, _, _, action, _) in FLOWS.items():
            def change(lines, action=action):
                at = cd_step_line(lines, action)
                pad = indent_of(lines[at])
                return lines[:at] + [f"{pad}- run: echo injected\n"] + lines[at:]
            self.assert_rejects(flow, change, "a step added before the hashira action")

    def test_rejects_services_on_static(self):
        def change(lines):
            first, _ = job_bounds(lines, "deploy")
            block = ["    services:\n", "      extra:\n", "        image: nginx\n"]
            return lines[:first + 1] + block + lines[first + 1:]
        self.assert_rejects("static-webapp", change, "a services block on the static deploy job")

    def test_accepts_another_step_after_the_cd_action(self):
        for flow, (_, gated, _, action, _) in FLOWS.items():
            def change(lines, gated=gated, action=action):
                _, end = job_bounds(lines, gated)
                while end > 0 and not lines[end - 1].strip():
                    end -= 1
                pad = indent_of(lines[cd_step_line(lines, action)])
                tail = lines[end - 1] if lines[end - 1].endswith("\n") else lines[end - 1] + "\n"
                return lines[:end - 1] + [tail, f"{pad}- run: echo verified\n"] + lines[end:]
            code, out = self.lint_with(flow, change)
            self.assertEqual(code, 0, f"lint rejected a verification step after the hashira action:\n{out}")


def gh_json(endpoint):
    code, out = run(["gh", "api", endpoint])
    return (json.loads(out) if code == 0 else None), out


class FixtureRepos(unittest.TestCase):

    def test_repos_exist_and_are_public(self):
        for flow, (repo, _, _, _, _) in FLOWS.items():
            data, out = gh_json(f"repos/{OWNER}/{repo}")
            self.assertIsNotNone(data, f"{OWNER}/{repo}: {out}")
            self.assertFalse(data.get("private"), f"{OWNER}/{repo} is not public")

    def test_static_repo_has_pages(self):
        data, out = gh_json(f"repos/{OWNER}/{FLOWS['static-webapp'][0]}/pages")
        self.assertIsNotNone(data, f"Pages is not enabled: {out}")

    def test_environments_exist_without_required_reviewers(self):
        for flow, (repo, _, env, _, _) in FLOWS.items():
            data, out = gh_json(f"repos/{OWNER}/{repo}/environments/{env}")
            self.assertIsNotNone(data, f"{OWNER}/{repo} has no environment {env}: {out}")
            rules = [rule.get("type") for rule in data.get("protection_rules") or []]
            self.assertNotIn("required_reviewers", rules, f"{OWNER}/{repo} {env} requires a reviewer")


if __name__ == "__main__":
    unittest.main()
