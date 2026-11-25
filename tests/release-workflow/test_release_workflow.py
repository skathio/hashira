#!/usr/bin/env python3
"""
Contract tests for the release workflow and its site and homepage wiring.

- release.yml runs only by workflow_dispatch with a `bump` choice of patch,
  minor or major, and refuses any ref but main.
- A read-only checks job, which uses hashira's own version-resolver and reads
  the _self-ci.yml runs, and a read-only docs build with docs-site/build.sh
  both run before the one job that pushes.
- The pushing job declares the `production` environment and is the only job
  that mints the App token (actions/create-github-app-token at the pinned
  SHA, RELEASE_APP_CLIENT_ID and RELEASE_APP_PRIVATE_KEY, scoped to skathio/hashira)
  and the only job that reads a secret.
- No step names v1 or v2, and nothing deletes a tag. The Release has
  generated notes.
- After the push, the run deploys through site.yml and then pings the org
  homepage through homepage.yml, whose failed ping still only warns.
- site.yml has no push trigger, is callable and runnable by hand after the
  production approval, builds with contents: read only, and keeps hashira's
  pages-upload and pages-deploy pinned to the v3.0.0 commit.
- Every action is pinned to a full SHA with a version comment, permissions
  are deny-all at the top and each job grant carries a comment.
- tests/shape-lints/release-lint.py passes, its --self-test passes, it fails
  a release.yml that drops the production environment, names v1 or v2 in a
  step, or reads a secret outside the pushing job, and _self-ci.yml runs it.
- gate-lints, no-nested-reusable-workflow and actionlint (when installed)
  still pass.

Run from the repo root: python3 tests/release-workflow/test_release_workflow.py
Needs python3 and PyYAML, as the other shape lints do.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RELEASE = ".github/workflows/release.yml"
SITE = ".github/workflows/site.yml"
HOMEPAGE = ".github/workflows/homepage.yml"
SELF_CI = ".github/workflows/_self-ci.yml"
LINT = "tests/shape-lints/release-lint.py"
APP_TOKEN = "actions/create-github-app-token@f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc"
V300 = "2c8d52526cbce593a445f7572b599813503160f5"
FULL_SHA = re.compile(r"@[0-9a-f]{40}$")
SAME_LINE_VERSION = re.compile(r"#\s*v\d+(\.\d+){0,2}\b")
LINE_ABOVE_VERSION = re.compile(r"^\s*#\s*\S+\s+v\d+(\.\d+){0,2}\b")
FROZEN = re.compile(r"\bv[12]\b")
TAG_DELETE = re.compile(
    r"git\s+tag\s+(-d|--delete)\b|git\s+push\b[^\n]*(\s-d\b|--delete\b|\s:refs/tags/)"
    r"|-X\s*DELETE[^\n]*git/refs|--method\s+DELETE[^\n]*git/refs")


def read(rel, root=ROOT):
    with open(os.path.join(root, rel), encoding="utf-8") as handle:
        return handle.read()


def load(rel):
    return yaml.safe_load(read(rel))


def triggers(doc):
    # PyYAML reads the bare key `on` as the boolean True.
    on = doc.get("on", doc.get(True))
    if isinstance(on, str):
        return {on: None}
    if isinstance(on, list):
        return {name: None for name in on}
    return on or {}


def dump(node):
    return yaml.safe_dump(node, default_flow_style=False, width=10000)


def steps(job):
    return job.get("steps") or []


def env_name(job):
    env = job.get("environment")
    return env.get("name") if isinstance(env, dict) else env


def needs(job):
    value = job.get("needs") or []
    return [value] if isinstance(value, str) else list(value)


def ancestors(jobs, name):
    seen, todo = set(), needs(jobs[name])
    while todo:
        parent = todo.pop()
        if parent not in seen and parent in jobs:
            seen.add(parent)
            todo.extend(needs(jobs[parent]))
    return seen


def jobs_where(jobs, predicate):
    return [name for name, job in jobs.items() if predicate(job)]


def runs(job, needle):
    return any(needle in str(step.get("run", "")) for step in steps(job))


def uses_any(job, needle):
    return any(needle in str(step.get("uses", "")) for step in steps(job))


def run_script(args, cwd=ROOT):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=300)


class ReleaseWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = load(RELEASE)
        cls.text = read(RELEASE)
        cls.jobs = cls.doc.get("jobs") or {}

    def push_job(self):
        names = jobs_where(self.jobs, lambda job: uses_any(job, "actions/create-github-app-token"))
        self.assertEqual(len(names), 1, "exactly one job mints the App token")
        return names[0]

    def test_runs_only_by_dispatch_with_a_bump_choice(self):
        on = triggers(self.doc)
        self.assertEqual(set(on), {"workflow_dispatch"})
        bump = (on["workflow_dispatch"] or {}).get("inputs", {}).get("bump")
        self.assertIsNotNone(bump, "workflow_dispatch has a `bump` input")
        self.assertEqual(bump.get("type"), "choice")
        self.assertEqual(sorted(bump.get("options") or []), ["major", "minor", "patch"])

    def test_refuses_any_ref_but_main(self):
        self.assertIn("refs/heads/main", self.text)

    def test_permissions_deny_all_at_the_top(self):
        self.assertIn(self.doc.get("permissions"), ({}, {"contents": "read"}))

    def test_pushing_job_waits_for_production(self):
        self.assertEqual(env_name(self.jobs[self.push_job()]), "production")

    def test_app_token_pinned_with_release_secrets_and_scoped(self):
        step = next(s for s in steps(self.jobs[self.push_job()])
                    if "actions/create-github-app-token" in str(s.get("uses", "")))
        self.assertEqual(step["uses"], APP_TOKEN)
        values = dump(step.get("with") or {})
        self.assertIn("secrets.RELEASE_APP_CLIENT_ID", values)
        self.assertIn("secrets.RELEASE_APP_PRIVATE_KEY", values)
        scope = step.get("with") or {}
        if "owner" in scope:
            self.assertEqual(str(scope["owner"]).strip(), "skathio")
        if "repositories" in scope:
            repos = [r.strip() for r in re.split(r"[,\n]", str(scope["repositories"])) if r.strip()]
            self.assertIn(repos, (["hashira"], ["skathio/hashira"]))

    def test_no_secret_outside_the_pushing_job(self):
        push = self.push_job()
        for name, job in self.jobs.items():
            if name == push:
                continue
            self.assertNotIn("secrets", job, f"job {name} passes secrets")
            self.assertNotIn("secrets.", dump(job), f"job {name} reads a secret")

    def test_only_the_pushing_job_is_in_production(self):
        self.assertEqual(jobs_where(self.jobs, lambda job: env_name(job) == "production"),
                         [self.push_job()])

    def test_checks_run_read_only_before_the_push(self):
        checks = jobs_where(self.jobs, lambda job: uses_any(job, ".github/actions/version-resolver"))
        self.assertTrue(checks, "a job resolves the version with hashira's version-resolver")
        before = ancestors(self.jobs, self.push_job())
        for name in checks:
            self.assertIn(name, before, f"{name} runs before the push")
            self.assertIsNone(env_name(self.jobs[name]), f"{name} runs before any approval")
            grants = self.jobs[name].get("permissions")
            self.assertIsInstance(grants, dict, f"{name} declares its permissions")
            self.assertNotIn("write", grants.values(), f"{name} is read-only")
        self.assertTrue(any("_self-ci.yml" in dump(self.jobs[n]) for n in before),
                        "a job before the push reads the _self-ci.yml runs")

    def test_release_logic_module_is_used(self):
        self.assertIn("tests/release/lib/release", self.text)

    def test_docs_build_is_read_only_and_before_the_push(self):
        docs = jobs_where(self.jobs, lambda job: runs(job, "docs-site/build.sh"))
        self.assertEqual(len(docs), 1, "one job builds the docs")
        self.assertEqual(self.jobs[docs[0]].get("permissions"), {"contents": "read"})
        self.assertIsNone(env_name(self.jobs[docs[0]]))
        self.assertIn(docs[0], ancestors(self.jobs, self.push_job()))

    def test_no_step_names_v1_or_v2(self):
        for name, job in self.jobs.items():
            for step in steps(job):
                self.assertIsNone(FROZEN.search(dump(step)), f"a step of {name} names v1 or v2")

    def test_no_tag_is_ever_deleted(self):
        self.assertIsNone(TAG_DELETE.search(self.text))

    def test_release_has_generated_notes(self):
        body = dump(self.jobs[self.push_job()])
        self.assertTrue("--generate-notes" in body or "generate_release_notes" in body)

    def test_pushes_with_the_app_token(self):
        step = next(s for s in steps(self.jobs[self.push_job()])
                    if "actions/create-github-app-token" in str(s.get("uses", "")))
        self.assertIn("id", step, "the token step has an id to read its output")
        self.assertIn(f"steps.{step['id']}.outputs.token", dump(self.jobs[self.push_job()]))

    def test_site_then_homepage_after_the_push(self):
        site = jobs_where(self.jobs, lambda job: str(job.get("uses", "")) == "./" + SITE)
        home = jobs_where(self.jobs, lambda job: "gh workflow run homepage.yml --ref main" in dump(job))
        self.assertEqual(len(site), 1, "one job deploys through site.yml")
        self.assertEqual(len(home), 1, "one job starts homepage.yml as a run of its own")
        self.assertIn(self.push_job(), ancestors(self.jobs, site[0]))
        self.assertIn(site[0], ancestors(self.jobs, home[0]))
        self.assertTrue(self.jobs[site[0]].get("with"), "the release tells site.yml it is approved")


class SiteWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = load(SITE)
        cls.jobs = cls.doc.get("jobs") or {}

    def build_job(self):
        names = jobs_where(self.jobs, lambda job: uses_any(job, ".github/actions/pages-upload"))
        self.assertEqual(len(names), 1)
        return names[0]

    def test_deploys_only_when_called_or_run_by_hand(self):
        self.assertEqual(set(triggers(self.doc)), {"workflow_call", "workflow_dispatch"})

    def test_permissions_deny_all_at_the_top(self):
        self.assertIn(self.doc.get("permissions"), ({}, {"contents": "read"}))

    def test_build_job_holds_only_contents_read(self):
        self.assertEqual(self.jobs[self.build_job()].get("permissions"), {"contents": "read"})

    def test_build_job_builds_docs_and_uploads_the_assembled_folder(self):
        job = self.jobs[self.build_job()]
        self.assertTrue(runs(job, "docs-site/build.sh"))
        upload = next(s for s in steps(job) if ".github/actions/pages-upload" in str(s.get("uses", "")))
        self.assertEqual(str((upload.get("with") or {}).get("path", "")).rstrip("/"), "artifacts/pages")

    def test_hashira_actions_stay_pinned_to_v300(self):
        used = [str(s.get("uses", "")) for job in self.jobs.values() for s in steps(job)]
        for action in ("pages-upload", "pages-deploy"):
            self.assertIn(f"skathio/hashira/.github/actions/{action}@{V300}", used)

    def test_hand_run_waits_for_production_and_release_call_skips_it(self):
        gates = jobs_where(self.jobs, lambda job: env_name(job) == "production")
        self.assertTrue(gates, "a hand run waits for the production approval")
        self.assertTrue(set(gates) & ancestors(self.jobs, self.build_job()))
        for name in gates:
            self.assertIn("inputs.", str(self.jobs[name].get("if", "")),
                          f"{name} is skipped when release.yml calls site.yml")

    def test_deploy_job_uses_github_pages(self):
        names = jobs_where(self.jobs, lambda job: uses_any(job, ".github/actions/pages-deploy"))
        self.assertEqual(len(names), 1)
        self.assertEqual(env_name(self.jobs[names[0]]), "github-pages")
        self.assertIn(self.build_job(), ancestors(self.jobs, names[0]))


class HomepageWorkflow(unittest.TestCase):
    def test_started_as_a_run_of_its_own_not_called(self):
        # A called workflow only sees the secrets its caller passes, so the `homepage` environment's
        # token read as empty and the release's ping was silently skipped.
        on = triggers(load(HOMEPAGE))
        self.assertIn("workflow_dispatch", on)
        self.assertNotIn("workflow_call", on)
        for name, job in (load(RELEASE).get("jobs") or {}).items():
            with self.subTest(job=name):
                self.assertNotEqual(str(job.get("uses", "")), "./" + HOMEPAGE)

    def test_the_release_job_that_starts_it_holds_only_actions_write(self):
        jobs = load(RELEASE).get("jobs") or {}
        home = [job for job in jobs.values() if "gh workflow run homepage.yml" in dump(job)]
        self.assertEqual(len(home), 1)
        self.assertEqual(home[0].get("permissions"), {"actions": "write"})
        self.assertNotIn("secrets.", dump(home[0]))
        self.assertNotIn("actions/checkout", dump(home[0]))

    def test_failed_ping_still_only_warns(self):
        text = read(HOMEPAGE)
        self.assertRegex(text, r"if\s+!\s+gh\s+api\s+repos/skathio/skathio\.github\.io/dispatches")
        self.assertIn("::warning", text)


def comment_covers(lines, index):
    """True when grant line `index` has a comment on it, in its block, or above `permissions:`."""
    if "#" in lines[index]:
        return True
    at = index - 1
    while at >= 0 and not lines[at].strip().startswith("permissions:"):
        if lines[at].strip().startswith("#"):
            return True
        at -= 1
    at -= 1
    return at >= 0 and lines[at].strip().startswith("#")


def indent_of(line):
    return len(line) - len(line.lstrip())


USES = re.compile(r"^\s*-?\s*uses:\s*([^\s#]+)")


def pinned(lines, i, ref):
    above = i > 0 and LINE_ABOVE_VERSION.match(lines[i - 1])
    return bool(FULL_SHA.search(ref)) and bool(SAME_LINE_VERSION.search(lines[i]) or above)


def unpinned_uses(rel):
    """Lines of `rel` whose non-local `uses:` lacks a full SHA or a version comment."""
    lines = read(rel).splitlines()
    found = [(i, USES.match(line)) for i, line in enumerate(lines)]
    return [f"{rel}:{i + 1}" for i, m in found
            if m and not m.group(1).startswith("./") and not pinned(lines, i, m.group(1))]


def is_code(stripped):
    return bool(stripped) and not stripped.startswith("#")


def block_indent_after(line, current):
    """The indent of the open `permissions:` block after `line`, or None outside one."""
    stripped = line.strip()
    if stripped.startswith("permissions:"):
        return indent_of(line) if stripped == "permissions:" else None
    if current is not None and is_code(stripped) and indent_of(line) <= current:
        return None
    return current


def grant_lines(lines):
    """Indexes of the grant lines inside job-level `permissions:` blocks."""
    start = next(i for i, line in enumerate(lines) if line.startswith("jobs:"))
    current, found = None, []
    for i in range(start, len(lines)):
        before = current
        current = block_indent_after(lines[i], current)
        stripped = lines[i].strip()
        if before is not None and current == before and is_code(stripped) \
                and not stripped.startswith("permissions:"):
            found.append(i)
    return found


class Conventions(unittest.TestCase):
    FILES = (RELEASE, SITE, HOMEPAGE)

    def test_every_action_pinned_by_sha_with_a_version(self):
        for rel in self.FILES:
            self.assertEqual(list(unpinned_uses(rel)), [])

    def test_every_job_grant_has_a_comment(self):
        for rel in (RELEASE, SITE):
            lines = read(rel).splitlines()
            bare = [f"{rel}:{i + 1}" for i in grant_lines(lines) if not comment_covers(lines, i)]
            self.assertEqual(bare, [], "each permission grant says why in a comment")

    def test_no_pull_request_target(self):
        for rel in self.FILES:
            self.assertNotIn("pull_request_target", read(rel))


def copy_tree(dest):
    for rel in (".github", "tests", "templates", "docs"):
        shutil.copytree(os.path.join(ROOT, rel), os.path.join(dest, rel),
                        ignore=shutil.ignore_patterns("node_modules", "__pycache__"))


def insert_step(text, job, step_lines):
    """Insert a step as the first step of `job` in release.yml text."""
    lines = text.splitlines(keepends=True)
    head = next(i for i, line in enumerate(lines) if re.match(rf"^  {re.escape(job)}:\s*$", line))
    at = next(i for i in range(head + 1, len(lines)) if lines[i].strip() == "steps:")
    first = lines[at + 1]
    pad = first[:len(first) - len(first.lstrip())]
    block = [f"{pad}- " + step_lines[0] + "\n"] + [f"{pad}  {s}\n" for s in step_lines[1:]]
    return "".join(lines[:at + 1] + block + lines[at + 1:])


class ReleaseLint(unittest.TestCase):
    def test_passes_on_the_repo(self):
        result = run_script([sys.executable, LINT])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS", result.stdout)

    def test_self_test_passes(self):
        result = run_script([sys.executable, LINT, "--self-test"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def lint_mutated(self, mutate):
        with tempfile.TemporaryDirectory() as tmp:
            copy_tree(tmp)
            path = os.path.join(tmp, RELEASE)
            baseline = run_script([sys.executable, LINT], cwd=tmp)
            self.assertEqual(baseline.returncode, 0, baseline.stdout + baseline.stderr)
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(mutate(text))
            return run_script([sys.executable, LINT], cwd=tmp)

    def other_job(self):
        jobs = load(RELEASE)["jobs"]
        return next(name for name, job in jobs.items()
                    if steps(job) and not uses_any(job, "actions/create-github-app-token"))

    def test_fails_without_production_on_the_pushing_job(self):
        result = self.lint_mutated(lambda text: re.sub(r"\bproduction\b", "staging", text))
        self.assertNotEqual(result.returncode, 0)

    def test_fails_on_a_step_naming_v1_or_v2(self):
        job = self.other_job()
        for major in ("v1", "v2"):
            with self.subTest(major=major):
                result = self.lint_mutated(lambda text: insert_step(
                    text, job, ["name: Move an old major", f"run: git tag -f {major} HEAD"]))
                self.assertNotEqual(result.returncode, 0)

    def test_fails_on_a_secret_outside_the_pushing_job(self):
        job = self.other_job()
        result = self.lint_mutated(lambda text: insert_step(
            text, job, ["name: Read a secret", "run: echo ok", "env:",
                        "  LEAK: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}"]))
        self.assertNotEqual(result.returncode, 0)

    def test_self_ci_runs_the_lint_and_its_self_test(self):
        commands = [str(s.get("run", "")) for job in (load(SELF_CI).get("jobs") or {}).values()
                    for s in steps(job)]
        self.assertTrue(any(LINT in c and "--self-test" not in c for c in commands))
        self.assertTrue(any(LINT in c and "--self-test" in c for c in commands))


class ExistingLints(unittest.TestCase):
    def test_gate_and_nesting_lints_pass(self):
        for lint in ("tests/shape-lints/gate-lints.py", "tests/shape-lints/no-nested-reusable-workflow.py"):
            with self.subTest(lint=lint):
                result = run_script([sys.executable, lint])
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(shutil.which("actionlint"), "actionlint is not installed")
    def test_actionlint_passes(self):
        result = run_script(["actionlint"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
