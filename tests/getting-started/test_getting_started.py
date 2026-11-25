#!/usr/bin/env python3
"""
Contract tests for `docs/getting-started.md`, the page that takes a new
consumer from nothing to a first release.

- It exists and covers choosing a flow, copying the flow's caller from
  `templates/<flow>/ci.yml`, the pin policy (`@v3` or a full SHA, never
  `@main`), the `production` environment, OIDC trusted publishing, and a
  first release cut with a dispatch.
- It links to every flow guide, to every `templates/<flow>/ci.yml` and to
  `docs/usage.md`, and every relative link points at a file that exists, so
  the docs site's dead-link check and GitHub both resolve it.
- It pastes no caller block: the templates stay the one copy that the
  identity lint tracks.
- No `uses:` ref in it pins `@main`.
- The template-identity lint and the v3 callers and docs contract still
  pass with the page in place.

Run from the repo root: python3 tests/getting-started/test_getting_started.py
Needs python3 and PyYAML, as the other shape lints do.
"""

import os
import re
import subprocess
import sys
import unittest

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PAGE = "docs/getting-started.md"
FLOWS = ("npm", "nuget", "static-webapp")
GITHUB_BLOB = re.compile(r"^https://github\.com/skathio/hashira/blob/[^/]+/(.+)$")
INLINE_LINK = re.compile(r"\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
REF_LINK = re.compile(r"^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+\"[^\"]*\")?\s*$", re.M)
FENCED = re.compile(r"^[ \t]*(```|~~~)[^\n]*\n(.*?)^[ \t]*\1", re.M | re.S)
MAIN_PIN = re.compile(r"uses:\s*\S+@main\b")
EXTERNAL = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)


def read_page():
    with open(os.path.join(ROOT, PAGE), encoding="utf-8") as handle:
        return handle.read()


def prose(text):
    """The page with fenced code removed, so a link inside an example is not counted."""
    return FENCED.sub("", text)


def link_targets(text):
    body = prose(text)
    return INLINE_LINK.findall(body) + REF_LINK.findall(body)


def repo_path(target):
    """The repo-relative file a link points at, or None for an external or in-page link."""
    target = target.split("#", 1)[0].split("?", 1)[0]
    if not target:
        return None
    blob = GITHUB_BLOB.match(target)
    if blob:
        return os.path.normpath(blob.group(1))
    if EXTERNAL.match(target):
        return None
    base = os.path.dirname(PAGE)
    return os.path.normpath(os.path.join(base, target))


def linked_files(text):
    return {p for p in (repo_path(t) for t in link_targets(text)) if p}


def relative_targets(text):
    found = []
    for target in link_targets(text):
        bare = target.split("#", 1)[0]
        if bare and not EXTERNAL.match(bare):
            found.append(target)
    return found


def run_script(*args):
    return subprocess.run(
        [sys.executable, *args], cwd=ROOT, capture_output=True, text=True, check=False
    )


class GettingStartedPage(unittest.TestCase):
    def setUp(self):
        self.assertTrue(os.path.isfile(os.path.join(ROOT, PAGE)), f"{PAGE} is missing")
        self.text = read_page()
        self.lower = self.text.lower()

    def test_links_every_flow_guide(self):
        links = linked_files(self.text)
        for flow in FLOWS:
            with self.subTest(flow=flow):
                self.assertIn(f"docs/flows/{flow}.md", links)

    def test_links_every_flow_template(self):
        links = linked_files(self.text)
        for flow in FLOWS:
            with self.subTest(flow=flow):
                self.assertIn(f"templates/{flow}/ci.yml", links)

    def test_links_usage_for_detail(self):
        self.assertIn("docs/usage.md", linked_files(self.text))

    def test_every_relative_link_resolves(self):
        targets = relative_targets(self.text)
        self.assertTrue(targets, "the page has no relative links")
        for target in targets:
            with self.subTest(target=target):
                rel = repo_path(target)
                self.assertTrue(os.path.exists(os.path.join(ROOT, rel)), f"dead link {target}")

    def test_covers_pin_policy(self):
        self.assertIn("@v3", self.text)
        self.assertIn("sha", self.lower)
        self.assertIn("@main", prose(self.text), "the page must say never to pin @main")

    def test_no_main_pin(self):
        self.assertIsNone(MAIN_PIN.search(self.text), "a uses: ref pins @main")

    def test_covers_production_environment(self):
        self.assertIn("`production`", self.text)
        self.assertIn("environment", self.lower)

    def test_covers_oidc_trusted_publishing(self):
        self.assertIn("oidc", self.lower)
        self.assertIn("trusted publish", self.lower)

    def test_covers_first_release_by_dispatch(self):
        self.assertIn("dispatch", self.lower)
        self.assertIn("release", self.lower)

    def test_pastes_no_caller_block(self):
        for _, block in FENCED.findall(self.text):
            try:
                parsed = yaml.safe_load(block)
            except yaml.YAMLError:
                continue
            with self.subTest(block=block[:60]):
                self.assertFalse(
                    isinstance(parsed, dict) and "jobs" in parsed,
                    "a caller workflow is pasted; link templates/<flow>/ci.yml instead",
                )


class ExistingLintsStillPass(unittest.TestCase):
    def test_template_identity_lint(self):
        result = run_script("tests/templates/identity-lint.py")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_v3_callers_docs_contract(self):
        result = run_script("tests/v3-callers-docs/test_v3_callers_docs.py")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
