#!/usr/bin/env python3
"""
Cross-reference check: every `inputs:` entry in
`.github/workflows/nuget-package-publish.yml` (and `nuget-package-ci.yml`)
appears in the corresponding markdown input table in `docs/flows/nuget.md`,
and vice versa. Secrets are checked similarly.

Acceptance criterion in phase 03 iteration 3.3.

Run from repo root: python3 tests/nuget-package-publish/docs-cross-ref.py
"""

import os
import re
import sys

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CI_WF = os.path.join(REPO_ROOT, ".github", "workflows", "nuget-package-ci.yml")
PUB_WF = os.path.join(REPO_ROOT, ".github", "workflows", "nuget-package-publish.yml")
DOC = os.path.join(REPO_ROOT, "docs", "flows", "nuget.md")


def fail(msg):
    print(f"docs-cross-ref: FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def load_workflow_inputs_secrets(path):
    with open(path, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    on_block = doc.get("on", doc.get(True)) or {}
    wfc = on_block.get("workflow_call") or {}
    inputs = list((wfc.get("inputs") or {}).keys())
    secrets = list((wfc.get("secrets") or {}).keys())
    return inputs, secrets


ROW_NAME_RE = re.compile(r"^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|")


def parse_table_names_under_heading(md_text, heading_substring):
    """Find the first ## or ### heading containing `heading_substring`, then
    scan forward until the next ## or ### heading and collect names from
    `| \`name\` | ...` rows."""
    lines = md_text.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if (ln.startswith("### ") or ln.startswith("## ")) and heading_substring in ln:
            start = i + 1
            break
    if start is None:
        fail(f"could not find heading containing '{heading_substring}' in {DOC}")
    names = []
    for ln in lines[start:]:
        if ln.startswith("## ") or ln.startswith("### "):
            break
        m = ROW_NAME_RE.match(ln)
        if m:
            names.append(m.group(1))
    return names


def diff(label, in_yaml, in_doc):
    yaml_set = set(in_yaml)
    doc_set = set(in_doc)
    only_yaml = sorted(yaml_set - doc_set)
    only_doc = sorted(doc_set - yaml_set)
    ok = True
    if only_yaml:
        print(f"docs-cross-ref: FAIL: {label}: in workflow YAML but missing from docs table: {only_yaml}", file=sys.stderr)
        ok = False
    if only_doc:
        print(f"docs-cross-ref: FAIL: {label}: in docs table but missing from workflow YAML: {only_doc}", file=sys.stderr)
        ok = False
    if ok:
        print(f"docs-cross-ref: OK  {label}: {sorted(yaml_set)} match")
    return ok


def main():
    for p in [CI_WF, PUB_WF, DOC]:
        if not os.path.isfile(p):
            fail(f"required file not found: {p}")

    ci_inputs, ci_secrets = load_workflow_inputs_secrets(CI_WF)
    pub_inputs, pub_secrets = load_workflow_inputs_secrets(PUB_WF)

    with open(DOC, "r", encoding="utf-8") as f:
        md = f.read()

    doc_ci_inputs = parse_table_names_under_heading(md, "CI inputs")
    doc_pub_inputs = parse_table_names_under_heading(md, "Publish inputs")
    doc_secrets = parse_table_names_under_heading(md, "Secret table")

    all_ok = True
    all_ok &= diff("CI inputs", ci_inputs, doc_ci_inputs)
    all_ok &= diff("Publish inputs", pub_inputs, doc_pub_inputs)
    # Combined secrets from both workflows (CI half currently has none).
    all_ok &= diff("Secrets (combined)", ci_secrets + pub_secrets, doc_secrets)

    if not all_ok:
        return 1

    print("docs-cross-ref: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
