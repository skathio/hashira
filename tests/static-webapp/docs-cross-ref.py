#!/usr/bin/env python3
"""
Cross-reference check: every `inputs:` entry in
`.github/workflows/static-webapp-ci.yml` appears in the corresponding
markdown input table in `docs/flows/static-webapp.md`, and vice versa.

Also asserts:
  - the workflow declares no `secrets:` block (per phase 4.2 acceptance:
    the static-webapp flow takes no consumer secrets — Pages deploy
    authenticates via OIDC, build is from public source).
  - the first fenced YAML code block inside section 1 of
    `docs/flows/static-webapp.md` (the main caller-workflow snippet) is
    parseable by `yaml.safe_load`.

Acceptance criterion in phase 04 iteration 4.3.

iter 3.3 note: this shim originally also cross-referenced
`static-webapp-deploy.yml`'s `Deploy inputs` table — that reusable
workflow was retired in iter 3.3 (D2 refinement B: deploy converted to
the `pages-deploy` composite, invoked directly by consumers with no
`workflow_call` inputs of its own to cross-reference). The `Deploy
inputs` table in `docs/flows/static-webapp.md` and this check's
corresponding assertions are stale until Phase 4.3 rewrites that doc for
the composite shape — tracked as a Phase 4 follow-up, not closed here
(out of this iteration's declared scope).

Run from repo root: python3 tests/static-webapp/docs-cross-ref.py
"""

import os
import re
import sys

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CI_WF = os.path.join(REPO_ROOT, ".github", "workflows", "static-webapp-ci.yml")
DOC = os.path.join(REPO_ROOT, "docs", "flows", "static-webapp.md")


def fail(msg):
    print(f"docs-cross-ref: FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def load_workflow_inputs_secrets(path):
    with open(path, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    # `on:` is YAML-parsed as the boolean True when unquoted; tolerate both.
    on_block = doc.get("on", doc.get(True)) or {}
    wfc = on_block.get("workflow_call") or {}
    inputs = list((wfc.get("inputs") or {}).keys())
    secrets = list((wfc.get("secrets") or {}).keys())
    return inputs, secrets


ROW_NAME_RE = re.compile(r"^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|")


def parse_table_names_under_heading(md_text, heading_substring):
    r"""Find the first ## or ### heading containing `heading_substring`, then
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
        print(
            f"docs-cross-ref: FAIL: {label}: in workflow YAML but missing from docs table: {only_yaml}",
            file=sys.stderr,
        )
        ok = False
    if only_doc:
        print(
            f"docs-cross-ref: FAIL: {label}: in docs table but missing from workflow YAML: {only_doc}",
            file=sys.stderr,
        )
        ok = False
    if ok:
        print(f"docs-cross-ref: OK  {label}: {sorted(yaml_set)} match")
    return ok


def extract_first_yaml_block_in_section(md_text, section_heading_substring):
    """Extract the first ```yaml ... ``` fenced block under the given ##/###
    heading. Returns the raw block text (without the fences)."""
    lines = md_text.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if (ln.startswith("## ") or ln.startswith("### ")) and section_heading_substring in ln:
            start = i + 1
            break
    if start is None:
        fail(
            f"could not find heading containing '{section_heading_substring}' in {DOC}"
        )
    # Scan forward until next ## heading or end.
    end = len(lines)
    for i in range(start, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break
    # Find the first ```yaml fence inside [start, end).
    fence_open = None
    for i in range(start, end):
        if lines[i].strip().startswith("```yaml"):
            fence_open = i + 1
            break
    if fence_open is None:
        fail(
            f"could not find a ```yaml fenced block under '{section_heading_substring}' in {DOC}"
        )
    fence_close = None
    for i in range(fence_open, end):
        if lines[i].strip() == "```":
            fence_close = i
            break
    if fence_close is None:
        fail(f"unterminated ```yaml fence under '{section_heading_substring}' in {DOC}")
    return "\n".join(lines[fence_open:fence_close])


def main():
    for p in [CI_WF, DOC]:
        if not os.path.isfile(p):
            fail(f"required file not found: {p}")

    ci_inputs, ci_secrets = load_workflow_inputs_secrets(CI_WF)

    # No-secrets assertion (phase 4.2 acceptance).
    if ci_secrets:
        fail(
            f"static-webapp-ci.yml unexpectedly declares secrets: {sorted(ci_secrets)}"
        )
    print("docs-cross-ref: OK  no-secrets: static-webapp-ci.yml declares no secrets")

    with open(DOC, "r", encoding="utf-8") as f:
        md = f.read()

    doc_ci_inputs = parse_table_names_under_heading(md, "CI inputs")

    all_ok = True
    all_ok &= diff("CI inputs", ci_inputs, doc_ci_inputs)

    # Caller-snippet YAML parse — section 1.
    snippet = extract_first_yaml_block_in_section(
        md, "Main caller workflow template"
    )
    try:
        parsed = yaml.safe_load(snippet)
    except yaml.YAMLError as e:
        fail(f"caller-snippet YAML in §1 failed to parse: {e}")
    if not isinstance(parsed, dict) or "jobs" not in parsed:
        fail(
            "caller-snippet YAML in §1 parsed but is not a workflow shape (missing top-level `jobs:`)"
        )
    print(
        f"docs-cross-ref: OK  caller-snippet: §1 fenced YAML parses cleanly; jobs={sorted(parsed['jobs'].keys())}"
    )

    if not all_ok:
        return 1

    print("docs-cross-ref: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
