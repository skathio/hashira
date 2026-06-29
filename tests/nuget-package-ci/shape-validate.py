#!/usr/bin/env python3
"""
Shape validation for `.github/workflows/nuget-package-ci.yml`.

Acceptance checks per phase 3.2 (+ iter-2.3 version-resolver wiring):
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
  (e) The workflow's `on.workflow_call.outputs` block declares EXACTLY the
      outputs in DOCUMENTED_OUTPUTS (D8's CI->CD one-scalar boundary
      contract) — no extra output is permitted, and each declared output
      has a non-empty `description:`. Each output's `value:` expression is
      also validated for CONNECTIVITY (ported from
      `tests/npm-package-ci/shape-validate.py` iter-2.2 pass-1 review,
      Major #3): the referenced job id must exist under `jobs:`, that
      job's own `outputs:` block must declare the same output name mapped
      from a `steps.<id>.outputs.<name>` expression, and a step with that
      exact `id` must exist in that job's `steps:` list.

Run from repo root: python3 tests/nuget-package-ci/shape-validate.py
Use `--self-test` for the typo-injection regression test of check (e)'s
connectivity extension.
Exits 0 on success; non-zero with a clear error otherwise.

Note: this duplicates lines from `tests/npm-package-ci/shape-validate.py`
intentionally — extracted only after a third shim appears (rule-of-three).
Two copies is cheaper to maintain than a premature helper module.
"""

import os
import re
import sys

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORKFLOW_PATH = os.path.join(REPO_ROOT, ".github", "workflows", "nuget-package-ci.yml")

# Iter 2.3 adds `bump`/`seed_version` (version-resolver wiring, D8) — mirrors
# `npm-package-ci.yml` iteration 2.2's manifest update.
DOCUMENTED_INPUTS = [
    "dotnet_version",
    "project_path",
    "test_filter",
    "coverage_path",
    "scan_disable",
    "library_ref",
    "bump",
    "seed_version",
]

# Iter 2.3: the CI->CD output-boundary contract (D8 / phase 2 exit criteria
# "Major 3 fix") requires EXACTLY this one workflow-level output — no second
# output for the `v`-prefixed tag form or the bump kind.
DOCUMENTED_OUTPUTS = [
    "resolved_version",
]

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
HASHIRA_PREFIX = "./.hashira/.github/actions/"

# Matches `${{ jobs.<job_id>.outputs.<output_name> }}` (whitespace-tolerant),
# the only shape a workflow-level `outputs.<name>.value:` is permitted to use
# per phase 2 exit criteria (D8's CI->CD boundary contract). Ported from
# `tests/npm-package-ci/shape-validate.py`.
WORKFLOW_OUTPUT_VALUE_RE = re.compile(
    r"^\$\{\{\s*jobs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}$"
)

# Matches `${{ steps.<step_id>.outputs.<output_name> }}` (whitespace-tolerant)
# — the shape a JOB-level `outputs.<name>:` value must take to actually wire
# a step's output through to the job boundary.
JOB_OUTPUT_VALUE_RE = re.compile(
    r"^\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}$"
)


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


