#!/usr/bin/env python3
"""
Contract tests for the `consumer-integration` job in `_self-ci.yml`.

- A matrix over the three flows runs on every pull request and every push
  to main. For hashira commit S it pushes branch `hashira/<S>` to each
  fixture repo with every `skathio/hashira` ref set to S, opens a PR,
  waits for its CI, fails if it fails, and links each fixture run in the
  job summary.
- On the same branch it runs the release path (`workflow_dispatch` with
  `bump: patch`, plus `seed_version: 0.0.0` when the fixture repo has no
  stable tag), asserts the tag and Release exist, then deletes the tag,
  the Release, the PR and the branch, on success, failure and cancellation.
- The npm fixture has a second branch `hashira/<S>-gate` whose PR run must
  fail at the quality gate job.
- Runs against one fixture repo never overlap and never cancel each other:
  a lock branch in each fixture repo (lib/lock.js), taken before anything
  is pushed and released by the always() cleanup. Not a concurrency group,
  because GitHub cancels all but one pending job in a group. A fixture
  wait gives up after 30 minutes with "timed out waiting for <repo> run
  <id>", inside a step limit, inside a job limit that covers every step.
- It authenticates with a GitHub App token minted by a SHA-pinned
  `actions/create-github-app-token`, from repo secrets.
- Every JS helper the job runs has `node:test` tests that `_self-ci.yml`
  runs on Node 20.

The job is read as text and YAML, together with the local scripts and
composite actions it runs, because the run itself needs the fixture repos
and the App. A test asserts only what the request states.

Run from the repo root: python3 tests/consumer-integration/test_consumer_integration.py
Needs python3 and PyYAML, as the other shape lints do.
"""

import glob
import itertools
import json
import os
import re
import unittest

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SELF_CI = ".github/workflows/_self-ci.yml"
THIS_FILE = "tests/consumer-integration/test_consumer_integration.py"
JOB = "consumer-integration"
FIXTURE_REPOS = ("hashira-fixture-npm", "hashira-fixture-nuget", "hashira-fixture-static")
FLOW_WORDS = ("npm", "nuget", "static")

EXPR = re.compile(r"\$\{\{\s*(.*?)\s*\}\}", re.S)
MATRIX_REF = re.compile(r"^matrix\.([\w.-]+)$")
SKIPS_EVENTS = re.compile(r"event_name|github\.ref|fork|head\.repo")
LOCAL_SCRIPT = re.compile(r"((?:\.github|tests)/[\w./-]+\.(?:js|mjs|cjs|sh|py))")
LOCAL_ACTION = re.compile(r"^\./(\.github/actions/[\w./-]+?)/?$")
SHA_PIN = re.compile(r"@[0-9a-f]{40}$")
APP_TOKEN = "actions/create-github-app-token@"
TIMEOUT_MESSAGE = re.compile(r"timed out waiting for \S+ run \S+")
THIRTY_MINUTES = re.compile(r"\b30\s*\*\s*60\b|\b1800(000)?\b|\b30\s*min|\b30m\b|minutes?\W{0,6}30\b|timeout-minutes:\s*30\b")
NODE_TEST = re.compile(r"node\s+--test\s+([^\n;&|]+)")


def path(rel):
    return os.path.join(ROOT, rel)


def read(rel):
    with open(path(rel), encoding="utf-8") as handle:
        return handle.read()


def workflow():
    return yaml.safe_load(read(SELF_CI)) or {}


def triggers():
    doc = workflow()
    # PyYAML reads the bare key `on` as the boolean True.
    return doc.get("on", doc.get(True)) or {}


def jobs():
    return workflow().get("jobs") or {}


def job():
    return jobs().get(JOB) or {}


def job_raw_text():
    """The job's lines as written, comments included."""
    lines = read(SELF_CI).splitlines()
    first = next((i for i, line in enumerate(lines) if re.match(rf"^  {JOB}:\s*$", line)), None)
    if first is None:
        return ""
    end = next((i for i in range(first + 1, len(lines)) if re.match(r"^ {0,2}\S", lines[i])), len(lines))
    return "\n".join(lines[first:end])


def steps(of_job=None):
    return (of_job if of_job is not None else job()).get("steps") or []


def local_files(text):
    """Contents of the local scripts and composite actions a text runs."""
    found = set(LOCAL_SCRIPT.findall(text))
    for match in re.finditer(r"uses:\s*\"?(\./[^\s\"]+)", text):
        action = LOCAL_ACTION.match(match.group(1))
        if action:
            found.update(os.path.relpath(f, ROOT) for f in glob.glob(path(action.group(1)) + "/**/*", recursive=True))
    return {rel: read(rel) for rel in sorted(found) if os.path.isfile(path(rel))}


def corpus(text):
    return text + "\n" + "\n".join(local_files(text).values())


