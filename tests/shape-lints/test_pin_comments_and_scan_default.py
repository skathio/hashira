#!/usr/bin/env python3
"""The user's rules for pinned-action version comments and the actionlint default.

1. Every SHA-pinned `uses:` line carries a `vX.Y.Z` version comment (on the same line, or a
   comment of the same step above it), and that comment names a tag that points at the SHA.
   The three SHAs the request verified name checkout v7.0.1, setup-node v7.1.0 and
   setup-dotnet v6.1.0.
2. One SHA has the same version comment everywhere (the offline check).
3. tests/shape-lints/pin-comments.py exists, resolves each SHA through the GitHub API with a
   token, fails on a wrong comment, has a passing --self-test, and runs in its own _self-ci job
   that hands it GITHUB_TOKEN.
4. npm-package-ci, nuget-package-ci and static-webapp-ci default `scan_disable` to 'codeql'; the
   flow docs, docs/catalog.md, docs/usage.md and CHANGELOG.md agree, and the shape-validate
   scripts pass.

Run with:
  python3 tests/shape-lints/test_pin_comments_and_scan_default.py

The tests that need github.com skip when it cannot be reached, and the tests that run the lint
online skip when no token is found in GITHUB_TOKEN or `gh auth token`.

Left to the builder, so not tested here: the lint's offline flag, its output wording, how it
pairs a comment with a pin, the _self-ci job's name, and scan-suite's own default.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LINT = os.path.join("tests", "shape-lints", "pin-comments.py")
CI_WORKFLOWS = ("npm-package-ci.yml", "nuget-package-ci.yml", "static-webapp-ci.yml")
FLOW_DOCS = ("npm.md", "nuget.md", "static-webapp.md")
# Shipped files with pins: the actions, workflows, templates, fixture sources and caller docs.
# The lints' own negative fixtures are left out on purpose.
PIN_SCOPE = (".github/", "templates/", "tests/consumers/", "docs/", "README.md")
VERIFIED = {
    "3d3c42e5aac5ba805825da76410c181273ba90b1": ("actions/checkout", "v7.0.1"),
    "949feb2413d6458794dcd2491c4babbbce0c15c1": ("actions/setup-node", "v7.1.0"),
    "0f4a354dd5547a28c70b7853dbd95d5b67886e73": ("actions/setup-dotnet", "v6.1.0"),
}

USES = re.compile(r"^(\s*)(-\s+)?uses:\s*([A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+)@([0-9a-f]{40})\b(.*)$")
VERSION = re.compile(r"\bv\d+\.\d+\.\d+\b")


def read(*parts):
    with open(os.path.join(REPO, *parts), encoding="utf8") as fh:
        return fh.read()


def repo_files():
    out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=REPO,
                         capture_output=True, text=True, check=True).stdout
    return [p for p in out.splitlines() if os.path.isfile(os.path.join(REPO, p))]


def comment_of(line):
    stripped = line.strip()
    return stripped[1:].strip() if stripped.startswith("#") else None


def is_step_start(line, indent):
    return line.strip().startswith("- ") and len(line) - len(line.lstrip()) < indent


def comments_inside_step(lines, index, indent):
    """Comment indexes between a non-item `uses:` line and its step's `- ` line, and that line."""
    found = []
    i = index - 1
    while i >= 0 and lines[i].strip() and not is_step_start(lines[i], indent):
        if comment_of(lines[i]) is not None:
            found.append(i)
        i -= 1
    return found, i


def step_comments(lines, index, indent, is_item):
    """Comment lines of the step holding lines[index], nearest first, with their indexes."""
    found, i = ([], index) if is_item else comments_inside_step(lines, index, indent)
    i -= 1
    while i >= 0 and comment_of(lines[i]) is not None:
        found.append(i)
        i -= 1
    return found


def pin_version(lines, index, match):
    """(version, line index) the pin's comment names, or (None, None)."""
    indent, item, action, _sha, rest = match.groups()
    same_line = VERSION.search(rest.split("#", 1)[1]) if "#" in rest else None
    if same_line:
        return same_line.group(0), index
    repo = "/".join(action.split("/")[:2])
    candidates = step_comments(lines, index, len(indent), bool(item))
    for i in candidates:
        text = comment_of(lines[i])
        named = re.search(re.escape(repo) + r"\s+(v\d+\.\d+\.\d+)\b", text)
        if named:
            return named.group(1), i
    for i in candidates:
        bare = VERSION.search(comment_of(lines[i]))
        if bare:
            return bare.group(0), i
    return None, None