def validate_output_connectivity(name, spec, jobs_block):
    """Check (e) connectivity extension, ported from
    `tests/npm-package-ci/shape-validate.py` (iter-2.2 pass-1 review,
    Major #3).

    A workflow-level output passing the key/description checks can still be
    silently broken at runtime if the `value:` expression references a job,
    job-level output, or step id that doesn't actually exist — none of which
    the key/description checks above would catch. Validate the full chain:

      1. `value:` matches `${{ jobs.<job_id>.outputs.<output_name> }}`.
      2. `<job_id>` exists as a key under `jobs:`.
      3. that job's own `outputs:` block declares `<output_name>`, mapped
         from a `${{ steps.<step_id>.outputs.<name> }}` expression.
      4. a step with `id: <step_id>` exists in that job's `steps:` list.

    Returns (ok, reason). This is structural/string-level validation against
    the parsed YAML, not a full GitHub Actions expression evaluator — enough
    to catch a referenced id that doesn't exist, which is the actual failure
    mode that slipped through on the npm side (a misspelled job id or step
    id silently producing an empty `resolved_version` at runtime).

    Known limitation (carried over honestly from the npm shim, not narrowed
    here): step (4) confirms a step with the referenced id exists, but does
    NOT confirm that step's own output carries the expected name — that
    mapping lives inside the invoked composite action's own `action.yml`
    (e.g. `version-resolver`), outside this workflow YAML, so it isn't fully
    resolvable by a structural check against this file alone. A
    correct-but-wrong step id (one that exists but doesn't produce
    `<name>`), or a correct step id with a mistyped final output name, will
    NOT be caught here. The 3 typo shapes `--self-test` exercises (job id,
    job-output name, step id) are caught; this 4th shape is a documented
    gap, not silently assumed covered.
    """
    value = spec.get("value") if isinstance(spec, dict) else None
    if not isinstance(value, str):
        return False, f"output '{name}' has no string `value:` expression"

    m = WORKFLOW_OUTPUT_VALUE_RE.match(value.strip())
    if not m:
        return False, (
            f"output '{name}' value '{value}' does not match the required "
            "`${{ jobs.<job_id>.outputs.<output_name> }}` shape (D8 boundary)"
        )
    job_id, job_output_name = m.group(1), m.group(2)

    job_spec = jobs_block.get(job_id)
    if not isinstance(job_spec, dict):
        return False, (
            f"output '{name}' references job '{job_id}' via `value: {value}`, "
            f"but no job with that id exists under `jobs:` (got: "
            f"{sorted(jobs_block.keys())})"
        )

    job_outputs = job_spec.get("outputs") or {}
    if not isinstance(job_outputs, dict) or job_output_name not in job_outputs:
        return False, (
            f"output '{name}' references `jobs.{job_id}.outputs.{job_output_name}`, "
            f"but job '{job_id}' does not declare an output named "
            f"'{job_output_name}' (got: "
            f"{sorted(job_outputs.keys()) if isinstance(job_outputs, dict) else job_outputs})"
        )

    job_output_value = job_outputs[job_output_name]
    if not isinstance(job_output_value, str):
        return False, (
            f"job '{job_id}' output '{job_output_name}' has no string value "
            f"(got: {job_output_value!r})"
        )
    sm = JOB_OUTPUT_VALUE_RE.match(job_output_value.strip())
    if not sm:
        return False, (
            f"job '{job_id}' output '{job_output_name}' value "
            f"'{job_output_value}' does not match the required "
            "`${{ steps.<step_id>.outputs.<name> }}` shape"
        )
    step_id, _step_output_name = sm.group(1), sm.group(2)

    steps = job_spec.get("steps") or []
    if not isinstance(steps, list):
        return False, f"job '{job_id}' has no `steps:` list"
    step_ids = [s.get("id") for s in steps if isinstance(s, dict) and s.get("id")]
    if step_id not in step_ids:
        return False, (
            f"job '{job_id}' output '{job_output_name}' references step id "
            f"'{step_id}' (via `jobs.{job_id}.outputs.{job_output_name}` -> "
            f"`steps.{step_id}.outputs....`), but no step with `id: {step_id}` "
            f"exists in job '{job_id}' (got: {step_ids})"
        )

    return True, (
        f"value chain resolves: jobs.{job_id}.outputs.{job_output_name} <- "
        f"steps.{step_id}.outputs.* (job '{job_id}' exists, declares "
        f"'{job_output_name}', step '{step_id}' exists)"
    )


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

    # Check (e): the CI->CD output-boundary contract (D8 / phase 2 exit
    # criteria "Major 3 fix") — exactly one workflow-level output, no second
    # output for the `v`-prefixed tag form or the bump kind. Mirrors
    # `tests/npm-package-ci/shape-validate.py`'s check (d).
    outputs_block = workflow_call.get("outputs") or {}
    if not isinstance(outputs_block, dict):
        fail("`on.workflow_call.outputs` is not a mapping")
    missing_outputs = [name for name in DOCUMENTED_OUTPUTS if name not in outputs_block]
    if missing_outputs:
        fail(f"documented outputs missing from workflow: {missing_outputs}")
    extra_outputs = [name for name in outputs_block if name not in DOCUMENTED_OUTPUTS]
    if extra_outputs:
        fail(
            f"workflow declares outputs not in the manifest: {extra_outputs} "
            "(D8's one-scalar CI->CD boundary contract permits exactly "
            f"{DOCUMENTED_OUTPUTS} — a second output, even for the "
            "`v`-prefixed tag form or the bump kind, is the exact mistake "
            "flagged across discovery, plan-review, and phase 2.1's "
            "architecture review)"
        )
    no_output_desc = [
        name for name, spec in outputs_block.items()
        if not (
            isinstance(spec, dict)
            and isinstance(spec.get("description"), str)
            and spec["description"].strip()
        )
    ]
    if no_output_desc:
        fail(f"outputs missing non-empty description (D10 contract surface): {no_output_desc}")

    # Check (e) connectivity extension: the key name + description checks
    # above pass even if the `value:` expression references a job/step id
    # that doesn't exist (a typo silently produces an empty output at
    # runtime instead of failing the shape check). Verify the full
    # jobs.<id>.outputs.<name> <- steps.<id>.outputs.<name> chain.
    jobs_block = doc.get("jobs") or {}
    if not isinstance(jobs_block, dict):
        fail("`jobs:` is not a mapping")
    connectivity_errors = []
    for name, spec in outputs_block.items():
        ok, reason = validate_output_connectivity(name, spec, jobs_block)
        if not ok:
            connectivity_errors.append(reason)
        else:
            print(f"shape-validate: OK  output '{name}'  ({reason})")
    if connectivity_errors:
        for err in connectivity_errors:
            print(f"shape-validate: FAIL: {err}", file=sys.stderr)
        return 1

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
        f"{len(DOCUMENTED_INPUTS)} documented inputs all present with non-empty descriptions; "
        f"{len(DOCUMENTED_OUTPUTS)} documented output(s) — D8's one-scalar boundary contract intact)"
    )
    return 0


