#!/usr/bin/env python3
"""
Contract tests for the v3 self-resolved library SHA.

The three consumer CI workflows drop the `library_ref` input. Each one
resolves the commit it was called at by itself and checks out hashira's
composite actions (into `.hashira/`) at exactly that commit, so a caller
pinned at `@<sha>` or `@v3` runs actions from the same commit as the
workflow file.

Run from the repo root: python3 tests/library-self-sha/test_library_self_sha.py
Needs python3 and PyYAML, as the other shape lints do.
"""

import glob
import os
import re
import subprocess
import unittest

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FLOWS = {
    "npm-package-ci.yml": "npm",
    "nuget-package-ci.yml": "nuget",
    "static-webapp-ci.yml": "static-webapp",
}
WORKFLOW_DIR = os.path.join(ROOT, ".github", "workflows")
SELF_CI = os.path.join(WORKFLOW_DIR, "_self-ci.yml")
# Refs that name the consumer's commit, never the library's own commit.
CALLER_REFS = ("github.sha", "github.workflow_sha", "github.ref", "github.head_ref")
# The OIDC fallback reads this claim from a token minted with these variables.
OIDC_MARKER = re.compile(r"job_workflow_sha|ACTIONS_ID_TOKEN_REQUEST_(TOKEN|URL)")
SHA_PIN = re.compile(r"@[0-9a-f]{40}\b")


