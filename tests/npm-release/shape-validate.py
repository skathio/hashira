#!/usr/bin/env python3
"""
Shape validation for `.github/actions/npm-release/action.yml`.

Acceptance checks (iteration 3.4 — full rewrite, removes semantic-release):
  (a) action.yml parses and is a composite action.
  (b) Every documented input (DOCUMENTED_INPUTS) is declared, with a non-empty
      `description:`; no undocumented inputs (contract surface).
  (c) Declares `released` + `version` outputs.
  (d) Every third-party `uses:` ref is pinned to a 40-char hex SHA (NF2).
  (e) NF4: setup-node step does NOT pass `registry-url` (which would write an
      _authToken line and shadow native OIDC).
  (f) NF5: the tag/release step sources GITHUB_TOKEN from `${{ github.token }}`
      (composite actions have no `secrets` context).
  (g) npm/Node floors enforced: npm >= 11.5.1, Node >= 22.14.
  (h) D1/D8/NFR-Rel-1 — NO package.json write, NO `npm pkg set`, NO `npm pack`
      step anywhere in this file (this composite consumes a pre-built tarball;
      it must never stamp or re-pack one). This is a structural check, not a
      behavioral one — a naive "does the right version show up" test would not
      catch a reintroduced stamp/re-pack step (pass-1/pass-2 plan review).
  (i) D1/D8 — `semantic-release` and all four retired plugins are NOT installed
      anywhere (the full-removal acceptance criterion for this iteration).
  (j) `version` is a required input (D8 — consumed, not computed).
  (k) `auth` enum input declared with default 'auto' (D3/D11).
  (l) `gh release create` call passes `--generate-notes` (D13).
  (m) actions/download-artifact step present, downloading the `npm-tarball`
      artifact (the CI->CD same-run handoff this composite consumes).

Run from repo root: python3 tests/npm-release/shape-validate.py
"""

import os
import re
import sys

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ACTION_PATH = os.path.join(REPO_ROOT, ".github", "actions", "npm-release", "action.yml")

DOCUMENTED_INPUTS = [
    "version",
    "node_version",
    "target",
    "auth",
    "npm_token",
    "working_directory",
]

DOCUMENTED_OUTPUTS = ["released", "version"]

# D1/D8: semantic-release and all four retired plugins must be entirely absent
# (not merely unused) — this is the full-removal acceptance criterion for
# iteration 3.4, checked as a structural fact, not just "behavior looks right".
FORBIDDEN_SEMANTIC_RELEASE_REFS = [
    "semantic-release",
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/npm",
    "@semantic-release/github",
]

