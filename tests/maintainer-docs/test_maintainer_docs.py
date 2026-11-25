#!/usr/bin/env python3
"""
Contract tests for the maintainer docs that come with the docs site and the
release workflow.

- CLAUDE.md drops its "no build" statements, names docs-site/, release.yml
  and docs/getting-started.md in its layout, lists the new test commands
  that _self-ci.yml runs, gives a CI job count equal to _self-ci.yml's, says
  releases go through release.yml with a `bump` while v1 and v2 stay frozen,
  and no longer says the site deploys on every push to main.
- The release skill dispatches release.yml and keeps the manual tag, Release
  and major-tag commands as the fallback, after the dispatch.
- The visual-test-site skill builds with docs-site/build.sh, serves
  artifacts/pages and screenshots the docs pages too, at 390px and 1440px in
  light and dark.
- docs/contributing.md writes down the GitHub App steps: create it, install
  it, add it as a bypass actor on the `release-tags` ruleset and store
  RELEASE_APP_CLIENT_ID and RELEASE_APP_PRIVATE_KEY as `production` environment
  secrets. It also names the docs site and release.yml.
- The docs build, with its dead-link check, and the existing shape lints
  still pass.

Run from the repo root: python3 tests/maintainer-docs/test_maintainer_docs.py
Needs python3 and PyYAML, as the other shape lints do. The docs build test
needs `npm ci` in docs-site/ first, as docs-site/build.sh does.
"""

import os
import re
import subprocess
import sys
import unittest

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CLAUDE = "CLAUDE.md"
RELEASE_SKILL = ".claude/skills/release/SKILL.md"
VISUAL_SKILL = ".claude/skills/visual-test-site/SKILL.md"
CONTRIBUTING = "docs/contributing.md"
SELF_CI = ".github/workflows/_self-ci.yml"
FENCE = re.compile(r"^\s*(```|~~~)")


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as handle:
        return handle.read()


def sections(text):
    """Map each markdown heading (H2 and below) to its body, ignoring `#` lines inside code fences."""
    found, current, fenced = {}, None, False
    for line in text.splitlines():
        if FENCE.match(line):
            fenced = not fenced
        heading = None if fenced else re.match(r"^(#{2,6})\s+(.*?)\s*$", line)
        if heading:
            current = heading.group(2)
            found[current] = []
        elif current is not None:
            found[current].append(line)
    return {name: "\n".join(body) for name, body in found.items()}


def section(text, title):
    for name, body in sections(text).items():
        if name.lower() == title.lower():
            return body
    raise AssertionError(f"no section headed {title!r}")


def paragraphs(text):
    return [p for p in re.split(r"\n\s*\n", text) if p.strip()]


def run(*args):
    return subprocess.run(list(args), cwd=ROOT, capture_output=True, text=True)


class ClaudeMd(unittest.TestCase):
    def setUp(self):
        self.text = read(CLAUDE)

    def test_no_build_statements_are_gone(self):
        # The docs site is built now, so the old claims are false.
        self.assertNotIn("no application code and no build", self.text)
        self.assertNotIn("There is no `npm install` and no build", self.text)

    def test_layout_names_docs_site_release_workflow_and_getting_started(self):
        layout = section(self.text, "Layout")
        for name in ("docs-site/", "release.yml", "docs/getting-started.md"):
            self.assertIn(name, layout, f"the Layout section does not name {name}")

    def test_commands_list_the_docs_build_and_new_tests(self):
        commands = next(body for name, body in sections(self.text).items() if name.startswith("Commands"))
        for needle in ("npm ci", "docs-site/build.sh", "node --test docs-site/",
                       "tests/release/", "tests/shape-lints/release-lint.py",
                       "tests/release-workflow/test_release_workflow.py"):
            self.assertIn(needle, commands, f"the Commands section does not list {needle}")
        self.assertRegex(commands, r"release-lint\.py\s+--self-test",
                         "the Commands section does not run release-lint.py --self-test")

    def test_ci_job_count_matches_self_ci(self):
        jobs = yaml.safe_load(read(SELF_CI))["jobs"]
        ci = section(self.text, "CI")
        counts = re.findall(r"(\d+)\s+jobs\b", ci)
        self.assertTrue(counts, "the CI section gives no job count")
        for count in counts:
            self.assertEqual(int(count), len(jobs),
                             f"CLAUDE.md says {count} jobs, _self-ci.yml has {len(jobs)}")

    def test_release_flow_goes_through_release_workflow(self):
        flow = section(self.text, "Release flow")
        self.assertIn("release.yml", flow)
        self.assertIn("bump", flow)
        self.assertIn("production", flow)
        self.assertNotIn("Releases are cut by hand.", flow)

    def test_release_flow_keeps_v1_and_v2_frozen(self):
        flow = section(self.text, "Release flow")
        self.assertRegex(flow, r"`?v1`? and `?v2`? are frozen")

    def test_site_no_longer_deploys_on_push(self):
        self.assertNotRegex(self.text, r"site deploys on every push to main")
        deploy = [p for p in paragraphs(self.text) if "site.yml" in p and "deploy" in p]
        self.assertTrue(deploy, "CLAUDE.md does not say how site.yml deploys")
        self.assertTrue(any("release.yml" in p for p in deploy),
                        "no paragraph on the site deploy names release.yml")


