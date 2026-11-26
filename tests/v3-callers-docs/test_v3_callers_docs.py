#!/usr/bin/env python3
"""
Contract tests for the v3 caller templates, the template-identity lint and
the v3 docs.

- `templates/<flow>/ci.yml` is a minimal caller: at most 45 non-blank,
  non-comment lines; on pull_request, push to main and workflow_dispatch;
  a `ci` job that calls the flow's reusable CI workflow and one gated job
  (`publish` for npm and NuGet, `deploy` for static) with `needs: ci` and
  `environment:`; the permissions each job needs, with a why-comment per
  grant; third-party actions pinned to a full SHA with a version comment.
- A lint (found through the job that runs it in `_self-ci.yml`) passes on
  the repo, has a `--self-test` mode, and fails on a one-character change
  to a template, to the first caller block of `docs/flows/<flow>.md` or to
  the README's caller, naming the file and the first differing line.
- The README names `skathio/hashira` only, has one caller per flow, and
  links the catalog and the migration guide.
- `docs/catalog.md` lists every reusable workflow and composite action with
  its inputs (name, required, default), outputs and a `uses:` snippet, and
  the shape-validate scripts fail when a catalog table and the YAML differ.
- `docs/migration-v2-to-v3.md` lists every removed or re-defaulted input and
  the gate now on by default; `docs/usage.md` says v2 is frozen like v1.

Run from the repo root: python3 tests/v3-callers-docs/test_v3_callers_docs.py
Needs python3 and PyYAML, as the other shape lints do.
"""

import glob
import os
import re
import shutil
import subprocess
import tempfile
import unittest

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
THIS_FILE = "tests/v3-callers-docs/test_v3_callers_docs.py"
SELF_CI = ".github/workflows/_self-ci.yml"
CATALOG = "docs/catalog.md"
MIGRATION = "docs/migration-v2-to-v3.md"
MAX_TEMPLATE_LINES = 45
# flow -> (reusable CI workflow, gated job, environment, CD composite action)
FLOWS = {
    "npm": ("npm-package-ci.yml", "publish", "production", "npm-release"),
    "nuget": ("nuget-package-ci.yml", "publish", "production", "nuget-push"),
    "static-webapp": ("static-webapp-ci.yml", "deploy", "github-pages", "pages-deploy"),
}
# Inputs v3 removed or re-defaulted, from the inputs of every workflow and
# action at v2.0.1 compared with this branch: `library_ref` is gone,
# `coverage_path` now defaults to '' and `project_path` became optional.
V2_BREAKING_INPUTS = ("library_ref", "coverage_path", "project_path")
COPIED_DIRS = (".github", "docs", "templates", "tests")
COPIED_FILES = ("README.md", "CLAUDE.md", "package.json")
YAML_LANGS = ("yaml", "yml")
LEVEL = {"none": 0, "read": 1, "write": 2}
EMPTY_CELLS = {"", "none", "(none)", "required", "(required)", "n/a", "-", "—", "–", "empty", "(empty)"}
TRUE_CELLS = {"yes", "true", "required", "✓", "✔", "y"}
FALSE_CELLS = {"no", "false", "optional", "", "-", "—", "–", "n"}

SHA_PIN = re.compile(r"@[0-9a-f]{40}(\s|$)")
FENCED = re.compile(r"^```(\S*)[ \t]*\n(.*?)^```", re.M | re.S)
HEADING = re.compile(r"^(#+)\s")
TABLE = re.compile(r"^(\|[^\n]*)\n[ \t]*\|[\s:|-]+\|[ \t]*\n((?:[ \t]*\|[^\n]*(?:\n|$))*)", re.M)
WRAPPED = re.compile(r"^(\*\*|[*_`\"'])(.*)\1$", re.S)
PERM_BLOCK = re.compile(r"^ {4,}permissions:[^\n]*\n((?:[ \t]*\n| {6,}[^\n]*(?:\n|$))*)", re.M)
USES_LINE = re.compile(r"^(?:([ \t]*#[^\n]*)\n)?[ \t]*-?[ \t]*uses:[ \t]*(\S+)([^\n]*)", re.M)
LINT_CMD = re.compile(r"\b(python3|node)\s+(tests/\S+\.(?:py|js|mjs|cjs))")
MAIN_PIN = re.compile(r"uses:\s*skathio/hashira/\S*@main\b")


