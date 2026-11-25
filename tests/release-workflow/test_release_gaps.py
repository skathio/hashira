#!/usr/bin/env python3
"""Cases the release and docs-build contract left open.

- release.yml's Plan step reads only gh's own "release not found" as "no Release". Any other
  failure of `gh release view` (network, auth) stops the job before the App token is minted,
  instead of going on to create a Release that may already exist.
- docs-site/build.sh refuses a docs/index.md: getting-started.md is published as the docs
  site's index page, so the two would be written to the same file.
- After the approval, publish refuses a commit main has moved past unless it already carries
  this version's tag, and a major tag that would move backwards, before the App token is minted
  and before any push. "Re-run failed jobs" reuses check's outputs, so check alone is not enough.
- The release decision cases in docs-site/request-gaps.test.mjs also run on Node 20, the
  oldest Node the release logic must keep working on.

The Plan step is run as release.yml holds it, with a stub `gh` first on PATH and GIT_DIR on an
empty repo, so the plan sees no tags and never reads this checkout's own.
"""

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RELEASE = ".github/workflows/release.yml"
SELF_CI = ".github/workflows/_self-ci.yml"
THIS = "python3 tests/release-workflow/test_release_gaps.py"
SHA = "a" * 40

GH_STUB = """#!/usr/bin/env bash
# Stands in for `gh release view`: prints GH_STUB_STDERR on stderr, exits GH_STUB_EXIT.
printf '%s\\n' "$*" >> "${GH_STUB_CALLS}"
if [ -n "${GH_STUB_STDERR}" ]; then printf '%s\\n' "${GH_STUB_STDERR}" >&2; fi
if [ "${GH_STUB_EXIT}" = 0 ]; then printf '{"tagName":"v3.9.9"}\\n'; fi
exit "${GH_STUB_EXIT}"
"""


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as handle:
        return handle.read()


def workflow(rel):
    return yaml.safe_load(read(rel))


def plan_script():
    steps = workflow(RELEASE)["jobs"]["publish"]["steps"]
    return next(step["run"] for step in steps if step.get("id") == "plan")


class PlanReadsTheRelease(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="release-gaps-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        bin_dir = os.path.join(self.tmp, "bin")
        os.mkdir(bin_dir)
        stub = os.path.join(bin_dir, "gh")
        with open(stub, "w", encoding="utf-8") as handle:
            handle.write(GH_STUB)
        os.chmod(stub, os.stat(stub).st_mode | stat.S_IXUSR)
        self.git_dir = os.path.join(self.tmp, "empty.git")
        subprocess.run(["git", "init", "--quiet", "--bare", self.git_dir], check=True)
        self.script = os.path.join(self.tmp, "plan.sh")
        with open(self.script, "w", encoding="utf-8") as handle:
            handle.write(plan_script())
        self.output = os.path.join(self.tmp, "github-output")
        self.calls = os.path.join(self.tmp, "gh-calls")
        self.env = dict(
            os.environ,
            PATH=bin_dir + os.pathsep + os.environ["PATH"],
            GIT_DIR=self.git_dir,
            GH_TOKEN="stub",
            GH_REPO="skathio/hashira",
            VERSION="3.9.9",
            SHA=SHA,
            GITHUB_OUTPUT=self.output,
            GH_STUB_CALLS=self.calls,
        )

    def plan(self, exit_code, stderr=""):
        env = dict(self.env, GH_STUB_EXIT=str(exit_code), GH_STUB_STDERR=stderr)
        return subprocess.run(["bash", self.script], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)

    def outputs(self):
        if not os.path.exists(self.output):
            return {}
        with open(self.output, encoding="utf-8") as handle:
            return dict(line.split("=", 1) for line in handle.read().splitlines() if line)

    def test_an_existing_release_counts_as_done(self):
        result = self.plan(0)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.outputs()["release"], "done")

    def test_release_not_found_plans_to_create_it(self):
        result = self.plan(1, "release not found")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.outputs(), {"tag": "create", "release": "create", "major_tag": "create", "major_tag_name": "v3"})

    def test_the_stub_was_asked_for_this_versions_release(self):
        self.plan(1, "release not found")
        with open(self.calls, encoding="utf-8") as handle:
            self.assertIn("release view v3.9.9", handle.read())

    def test_any_other_failure_stops_the_job_and_plans_nothing(self):
        for code, stderr in (
            (1, "HTTP 503: Service Unavailable (https://api.github.com/graphql)"),
            (4, "HTTP 401: Bad credentials (https://api.github.com/graphql)"),
            (1, "error connecting to api.github.com"),
            (1, ""),
            (127, "gh: command not found"),
        ):
            with self.subTest(stderr=stderr):
                if os.path.exists(self.output):
                    os.remove(self.output)
                result = self.plan(code, stderr)
                self.assertNotEqual(result.returncode, 0, "a failed read was taken for 'no Release'")
                self.assertEqual(self.outputs(), {}, "nothing may be planned from a failed read")
                self.assertIn("::error::", result.stdout)
                if stderr:
                    self.assertIn(stderr, result.stdout, "the error says why the read failed")