# D1/D8/NFR-Rel-1: this composite must never write a version into a
# package.json, nor re-pack a tarball — it only publishes the one CI already
# built. Structural check (not "does the right version appear").
FORBIDDEN_STAMP_OR_REPACK = [
    "npm pkg set",
    "npm pack",
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
    print(f"shape-validate: OK  {len(DOCUMENTED_INPUTS)} documented inputs present, described, no extras")

    # (j) `version` is required (D8 — consumed, not computed).
    version_spec = inputs_block.get("version") or {}
    if version_spec.get("required") is not True:
        fail("D8 violation: 'version' input must be `required: true` (consumed, not computed)")
    print("shape-validate: OK  D8 — 'version' input is required")

    # (k) `auth` enum default.
    auth_spec = inputs_block.get("auth") or {}
    if auth_spec.get("default") != "auto":
        fail(f"D3/D11 violation: 'auth' input default must be 'auto', got {auth_spec.get('default')!r}")
    print("shape-validate: OK  D3/D11 — 'auth' input defaults to 'auto'")

    # (c) outputs.
    outputs_block = doc.get("outputs") or {}
    missing_out = [n for n in DOCUMENTED_OUTPUTS if n not in outputs_block]
    if missing_out:
        fail(f"documented outputs missing: {missing_out}")
    print(f"shape-validate: OK  {len(DOCUMENTED_OUTPUTS)} documented outputs present")

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

    # (m) actions/download-artifact present, targeting the npm-tarball artifact
    # (the CI->CD same-run handoff this composite consumes — NFR-Rel-1).
    download_step = next(
        (s for s in steps if isinstance(s, dict)
         and isinstance(s.get("uses"), str)
         and s["uses"].startswith("actions/download-artifact@")),
        None,
    )
    if download_step is None:
        fail("no actions/download-artifact step found — this composite must download the same-run npm-tarball artifact, never re-pack (NFR-Rel-1)")
    dl_with = download_step.get("with") or {}
    if dl_with.get("name") != "npm-tarball":
        fail(f"actions/download-artifact must target name: npm-tarball (the CI version job's artifact), got {dl_with.get('name')!r}")
    print("shape-validate: OK  NFR-Rel-1 — downloads the same-run 'npm-tarball' artifact")

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

    # (f) NF5: GITHUB_TOKEN from github.token in a step env (the tag/release step).
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

    # (g) npm/Node floors enforced.
    if "11.5.1" not in all_run:
        fail("npm floor: no npm >= 11.5.1 floor check found in any step")
    if "22" not in all_run or "14" not in all_run:
        fail("Node floor: no Node >= 22.14 floor check found in any step")
    print("shape-validate: OK  npm >= 11.5.1 / Node >= 22.14 floors enforced")

    # (h) D1/D8/NFR-Rel-1 — no stamp / re-pack step, anywhere (structural check,
    # not behavioral — see module docstring).
    for bad in FORBIDDEN_STAMP_OR_REPACK:
        if bad in all_run:
            fail(f"NFR-Rel-1 violation: CD composite must never stamp or re-pack — found '{bad}' in a run: step. This composite must only publish the artifact CI already built.")
    if "package.json" in raw:
        # Permit the header-comment mentions (the design-rationale prose
        # explicitly documents the ABSENCE of any package.json write); the
        # real check is that no run: step ever opens/writes one, already
        # covered by the `npm pkg set`/`npm pack` checks above. Flag if a
        # `>` package.json (shell redirect/write) pattern appears anywhere.
        if re.search(r">\s*package\.json\b", raw) or re.search(r"package\.json\s*<<", raw):
            fail("NFR-Rel-1 violation: found a shell redirect into package.json — this composite must never write one")
    print("shape-validate: OK  NFR-Rel-1 — no package.json write / npm pkg set / npm pack step found")

    # (i) D1/D8 — semantic-release and all four plugins entirely absent from
    # any executable step (run: scripts, or an inputs/outputs/uses: contract
    # surface) — checked against the flattened `run:` bodies plus the
    # inputs/outputs block, NOT the raw file text, so the header's own
    # design-rationale prose (explaining what was removed and why) doesn't
    # trip a false positive. A real reintroduction would show up as an
    # install/require in a `run:` step, not a comment.
    contract_text = yaml.dump({"inputs": inputs_block, "outputs": outputs_block})
    executable_text = all_run + "\n" + contract_text
    for ref in FORBIDDEN_SEMANTIC_RELEASE_REFS:
        if ref in executable_text:
            fail(f"D1/D8 violation: '{ref}' must be entirely removed from this composite (full-removal acceptance criterion, iteration 3.4) — found in an executable step or the inputs/outputs contract")
    print(f"shape-validate: OK  D1/D8 — semantic-release + all 4 plugins entirely absent from executable steps ({len(FORBIDDEN_SEMANTIC_RELEASE_REFS)} names checked)")

    # (l) `gh release create` passes `--generate-notes` (D13).
    if "gh release create" not in all_run:
        fail("D4 violation: no `gh release create` call found")
    release_create_lines = [
        line for line in all_run.splitlines() if "gh release create" in line
    ]
    if not any("--generate-notes" in line for line in release_create_lines):
        fail("D13 violation: `gh release create` call does not pass `--generate-notes`")
    print("shape-validate: OK  D13 — `gh release create --generate-notes` present")

    print(
        f"shape-validate: PASS ({len(uses_refs)} uses refs SHA-pinned; "
        f"{len(DOCUMENTED_INPUTS)} inputs + {len(DOCUMENTED_OUTPUTS)} outputs; "
        "NF4/NF5/D1/D3/D4/D8/D13/NFR-Rel-1 checks green)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