def path(rel, root=ROOT):
    return os.path.join(root, rel)


def read(rel, root=ROOT):
    with open(path(rel, root), encoding="utf-8") as handle:
        return handle.read()


def write(rel, text, root):
    with open(path(rel, root), "w", encoding="utf-8") as handle:
        handle.write(text)


def load(rel, root=ROOT):
    return yaml.safe_load(read(rel, root))


def mapping(value, key):
    return (value or {}).get(key) or {}


def triggers(doc):
    # PyYAML reads the bare `on:` key as boolean True.
    return doc.get("on", doc.get(True)) or {}


def template_rel(flow):
    return f"templates/{flow}/ci.yml"


def counted_lines(text):
    return [line for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]


def fenced_blocks(text):
    """(language, first body line index, body lines) for each fenced block."""
    return [(m.group(1).lower(), text.count("\n", 0, m.start(2)), m.group(2).splitlines())
            for m in FENCED.finditer(text)]


def caller_block(text, workflow):
    """First YAML block calling `workflow`: (start line index, body lines)."""
    needle = f"skathio/hashira/.github/workflows/{workflow}@"
    return next(((start, body) for lang, start, body in fenced_blocks(text)
                 if lang in YAML_LANGS and any(needle in line for line in body)), (None, None))


# This repo's own deploy workflows. release.yml calls them, so they take `workflow_call`, but no
# consumer does.
INTERNAL_WORKFLOWS = {"site.yml", "homepage.yml"}


def reusable_workflows():
    """The consumer-facing reusable workflows."""
    files = sorted(glob.glob(path(".github/workflows/*.yml")))
    return [os.path.basename(f) for f in files if os.path.basename(f) not in INTERNAL_WORKFLOWS
            and "workflow_call" in triggers(load(os.path.relpath(f, ROOT)))]


def composite_actions():
    return sorted(os.path.basename(os.path.dirname(f)) for f in glob.glob(path(".github/actions/*/action.yml")))


def contract_of(name):
    """(inputs, outputs) of a reusable workflow file name or an action name."""
    if name.endswith(".yml"):
        spec = mapping(triggers(load(f".github/workflows/{name}")), "workflow_call")
    else:
        spec = load(f".github/actions/{name}/action.yml")
    return mapping(spec, "inputs"), mapping(spec, "outputs")


def required_inputs(name):
    return {key for key, spec in contract_of(name)[0].items() if spec.get("required")}


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


# --- the template-identity lint, found through its _self-ci.yml job -------

def self_ci_commands():
    jobs = mapping(load(SELF_CI), "jobs").values()
    return [line for job in jobs for step in job.get("steps") or []
            for line in str(step.get("run") or "").splitlines()]


def is_identity_lint(rel):
    if rel == THIS_FILE or not os.path.isfile(path(rel)):
        return False
    source = read(rel)
    return all(word in source for word in ("templates", "README", "docs/flows"))


def find_identity_lint():
    found = [m.groups() for m in map(LINT_CMD.search, self_ci_commands()) if m]
    return next(((runner, rel) for runner, rel in found if is_identity_lint(rel)), (None, None))


# --- catalog tables -------------------------------------------------------

def entry_pattern(name):
    stem = re.escape(name[:-4] if name.endswith(".yml") else name)
    return re.compile(rf"(?<![\w-]){stem}(\.yml)?(?![\w-])")


def heading_depth(line):
    match = HEADING.match(line)
    return len(match.group(1)) if match else 0


def catalog_section(text, name):
    """(start line index, lines) under the first heading naming `name`, up
    to the next heading of the same or a higher level."""
    lines, pattern = text.splitlines(), entry_pattern(name)
    start = next((i for i, line in enumerate(lines) if heading_depth(line) and pattern.search(line)), None)
    if start is None:
        return None, None
    depth = heading_depth(lines[start])
    end = next((i for i in range(start + 1, len(lines)) if 0 < heading_depth(lines[i]) <= depth), len(lines))
    return start, lines[start:end]


def split_row(line):
    cells = re.split(r"(?<!\\)\|", line.strip().strip("|"))
    return [cell.strip().replace("\\|", "|") for cell in cells]


def tables(section):
    """Each table in `section` (a list of lines) as (header cells, row lines)."""
    return [([c.lower() for c in split_row(m.group(1))], m.group(2).splitlines())
            for m in TABLE.finditer("\n".join(section) + "\n")]