class ReleaseSkill(unittest.TestCase):
    def setUp(self):
        self.text = read(RELEASE_SKILL)

    def test_dispatches_release_workflow_with_bump(self):
        self.assertIn("release.yml", self.text)
        self.assertIn("bump", self.text)
        self.assertRegex(self.text, r"gh workflow run release\.yml|[Dd]ispatch")

    def test_keeps_manual_commands_as_fallback_after_dispatch(self):
        for command in ("git tag -a", "gh release create", "git push -f origin"):
            self.assertIn(command, self.text, f"the manual fallback lost `{command}`")
        self.assertIn("release.yml", self.text, "the skill does not dispatch release.yml")
        self.assertLess(self.text.index("release.yml"), self.text.index("git tag -a"),
                        "the manual commands come before the release.yml dispatch")

    def test_v1_and_v2_stay_frozen(self):
        self.assertRegex(self.text, r"`?v1`? and `?v2`?\s+(are|stay)\s+frozen")


class VisualTestSkill(unittest.TestCase):
    def setUp(self):
        self.text = read(VISUAL_SKILL)

    def test_builds_and_serves_artifacts_pages(self):
        self.assertIn("docs-site/build.sh", self.text)
        self.assertIn("artifacts/pages", self.text)
        self.assertNotRegex(self.text, r"--directory\s+site\b",
                            "the skill still serves site/ alone")

    def test_screenshots_docs_pages_at_both_widths_and_schemes(self):
        self.assertIn("docs/", self.text)
        for needle in ("390", "1440", "light", "dark"):
            self.assertIn(needle, self.text)
        self.assertRegex(self.text, r"(?i)catalog")
        self.assertRegex(self.text, r"(?i)flow guide|flows/")


class Contributing(unittest.TestCase):
    def setUp(self):
        self.text = read(CONTRIBUTING)

    def app_section(self):
        found = [body for name, body in sections(self.text).items()
                 if "RELEASE_APP_PRIVATE_KEY" in body]
        self.assertTrue(found, "no section of contributing.md stores the release App's secrets")
        return found[0]

    def test_app_setup_steps_are_written_down(self):
        body = self.app_section()
        self.assertIn("GitHub App", body)
        self.assertRegex(body, r"(?i)\bcreate")
        self.assertRegex(body, r"(?i)\binstall")
        self.assertIn("release-tags", body)
        self.assertRegex(body, r"(?i)bypass")
        self.assertIn("RELEASE_APP_CLIENT_ID", body)
        self.assertIn("production", body)

    def test_names_docs_site_and_release_workflow(self):
        self.assertIn("docs-site", self.text)
        self.assertIn("release.yml", self.text)


class StillPasses(unittest.TestCase):
    LINTS = (
        "tests/npm-release/shape-validate.py", "tests/npm-package-ci/shape-validate.py",
        "tests/nuget-package-ci/shape-validate.py", "tests/pages-upload/shape-validate.py",
        "tests/pages-deploy/shape-validate.py", "tests/static-webapp-ci/shape-validate.py",
        "tests/catalog/shape-validate.py", "tests/static-webapp/docs-cross-ref.py",
        "tests/templates/identity-lint.py", "tests/shape-lints/fixture-diff.py",
        "tests/shape-lints/no-nested-reusable-workflow.py", "tests/shape-lints/gate-lints.py",
        "tests/shape-lints/release-lint.py",
    )

    def test_shape_lints_pass(self):
        for lint in self.LINTS:
            with self.subTest(lint=lint):
                result = run(sys.executable, lint)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_docs_build_with_dead_link_check_passes(self):
        result = run("bash", "docs-site/build.sh")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(os.path.isfile(os.path.join(ROOT, "artifacts/pages/docs/index.html")))


if __name__ == "__main__":
    unittest.main()