def in_pin_scope(rel):
    return rel.startswith(PIN_SCOPE) and rel.endswith((".yml", ".yaml", ".md"))


def pins_in(rel, lines):
    for index, line in enumerate(lines):
        match = USES.match(line)
        if not match:
            continue
        version, comment_line = pin_version(lines, index, match)
        yield {"file": rel, "line": index + 1, "action": match.group(3),
               "repo": "/".join(match.group(3).split("/")[:2]), "sha": match.group(4),
               "version": version, "comment_line": comment_line}


def collect_pins(root=REPO):
    pins = []
    for rel in filter(in_pin_scope, repo_files()):
        with open(os.path.join(root, rel), encoding="utf8") as fh:
            pins.extend(pins_in(rel, fh.read().split("\n")))
    return pins


def github_reachable():
    try:
        probe = subprocess.run(["git", "ls-remote", "--tags", "https://github.com/actions/checkout"],
                               capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return probe.returncode == 0


def tags_on(repo, cache={}):
    if repo not in cache:
        out = subprocess.run(["git", "ls-remote", "--tags", f"https://github.com/{repo}"],
                             capture_output=True, text=True, timeout=120, check=True).stdout
        tags = {}
        for row in out.splitlines():
            sha, ref = row.split("\t")
            tag = ref[len("refs/tags/"):].removesuffix("^{}")
            tags.setdefault(tag, set()).add(sha)
        cache[repo] = tags
    return cache[repo]


def token():
    if os.environ.get("GITHUB_TOKEN"):
        return os.environ["GITHUB_TOKEN"]
    try:
        out = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() if out.returncode == 0 and out.stdout.strip() else None


def run_lint(root, *args, with_token=True):
    env = dict(os.environ)
    env.pop("GITHUB_TOKEN", None)
    if with_token:
        env["GITHUB_TOKEN"] = token()
    return subprocess.run([sys.executable, os.path.join(root, LINT), *args], cwd=root, env=env,
                          capture_output=True, text=True, timeout=600)


def copy_repo():
    root = tempfile.mkdtemp(prefix="pin-comments-")
    for rel in repo_files():
        dest = os.path.join(root, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(os.path.join(REPO, rel), dest)
    return root


def rewrite_comment(root, pin, new_version):
    path = os.path.join(root, pin["file"])
    with open(path, encoding="utf8") as fh:
        lines = fh.read().split("\n")
    i = pin["comment_line"]
    if i == pin["line"] - 1:
        head, comment = lines[i].split("#", 1)
        lines[i] = head + "#" + comment.replace(pin["version"], new_version, 1)
    else:
        lines[i] = lines[i].replace(pin["version"], new_version, 1)
    with open(path, "w", encoding="utf8") as fh:
        fh.write("\n".join(lines))


def section(text, heading_pattern):
    match = re.search(heading_pattern, text, re.M)
    if not match:
        return None
    level = len(match.group(0).split(" ", 1)[0])
    rest = text[match.end():]
    end = re.search(r"^#{1,%d} " % level, rest, re.M)
    return rest[:end.start()] if end else rest


class PinComments(unittest.TestCase):
    def test_there_are_pins_to_check(self):
        self.assertGreater(len(collect_pins()), 100)

    def test_every_pin_has_a_version_comment(self):
        missing = [f"{p['file']}:{p['line']} {p['action']}" for p in collect_pins() if not p["version"]]
        self.assertEqual(missing, [], "SHA pins with no vX.Y.Z comment")

    def test_one_sha_has_one_comment_everywhere(self):
        seen = {}
        for pin in collect_pins():
            if pin["version"]:
                seen.setdefault(pin["sha"], {}).setdefault(pin["version"], []).append(
                    f"{pin['file']}:{pin['line']}")
        split = {sha: versions for sha, versions in seen.items() if len(versions) > 1}
        self.assertEqual(split, {}, "one SHA named with different versions")

    def test_the_three_verified_shas_name_their_real_tags(self):
        wrong = []
        for pin in collect_pins():
            if pin["sha"] in VERIFIED:
                action, version = VERIFIED[pin["sha"]]
                self.assertEqual(pin["repo"], action, f"{pin['file']}:{pin['line']}")
                if pin["version"] != version:
                    wrong.append(f"{pin['file']}:{pin['line']} says {pin['version']}, not {version}")
        self.assertEqual(wrong, [])

    def test_the_verified_shas_are_all_found(self):
        shas = {pin["sha"] for pin in collect_pins()}
        self.assertTrue(set(VERIFIED) <= shas, "a verified SHA is no longer pinned anywhere")

    @unittest.skipUnless(github_reachable(), "github.com cannot be reached")
    def test_every_comment_names_a_tag_on_its_sha(self):
        wrong = []
        for pin in collect_pins():
            if not pin["version"]:
                continue
            on_tag = tags_on(pin["repo"]).get(pin["version"], set())
            if pin["sha"] not in on_tag:
                wrong.append(f"{pin['file']}:{pin['line']} {pin['repo']}@{pin['sha'][:8]} "
                             f"is not tag {pin['version']}")
        self.assertEqual(wrong, [])


class PinCommentsLint(unittest.TestCase):
    def test_lint_exists(self):
        self.assertTrue(os.path.isfile(os.path.join(REPO, LINT)), f"{LINT} is missing")

    def test_self_test_passes(self):
        self.assertTrue(os.path.isfile(os.path.join(REPO, LINT)), f"{LINT} is missing")
        result = run_lint(REPO, "--self-test", with_token=bool(token()))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(token() and github_reachable(), "no GitHub token or no network")
    def test_lint_passes_on_the_repo(self):
        result = run_lint(REPO)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(token() and github_reachable(), "no GitHub token or no network")
    def test_lint_fails_when_a_comment_names_a_tag_on_another_sha(self):
        root = copy_repo()
        try:
            for pin in collect_pins(root):
                if pin["sha"].startswith("3d3c42e5") and pin["version"]:
                    rewrite_comment(root, pin, "v4.2.2")
            result = run_lint(root)
        finally:
            shutil.rmtree(root, ignore_errors=True)
        self.assertNotEqual(result.returncode, 0, "checkout's SHA commented v4.2.2 everywhere passed")

    @unittest.skipUnless(token() and github_reachable(), "no GitHub token or no network")
    def test_lint_fails_when_one_sha_has_two_comments(self):
        root = copy_repo()
        try:
            pin = next(p for p in collect_pins(root) if p["sha"].startswith("949feb24") and p["version"])
            rewrite_comment(root, pin, "v7.0.0")
            result = run_lint(root)
        finally:
            shutil.rmtree(root, ignore_errors=True)
        self.assertNotEqual(result.returncode, 0, "one setup-node pin with another comment passed")


class PinCommentsSelfCiJob(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.jobs = yaml.safe_load(read(".github", "workflows", "_self-ci.yml"))["jobs"]

    def runs(self, job):
        return [step.get("run", "") for step in job.get("steps", [])]

    def lint_jobs(self, self_test):
        def runs_lint(job):
            lines = "\n".join(self.runs(job)).split("\n")
            return any("pin-comments.py" in l and ("--self-test" in l) == self_test for l in lines)
        return {name: job for name, job in self.jobs.items() if runs_lint(job)}

    def test_a_job_runs_the_lint(self):
        self.assertTrue(self.lint_jobs(self_test=False), "no _self-ci job runs pin-comments.py")

    def test_a_job_runs_the_self_test(self):
        self.assertTrue(self.lint_jobs(self_test=True), "no _self-ci job runs pin-comments.py --self-test")

    def test_the_lint_has_its_own_job(self):
        for name, job in self.lint_jobs(self_test=False).items():
            others = set()
            for script in self.runs(job):
                others |= set(re.findall(r"tests/[\w./-]+\.(?:py|js|mjs)", script))
            self.assertEqual(others - {LINT.replace(os.sep, "/")}, set(), f"{name} runs other checks too")

    def test_the_lint_gets_the_github_token(self):
        for name, job in self.lint_jobs(self_test=False).items():
            env = dict(job.get("env") or {})
            for step in job.get("steps", []):
                if "pin-comments.py" in step.get("run", ""):
                    env.update(step.get("env") or {})
            value = str(env.get("GITHUB_TOKEN", ""))
            self.assertRegex(value, r"\$\{\{\s*(secrets\.GITHUB_TOKEN|github\.token)\s*\}\}", name)

    def test_the_lint_jobs_pin_their_actions(self):
        jobs = {**self.lint_jobs(self_test=False), **self.lint_jobs(self_test=True)}
        for name, job in jobs.items():
            for step in job.get("steps", []):
                if "uses" in step and not step["uses"].startswith("./"):
                    self.assertRegex(step["uses"], r"@[0-9a-f]{40}$", name)


class ScanDisableDefault(unittest.TestCase):
    def input_of(self, workflow):
        doc = yaml.safe_load(read(".github", "workflows", workflow))
        on = doc.get("on", doc.get(True))
        return on["workflow_call"]["inputs"]["scan_disable"]

    def test_the_three_ci_workflows_default_to_codeql(self):
        for workflow in CI_WORKFLOWS:
            with self.subTest(workflow=workflow):
                spec = self.input_of(workflow)
                self.assertEqual(spec.get("default"), "codeql")
                self.assertEqual(spec.get("type"), "string")
                self.assertFalse(spec.get("required", False))

    def test_input_descriptions_no_longer_name_the_old_default(self):
        for workflow in CI_WORKFLOWS:
            with self.subTest(workflow=workflow):
                self.assertNotIn("codeql,actionlint", self.input_of(workflow).get("description", ""))

    def test_flow_doc_tables_show_codeql(self):
        for doc in FLOW_DOCS:
            with self.subTest(doc=doc):
                rows = [r for r in read("docs", "flows", doc).split("\n") if r.startswith("| `scan_disable` |")]
                self.assertEqual(len(rows), 1, rows)
                cells = [c.strip() for c in rows[0].strip("|").split("|")]
                self.assertIn(cells[2], ("`codeql`", "`'codeql'`", '`"codeql"`'))

    def test_flow_docs_no_longer_state_the_old_default(self):
        for doc in FLOW_DOCS:
            with self.subTest(doc=doc):
                stale = re.findall(r"codeql,actionlint(?![,\w])", read("docs", "flows", doc))
                self.assertEqual(stale, [])

    def test_catalog_rows_for_the_three_workflows_show_codeql(self):
        catalog = read("docs", "catalog.md")
        for workflow in CI_WORKFLOWS:
            with self.subTest(workflow=workflow):
                body = section(catalog, r"^### " + re.escape(workflow) + r"\s*$")
                self.assertIsNotNone(body, f"no catalog section for {workflow}")
                self.assertIn("| `scan_disable` | no | `codeql` |", body)

    def test_usage_default_section_names_codeql(self):
        usage = read("docs", "usage.md")
        body = section(usage, r"^### Default value\s*$")
        self.assertIsNotNone(body, "docs/usage.md lost its scan_disable Default value section")
        self.assertRegex(body, r"scan_disable:\s*['\"]codeql['\"]")

    def test_changelog_notes_the_new_actionlint_default(self):
        body = section(read("CHANGELOG.md"), r"^## \[3\.4\.0\].*$")
        self.assertIsNotNone(body, "CHANGELOG.md has no [3.4.0] entry")
        self.assertIn("actionlint", body)
        self.assertIn("scan_disable", body)
        for workflow in CI_WORKFLOWS:
            self.assertIn(workflow.removesuffix(".yml"), body)

    def test_shape_validate_scripts_pass(self):
        for folder in ("npm-package-ci", "nuget-package-ci", "static-webapp-ci", "catalog"):
            for args in ((), ("--self-test",)):
                with self.subTest(folder=folder, args=args):
                    result = subprocess.run(
                        [sys.executable, os.path.join("tests", folder, "shape-validate.py"), *args],
                        cwd=REPO, capture_output=True, text=True, timeout=300)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
