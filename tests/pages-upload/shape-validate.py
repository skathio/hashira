#!/usr/bin/env python3
"""
Shape validation for `.github/actions/pages-upload/action.yml`.

Per phase 4.1 acceptance: this shim validates the YAML structure of the
composite action when the runtime smoke (`pages-upload-shape-smoke` in
`_self-ci.yml`) is not sufficient. The runtime smoke exercises the
autodetect + summary path via the `HASHIRA_PAGES_UPLOAD_DRY_RUN=1`
override, which skips the third-party upload step; this shim provides
the complementary static check.

Assertions:
  (a) The action references `actions/upload-pages-artifact@<SHA>`.
  (b) The SHA is a 40-char hex pin AND the immediately-preceding line is
      a `# v<x.y.z>` comment (NF2: SHA-pin + human-readable version).
  (c) The action declares the documented inputs (`path`, `artifact_name`,
      `retention_days`) with non-empty descriptions (D10).
  (d) The action does NOT itself set top-level `permissions:` (composite
      actions can't, but we assert the YAML doesn't accidentally carry a
      placeholder — the requirement is documented in the header instead
      per the `## Required caller permissions` block).
  (e) A resolve step writes `resolved_path` and `detection_mode` to
      `${GITHUB_OUTPUT}` (proves the autodetect path is wired through to
      outputs, not just printed to summary).

Run from repo root: python3 tests/pages-upload/shape-validate.py
"""

import os
import re
import sys

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ACTION_PATH = os.path.join(REPO_ROOT, ".github", "actions", "pages-upload", "action.yml")

DOCUMENTED_INPUTS = ["path", "artifact_name", "retention_days"]
THIRD_PARTY_REF_PREFIX = "actions/upload-pages-artifact@"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
VERSION_COMMENT_RE = re.compile(r"\bv\d+\.\d+\.\d+\b")


def fail(msg):
    print(f"shape-validate: FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def main():
    if not os.path.isfile(ACTION_PATH):
        fail(f"action.yml not found at {ACTION_PATH}")

    with open(ACTION_PATH, "r", encoding="utf-8") as f:
        raw = f.read()

    try:
        doc = yaml.safe_load(raw)
    except yaml.YAMLError as e:
        fail(f"YAML parse error: {e}")

    if not isinstance(doc, dict):
        fail("action.yml root is not a mapping")

    # (c) Inputs with non-empty descriptions.
    inputs_block = doc.get("inputs") or {}
    if not isinstance(inputs_block, dict):
        fail("`inputs:` is not a mapping")
    missing = [n for n in DOCUMENTED_INPUTS if n not in inputs_block]
    if missing:
        fail(f"documented inputs missing: {missing}")
    extra = [n for n in inputs_block if n not in DOCUMENTED_INPUTS]
    if extra:
        fail(f"action declares inputs not in the manifest: {extra}")
    no_desc = [
        n for n, spec in inputs_block.items()
        if not (
            isinstance(spec, dict)
            and isinstance(spec.get("description"), str)
            and spec["description"].strip()
        )
    ]
    if no_desc:
        fail(f"inputs missing non-empty description (D10): {no_desc}")

    # (d) Composite-action YAML should not carry a top-level `permissions:`.
    if "permissions" in doc:
        fail(
            "action.yml carries a top-level `permissions:` block; composite "
            "actions cannot grant permissions — they must be granted by the "
            "calling workflow's job (documented in the `## Required caller "
            "permissions` header block)."
        )

    # (a) + (b) Third-party ref + SHA pin + version comment.
    # Walk the raw lines so we can verify the "comment on previous line"
    # convention (NF2). YAML loaders strip comments.
    lines = raw.splitlines()
    found_ref = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if THIRD_PARTY_REF_PREFIX in stripped:
            found_ref = True
            # Extract the SHA after the @.
            m = re.search(
                r"actions/upload-pages-artifact@([0-9a-fA-F]{40})\b",
                stripped,
            )
            if not m:
                fail(
                    f"reference to upload-pages-artifact on line {i+1} is not "
                    f"pinned to a 40-char hex SHA: {stripped!r}"
                )
            sha = m.group(1)
            if not SHA_RE.match(sha):
                fail(f"SHA on line {i+1} is not lowercase hex: {sha}")
            # Look upward through comment / blank lines for the version comment.
            version_seen = False
            j = i - 1
            while j >= 0:
                prev = lines[j].strip()
                if prev == "":
                    j -= 1
                    continue
                if prev.startswith("#"):
                    if VERSION_COMMENT_RE.search(prev):
                        version_seen = True
                    break
                # Hit a non-comment, non-blank line — stop searching.
                break
            if not version_seen:
                fail(
                    f"reference to upload-pages-artifact on line {i+1} is not "
                    f"preceded by a `# v<x.y.z>` comment (NF2)."
                )

    if not found_ref:
        fail(
            "action does not reference actions/upload-pages-artifact — the "
            "action's whole purpose is to wrap that upstream action."
        )

    # (e) Resolve step writes outputs.
    runs = doc.get("runs") or {}
    steps = (runs.get("steps") if isinstance(runs, dict) else None) or []
    if not isinstance(steps, list):
        fail("`runs.steps` is not a sequence")

    found_resolve_output = False
    for step in steps:
        if not isinstance(step, dict):
            continue
        if step.get("id") != "resolve":
            continue
        run_block = step.get("run", "")
        if not isinstance(run_block, str):
            continue
        if (
            "resolved_path=" in run_block
            and "detection_mode=" in run_block
            and "GITHUB_OUTPUT" in run_block
        ):
            found_resolve_output = True
            break
    if not found_resolve_output:
        fail(
            "no resolve step writes `resolved_path` + `detection_mode` to "
            "`${GITHUB_OUTPUT}` — the autodetect path is not exposed as an "
            "output."
        )

    print(
        f"shape-validate: PASS (upload-pages-artifact SHA-pinned with "
        f"version comment; {len(DOCUMENTED_INPUTS)} inputs all present with "
        "non-empty descriptions; no top-level permissions; resolve step "
        "wires outputs.)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