def read_text(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def load_yaml(path):
    return yaml.safe_load(read_text(path))


def workflow_path(name):
    return os.path.join(WORKFLOW_DIR, name)


def call_inputs(doc):
    # PyYAML reads the bare `on:` key as boolean True.
    trigger = doc.get("on", doc.get(True)) or {}
    return (trigger.get("workflow_call") or {}).get("inputs") or {}


def jobs_of(doc):
    return doc.get("jobs") or {}


def steps_of(job):
    return job.get("steps") or []


def is_library_checkout(step):
    uses = str(step.get("uses", ""))
    path = str((step.get("with") or {}).get("path", "")).rstrip("/")
    return uses.startswith("actions/checkout@") and path in (".hashira", "./.hashira")


def uses_library_action(step):
    return str(step.get("uses", "")).startswith("./.hashira/")


def needs_list(job):
    needs = job.get("needs") or []
    return [needs] if isinstance(needs, str) else list(needs)


def library_checkouts(doc):
    for job_id, job in jobs_of(doc).items():
        for step in steps_of(job):
            if is_library_checkout(step):
                yield job_id, job, step


def flow_jobs():
    for name in FLOWS:
        for job_id, job in jobs_of(load_yaml(workflow_path(name))).items():
            yield name, job_id, job


def flow_library_checkouts():
    for name in FLOWS:
        for job_id, job, step in library_checkouts(load_yaml(workflow_path(name))):
            yield name, job_id, job, step


def checkout_ref(step):
    return str((step.get("with") or {}).get("ref", ""))


def library_actions_before_checkout(job):
    early = []
    for step in steps_of(job):
        if is_library_checkout(step):
            return early
        if uses_library_action(step):
            early.append(step["uses"])
    return early


def id_token_grants(name):
    lines = read_text(workflow_path(name)).splitlines()
    for index, line in enumerate(lines):
        if re.match(r"^\s*id-token:\s*write\b", line):
            previous = lines[index - 1] if index else ""
            yield index + 1, "#" in line or previous.strip().startswith("#")


class NoLibraryRefInput(unittest.TestCase):
    def test_workflow_call_has_no_library_ref_input(self):
        for name in FLOWS:
            with self.subTest(workflow=name):
                self.assertNotIn("library_ref", call_inputs(load_yaml(workflow_path(name))))

    def test_workflow_text_never_mentions_library_ref(self):
        for name in FLOWS:
            with self.subTest(workflow=name):
                self.assertNotIn("library_ref", read_text(workflow_path(name)))

    def test_no_caller_in_this_repo_passes_library_ref(self):
        for path in glob.glob(os.path.join(WORKFLOW_DIR, "*.yml")):
            for job_id, job in jobs_of(load_yaml(path)).items():
                if not any(flow in str(job.get("uses", "")) for flow in FLOWS):
                    continue
                with self.subTest(file=os.path.basename(path), job=job_id):
                    self.assertNotIn("library_ref", job.get("with") or {})

    def test_docs_never_mention_library_ref_outside_migration_guide(self):
        paths = [os.path.join(ROOT, "README.md")]
        paths += glob.glob(os.path.join(ROOT, "docs", "**", "*.md"), recursive=True)
        paths += glob.glob(os.path.join(ROOT, "templates", "**", "*"), recursive=True)
        for path in paths:
            if not os.path.isfile(path) or path.endswith("migration-v2-to-v3.md"):
                continue
            with self.subTest(file=os.path.relpath(path, ROOT)):
                self.assertNotIn("library_ref", read_text(path))


class LibraryCheckedOutAtOwnSha(unittest.TestCase):
    def test_every_job_using_library_actions_checks_out_the_library_first(self):
        for name, job_id, job in flow_jobs():
            with self.subTest(workflow=name, job=job_id):
                self.assertEqual(library_actions_before_checkout(job), [])

    def test_each_workflow_checks_out_the_library(self):
        for name in FLOWS:
            with self.subTest(workflow=name):
                self.assertTrue(list(library_checkouts(load_yaml(workflow_path(name)))))

    def test_library_ref_is_a_resolved_expression_not_an_input_or_literal(self):
        for name, job_id, _job, step in flow_library_checkouts():
            ref = checkout_ref(step)
            with self.subTest(workflow=name, job=job_id, ref=ref):
                self.assertRegex(ref, r"^\$\{\{.*\}\}$", "ref must be resolved at run time")
                self.assertNotIn("inputs.", ref, "ref must not come from a caller input")

    def test_library_ref_is_not_the_callers_commit(self):
        for name, job_id, _job, step in flow_library_checkouts():
            used = [r for r in CALLER_REFS if re.search(re.escape(r) + r"\b", checkout_ref(step))]
            with self.subTest(workflow=name, job=job_id):
                self.assertEqual(used, [])

    def test_ref_from_another_job_is_declared_in_needs(self):
        for name, job_id, job, step in flow_library_checkouts():
            sources = set(re.findall(r"needs\.([A-Za-z0-9_-]+)\.outputs", checkout_ref(step)))
            with self.subTest(workflow=name, job=job_id):
                self.assertEqual(sources - set(needs_list(job)), set())


class OidcFallbackStaysInSetup(unittest.TestCase):
    """Holds only when the OIDC `job_workflow_sha` fallback is used."""

    def test_the_sha_token_is_requested_only_in_setup(self):
        requesters = [(name, job_id) for name, job_id, job in flow_jobs()
                      if OIDC_MARKER.search(yaml.safe_dump(steps_of(job)))]
        for name, job_id in requesters:
            with self.subTest(workflow=name, job=job_id):
                self.assertEqual(job_id, "setup")

    def test_workflow_level_permissions_never_grant_id_token(self):
        for name in FLOWS:
            perms = load_yaml(workflow_path(name)).get("permissions") or {}
            with self.subTest(workflow=name):
                self.assertNotEqual(perms.get("id-token"), "write")

    def test_id_token_grant_has_a_why_comment(self):
        for name in FLOWS:
            for line_no, commented in id_token_grants(name):
                with self.subTest(workflow=name, line=line_no):
                    self.assertTrue(commented, "id-token: write needs a why-comment")

    def test_docs_list_id_token_write_when_the_workflow_needs_it(self):
        for name, flow in FLOWS.items():
            if not OIDC_MARKER.search(read_text(workflow_path(name))):
                continue
            doc_path = os.path.join(ROOT, "docs", "flows", flow + ".md")
            with self.subTest(workflow=name):
                self.assertIn("id-token: write", read_text(doc_path))


class ConventionsHold(unittest.TestCase):
    def test_top_level_permissions_are_deny_all(self):
        for name in FLOWS:
            perms = load_yaml(workflow_path(name)).get("permissions")
            with self.subTest(workflow=name):
                self.assertIn(perms, ({}, {"contents": "read"}))

    def test_third_party_actions_are_sha_pinned(self):
        for name, job_id, job in flow_jobs():
            unpinned = [str(s["uses"]) for s in steps_of(job)
                        if s.get("uses") and not str(s["uses"]).startswith("./")
                        and not SHA_PIN.search(str(s["uses"]))]
            with self.subTest(workflow=name, job=job_id):
                self.assertEqual(unpinned, [])

    def test_self_ci_calls_a_consumer_ci_workflow(self):
        calls = [str(job.get("uses", "")) for job in jobs_of(load_yaml(SELF_CI)).values()]
        self.assertTrue(any(flow in call for call in calls for flow in FLOWS))

    def test_self_ci_runs_this_file(self):
        self.assertIn("tests/library-self-sha/test_library_self_sha.py", read_text(SELF_CI))


def new_lib_files():
    try:
        base = subprocess.run(
            ["git", "merge-base", "HEAD", "main"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
        listed = subprocess.run(
            ["git", "diff", "--name-only", "--diff-filter=A", base, "--", ".github/actions"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return []
    untracked = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", ".github/actions"],
        cwd=ROOT, capture_output=True, text=True, check=False,
    ).stdout
    paths = set(listed.split()) | set(untracked.split())
    return sorted(p for p in paths if re.search(r"/lib/[^/]+\.(c|m)?js$", p))


def node20_test_files():
    found = set()
    for job in jobs_of(load_yaml(SELF_CI)).values():
        steps = steps_of(job)
        versions = {str((s.get("with") or {}).get("node-version", "")) for s in steps}
        if "20" not in versions:
            continue
        for step in steps:
            found.update(re.findall(r"node --test ([^\n]+)", str(step.get("run", ""))))
    return " ".join(found)


class NewLibFilesAreTested(unittest.TestCase):
    def test_each_new_lib_file_has_a_node_test_run_on_node_20(self):
        node20 = node20_test_files()
        for lib in new_lib_files():
            base = os.path.splitext(os.path.basename(lib))[0]
            tests = [t for t in glob.glob(os.path.join(ROOT, "tests", "**", "*.test.js"), recursive=True)
                     if base in read_text(t)]
            with self.subTest(lib=lib):
                self.assertTrue(tests, "no node:test file requires " + base)
                self.assertTrue(any(os.path.relpath(t, ROOT) in node20 for t in tests),
                                "no _self-ci.yml Node 20 job runs a test for " + base)


if __name__ == "__main__":
    unittest.main(verbosity=1)
