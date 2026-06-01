#!/usr/bin/env python3
"""
Shape validation for `.github/actions/npm-release/action.yml`.

Acceptance checks (iteration 1.2):
  (a) action.yml parses and is a composite action.
  (b) Every documented input (DOCUMENTED_INPUTS) is declared, with a non-empty
      `description:`; no undocumented inputs (contract surface).
  (c) Declares `released` + `version` outputs.
  (d) Every third-party `uses:` ref is pinned to a 40-char hex SHA (NF2).
  (e) NF4: setup-node step does NOT pass `registry-url` (which would write an
      _authToken line and shadow native OIDC).
  (f) NF5: the semantic-release step sources GITHUB_TOKEN from
      `${{ github.token }}` (composite actions have no `secrets` context).
  (g) M1: a runtime step enforces the npm >= 11.5.1 floor.
  (h) D2/R3: the refreshed plugin set is pinned to exact versions; the retired
      @semantic-release/git + /changelog plugins are NOT installed (D3).

Run from repo root: python3 tests/npm-release/shape-validate.py
"""

import os
import re
import sys

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ACTION_PATH = os.path.join(REPO_ROOT, ".github", "actions", "npm-release", "action.yml")

DOCUMENTED_INPUTS = [
    "node_version",
    "target",
    "prerelease_branches",
    "maintenance_branches",
    "working_directory",
    "x_releaserc_overrides",
]

DOCUMENTED_OUTPUTS = ["released", "version"]

# Exact pins required (D2/R3). Retired plugins must be absent (D3).
REQUIRED_PINS = [
    "semantic-release@25.0.3",
    "@semantic-release/commit-analyzer@13.0.1",
    "@semantic-release/release-notes-generator@14.1.1",
    "@semantic-release/npm@13.1.5",
    "@semantic-release/github@12.0.8",
]
FORBIDDEN_PLUGINS = [
    "@semantic-release/git@",
    "@semantic-release/changelog@",
]

SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def fail(msg):
    print(f"shape-validate: FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def collect_steps(runs):
    steps = runs.get("steps")
    if not isinstance(steps, list):
        fail("`runs.steps` missing or not a list")
    return steps


def main():
    if not os.path.isfile(ACTION_PATH):
        fail(f"action not found at {ACTION_PATH}")

    with open(ACTION_PATH, "r", encoding="utf-8") as f:
        raw = f.read()

    try:
        doc = yaml.safe_load(raw)
    except yaml.YAMLError as e:
        fail(f"YAML parse error: {e}")

    if not isinstance(doc, dict):
        fail("action root is not a mapping")

    runs = doc.get("runs") or {}
    if runs.get("using") != "composite":
        fail(f"action must be `using: composite`; got {runs.get('using')!r}")

    # (b) inputs contract.
    inputs_block = doc.get("inputs") or {}
    if not isinstance(inputs_block, dict):
        fail("`inputs` is not a mapping")
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
        fail(f"inputs missing non-empty description: {no_desc}")

    # (c) outputs.
    outputs_block = doc.get("outputs") or {}
    missing_out = [n for n in DOCUMENTED_OUTPUTS if n not in outputs_block]
    if missing_out:
        fail(f"documented outputs missing: {missing_out}")

    steps = collect_steps(runs)

    # (d) SHA-pin every third-party `uses:`.
    uses_refs = [s["uses"] for s in steps if isinstance(s, dict) and "uses" in s]
    if not uses_refs:
        fail("no `uses:` refs found in composite steps")
    for ref in uses_refs:
        if "@" not in ref:
            fail(f"uses ref '{ref}' has no `@<ref>`")
        _, sha = ref.rsplit("@", 1)
        if not SHA_RE.match(sha):
            fail(f"uses ref '{ref}' is not pinned to a 40-char hex SHA (got '{sha}')")
        print(f"shape-validate: OK  {ref}  (SHA-pinned)")

    # (e) NF4: setup-node must NOT set registry-url.
    setup_node = next(
        (s for s in steps if isinstance(s, dict)
         and isinstance(s.get("uses"), str)
         and s["uses"].startswith("actions/setup-node@")),
        None,
    )
    if setup_node is None:
        fail("no actions/setup-node step found")
    with_block = setup_node.get("with") or {}
    if "registry-url" in with_block:
        fail("NF4 violation: actions/setup-node sets `registry-url` (would write _authToken and shadow native OIDC)")
    print("shape-validate: OK  NF4 — setup-node has no registry-url")

    # (f) NF5: GITHUB_TOKEN from github.token in a step env.
    token_ok = False
    for s in steps:
        if isinstance(s, dict):
            env = s.get("env") or {}
            tok = str(env.get("GITHUB_TOKEN", ""))
            if "github.token" in tok:
                token_ok = True
            if "secrets." in tok:
                fail(f"NF5 violation: GITHUB_TOKEN sourced from secrets context ({tok!r}) — composite actions have no secrets context")
    if not token_ok:
        fail("NF5: no step sources GITHUB_TOKEN from ${{ github.token }}")
    print("shape-validate: OK  NF5 — GITHUB_TOKEN from github.token")

    # Flatten all step `run:` scripts for textual checks.
    all_run = "\n".join(
        s["run"] for s in steps if isinstance(s, dict) and isinstance(s.get("run"), str)
    )

    # (g) M1: npm floor enforced.
    if "11.5.1" not in all_run:
        fail("M1: no npm >= 11.5.1 floor check found in any step")
    print("shape-validate: OK  M1 — npm >= 11.5.1 floor enforced")

    # (h) D2/R3 pins present; D3 forbidden plugins absent.
    for pin in REQUIRED_PINS:
        if pin not in all_run:
            fail(f"D2/R3: required pin '{pin}' not found in install step")
    for bad in FORBIDDEN_PLUGINS:
        if bad in all_run:
            fail(f"D3 violation: tag-driven flow must not install '{bad}'")
    print(f"shape-validate: OK  D2/R3 — {len(REQUIRED_PINS)} pins present; D3 — git/changelog absent")

    print(
        f"shape-validate: PASS ({len(uses_refs)} uses refs SHA-pinned; "
        f"{len(DOCUMENTED_INPUTS)} inputs + {len(DOCUMENTED_OUTPUTS)} outputs; "
        "NF4/NF5/M1/D2/D3 checks green)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