def guard_script():
    steps = workflow(RELEASE)["jobs"]["publish"]["steps"]
    return next(step["run"] for step in steps if step.get("name") == "Refuse a commit main has moved past")


class PublishRefusesAStaleCommit(unittest.TestCase):
    """The guard step run as release.yml holds it, against a throwaway repo.

    History: A <- B on main, and C branching from A off main.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="release-guard-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.git_env = dict(os.environ, GIT_DIR=os.path.join(self.tmp, "repo.git"),
                            GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
                            GIT_COMMITTER_EMAIL="t@t")
        self.git("init", "--quiet", "--bare", self.git_env["GIT_DIR"])
        tree = self.git("mktree", stdin="")
        self.a = self.git("commit-tree", tree, "-m", "A")
        self.b = self.git("commit-tree", tree, "-p", self.a, "-m", "B")
        self.c = self.git("commit-tree", tree, "-p", self.a, "-m", "C")
        self.git("update-ref", "refs/remotes/origin/main", self.b)
        self.script = os.path.join(self.tmp, "guard.sh")
        with open(self.script, "w", encoding="utf-8") as handle:
            handle.write(guard_script())

    def git(self, *args, stdin=None):
        return subprocess.run(["git", *args], env=self.git_env, input=stdin, capture_output=True,
                              text=True, check=True).stdout.strip()

    def tag(self, name, commit):
        self.git("update-ref", f"refs/tags/{name}", commit)

    def guard(self, sha, version="3.2.0"):
        env = dict(self.git_env, VERSION=version, SHA=sha)
        return subprocess.run(["bash", self.script], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)

    def test_mains_head_passes(self):
        self.tag("v3", self.a)
        result = self.guard(self.b)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_commit_main_moved_past_is_refused(self):
        # Run 1 on A waited at the approval; main moved to B. Re-running its failed jobs must not
        # publish v3.2.0 on A.
        result = self.guard(self.a)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not main's HEAD", result.stdout + result.stderr)

    def test_a_rerun_finishing_its_own_tag_passes(self):
        # v3.2.0 was pushed on A before the run failed; main has moved on since. Finishing is allowed.
        self.tag("v3.2.0", self.a)
        self.tag("v3", self.a)
        result = self.guard(self.a)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_major_tag_the_commit_does_not_contain_is_refused(self):
        # v3 is on C, which B does not contain: moving it to B would pull consumers off C.
        self.tag("v3", self.c)
        result = self.guard(self.b)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refusing to release an older commit", result.stdout)

    def test_a_superseded_rerun_finishing_its_release_passes(self):
        # Run 1 pushed v3.2.0 on A, then its Release failed. Run 2 released v3.2.1 on B and moved
        # v3 to B. Re-running run 1 only creates the missing Release, so it must not be refused.
        self.tag("v3.2.0", self.a)
        self.tag("v3.2.1", self.b)
        self.tag("v3", self.b)
        result = self.guard(self.a)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_new_major_with_no_major_tag_passes(self):
        result = self.guard(self.b, version="4.0.0")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_the_guard_runs_before_the_token_and_any_push(self):
        steps = workflow(RELEASE)["jobs"]["publish"]["steps"]
        names = [step.get("name") or step.get("id") or step.get("uses", "") for step in steps]
        guard = names.index("Refuse a commit main has moved past")
        token = next(i for i, step in enumerate(steps) if "create-github-app-token" in str(step.get("uses", "")))
        self.assertLess(guard, token)

    def test_the_sink_checks_ancestry_before_its_first_push(self):
        steps = workflow(RELEASE)["jobs"]["publish"]["steps"]
        run = next(step["run"] for step in steps if step.get("name") == "Tag, release and point the major tag")
        self.assertLess(run.index("merge-base --is-ancestor"), run.index("push origin"))


def deploy_guard_script():
    steps = workflow(".github/workflows/site.yml")["jobs"]["deploy"]["steps"]
    return next(step["run"] for step in steps if step.get("name") == "Refuse unless this commit holds the latest release")


class SiteDeployRefusesAStaleRelease(unittest.TestCase):
    """site.yml's deploy-time check, run as the file holds it, against a throwaway remote.

    "Re-run failed jobs" after a failed deploy re-runs only `deploy`, so the check lives there.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="site-guard-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.remote = os.path.join(self.tmp, "repo.git")
        self.git_env = dict(os.environ, GIT_DIR=self.remote, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
                            GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        self.git("init", "--quiet", "--bare", self.remote)
        tree = self.git("mktree", stdin="")
        self.a = self.git("commit-tree", tree, "-m", "A")
        self.b = self.git("commit-tree", tree, "-p", self.a, "-m", "B")
        self.script = os.path.join(self.tmp, "guard.sh")
        with open(self.script, "w", encoding="utf-8") as handle:
            handle.write(deploy_guard_script())

    def git(self, *args, stdin=None):
        return subprocess.run(["git", *args], env=self.git_env, input=stdin, capture_output=True,
                              text=True, check=True).stdout.strip()

    def annotated(self, name, commit):
        self.git("tag", "-a", name, "-m", name, commit)

    def light(self, name, commit):
        self.git("update-ref", f"refs/tags/{name}", commit)

    def guard(self, sha):
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update(SHA=sha, REMOTE=self.remote)
        return subprocess.run(["bash", self.script], cwd=self.tmp, env=env, capture_output=True, text=True, timeout=60)

    def test_the_latest_release_deploys(self):
        self.annotated("v3.1.0", self.a)
        self.annotated("v3.1.1", self.b)
        self.light("v3", self.b)
        result = self.guard(self.b)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_an_older_release_rerun_is_refused(self):
        # Run 1 released v3.1.0 on A and its deploy failed; run 2 released v3.1.1 on B. Re-running
        # run 1's failed deploy must not put A's site over B's.
        self.annotated("v3.1.0", self.a)
        self.annotated("v3.1.1", self.b)
        result = self.guard(self.a)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("this run is stale", result.stdout)

    def test_versions_compare_as_numbers(self):
        self.annotated("v3.9.0", self.a)
        self.annotated("v3.10.0", self.b)
        self.assertEqual(self.guard(self.b).returncode, 0)
        self.assertNotEqual(self.guard(self.a).returncode, 0)

    def test_a_lightweight_release_tag_counts(self):
        self.light("v3.2.0", self.b)
        self.assertEqual(self.guard(self.b).returncode, 0)

    def test_a_major_tag_alone_is_not_a_release(self):
        self.light("v3", self.b)
        result = self.guard(self.b)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no vX.Y.Z release tag", result.stdout)

    def test_only_a_release_call_runs_the_check(self):
        steps = workflow(".github/workflows/site.yml")["jobs"]["deploy"]["steps"]
        step = next(s for s in steps if s.get("name") == "Refuse unless this commit holds the latest release")
        self.assertEqual(str(step.get("if")).replace(" ", ""), "${{inputs.released}}")
        self.assertLess(steps.index(step), next(i for i, s in enumerate(steps) if s.get("id") == "deploy"))


class BuildRefusesADocsIndexPage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="docs-index-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        for folder in ("docs-site/node_modules/vitepress", "docs/flows", "site"):
            os.makedirs(os.path.join(self.tmp, folder))
        shutil.copy(os.path.join(ROOT, "docs-site/build.sh"), os.path.join(self.tmp, "docs-site/build.sh"))
        for rel in ("docs/getting-started.md", "docs/flows/npm.md", "site/mark.svg"):
            self.write(rel)

    def write(self, rel):
        with open(os.path.join(self.tmp, rel), "w", encoding="utf-8") as handle:
            handle.write("# Page\n")

    def build(self):
        return subprocess.run(["bash", os.path.join(self.tmp, "docs-site/build.sh")], cwd=self.tmp,
                              capture_output=True, text=True, timeout=120)

    def test_docs_index_md_is_refused_before_anything_is_staged(self):
        self.write("docs/index.md")
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("docs/index.md", result.stderr)
        self.assertIn("getting-started.md", result.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "artifacts")), "nothing is staged or built")

    def test_an_index_page_in_a_subfolder_is_not_refused(self):
        # Only docs/index.md lands on the home page's file; docs/flows/index.md has its own.
        self.write("docs/flows/index.md")
        result = self.build()
        self.assertNotIn("docs/index.md", result.stderr)
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "artifacts/docs-site/src/flows/index.md")),
                        result.stdout + result.stderr)

    def test_the_repo_has_no_docs_index_md(self):
        self.assertFalse(os.path.exists(os.path.join(ROOT, "docs/index.md")))


class CiWiring(unittest.TestCase):
    def test_release_cases_in_the_gaps_file_run_on_node_20(self):
        job = workflow(SELF_CI)["jobs"]["release-logic-unit-tests"]
        node = next(step["with"]["node-version"] for step in job["steps"] if "setup-node" in str(step.get("uses", "")))
        self.assertEqual(str(node), "20")
        commands = "\n".join(str(step.get("run", "")) for step in job["steps"])
        self.assertIn("docs-site/request-gaps.test.mjs", commands)

    def test_self_ci_and_claude_md_run_this_file(self):
        jobs = workflow(SELF_CI)["jobs"]
        ran = [name for name, job in jobs.items() if any(THIS in str(step.get("run", "")) for step in job.get("steps", []))]
        self.assertEqual(ran, ["release-lint"])
        self.assertIn(THIS, read("CLAUDE.md"))
        self.assertIn("docs-site/request-gaps.test.mjs", read("CLAUDE.md").split("node --test tests/release/release.test.js", 1)[1].split("\n", 1)[0])


if __name__ == "__main__":
    sys.exit(unittest.main())
