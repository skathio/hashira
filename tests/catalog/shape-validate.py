#!/usr/bin/env python3
"""
Shape validation for `docs/catalog.md` against the YAML it describes.

Every reusable workflow (`.github/workflows/*.yml` with `on: workflow_call`)
and every composite action (`.github/actions/<name>/action.yml`) must have a
`### <name>` section in the catalog holding:

  (a) an input table (`| Input | Required | Default |`) listing exactly the
      YAML's inputs, each with the YAML's required flag (`yes`/`no`) and,
      for an optional input, the YAML's default (`` `''` `` for empty, `—`
      for a required input);
  (b) an output table (`| Output | ... |`) listing exactly the YAML's
      outputs, and, for a workflow that declares `workflow_call` secrets, a
      secret table (`| Secret | Required | ... |`) listing exactly those,
      each with the YAML's required flag;
  (c) a `uses: skathio/hashira/.github/<workflows|actions>/<name>@<ref>`
      snippet whose ref is not `main`.

A table that says "No inputs." / "No outputs." stands for an empty one.
The entries come from the filesystem, so a new workflow or action without
a catalog section fails here.

Run from repo root:
  python3 tests/catalog/shape-validate.py              # check the catalog
  python3 tests/catalog/shape-validate.py --self-test  # negative cases

Needs python3 and PyYAML. Exits 0 on success, 1 on any mismatch.
"""

import glob
import os
import re
import sys

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CATALOG = os.path.join(REPO_ROOT, "docs", "catalog.md")

ROW = re.compile(r"^\|(.*)\|\s*$")
SEPARATOR = re.compile(r"^\|[\s:|-]+\|\s*$")
NONE_SHOWN = {"—", "-", ""}
# This repo's own deploy workflows. release.yml calls them, so they take `workflow_call`, but no
# consumer does, so they are not catalog entries.
INTERNAL_WORKFLOWS = {"site.yml", "homepage.yml"}


def load(path):
    with open(path, encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def workflow_call(doc):
    on = doc.get("on", doc.get(True)) or {}
    return on.get("workflow_call") if isinstance(on, dict) and "workflow_call" in on else None


def entries(root):
    """(name, kind, inputs, outputs, secrets) for every reusable workflow and action."""
    workflows = [(os.path.basename(path), workflow_call(load(path)))
                 for path in sorted(glob.glob(os.path.join(root, ".github", "workflows", "*.yml")))]
    actions = [(os.path.basename(os.path.dirname(path)), load(path))
               for path in sorted(glob.glob(os.path.join(root, ".github", "actions", "*", "action.yml")))]
    found = [(name, "workflows", spec or {}) for name, spec in workflows
             if spec is not None and name not in INTERNAL_WORKFLOWS]
    found += [(name, "actions", spec) for name, spec in actions]
    return [(name, kind, spec.get("inputs") or {}, spec.get("outputs") or {}, spec.get("secrets") or {})
            for name, kind, spec in found]


def section(lines, name):
    """Lines under the `### <name>` heading up to the next heading of level
    3 or higher, or None."""
    heading = f"### {name}"
    start = next((i for i, line in enumerate(lines) if line.strip() == heading), None)
    if start is None:
        return None
    end = next((i for i in range(start + 1, len(lines)) if re.match(r"^#{1,3}\s", lines[i])), len(lines))
    return lines[start + 1:end]


def cells(line):
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", line.strip()[1:-1])]


def table_rows(lines, start):
    """Rows of cells from `start` while the lines are table rows, and the
    index after the last one."""
    end = next((i for i in range(start, len(lines)) if not ROW.match(lines[i])), len(lines))
    return [cells(line) for line in lines[start:end]], end


def tables(lines):
    """Each table as (lower-cased header cells, rows of cells)."""
    found, i = [], 0
    while i + 1 < len(lines):
        if not (ROW.match(lines[i]) and SEPARATOR.match(lines[i + 1])):
            i += 1
            continue
        rows, end = table_rows(lines, i + 2)
        found.append(([c.lower() for c in cells(lines[i])], rows))
        i = end
    return found


def unquote(text):
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] == "`":
        text = text[1:-1]
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        text = text[1:-1]
    return text


def expected_default(spec):
    value = spec.get("default")
    if isinstance(value, bool):
        return "true" if value else "false"
    return "" if value is None else str(value)


def default_problem(label, spec, cell):
    """The problem with an input's Default cell, or None."""
    if spec.get("required"):
        return None if cell in NONE_SHOWN else f"{label}: required input shows default {cell!r}, expected —"
    wanted = expected_default(spec)
    return None if unquote(cell) == wanted else f"{label}: Default shows {cell!r}, the YAML default is {wanted!r}"


def check_input_row(label, spec, row, req, default):
    """Problems with one input's row: its Required and Default cells."""
    if len(row) <= max(req, default):
        return [f"{label}: the row has too few cells"]
    spec = spec or {}
    expected = "yes" if spec.get("required") else "no"
    problems = [f"{label}: Required shows {row[req]!r}, the YAML says {expected}",
                default_problem(label, spec, row[default])]
    if row[req].lower() == expected:
        problems.pop(0)
    return [p for p in problems if p]


def check_inputs(name, inputs, table):
    if table is None:
        return [] if not inputs else [f"{name}: no `| Input | Required | Default |` table"]
    header, rows = table
    req, default = header.index("required"), header.index("default")
    shown = {unquote(row[0]): row for row in rows}
    problems = [f"{name}: input `{key}` is in the YAML but not in the catalog"
                for key in inputs if key not in shown]
    problems += [f"{name}: catalog row `{key}` is not an input in the YAML"
                 for key in shown if key not in inputs]
    for key in (k for k in inputs if k in shown):
        problems += check_input_row(f"{name}.{key}", inputs[key], shown[key], req, default)
    return problems