def bare(cell):
    for _ in range(3):
        cell = WRAPPED.sub(r"\2", cell.strip())
    return cell.strip()


def column(header, word):
    return next((i for i, cell in enumerate(header) if word in cell), None)


def input_rows(section):
    """name -> (required cell, default cell, row line) from each table with
    a required and a default column."""
    rows = {}
    for header, body in tables(section):
        req, default = column(header, "required"), column(header, "default")
        rows.update({bare(cells[0]): (cells[req], cells[default], line)
                     for line, cells in ((line, split_row(line)) for line in body)
                     if None not in (req, default) and len(cells) > max(req, default)})
    return rows


def first_cells(section):
    return {bare(split_row(line)[0]) for _, body in tables(section) for line in body}


def default_matches(spec, cell):
    value, shown = spec.get("default"), bare(cell).lower()
    expected = "" if value is None else str(value).lower()
    return shown == expected or (expected == "" and shown in EMPTY_CELLS)


def required_matches(spec, cell):
    return bare(cell).lower() in (TRUE_CELLS if spec.get("required") else FALSE_CELLS)


def catalog_input_problems(name, rows):
    inputs, outputs = contract_of(name)
    shown = {key: spec for key, spec in inputs.items() if key in rows}
    return ([f"{name}: input {key} missing" for key in inputs if key not in rows]
            + [f"{name}.{key}: required shown as {rows[key][0]!r}"
               for key, spec in shown.items() if not required_matches(spec, rows[key][0])]
            + [f"{name}.{key}: default shown as {rows[key][1]!r}" for key, spec in shown.items()
               if not spec.get("required") and not default_matches(spec, rows[key][1])]
            + [f"{name}: {key} is not in the YAML" for key in rows if key not in inputs and key not in outputs])


# --- permissions ----------------------------------------------------------

def granted(perms):
    if perms in ("read-all", "write-all"):
        return {"*": LEVEL[perms.split("-")[0]]}
    return {key: LEVEL.get(str(value), 0) for key, value in (perms or {}).items()}


def workflow_needs(workflow):
    grants = [granted(job.get("permissions")) for job in mapping(load(f".github/workflows/{workflow}"), "jobs").values()]
    return {key: max(g.get(key, 0) for g in grants) for grant in grants for key in grant}


def grant_lines_without_why(text):
    """Job-level permission grants with no comment on the line or on the
    line directly above."""
    lines = "".join(PERM_BLOCK.findall(text)).splitlines()
    return [line.strip() for i, line in enumerate(lines)
            if line.strip() and not line.strip().startswith("#") and "#" not in line
            and not (i and lines[i - 1].strip().startswith("#"))]


def unpinned_third_party(text):
    return [ref for above, ref, rest in USES_LINE.findall(text)
            if not ref.startswith(("skathio/hashira/", "./"))
            and not (SHA_PIN.search(ref + " ") and (above or re.search(r"#.*\bv\d", rest)))]


# --- tests ----------------------------------------------------------------

