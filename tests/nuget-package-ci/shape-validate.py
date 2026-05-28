#!/usr/bin/env python3
"""
Shape validation for `.github/workflows/nuget-package-ci.yml`.

Acceptance checks per phase 3.2:
  (a) Every `uses:` ref in the workflow either:
      - starts with `./.hashira/.github/actions/<name>` and the
        corresponding `.github/actions/<name>/action.yml` exists in this
        repo (D14 library-self-checkout pattern), OR
      - starts with `./` and points to an existing path in this repo
        (legacy/library-self-CI shape), OR
      - is a third-party ref pinned to a 40-char hex SHA.
  (b) Every documented input (in DOCUMENTED_INPUTS) appears in the
      workflow's `on.workflow_call.inputs` block.
  (c) Workflow-level `permissions:` is `{}` (deny-all per NF6).
  (d) Every input has a non-empty `description:` (D10 contract surface
      per iter-2.2 Minor #2 fix).

Run from repo root: python3 tests/nuget-package-ci/shape-validate.py
Exits 0 on success; non-zero with a clear error otherwise.

Note: this duplicates ~40 lines from `tests/npm-package-ci/shape-validate.py`
intentionally — extracted only after a third shim appears (rule-of-three).
Two copies is cheaper to maintain than a premature helper module.
"""

import os
import re
import sys

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORKFLOW_PATH = os.path.join(REPO_ROOT, ".github", "workflows", "nuget-package-ci.yml")

DOCUMENTED_INPUTS = [
    "dotnet_version",
    "project_path",
    "test_filter",
    "coverage_path",
    "scan_disable",
    "library_ref",
]

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
HASHIRA_PREFIX = "./.hashira/.github/actions/"


def fail(msg):
    print(f"shape-validate: FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def collect_uses(node, acc):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "uses" and isinstance(value, str):
                acc.append(value)
            else:
                collect_uses(value, acc)
    elif isinstance(node, list):
        for item in node:
            collect_uses(item, acc)


def validate_uses_ref(ref):
    if ref.startswith(HASHIRA_PREFIX):
        relative = ref[len(HASHIRA_PREFIX):]
        candidate_dir = os.path.join(REPO_ROOT, ".github", "actions", relative)
        candidate_yml = os.path.join(candidate_dir, "action.yml")
        candidate_yaml = os.path.join(candidate_dir, "action.yaml")
        if os.path.isdir(candidate_dir) and (
            os.path.isfile(candidate_yml) or os.path.isfile(candidate_yaml)
        ):
            return True, "D14 library-self-checkout ref present"
        return False, (
            f"D14 ref '{ref}' does not resolve to "
            f".github/actions/{relative}/action.yml under {REPO_ROOT}"
        )
    if ref.startswith("./"):
        candidate_dir = os.path.join(REPO_ROOT, ref[2:])
        candidate_yml = os.path.join(candidate_dir, "action.yml")
        candidate_yaml = os.path.join(candidate_dir, "action.yaml")
        if os.path.isdir(candidate_dir) and (
            os.path.isfile(candidate_yml) or os.path.isfile(candidate_yaml)
        ):
            return True, "local action present"
        return False, f"local ref '{ref}' does not resolve to a directory with action.yml under {REPO_ROOT}"
    if "@" not in ref:
        return False, f"third-party ref '{ref}' has no `@<ref>`"
    _, sha = ref.rsplit("@", 1)
    if not SHA_RE.match(sha):
        return False, f"third-party ref '{ref}' is not pinned to a 40-char hex SHA (got '{sha}')"
    return True, "SHA-pinned"


def main():
    if not os.path.isfile(WORKFLOW_PATH):
        fail(f"workflow not found at {WORKFLOW_PATH}")

    with open(WORKFLOW_PATH, "r", encoding="utf-8") as f:
        raw = f.read()

    try:
        doc = yaml.safe_load(raw)
    except yaml.YAMLError as e:
        fail(f"YAML parse error: {e}")

    if not isinstance(doc, dict):
        fail("workflow root is not a mapping")

    # PyYAML parses the bare `on:` key as Python True (boolean). Accept either.
    on_block = doc.get("on", doc.get(True))
    if not isinstance(on_block, dict):
        fail("`on:` block missing or not a mapping")
    workflow_call = on_block.get("workflow_call")
    if not isinstance(workflow_call, dict):
        fail("`on.workflow_call` missing or not a mapping (expected for a reusable workflow)")
    inputs_block = workflow_call.get("inputs") or {}
    if not isinstance(inputs_block, dict):
        fail("`on.workflow_call.inputs` is not a mapping")

    # Check (b): every documented input is declared.
    missing_inputs = [name for name in DOCUMENTED_INPUTS if name not in inputs_block]
    if missing_inputs:
        fail(f"documented inputs missing from workflow: {missing_inputs}")
    extra_inputs = [name for name in inputs_block if name not in DOCUMENTED_INPUTS]
    if extra_inputs:
        fail(
            f"workflow declares inputs not in the manifest: {extra_inputs} "
            "(if intentional, update DOCUMENTED_INPUTS in this shim)"
        )

    # Check (d): non-empty descriptions per D10 contract surface.
    no_desc = [
        name for name, spec in inputs_block.items()
        if not (
            isinstance(spec, dict)
            and isinstance(spec.get("description"), str)
            and spec["description"].strip()
        )
    ]
    if no_desc:
        fail(f"inputs missing non-empty description (D10 contract surface): {no_desc}")

    # Check (c): workflow-level permissions deny-all baseline (NF6).
    perms = doc.get("permissions")
    if perms != {} and perms != "{}":
        fail(f"workflow-level `permissions:` must be `{{}}` (deny-all baseline per NF6); got {perms!r}")

    # Check (a): every `uses:` ref is valid.
    uses_refs = []
    collect_uses(doc.get("jobs", {}), uses_refs)
    if not uses_refs:
        fail("no `uses:` refs found in workflow jobs (expected at least the checkout pin)")

    errors = []
    for ref in uses_refs:
        ok, reason = validate_uses_ref(ref)
        if not ok:
            errors.append(reason)
        else:
            print(f"shape-validate: OK  {ref}  ({reason})")

    if errors:
        for err in errors:
            print(f"shape-validate: FAIL: {err}", file=sys.stderr)
        return 1

    print(
        f"shape-validate: PASS ({len(uses_refs)} uses refs; "
        f"{len(DOCUMENTED_INPUTS)} documented inputs all present with non-empty descriptions)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