def job_corpus():
    return corpus(json.dumps(job()) + "\n" + job_raw_text())


def matrix_legs():
    matrix = ((job().get("strategy") or {}).get("matrix")) or {}
    if isinstance(matrix, str):
        return []
    base = {k: v for k, v in matrix.items() if k not in ("include", "exclude")}
    legs = [dict(zip(base, combo)) for combo in itertools.product(*base.values())] if base else []
    return legs + [dict(item) for item in matrix.get("include") or [] if item not in legs]


def lookup(leg, dotted):
    value = leg
    for part in dotted.split("."):
        value = value.get(part) if isinstance(value, dict) else None
    return value


def expand(text, leg):
    def one(match):
        ref = MATRIX_REF.match(match.group(1))
        value = lookup(leg, ref.group(1)) if ref else None
        return match.group(0) if value is None else str(value)
    return EXPR.sub(one, text)


def step_index(command):
    """Index of the step that runs `integrate.js <command>`, or -1."""
    pattern = re.compile(rf"integrate\.js\s+{re.escape(command)}\s*$")
    return next((i for i, s in enumerate(steps()) if pattern.search(str(s.get("run") or "").strip())), -1)


def cleanup_corpus():
    """Text of the steps and later jobs that run whatever the outcome."""
    parts = [json.dumps(step) for step in steps() if "always()" in str(step.get("if", ""))]
    for name, other in jobs().items():
        needs = other.get("needs") or []
        needs = [needs] if isinstance(needs, str) else needs
        if JOB in needs and "always()" in str(other.get("if", "")):
            parts.append(json.dumps(other))
    return corpus("\n".join(parts)).lower() if parts else ""


def comment_above_step(lines, at):
    """Whether a comment sits on the line above the step holding line `at`."""
    start = next((i for i in range(at, -1, -1) if lines[i].lstrip().startswith("- ")), at)
    return start > 0 and lines[start - 1].strip().startswith("#")


def uses_with_comment(text):
    """(ref, has version comment) for each `uses:` line in the text."""
    lines = text.splitlines()
    found = []
    for i, line in enumerate(lines):
        match = re.match(r"^\s*-?\s*uses:\s*(\S+)(.*)$", line)
        if match:
            inline = bool(re.search(r"#.*\bv\d", match.group(2)))
            found.append((match.group(1), inline or comment_above_step(lines, i)))
    return found


def permission_lines(lines):
    """(index, line) of each grant under the job's `permissions:`, comments skipped."""
    start = next((i for i, line in enumerate(lines) if re.match(r"^    permissions:\s*$", line)), len(lines))
    end = next((i for i in range(start + 1, len(lines))
                if lines[i].strip() and not lines[i].startswith("      ")), len(lines))
    return [(i, lines[i]) for i in range(start + 1, end)
            if lines[i].strip() and not lines[i].strip().startswith("#")]


def grants_without_why(text):
    lines = text.splitlines()
    return [line.strip() for i, line in permission_lines(lines)
            if "#" not in line and not lines[i - 1].strip().startswith("#")]


def node20_test_files():
    """Test files that a _self-ci.yml job runs with `node --test` on Node 20."""
    files = set()
    for other in jobs().values():
        text = json.dumps(other)
        if not re.search(r"node-version\"?:\s*\"?'?20\b", text):
            continue
        for match in NODE_TEST.finditer("\n".join(str(s.get("run") or "") for s in steps(other))):
            files.update(match.group(1).split())
    return files


def js_helpers():
    return [rel for rel in local_files(job_corpus())
            if rel.endswith((".js", ".mjs", ".cjs")) and not rel.endswith(".test.js")]


def tests_covering(helper):
    stem = os.path.splitext(os.path.basename(helper))[0]
    return [rel for rel in node20_test_files() if os.path.isfile(path(rel)) and stem in read(rel)]


# --- tests ----------------------------------------------------------------