class TemplateShape(unittest.TestCase):

    def each_template(self):
        for flow, spec in FLOWS.items():
            rel = template_rel(flow)
            self.assertTrue(os.path.isfile(path(rel)), f"{rel} is missing")
            yield spec, rel, read(rel), load(rel)

    def test_at_most_45_counted_lines(self):
        counts = {rel: len(counted_lines(text)) for _, rel, text, _ in self.each_template()}
        self.assertEqual({rel: n for rel, n in counts.items() if n > MAX_TEMPLATE_LINES}, {},
                         "templates over 45 non-blank, non-comment lines")

    def test_triggers(self):
        for _, rel, _, doc in self.each_template():
            on = triggers(doc)
            self.assertEqual(set(on), {"pull_request", "push", "workflow_dispatch"}, rel)
            self.assertEqual(mapping(on, "push").get("branches"), ["main"], rel)

    def test_ci_job_calls_the_flow_workflow(self):
        for (workflow, _, _, _), rel, _, doc in self.each_template():
            uses = str(mapping(mapping(doc, "jobs"), "ci").get("uses", ""))
            self.assertTrue(uses.startswith(f"skathio/hashira/.github/workflows/{workflow}@"),
                            f"{rel}: job ci uses {uses!r}")

    def test_one_gated_job_needs_ci_with_environment(self):
        for (_, gated, env, _), rel, _, doc in self.each_template():
            jobs = mapping(doc, "jobs")
            self.assertEqual(set(jobs), {"ci", gated}, rel)
            self.assertIn(jobs[gated].get("needs"), ("ci", ["ci"]), f"{rel}: {gated}.needs")
            environment = jobs[gated].get("environment")
            name = environment.get("name") if isinstance(environment, dict) else environment
            self.assertEqual(name, env, f"{rel}: {gated}.environment")

    def test_gated_job_runs_the_cd_action_with_its_required_inputs(self):
        for (_, gated, _, action), rel, _, doc in self.each_template():
            prefix = f"skathio/hashira/.github/actions/{action}@"
            steps = doc["jobs"][gated].get("steps") or []
            step = next((s for s in steps if str(s.get("uses", "")).startswith(prefix)), None)
            self.assertIsNotNone(step, f"{rel}: {gated} does not run {action}")
            missing = required_inputs(action) - set(step.get("with") or {})
            self.assertEqual(missing, set(), f"{rel}: {action} needs these inputs")

    def test_ci_job_passes_required_workflow_inputs(self):
        for (workflow, _, _, _), rel, _, doc in self.each_template():
            missing = required_inputs(workflow) - set(doc["jobs"]["ci"].get("with") or {})
            self.assertEqual(missing, set(), f"{rel}: {workflow} needs these inputs")

    def test_top_level_permissions_deny_all(self):
        for _, rel, _, doc in self.each_template():
            self.assertIn(doc.get("permissions"), ({}, {"contents": "read"}), rel)

    def test_ci_job_grants_what_the_workflow_jobs_request(self):
        for (workflow, _, _, _), rel, _, doc in self.each_template():
            have = granted(doc["jobs"]["ci"].get("permissions"))
            short = [key for key, level in workflow_needs(workflow).items()
                     if max(have.get(key, 0), have.get("*", 0)) < level]
            self.assertEqual(short, [], f"{rel}: job ci grants less than {workflow} requests")

    def test_each_grant_has_a_why_comment(self):
        for _, rel, text, _ in self.each_template():
            self.assertEqual(grant_lines_without_why(text), [], f"{rel}: grants without a why-comment")

    def test_third_party_actions_pinned_to_sha_with_version_comment(self):
        for _, rel, text, _ in self.each_template():
            self.assertEqual(unpinned_third_party(text), [], f"{rel}: not SHA-pinned with a version comment")


class IdentityLint(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.runner, cls.lint = find_identity_lint()
        cls.copy = copy_repo("v3-callers-")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.copy, ignore_errors=True)

    def setUp(self):
        self.assertIsNotNone(self.lint, "no _self-ci.yml job runs a template-identity lint "
                                        "over templates/, docs/flows/ and the README")

    def lint_in_copy(self, rel, text):
        original = read(rel, self.copy)
        write(rel, text, self.copy)
        try:
            return run([self.runner, self.lint], cwd=self.copy)
        finally:
            write(rel, original, self.copy)

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

    def assert_names_file_and_line(self, out, files, line_numbers, texts):
        self.assertTrue(any(f in out for f in files), f"output names none of {files}:\n{out}")
        by_number = any(re.search(rf"(?<!\d){n}(?!\d)", out) for n in line_numbers)
        by_text = any(t.strip() in out for t in texts)
        self.assertTrue(by_number or by_text, f"output does not show the first differing line:\n{out}")

    def mutate(self, rel, start, body, workflow):
        """Change one character of the `uses:` line of job ci inside `body`."""
        offset = next(k for k, line in enumerate(body) if f"/{workflow}@" in line)
        old = body[offset]
        new = old.replace(f"/{workflow}@", f"/{workflow[:-5]}x.yml@", 1)
        lines = read(rel).splitlines(keepends=True)
        lines[start + offset] = lines[start + offset].replace(old, new, 1)
        return "".join(lines), (offset + 1, start + offset + 1), (old, new)

    def check_one_character_change(self, rel, files, workflow):
        start, body = caller_block(read(rel), workflow) if rel.endswith(".md") else (0, read(rel).splitlines())
        self.assertIsNotNone(start, f"{rel} has no caller block for {workflow}")
        text, numbers, texts = self.mutate(rel, start, body, workflow)
        code, out = self.lint_in_copy(rel, text)
        self.assertNotEqual(code, 0, f"lint passed with a one-character change to the {workflow} caller in {rel}")
        self.assert_names_file_and_line(out, files, numbers, texts)

    def test_fails_on_one_character_change_to_template(self):
        for flow, (workflow, _, _, _) in FLOWS.items():
            files = (template_rel(flow), f"docs/flows/{flow}.md", "README.md")
            self.check_one_character_change(template_rel(flow), files, workflow)

    def test_fails_on_one_character_change_to_docs_caller(self):
        for flow, (workflow, _, _, _) in FLOWS.items():
            self.check_one_character_change(f"docs/flows/{flow}.md", (f"docs/flows/{flow}.md",), workflow)

    def test_fails_on_one_character_change_to_readme_caller(self):
        for workflow, _, _, _ in FLOWS.values():
            self.check_one_character_change("README.md", ("README.md",), workflow)

    def test_fails_when_docs_caller_loses_its_last_line(self):
        for flow, (workflow, _, _, _) in FLOWS.items():
            rel = f"docs/flows/{flow}.md"
            start, body = caller_block(read(rel), workflow)
            self.assertIsNotNone(start, f"{rel} has no caller block for {workflow}")
            lines = read(rel).splitlines(keepends=True)
            del lines[start + len(body) - 1]
            code, out = self.lint_in_copy(rel, "".join(lines))
            self.assertNotEqual(code, 0, f"lint passed with a shortened caller in {rel}:\n{out}")