def run_self_test():
    """`--self-test`: typo-injection regression test for check (e)'s
    connectivity extension, ported from
    `tests/npm-package-ci/shape-validate.py`.

    Loads the REAL workflow file, then for each case below mutates a deep
    copy's `jobs:` block by exactly one id/name and asserts
    `validate_output_connectivity` now reports failure. Without this
    extension, all three of these typos would pass check (e) cleanly while
    the real workflow would silently produce an empty `resolved_version`
    output at runtime — this test pins that regression closed.

    Exits 0 if all cases correctly fail closed; non-zero (with details) if
    any case wrongly passes (i.e. the connectivity check regressed).
    """
    import copy

    if not os.path.isfile(WORKFLOW_PATH):
        fail(f"workflow not found at {WORKFLOW_PATH}")
    with open(WORKFLOW_PATH, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f.read())

    # PyYAML parses the bare `on:` key as Python True (boolean); same
    # accept-either handling as `main()`.
    on_block = doc.get("on", doc.get(True))
    outputs_block = on_block["workflow_call"]["outputs"]
    name = "resolved_version"
    base_jobs = doc["jobs"]

    # Sanity check: the unmutated real workflow must pass first, or the
    # cases below would be meaningless (failing for the wrong reason).
    ok, reason = validate_output_connectivity(name, outputs_block[name], base_jobs)
    if not ok:
        fail(f"self-test precondition failed — real workflow's own connectivity check "
             f"does not pass before mutation: {reason}")
    print(f"shape-validate --self-test: precondition OK — real workflow passes ({reason})")

    cases = {}

    # Case 1: typo the job id referenced by the workflow-level `value:`.
    mutated_value = {
        **outputs_block[name],
        "value": "${{ jobs.versionz.outputs.resolved_version }}",
    }
    cases["typo_job_id_in_workflow_value"] = (mutated_value, base_jobs)

    # Case 2: typo the job-level output NAME (the job no longer declares
    # the output the workflow-level `value:` expects).
    jobs_typo_job_output_name = copy.deepcopy(base_jobs)
    resolved = jobs_typo_job_output_name["version"]["outputs"].pop("resolved_version")
    jobs_typo_job_output_name["version"]["outputs"]["resolved_versionz"] = resolved
    cases["typo_job_output_name"] = (outputs_block[name], jobs_typo_job_output_name)

    # Case 3: typo the step id the job-level output maps from.
    jobs_typo_step_id = copy.deepcopy(base_jobs)
    jobs_typo_step_id["version"]["outputs"]["resolved_version"] = (
        "${{ steps.resolvez.outputs.version }}"
    )
    cases["typo_step_id"] = (outputs_block[name], jobs_typo_step_id)

    failures = []
    for case_name, (spec, jobs_block) in cases.items():
        ok, reason = validate_output_connectivity(name, spec, jobs_block)
        if ok:
            failures.append(
                f"{case_name}: WRONGLY PASSED (connectivity check regressed) — {reason}"
            )
        else:
            print(f"shape-validate --self-test: {case_name} correctly failed closed: {reason}")

    if failures:
        for f_ in failures:
            print(f"shape-validate --self-test: FAIL: {f_}", file=sys.stderr)
        return 1

    print(f"shape-validate --self-test: PASS ({len(cases)}/{len(cases)} typo-injection cases failed closed)")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        sys.exit(run_self_test())
    sys.exit(main())