class JobAndTriggers(unittest.TestCase):

    def test_job_exists(self):
        self.assertTrue(JOB in jobs(), f"{SELF_CI}: no job {JOB}")

    def test_matrix_has_one_leg_per_flow(self):
        legs = matrix_legs()
        self.assertEqual(len(legs), 3, f"{JOB}: matrix legs {legs}")
        for word in FLOW_WORDS:
            self.assertEqual(sum(word in json.dumps(leg) for leg in legs), 1, f"{JOB}: no single leg for {word}")

    def test_job_names_each_fixture_repo(self):
        legs = [expand(job_corpus(), leg) for leg in matrix_legs()]
        for repo in FIXTURE_REPOS:
            self.assertTrue(any(repo in text for text in legs), f"{JOB}: no leg targets skathio/{repo}")

    def test_runs_on_every_pull_request(self):
        on = triggers()
        self.assertIn("pull_request", on, f"{SELF_CI}: not run on pull_request")
        pr = on.get("pull_request") or {}
        for key in ("branches", "branches-ignore", "paths", "paths-ignore"):
            self.assertNotIn(key, pr, f"{SELF_CI}: pull_request filtered by {key}")

    def test_runs_on_every_push_to_main(self):
        push = triggers().get("push") or {}
        self.assertEqual(push.get("branches"), ["main"], f"{SELF_CI}: push branches")
        for key in ("paths", "paths-ignore"):
            self.assertNotIn(key, push, f"{SELF_CI}: push filtered by {key}")

    def test_job_is_not_skipped_by_event_or_fork(self):
        condition = str(job().get("if", ""))
        self.assertNotRegex(condition, SKIPS_EVENTS, f"{JOB}: if: {condition}")

    def test_never_pull_request_target(self):
        self.assertNotIn("pull_request_target", triggers(), SELF_CI)

    def test_this_file_runs_in_self_ci(self):
        runs = [str(s.get("run") or "") for j in jobs().values() for s in steps(j)]
        self.assertTrue(any(THIS_FILE in run for run in runs), f"{SELF_CI}: no job runs {THIS_FILE}")


class NoOverlap(unittest.TestCase):

    def test_no_concurrency_group_that_would_cancel_a_pending_run(self):
        self.assertIsNone(job().get("concurrency"), f"{JOB}: a concurrency group cancels all but one pending run")

    def test_lock_is_waited_for_then_taken_before_anything_is_pushed(self):
        wait, take, push = step_index("lock-wait"), step_index("lock"), step_index("open")
        self.assertTrue(0 <= wait < take < push, f"{JOB}: lock-wait {wait}, lock {take}, open {push}")

    def test_waiting_for_the_lock_holds_no_app_token(self):
        wait = steps()[step_index("lock-wait")]
        self.assertNotIn("GH_TOKEN", wait.get("env") or {}, f"{JOB}: lock-wait must not hold a token that expires")

    def test_cleanup_runs_after_the_lock_whatever_the_outcome(self):
        cleanup = step_index("cleanup")
        self.assertGreater(cleanup, step_index("lock"))
        self.assertIn("always()", str(steps()[cleanup].get("if", "")))


class Timeouts(unittest.TestCase):

    def test_timeout_message_names_repo_and_run(self):
        self.assertRegex(job_corpus(), TIMEOUT_MESSAGE, f"{JOB}: no 'timed out waiting for <repo> run <id>' failure")

    def test_fixture_wait_is_thirty_minutes(self):
        self.assertRegex(job_corpus(), THIRTY_MINUTES, f"{JOB}: no 30-minute limit on a fixture job")

    def test_each_fixture_wait_has_a_step_limit_above_thirty_minutes(self):
        for command in ("pr-run", "gate-run", "release"):
            limit = steps()[step_index(command)].get("timeout-minutes")
            self.assertTrue(isinstance(limit, int) and limit > 30, f"{JOB}: {command} step limit {limit}")

    def test_job_limit_covers_every_step_limit(self):
        total = sum(s.get("timeout-minutes") or 0 for s in steps())
        self.assertGreaterEqual(job().get("timeout-minutes") or 0, total, f"{JOB}: steps add up to {total} minutes")
        self.assertLessEqual(job().get("timeout-minutes") or 0, 360, f"{JOB}: GitHub ends a job at 360 minutes")

    def test_no_app_token_spans_two_fixture_waits(self):
        for command in ("pr-run", "gate-run", "release"):
            env = steps()[step_index(command)].get("env") or {}
            tokens = [str(e) for e in env.values() if "steps." in str(e)]
            self.assertTrue(tokens, f"{JOB}: {command} has no App token")
        used = [str((steps()[step_index(c)].get("env") or {}).get("GH_TOKEN")) for c in ("pr-run", "gate-run", "release")]
        self.assertEqual(len(set(used)), 3, f"{JOB}: fixture waits share a token: {used}")


class Authentication(unittest.TestCase):

    def app_token_steps(self):
        return [s for s in steps() if str(s.get("uses", "")).startswith(APP_TOKEN)]

    def test_app_token_is_minted(self):
        self.assertTrue(self.app_token_steps(), f"{JOB}: no {APP_TOKEN} step")

    def test_app_token_action_is_sha_pinned(self):
        for step in self.app_token_steps():
            self.assertRegex(step["uses"], SHA_PIN, f"{JOB}: {step['uses']}")

    def test_app_id_and_key_come_from_secrets(self):
        for step in self.app_token_steps():
            values = [str(v) for v in (step.get("with") or {}).values()]
            self.assertGreaterEqual(sum("secrets." in v for v in values), 2, f"{JOB}: app token inputs {values}")

    def test_fixture_calls_use_the_app_token(self):
        ids = [s.get("id") for s in self.app_token_steps() if s.get("id")]
        self.assertTrue(ids, f"{JOB}: the app token step has no id")
        text = json.dumps(steps())
        self.assertTrue(any(f"steps.{i}.outputs.token" in text for i in ids), f"{JOB}: app token never used")