class Readme(unittest.TestCase):

    def setUp(self):
        self.text = read("README.md")

    def test_no_old_names(self):
        found = [word for word in ("hashira-ops", "static-webapp-deploy", "library_ref") if word in self.text]
        self.assertEqual(found, [], "README.md mentions these")

    def test_hashira_uses_refs_name_skathio_hashira(self):
        refs = re.findall(r"uses:\s*(\S+)", self.text)
        self.assertEqual([r for r in refs if "hashira" in r and not r.startswith("skathio/hashira/")], [])

    def test_one_caller_per_flow(self):
        blocks = [body for lang, _, body in fenced_blocks(self.text) if lang in YAML_LANGS]
        for workflow, _, _, _ in FLOWS.values():
            needle = f"skathio/hashira/.github/workflows/{workflow}@"
            count = sum(1 for body in blocks if any(needle in line for line in body))
            self.assertEqual(count, 1, f"README.md has {count} caller blocks for {workflow}")

    def test_links_catalog_and_migration_guide(self):
        links = re.findall(r"\]\((?:\./)?([^)#\s]+)", self.text)
        self.assertEqual([t for t in (CATALOG, MIGRATION) if t not in links], [], "README.md does not link these")


class Catalog(unittest.TestCase):

    def setUp(self):
        self.assertTrue(os.path.isfile(path(CATALOG)), f"{CATALOG} is missing")
        self.text = read(CATALOG)

    def entries(self):
        return reusable_workflows() + composite_actions()

    def section(self, name):
        _, section = catalog_section(self.text, name)
        self.assertIsNotNone(section, f"{CATALOG} has no heading for {name}")
        return section

    def test_every_entry_has_a_uses_snippet(self):
        def snippet(name):
            kind = f"workflows/{name}" if name.endswith(".yml") else f"actions/{name}"
            return rf"uses:\s*skathio/hashira/\.github/{re.escape(kind)}@(?!main\b)\S+"
        missing = [n for n in self.entries() if not re.search(snippet(n), "\n".join(self.section(n)))]
        self.assertEqual(missing, [], f"{CATALOG}: no uses: snippet for these")

    def test_inputs_match_yaml(self):
        problems = [p for n in self.entries() for p in catalog_input_problems(n, input_rows(self.section(n)))]
        self.assertEqual(problems, [])

    def test_outputs_listed(self):
        missing = [f"{n}.{key}" for n in self.entries() for key in contract_of(n)[1]
                   if key not in first_cells(self.section(n))]
        self.assertEqual(missing, [], f"{CATALOG}: outputs missing")