def check_outputs(name, outputs, table):
    if table is None:
        return [] if not outputs else [f"{name}: no `| Output | ... |` table"]
    shown = {unquote(row[0]) for row in table[1]}
    return ([f"{name}: output `{key}` is in the YAML but not in the catalog" for key in outputs if key not in shown]
            + [f"{name}: catalog output `{key}` is not an output in the YAML" for key in shown if key not in outputs])


def secret_required_problem(label, spec, row, req):
    """The problem with a secret row's Required cell, or None."""
    expected = "yes" if (spec or {}).get("required") else "no"
    shown = row[req] if len(row) > req else ""
    return None if shown.lower() == expected else f"{label}: secret Required shows {shown!r}, the YAML says {expected}"


def check_secrets(name, secrets, table):
    if table is None:
        return [] if not secrets else [f"{name}: no `| Secret | Required | ... |` table"]
    header, rows = table
    shown = {unquote(row[0]): row for row in rows}
    problems = ([f"{name}: secret `{key}` is in the YAML but not in the catalog" for key in secrets if key not in shown]
                + [f"{name}: catalog secret `{key}` is not a secret in the YAML" for key in shown if key not in secrets])
    if "required" not in header:
        return problems + [f"{name}: the secret table has no Required column"]
    req = header.index("required")
    found = (secret_required_problem(f"{name}.{key}", secrets[key], shown[key], req) for key in secrets if key in shown)
    return problems + [p for p in found if p]


def check_entry(lines, name, kind, inputs, outputs, secrets):
    body = section(lines, name)
    if body is None:
        return [f"{name}: no `### {name}` section in docs/catalog.md"]
    found = tables(body)
    input_table = next((t for t in found if "required" in t[0] and "default" in t[0]), None)
    output_table = next((t for t in found if t[0] and t[0][0] == "output"), None)
    secret_table = next((t for t in found if t[0] and t[0][0] == "secret"), None)
    snippet = re.compile(rf"uses:\s*skathio/hashira/\.github/{kind}/{re.escape(name)}@(\S+)")
    refs = [m.group(1) for m in map(snippet.search, body) if m]
    problems = (check_inputs(name, inputs, input_table) + check_outputs(name, outputs, output_table)
                + check_secrets(name, secrets, secret_table))
    if not refs:
        problems.append(f"{name}: no `uses: skathio/hashira/.github/{kind}/{name}@<ref>` snippet")
    problems += [f"{name}: snippet pins @main" for ref in refs if ref == "main"]
    return problems


def validate(catalog_text, root):
    lines = catalog_text.splitlines()
    return [p for entry in entries(root) for p in check_entry(lines, *entry)]


def self_test():
    """Mutate the real catalog in memory; each mutation must fail."""
    with open(CATALOG, encoding="utf-8") as handle:
        text = handle.read()
    if validate(text, REPO_ROOT):
        print("catalog shape-validate --self-test: FAIL: the real catalog does not pass", file=sys.stderr)
        return 1
    cases = {
        "input row removed": (text.replace("| `node_version` | no | `20` |\n", "", 1), "node_version` is in the YAML"),
        "extra input row": (text.replace("| `level` | no | `strict` |\n",
                                         "| `level` | no | `strict` |\n| `x_bogus` | no | `''` |\n", 1),
                            "`x_bogus` is not an input"),
        "wrong default": (text.replace("| `scan_disable` | no | `codeql` |",
                                       "| `scan_disable` | no | `codeql,actionlint` |", 1), "scan_disable: Default shows"),
        "wrong required": (text.replace("| `version` | yes | — |", "| `version` | no | — |", 1), "version: Required shows"),
        "output removed": (text.replace("| `page_url` |", "| `page_urls` |", 1), "output `page_url` is in the YAML"),
        "section removed": (text.replace("### quality-gate\n", "### quality gate\n", 1), "no `### quality-gate` section"),
        "secret row removed": (text.replace("| `build_token` | no |", "| `build_tokens` | no |", 1),
                               "secret `build_token` is in the YAML"),
        "secret required flag": (text.replace("| `build_token` | no |", "| `build_token` | yes |", 1),
                                 "build_token: secret Required shows"),
        "snippet at main": (text.replace("actions/scan-suite@v3", "actions/scan-suite@main", 1), "snippet pins @main"),
    }
    failures = []
    for case, (mutated, marker) in cases.items():
        if mutated == text:
            failures.append(f"{case}: the mutation did not apply; update this self-test")
            continue
        problems = validate(mutated, REPO_ROOT)
        if not any(marker in p for p in problems):
            failures.append(f"{case}: expected a problem containing {marker!r}, got {problems}")
    for failure in failures:
        print(f"catalog shape-validate --self-test: FAIL: {failure}", file=sys.stderr)
    if failures:
        return 1
    print(f"catalog shape-validate --self-test: PASS ({len(cases)} mutations each failed)")
    return 0


def main(argv):
    if "--self-test" in argv:
        return self_test()
    if not os.path.isfile(CATALOG):
        print("catalog shape-validate: FAIL: docs/catalog.md is missing", file=sys.stderr)
        return 1
    with open(CATALOG, encoding="utf-8") as handle:
        problems = validate(handle.read(), REPO_ROOT)
    for problem in problems:
        print(f"catalog shape-validate: FAIL: {problem}", file=sys.stderr)
    if problems:
        return 1
    print(f"catalog shape-validate: PASS ({len(entries(REPO_ROOT))} workflows and actions match docs/catalog.md)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
