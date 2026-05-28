#!/usr/bin/env python3
"""
Shape validation for `.github/actions/pages-deploy/action.yml`.

Per phase 4.1 acceptance: this shim is the PRIMARY validation for
`pages-deploy` because the action wraps `actions/deploy-pages`, which
requires GitHub Pages to be enabled on the target repo to function.
The library repo deliberately does NOT enable Pages on itself (per phase
4.1 scope: "no real Pages deploy from the library"). The runtime
behavior is verified by the user post-v1 when they wire a real static-
webapp consumer.

Assertions:
  (a) The action references `actions/deploy-pages@<SHA>`.
  (b) The SHA is a 40-char hex pin AND the immediately-preceding line is
      a `# v<x.y.z>` comment (NF2: SHA-pin + human-readable version).
  (c) The action does NOT itself set top-level `permissions:` (composite
      actions can't; the requirement is documented in the header's
      `## Required caller permissions` block instead).
  (d) A summary step writes the deployed URL to `${GITHUB_STEP_SUMMARY}`
      using the `page_url` output from the deploy step (the deployed-URL
      observability contract per the phase file).
  (e) The action declares exactly the documented input (`artifact_name`)
      with a non-empty description (D10).

Run from repo root: python3 tests/pages-deploy/shape-validate.py
"""

import os
import re
import sys

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ACTION_PATH = os.path.join(REPO_ROOT, ".github", "actions", "pages-deploy", "action.yml")

DOCUMENTED_INPUTS = ["artifact_name"]
THIRD_PARTY_REF_PREFIX = "actions/deploy-pages@"
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

    # (e) Inputs.
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

    # (c) No top-level permissions.
    if "permissions" in doc:
        fail(
            "action.yml carries a top-level `permissions:` block; composite "
            "actions cannot grant permissions — they must be granted by the "
            "calling workflow's job (documented in the `## Required caller "
            "permissions` header block)."
        )

    # (a) + (b) Third-party ref + SHA pin + version comment (line-level).
    lines = raw.splitlines()
    found_ref = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if THIRD_PARTY_REF_PREFIX in stripped:
            found_ref = True
            m = re.search(
                r"actions/deploy-pages@([0-9a-fA-F]{40})\b",
                stripped,
            )
            if not m:
                fail(
                    f"reference to deploy-pages on line {i+1} is not pinned "
                    f"to a 40-char hex SHA: {stripped!r}"
                )
            sha = m.group(1)
            if not SHA_RE.match(sha):
                fail(f"SHA on line {i+1} is not lowercase hex: {sha}")
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
                break
            if not version_seen:
                fail(
                    f"reference to deploy-pages on line {i+1} is not preceded "
                    f"by a `# v<x.y.z>` comment (NF2)."
                )

    if not found_ref:
        fail(
            "action does not reference actions/deploy-pages — the action's "
            "whole purpose is to wrap that upstream action."
        )

    # (d) Summary step uses page_url.
    runs = doc.get("runs") or {}
    steps = (runs.get("steps") if isinstance(runs, dict) else None) or []
    if not isinstance(steps, list):
        fail("`runs.steps` is not a sequence")

    found_summary_step = False
    for step in steps:
        if not isinstance(step, dict):
            continue
        run_block = step.get("run", "")
        env_block = step.get("env", {}) or {}
        if not isinstance(run_block, str):
            continue
        # Look for a step that references the deploy step's page_url AND
        # appends to GITHUB_STEP_SUMMARY.
        env_uses_page_url = any(
            isinstance(v, str) and "steps.deploy.outputs.page_url" in v
            for v in env_block.values()
        )
        inline_uses_page_url = "steps.deploy.outputs.page_url" in run_block
        if (
            "GITHUB_STEP_SUMMARY" in run_block
            and (env_uses_page_url or inline_uses_page_url)
        ):
            found_summary_step = True
            break
    if not found_summary_step:
        fail(
            "no step appends the deploy step's `page_url` output to "
            "`${GITHUB_STEP_SUMMARY}` — the deployed-URL observability "
            "contract (phase 4.1) is not met."
        )

    print(
        f"shape-validate: PASS (deploy-pages SHA-pinned with version "
        f"comment; {len(DOCUMENTED_INPUTS)} input present with non-empty "
        "description; no top-level permissions; summary step emits "
        "page_url.)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