class CatalogLints(unittest.TestCase):
    """The shape-validate scripts compare the catalog tables with the YAML."""

    SCRIPTS = [os.path.relpath(s, ROOT) for s in sorted(glob.glob(path("tests/*/shape-validate.py")))] + [
        "tests/static-webapp/docs-cross-ref.py"]

    @classmethod
    def setUpClass(cls):
        cls.copy = copy_repo("v3-catalog-")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.copy, ignore_errors=True)

    def scripts_fail(self, catalog_text):
        original = read(CATALOG, self.copy)
        write(CATALOG, catalog_text, self.copy)
        try:
            return any(run(["python3", script], cwd=self.copy)[0] != 0 for script in self.SCRIPTS)
        finally:
            write(CATALOG, original, self.copy)

    def test_scripts_pass_on_the_repo(self):
        failed = [(script, out) for script in self.SCRIPTS for code, out in [run(["python3", script])] if code]
        self.assertEqual(failed, [])

    def first_input_row(self, name):
        """(catalog lines, index of the row of `name`'s first input)."""
        self.assertTrue(os.path.isfile(path(CATALOG)), f"{CATALOG} is missing")
        lines = read(CATALOG).splitlines(keepends=True)
        start, section = catalog_section("".join(lines), name)
        self.assertIsNotNone(section, f"{CATALOG} has no heading for {name}")
        key = next(iter(contract_of(name)[0]))
        row = input_rows(section).get(key)
        self.assertIsNotNone(row, f"{CATALOG}: {name} input {key} missing")
        return lines, next(i for i in range(start, len(lines)) if lines[i].rstrip("\n") == row[2]), key

    def test_missing_input_row_fails(self):
        for name in reusable_workflows() + composite_actions():
            lines, index, key = self.first_input_row(name)
            del lines[index]
            self.assertTrue(self.scripts_fail("".join(lines)),
                            f"no shape-validate script noticed {name}.{key} missing from {CATALOG}")

    def test_extra_input_row_fails(self):
        for name in reusable_workflows() + composite_actions():
            lines, index, key = self.first_input_row(name)
            lines.insert(index + 1, lines[index].replace(key, "x_not_an_input", 1))
            self.assertTrue(self.scripts_fail("".join(lines)),
                            f"no shape-validate script noticed an extra {name} row in {CATALOG}")


class MigrationAndUsage(unittest.TestCase):

    def migration(self):
        self.assertTrue(os.path.isfile(path(MIGRATION)), f"{MIGRATION} is missing")
        return read(MIGRATION)

    def test_lists_exactly_the_reusable_workflows(self):
        self.assertEqual(reusable_workflows(), ["npm-package-ci.yml", "nuget-package-ci.yml", "pages-site.yml", "static-webapp-ci.yml"])

    def test_migration_lists_each_breaking_input_with_a_caller_line(self):
        text = self.migration()
        missing = [n for n in V2_BREAKING_INPUTS if not re.search(rf"(?<![\w-]){n}\s*:", text)]
        self.assertEqual(missing, [], f"{MIGRATION}: no caller line for these inputs")

    def test_migration_says_the_gate_is_on_by_default(self):
        self.assertTrue("quality_gate" in self.migration(), f"{MIGRATION} does not mention quality_gate")

    def test_migration_lists_new_id_token_grant_when_ci_needs_it(self):
        new_grant = any(workflow_needs(w).get("id-token", 0) == LEVEL["write"]
                        for w in ("npm-package-ci.yml", "nuget-package-ci.yml"))
        self.assertFalse(new_grant and "id-token: write" not in self.migration(),
                         f"{MIGRATION} does not list id-token: write")

    def test_usage_says_v2_is_frozen(self):
        text = re.sub(r"\s+", " ", read("docs/usage.md"))
        frozen = r"\bv2\b(?:(?!\bv1\b)[^.]){0,80}\bfrozen\b"
        self.assertTrue(re.search(frozen, text), "docs/usage.md does not say v2 is frozen")


class NoOldNames(unittest.TestCase):

    def test_acceptance_grep_finds_only_the_migration_guide(self):
        proc = subprocess.run(
            'grep -rn "library_ref\\|hashira-ops\\|static-webapp-deploy" '
            "README.md docs templates .github/workflows/*-ci.yml",
            cwd=ROOT, shell=True, capture_output=True, text=True)
        hits = [line for line in proc.stdout.splitlines() if not line.startswith(MIGRATION + ":")]
        self.assertEqual(hits, [])

    def test_no_doc_or_template_pins_main(self):
        files = ["README.md"] + [os.path.relpath(f, ROOT) for f in glob.glob(path("docs/**/*.md"), recursive=True)
                                 + glob.glob(path("templates/*/ci.yml"))]
        hits = [f"{rel}:{i}" for rel in files for i, line in enumerate(read(rel).splitlines(), 1)
                if MAIN_PIN.search(line)]
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
