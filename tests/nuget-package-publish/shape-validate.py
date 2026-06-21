#!/usr/bin/env python3
"""
Shape validation for `.github/workflows/nuget-package-publish.yml`.

Acceptance check per phase 3.3:
  (a) Every `uses:` ref in the workflow either:
      - starts with `./.hashira/.github/actions/<name>` (D14
        library-self-checkout pattern) and the corresponding
        `.github/actions/<name>/action.yml` exists in this repo, OR
      - starts with `./` and points to an existing path in this repo, OR
      - is a third-party ref pinned to a 40-char hex SHA.
  (b) Every documented input (in DOCUMENTED_INPUTS) appears in the
      workflow's `on.workflow_call.inputs` block; symmetric check
      rejects undocumented inputs.
  (c) Every input has a non-empty `description:` (D10 contract surface).
  (d) Every documented secret appears; secrets carry non-empty
      `description:`.
  (e) Workflow-level `permissions:` is `{}` (NF6 deny-all baseline).
  (f) The `pack-and-push` job declares
      `environment: ${{ inputs.environment_name }}` (the gate per D13).
  (g) The `preflight` job does NOT declare `environment:`
      (iter-2.3 reviewer Minor #2 carry-over — preflight is
      pre-gate and must run unconditionally).

Run from repo root: python3 tests/nuget-package-publish/shape-validate.py
"""

import os
import re
import sys

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORKFLOW_PATH = os.path.join(REPO_ROOT, ".github", "workflows", "nuget-package-publish.yml")

DOCUMENTED_INPUTS = [
    "dotnet_version",
    "project_path",
    "target",
    "prerelease_identifier",
    "version_increment",
    "environment_name",
    "library_ref",
    "nuget_user",
]

DOCUMENTED_SECRETS = ["NUGET_API_KEY"]

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

    on_block = doc.get("on", doc.get(True))
    if not isinstance(on_block, dict):
        fail("`on:` block missing or not a mapping")
    workflow_call = on_block.get("workflow_call")
    if not isinstance(workflow_call, dict):
        fail("`on.workflow_call` missing or not a mapping")

    # Inputs check.
    inputs_block = workflow_call.get("inputs") or {}
    if not isinstance(inputs_block, dict):
        fail("`on.workflow_call.inputs` is not a mapping")
    missing_inputs = [n for n in DOCUMENTED_INPUTS if n not in inputs_block]
    if missing_inputs:
        fail(f"documented inputs missing from workflow: {missing_inputs}")
    extra_inputs = [n for n in inputs_block if n not in DOCUMENTED_INPUTS]
    if extra_inputs:
        fail(f"workflow declares inputs not in the manifest: {extra_inputs}")
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

    # Secrets check.
    secrets_block = workflow_call.get("secrets") or {}
    if not isinstance(secrets_block, dict):
        fail("`on.workflow_call.secrets` is not a mapping")
    missing_secrets = [n for n in DOCUMENTED_SECRETS if n not in secrets_block]
    if missing_secrets:
        fail(f"documented secrets missing from workflow: {missing_secrets}")
    extra_secrets = [n for n in secrets_block if n not in DOCUMENTED_SECRETS]
    if extra_secrets:
        fail(f"workflow declares secrets not in the manifest: {extra_secrets}")
    no_secret_desc = [
        n for n, spec in secrets_block.items()
        if not (
            isinstance(spec, dict)
            and isinstance(spec.get("description"), str)
            and spec["description"].strip()
        )
    ]
    if no_secret_desc:
        fail(f"secrets missing non-empty description (D10): {no_secret_desc}")

    # Workflow-level deny-all.
    perms = doc.get("permissions")
    if perms != {} and perms != "{}":
        fail(f"workflow-level `permissions:` must be `{{}}` (NF6); got {perms!r}")

    # pack-and-push job: environment gate (D13).
    jobs = doc.get("jobs") or {}
    pap = jobs.get("pack-and-push")
    if not isinstance(pap, dict):
        fail("missing `pack-and-push` job")
    env_decl = pap.get("environment")
    if not env_decl:
        fail("pack-and-push job missing `environment:` declaration (D13 gate)")
    if "${{ inputs.environment_name }}" not in str(env_decl):
        fail(
            f"pack-and-push `environment:` must reference inputs.environment_name "
            f"(D13); got {env_decl!r}"
        )

    # preflight job: must NOT have environment: (iter-2.3 Minor #2 carry-over).
    preflight = jobs.get("preflight")
    if not isinstance(preflight, dict):
        fail("missing `preflight` job")
    if "environment" in preflight:
        fail(
            "preflight job MUST NOT declare `environment:` — preflight runs "
            "BEFORE the gate (iter-2.3 review Minor #2 carry-over)."
        )

    # uses-ref check.
    uses_refs = []
    collect_uses(jobs, uses_refs)
    if not uses_refs:
        fail("no `uses:` refs found in workflow jobs")

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
        f"{len(DOCUMENTED_INPUTS)} inputs + {len(DOCUMENTED_SECRETS)} secrets "
        "all present with non-empty descriptions; preflight has no `environment:`; "
        "pack-and-push gates on inputs.environment_name)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