class FixturePullRequest(unittest.TestCase):

    def test_pushes_branch_named_after_the_commit(self):
        self.assertRegex(job_corpus(), r"hashira/\$", f"{JOB}: no hashira/<S> branch")

    def test_rewrites_hashira_refs(self):
        self.assertIn("skathio/hashira", job_corpus(), f"{JOB}: never rewrites skathio/hashira refs")

    def test_opens_a_pull_request(self):
        self.assertRegex(job_corpus().lower(), r"pr create|/pulls\b|pulls\.create", f"{JOB}: never opens a fixture PR")

    def test_waits_for_the_run_and_checks_its_result(self):
        self.assertRegex(job_corpus(), r"conclusion|run watch", f"{JOB}: never checks the fixture run's result")

    def test_links_fixture_runs_in_summary(self):
        text = job_corpus()
        self.assertIn("GITHUB_STEP_SUMMARY", text, f"{JOB}: writes no job summary")
        self.assertRegex(text, r"actions/runs|html_url|\burl\b", f"{JOB}: summary does not link the fixture run")


class ReleasePath(unittest.TestCase):

    def test_dispatches_the_fixture_workflow(self):
        self.assertRegex(job_corpus().lower(), r"workflow run|/dispatches|workflow_dispatch",
                         f"{JOB}: never dispatches the release path")

    def test_dispatch_sets_bump_patch(self):
        self.assertRegex(job_corpus(), r"bump\W{1,4}patch", f"{JOB}: no bump: patch")

    def test_seed_version_zero_when_no_stable_tag(self):
        self.assertRegex(job_corpus(), r"seed_version\W{1,4}0\.0\.0", f"{JOB}: no seed_version 0.0.0")

    def test_asserts_release_exists(self):
        self.assertRegex(job_corpus().lower(), r"release view|releases/tags|getreleasebytag",
                         f"{JOB}: never checks the Release")

    def test_asserts_tag_exists(self):
        self.assertRegex(job_corpus().lower(), r"refs/tags|ls-remote|git/ref/tags", f"{JOB}: never checks the tag")


class Cleanup(unittest.TestCase):

    def test_cleanup_runs_whatever_the_outcome(self):
        self.assertTrue(cleanup_corpus(), f"{JOB}: no cleanup with if: always()")

    def test_cleanup_deletes_release(self):
        text = cleanup_corpus()
        self.assertIn("release", text, f"{JOB}: cleanup does not delete the Release")
        self.assertIn("delete", text, f"{JOB}: cleanup deletes nothing")

    def test_cleanup_deletes_tag(self):
        self.assertRegex(cleanup_corpus(), r"cleanup-tag|refs/tags|tags/|--delete", f"{JOB}: cleanup keeps the tag")

    def test_cleanup_closes_pull_request(self):
        self.assertRegex(cleanup_corpus(), r"pr close|closed", f"{JOB}: cleanup leaves the fixture PR open")

    def test_cleanup_deletes_branch(self):
        self.assertRegex(cleanup_corpus(), r"refs/heads|heads/|delete-branch|--delete",
                         f"{JOB}: cleanup keeps branch hashira/<S>")


class GateNegative(unittest.TestCase):

    def test_pushes_gate_branch(self):
        self.assertIn("-gate", job_corpus(), f"{JOB}: no hashira/<S>-gate branch")

    def test_checks_failure_at_quality_gate_job(self):
        self.assertIn("quality-gate", job_corpus(), f"{JOB}: never checks the quality-gate job")


class Conventions(unittest.TestCase):

    def test_third_party_actions_sha_pinned_with_version_comment(self):
        for ref, commented in uses_with_comment(job_raw_text()):
            if ref.startswith(("./", "skathio/hashira/")):
                continue
            self.assertRegex(ref, SHA_PIN, f"{JOB}: {ref} not SHA-pinned")
            self.assertTrue(commented, f"{JOB}: {ref} has no version comment")

    def test_permissions_declared_with_why_comment(self):
        self.assertIn("permissions", job(), f"{JOB}: no job permissions")
        self.assertEqual(grants_without_why(job_raw_text()), [], f"{JOB}: grants without a why-comment")

    def test_top_level_permissions_stay_read_only(self):
        self.assertEqual(workflow().get("permissions"), {"contents": "read"}, SELF_CI)

    def test_js_helpers_have_node20_tests(self):
        for helper in js_helpers():
            self.assertTrue(tests_covering(helper), f"{helper}: no node:test run on Node 20 in {SELF_CI}")


if __name__ == "__main__":
    unittest.main()
