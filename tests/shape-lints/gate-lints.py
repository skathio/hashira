#!/usr/bin/env python3
"""
Environment-gate presence lint + `pull_request_target` prohibition lint
(phase 5 iteration 5.2; decisions.md D12; security.md B8; FR-15).

Two small, unrelated self-CI checks, bundled in one shim because both are
tiny and both belong to the same "lint family" this phase is building —
not because they share any logic:

  CHECK A — Environment-gate presence
    For each of the three flow docs' main caller-workflow example
    (docs/flows/{npm,nuget,static-webapp}.md), extract the fenced YAML
    block(s) that together make up the documented caller file, find the
    GATED job (the one with a `needs:` edge onto the CI job — i.e. the
    `publish`/`deploy` job a maintainer approves before it runs), and
    assert it declares an `environment:` key (D12; docs/usage.md's
    "Environment-reviewer gate" section literally promises this lint
    exists: "a static-shape check (Phase 5) asserts that every gated
    publish/deploy job in the library's own templates declares an
    environment: key"). This is the only mechanizable half of D12's
    defense-in-depth story — the library cannot verify a reviewer is
    actually configured on that Environment (admin-tier scope the
    workflow token lacks); it CAN verify the maintainer didn't forget the
    gate keyword itself.

  CHECK B — `pull_request_target` prohibition
    A repo-wide check that no `.github/workflows/*.yml` file's `on:`
    trigger block uses `pull_request_target`. B8 names this the canonical
    privilege-escalation footgun (pressure to "fix" the read-only fork-PR
    token by switching triggers) and states the prohibition as a HARD
    requirement, not advisory — "fail loud rather than be clever." See
    "Design decision — YAML-scoped, not a bare grep" below for why this
    check parses the `on:` block instead of substring-matching the raw
    file text.

## Design decision: a fresh, focused shim — not an import of an existing one

Same reuse-vs-rebuild call iteration 5.1 made for its own precedent
(tests/shape-lints/no-nested-reusable-workflow.py's module docstring), made
explicit here rather than silently repeated:

  - CHECK A's `extract_first_yaml_block_in_section`-style problem (pull a
    fenced ```yaml block out from under a markdown heading) is EXACTLY the
    helper `tests/static-webapp/docs-cross-ref.py` already implements and
    is the right tool for the job (per the iteration brief and the diary's
    explicit naming of it as the precedent for this check) — markdown
    fenced-YAML extraction is a genuinely different problem shape from
    iteration 5.1's PyYAML tree-walk (a graph-reachability question over an
    already-parsed YAML document) and from tests/dual-pin/lint.py's lexical
    regex scan (a cross-node string-equality question). Three distinct
    problem shapes, three distinct tools — not fragmentation.
  - Decision: a LOCAL re-implementation
    (`extract_first_yaml_block_under_heading` below), not an `import` of
    `tests/static-webapp/docs-cross-ref.py`. Reasoning, mirroring 5.1's:
    that module's function is hardcoded to one target doc
    (`docs/flows/static-webapp.md`, a module-level `DOC` constant baked
    into its own `fail()` messages) and is a script entry point, not a
    published library API (no `__all__`, no docstring promising stability,
    every sibling shim in this repo is independently self-contained rather
    than importing a shared module — confirmed precedent from 5.1's own
    review). This check needs to run the SAME extraction logic against
    THREE different docs with three different heading substrings, which
    the original function already supports via its parameter (it is not
    hardcoded to a single heading) — but importing it would still mean
    depending on a script's internals across a target it wasn't written to
    iterate over, for one ~30-line generically-parameterized function.
    A local copy, kept intentionally close to the original (same algorithm:
    find heading -> scan to next ## heading -> find first ```yaml fence ->
    find closing fence), is clearer than a cross-module dependency on a
    single-purpose script. This mirrors 5.1's own precedent exactly: reuse
    the ARCHITECTURE, not the module.
  - CHECK B is the simplest member of the whole lint family — see "Design
    decision — YAML-scoped, not a bare grep" below for why even THIS gets
    a few lines of YAML parsing rather than literally zero.

## Design decision — YAML-scoped, not a bare grep, for CHECK B

The iteration brief asks directly: is there a legitimate reason
`pull_request_target` could appear as a STRING inside a comment,
description field, or other non-trigger context, such that a naive
substring grep would false-positive? Answer, verified directly against
this repo's real files: YES, today, for real. `static-webapp-ci.yml`
contains the literal string `pull_request_target` FIVE times — all inside
a `# ## pull_request_target is forbidden (B8, iter 3.3)` comment block
documenting this very prohibition for consumers. A bare
`grep pull_request_target .github/workflows/*.yml` run today would FAIL
on a file that is, in fact, fully compliant — the textbook false-positive
the brief asked to rule in or out.

Given B8's "fail loud rather than be clever" framing, a naive grep is
tempting (zero false-NEGATIVES, simplest possible implementation) but
would also produce a false positive on a *documentation comment about the
prohibition itself* on every single CI run from now on — not an
acceptable steady-state for a hard, blocking check (a check that cries
wolf gets disabled, which is the actual failure mode "fail loud" is
trying to avoid). The chosen middle ground: parse just the `on:` block of
each workflow YAML (a few lines of PyYAML, not a full shell-AST parser the
way CHECK 2 of the no-CD-stamp lint explicitly declined to be) and assert
`pull_request_target` is not one of its trigger keys. This keeps the
check's FALSE-NEGATIVE surface effectively zero — `on:` triggers are a
fixed, small set of top-level keys GitHub Actions itself requires to be
literal YAML keys, not free text, so there is no realistic obfuscation
vector the way CHECK 2's shell-text scan has to worry about (a `run:`
step can build a string a dozen ways; an `on:` trigger key cannot) — while
eliminating the one concrete false-positive this repo already
demonstrates. This is documented as a deliberate scope choice, not
over-engineering: the check is still "no YAML schema validation, no
job/step inspection, just look at one top-level key," which is about as
small as a correct version of this check can be.

Targets checked (CHECK B): every `.github/workflows/*.yml` file in this
repository.

Targets checked (CHECK A): the main caller-workflow example in each of
`docs/flows/npm.md` (§2, "Publish caller workflow template" — split across
two snippets with §1 the CI half and §2 the gated half), `docs/flows/
nuget.md` (§2, same shape), and `docs/flows/static-webapp.md` (§1, "Main
caller workflow template" — both `ci` and `deploy` jobs in ONE fenced
block, a different shape from npm/nuget's two-snippet split; this check's
gated-job-finder works on both shapes generically by searching for ANY
job-shaped node with a `needs:` key, not by assuming a fixed document
shape).

This repo's own fixture/template surface for a full caller workflow
modeling a gated job: NONE exists today, checked directly. The only
on-disk YAML under `tests/` is `tests/dual-pin/caller-fixture.yml` (models
only the CI half — a `ci` job with no `needs:`, no `environment:`, by
design: it exists solely for the dual-pin lint, which has nothing to do
with gating) and the `tests/shape-lints/fixtures/*.yml` composite-action
fixtures (not workflows at all). `_self-ci.yml`'s own smoke jobs
(`npm-release-dry-run`, `nuget-push-smoke`, `pages-deploy-smoke-*`, etc.)
invoke the library's CD composites DIRECTLY to test the composites
themselves — they are not modeling a CONSUMER's gated-job pattern (none of
these smoke JOBS declares `environment:`; confirmed via a job-scoped grep
for an indented `environment:` key, zero hits — note a bare
`grep -n environment:` now ALSO matches this lint's own documentation
comments below, so the indentation-scoped form is the reproducible check)
and are out of scope for this check by design, not by oversight.
So CHECK A's only real targets are the three docs — recorded here
explicitly per the iteration brief's instruction not to invent a target
that doesn't exist.

CHECK A's honest limitation: like `docs-cross-ref.py`'s heading-scoped
extraction, this assumes a doc's gated-job snippet appears verbatim inside
a single contiguous fenced ```yaml block under a known heading. It would
not catch a hypothetical FOURTH gated-job example added to a doc under a
heading this lint doesn't know about, or one expressed as plain prose
instead of a fenced block. Not a gap today (verified: each doc has
exactly one gated-job example, under the headings checked) — named so a
future doc restructure doesn't silently fall outside this lint's reach.

Run from repo root: python3 tests/shape-lints/gate-lints.py
Exits 0 on success; non-zero with a clear, per-violation error otherwise.
`--self-test` proves both negative-test fixtures fail closed for the
correct, distinct reason (mirrors the established --self-test convention).
"""

import os
import sys

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORKFLOWS_DIR = os.path.join(REPO_ROOT, ".github", "workflows")
FIXTURES_DIR = os.path.join(REPO_ROOT, "tests", "shape-lints", "fixtures")

# CHECK A targets: (doc_path, doc_label, heading_substring). The heading
# substring is matched against any "## "/"### " line containing it (same
# semantics as docs-cross-ref.py's extract_first_yaml_block_in_section).
# npm/nuget split the CI and Publish halves into two fenced snippets under
# two different ## headings; the gated job (publish) lives in the SECOND
# snippet for both. static-webapp puts both jobs (ci + deploy) in ONE
# fenced block under its FIRST heading.
GATE_DOC_TARGETS = [
    (
        os.path.join(REPO_ROOT, "docs", "flows", "npm.md"),
        "docs/flows/npm.md",
        "Publish caller workflow template",
    ),
    (
        os.path.join(REPO_ROOT, "docs", "flows", "nuget.md"),
        "docs/flows/nuget.md",
        "Publish caller workflow template",
    ),
    (
        os.path.join(REPO_ROOT, "docs", "flows", "static-webapp.md"),
        "docs/flows/static-webapp.md",
        "Main caller workflow template",
    ),
]


def fail(msg):
    print(f"gate-lints: FAIL: {msg}", file=sys.stderr)


# ---------------------------------------------------------------------------
# CHECK A — Environment-gate presence
# ---------------------------------------------------------------------------


def extract_first_yaml_block_under_heading(md_text, heading_substring, doc_label):
    """Extract the first ```yaml ... ``` fenced block under the first
    ##/### heading containing `heading_substring`. Returns (block_text,
    error) — error is None on success. Mirrors
    tests/static-webapp/docs-cross-ref.py's
    `extract_first_yaml_block_in_section` algorithm exactly (find heading
    -> scan to next ## heading or EOF -> find first ```yaml fence -> find
    its closing fence); re-implemented locally rather than imported — see
    the module docstring's "Design decision" section for why.
    """
    lines = md_text.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if (ln.startswith("## ") or ln.startswith("### ")) and heading_substring in ln:
            start = i + 1
            break
    if start is None:
        return None, f"could not find heading containing '{heading_substring}' in {doc_label}"

    end = len(lines)
    for i in range(start, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break

    fence_open = None
    for i in range(start, end):
        if lines[i].strip().startswith("```yaml"):
            fence_open = i + 1
            break
    if fence_open is None:
        return None, f"could not find a ```yaml fenced block under '{heading_substring}' in {doc_label}"

    fence_close = None
    for i in range(fence_open, end):
        if lines[i].strip() == "```":
            fence_close = i
            break
    if fence_close is None:
        return None, f"unterminated ```yaml fence under '{heading_substring}' in {doc_label}"

    return "\n".join(lines[fence_open:fence_close]), None


def find_gated_jobs(parsed):
    """Collect every JOB-LEVEL node that declares a `needs:` key — the
    documented convention this whole work item uses for "the job that runs
    after CI and is the thing a human approves" (D12's publish/deploy job).
    `acc` collects (job_key, node) pairs, where `job_key` is the job's name.

    Deliberately does NOT recurse into a job's own internals (`steps:`,
    `with:`, `strategy:`, etc.) — only the two real target shapes' actual
    JOB level is inspected, never descended past it. Pass-1 review, Minor:
    an earlier version walked the WHOLE tree looking for any mapping with a
    `needs:` key, which could descend into a step's `with:` block and
    misreport a key there as a "gated job" if it happened to be named
    `needs` (verified reproducible against the earlier version: a step
    `with: {needs: ...}` was mislabeled "gated job 'with'"). Constraining
    to the two known job-level shapes below eliminates that class
    structurally, not by adding more exceptions.

    HONEST RESIDUAL LIMITATION (not silently assumed covered): this does
    NOT distinguish "the actual publish/deploy gate" from "any other
    job-level node that happens to have a `needs:` edge." If a flow doc
    ever shows MULTIPLE job-level nodes with `needs:` (e.g. a `test` job
    with `needs: setup` alongside the real `publish` gate — the D10
    multi-job consumer-composition pattern), every one of them gets
    checked for `environment:`, which would misfire on a legitimately
    non-gated job. Verified directly against today's three real targets:
    each has exactly one job-level `needs:` node, so this ambiguity does
    not currently manifest. Should a flow doc ever grow a second
    `needs:`-bearing job, the correct fix is to additionally key on the
    job name (`publish`/`deploy`) or on the presence of a CD-composite
    `uses:` step, not to widen this function further.

    Two known shapes, covering both real flow-doc snippet styles:
      - Full workflow document (static-webapp.md's one-block style):
        `{jobs: {ci: {...}, deploy: {needs: ci, ...}}}` — iterate
        `jobs.values()`.
      - Bare job-fragment (npm.md/nuget.md's two-snippet style, where the
        extracted block IS just the gated job, not a full document):
        `{publish: {needs: ci, ...}}` — iterate the root dict's own
        top-level values directly.
    In both cases the candidate is the job dict itself; only `needs:`/
    `environment:` AT THAT LEVEL are inspected, never a level deeper.
    """
    if not isinstance(parsed, dict):
        return []
    if isinstance(parsed.get("jobs"), dict):
        candidates = parsed["jobs"].items()
    else:
        candidates = parsed.items()
    acc = []
    for job_key, job in candidates:
        if isinstance(job, dict) and "needs" in job:
            acc.append((job_key, job))
    return acc


def check_environment_gate_in_text(yaml_text, doc_label):
    """Run CHECK A against one in-memory YAML fragment/document. Returns
    (gated_job_count, violations)."""
    try:
        parsed = yaml.safe_load(yaml_text)
    except yaml.YAMLError as e:
        return 0, [f"[{doc_label}] fenced YAML block failed to parse: {e}"]

    gated_jobs = find_gated_jobs(parsed)

    if not gated_jobs:
        return 0, [
            f"[{doc_label}] no gated job found (no job-shaped node with a "
            f"`needs:` key) in the extracted caller-workflow snippet — this "
            f"check has nothing to verify, which is itself a failure of "
            f"this lint's purpose"
        ]

    violations = []
    for job_key, job in gated_jobs:
        if "environment" not in job:
            job_label = job_key or "<unnamed gated job>"
            violations.append(
                f"[{doc_label}] ENVIRONMENT-GATE-MISSING violation (D12): "
                f"the gated job '{job_label}' (needs={job['needs']!r}) "
                f"does not declare an `environment:` key. The GitHub "
                f"Environment's required-reviewer setting is the ONLY "
                f"control that pauses an unreviewed publish/deploy on "
                f"every push — a maintainer-template missing `environment:` "
                f"silently removes that gate for every consumer who copies "
                f"it. See docs/usage.md#environment-reviewer-gate."
            )
    return len(gated_jobs), violations


def check_environment_gate_in_doc(doc_path, doc_label, heading_substring):
    """CHECK A against one real on-disk doc. Returns (gated_job_count,
    violations)."""
    if not os.path.isfile(doc_path):
        return 0, [f"required doc not found: {doc_path}"]
    with open(doc_path, "r", encoding="utf-8") as f:
        md_text = f.read()
    block, err = extract_first_yaml_block_under_heading(md_text, heading_substring, doc_label)
    if err:
        return 0, [err]
    return check_environment_gate_in_text(block, doc_label)


# ---------------------------------------------------------------------------
# CHECK B — `pull_request_target` prohibition
# ---------------------------------------------------------------------------


def extract_on_block_triggers(doc):
    """Return the set of top-level trigger keys declared under a parsed
    workflow YAML document's `on:` block. Handles the YAML 1.1 quirk where
    an unquoted `on:` key parses as the boolean `True` (same tolerance
    tests/static-webapp/docs-cross-ref.py's `load_workflow_inputs_secrets`
    already applies for this repo's workflows).

    `on:` may be a scalar string (`on: push`), a list
    (`on: [push, pull_request]`), or a mapping
    (`on: {pull_request: {}, push: {...}}`) — all three are valid GitHub
    Actions shapes; every kept workflow in this repo uses the mapping
    form, but this function tolerates all three so a future workflow using
    a different shape is still checked correctly rather than silently
    skipped.
    """
    on_block = doc.get("on", doc.get(True))
    if on_block is None:
        return set()
    if isinstance(on_block, str):
        return {on_block}
    if isinstance(on_block, list):
        return set(on_block)
    if isinstance(on_block, dict):
        return set(on_block.keys())
    return set()


def check_no_pull_request_target_in_text(yaml_text, label):
    """CHECK B against one in-memory workflow YAML text blob. Returns a
    list of violation strings (empty = clean)."""
    try:
        doc = yaml.safe_load(yaml_text)
    except yaml.YAMLError as e:
        return [f"[{label}] YAML parse error: {e}"]
    if not isinstance(doc, dict):
        return [f"[{label}] root is not a mapping"]

    triggers = extract_on_block_triggers(doc)
    if "pull_request_target" in triggers:
        return [
            f"[{label}] PULL-REQUEST-TARGET-PROHIBITED violation (B8): "
            f"the `on:` block declares `pull_request_target` as a trigger. "
            f"This is a hard prohibition, not advisory — `pull_request_target` "
            f"runs in the BASE repo's context (base-repo secrets, a token "
            f"scoped to the base repo) even for a fork-originated PR, which "
            f"is the canonical privilege-escalation footgun B8 exists to "
            f"prevent. Use `pull_request` instead (read-only fork token, no "
            f"secrets)."
        ]
    return []


def check_no_pull_request_target_in_workflow(path, label):
    if not os.path.isfile(path):
        return [f"workflow not found: {path}"]
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    return check_no_pull_request_target_in_text(text, label)


def collect_real_workflow_files():
    """Every `.github/workflows/*.yml`/`*.yaml` file in this repo —
    CHECK B's repo-wide scope. Returns [(path, label)]."""
    if not os.path.isdir(WORKFLOWS_DIR):
        return []
    out = []
    for fname in sorted(os.listdir(WORKFLOWS_DIR)):
        if fname.endswith(".yml") or fname.endswith(".yaml"):
            out.append((os.path.join(WORKFLOWS_DIR, fname), f".github/workflows/{fname}"))
    return out


# ---------------------------------------------------------------------------
# main / self-test
# ---------------------------------------------------------------------------


def main():
    all_violations = []
    total_gated_jobs = 0

    # CHECK A.
    for doc_path, doc_label, heading_substring in GATE_DOC_TARGETS:
        count, violations = check_environment_gate_in_doc(doc_path, doc_label, heading_substring)
        total_gated_jobs += count
        if violations:
            all_violations.extend(violations)
        else:
            print(f"gate-lints: OK  CHECK-A  {doc_label}  ({count} gated job(s), all declare environment:)")

    if total_gated_jobs == 0:
        fail(
            "CHECK A found zero gated jobs across all three flow docs — "
            "the environment-gate lint has nothing to check (this would "
            "silently pass with zero coverage, which is itself a failure "
            "of this lint's purpose)"
        )
        return 1

    # CHECK B.
    workflow_files = collect_real_workflow_files()
    if not workflow_files:
        fail(f"CHECK B found no workflow files under {WORKFLOWS_DIR} — nothing to check")
        return 1

    for path, label in workflow_files:
        violations = check_no_pull_request_target_in_workflow(path, label)
        if violations:
            all_violations.extend(violations)
        else:
            print(f"gate-lints: OK  CHECK-B  {label}  (on: block does not use pull_request_target)")

    if all_violations:
        for v in all_violations:
            fail(v)
        print(
            f"gate-lints: FAIL ({len(all_violations)} violation(s) across "
            f"{len(GATE_DOC_TARGETS)} doc(s) [CHECK A] and "
            f"{len(workflow_files)} workflow file(s) [CHECK B])",
            file=sys.stderr,
        )
        return 1

    print(
        f"gate-lints: PASS (CHECK A: {total_gated_jobs} gated job(s) across "
        f"{len(GATE_DOC_TARGETS)} doc(s), all declare environment:; "
        f"CHECK B: {len(workflow_files)} workflow file(s), none use "
        f"pull_request_target as a trigger)"
    )
    return 0


def run_self_test():
    """`--self-test`: proves both negative-test fixtures fail closed for
    the correct, distinct reason, and that the real docs/workflows stay
    clean. Mirrors the established --self-test convention (dual-pin/lint.py,
    no-nested-reusable-workflow.py)."""
    cases_failed = []

    # --- CHECK A negative fixture: a gated job missing `environment:`. ---
    fixture_a_path = os.path.join(FIXTURES_DIR, "gated-job-missing-environment.yml")
    if not os.path.isfile(fixture_a_path):
        cases_failed.append(f"CHECK-A fixture not found: {fixture_a_path}")
    else:
        with open(fixture_a_path, "r", encoding="utf-8") as f:
            text = f.read()
        count, violations = check_environment_gate_in_text(text, "fixture:gated-job-missing-environment.yml")
        if count == 0:
            cases_failed.append(
                "gated_job_missing_environment_fails_closed: fixture has no "
                "gated job (no `needs:` found) — fixture is not exercising "
                "CHECK A at all"
            )
        elif not violations:
            cases_failed.append(
                "gated_job_missing_environment_fails_closed: expected a "
                "violation, but the lint reported the fixture as clean — "
                "negative fixture is NOT failing closed"
            )
        elif not any("ENVIRONMENT-GATE-MISSING" in v for v in violations):
            cases_failed.append(
                f"gated_job_missing_environment_fails_closed: fixture "
                f"produced violation(s) {violations!r}, but none mention "
                f"'ENVIRONMENT-GATE-MISSING' — failing for the WRONG reason"
            )
        else:
            print(
                "gate-lints --self-test: gated_job_missing_environment_fails_closed "
                f"correctly failed closed for the right reason: {violations[0]}"
            )

    # --- CHECK B negative fixture: a workflow using pull_request_target. ---
    fixture_b_path = os.path.join(FIXTURES_DIR, "pull-request-target-workflow.yml")
    if not os.path.isfile(fixture_b_path):
        cases_failed.append(f"CHECK-B fixture not found: {fixture_b_path}")
    else:
        with open(fixture_b_path, "r", encoding="utf-8") as f:
            text = f.read()
        violations = check_no_pull_request_target_in_text(text, "fixture:pull-request-target-workflow.yml")
        if not violations:
            cases_failed.append(
                "pull_request_target_workflow_fails_closed: expected a "
                "violation, but the lint reported the fixture as clean — "
                "negative fixture is NOT failing closed"
            )
        elif not any("PULL-REQUEST-TARGET-PROHIBITED" in v for v in violations):
            cases_failed.append(
                f"pull_request_target_workflow_fails_closed: fixture "
                f"produced violation(s) {violations!r}, but none mention "
                f"'PULL-REQUEST-TARGET-PROHIBITED' — failing for the WRONG "
                f"reason"
            )
        else:
            print(
                "gate-lints --self-test: pull_request_target_workflow_fails_closed "
                f"correctly failed closed for the right reason: {violations[0]}"
            )

    # --- CHECK B false-positive control: the REAL static-webapp-ci.yml,
    # which mentions the literal string `pull_request_target` five times
    # inside a comment block documenting this very prohibition. The
    # YAML-scoped (on:-block-only) check must NOT trip on this — proving
    # the design decision documented in the module docstring actually
    # holds, not just asserted in prose. ---
    real_static_webapp_path = os.path.join(WORKFLOWS_DIR, "static-webapp-ci.yml")
    if not os.path.isfile(real_static_webapp_path):
        cases_failed.append(f"real target not found: {real_static_webapp_path}")
    else:
        with open(real_static_webapp_path, "r", encoding="utf-8") as f:
            real_text = f.read()
        if "pull_request_target" not in real_text:
            cases_failed.append(
                "static_webapp_ci_comment_does_not_false_positive: expected "
                "static-webapp-ci.yml to contain the literal string "
                "'pull_request_target' (in its prohibition-documenting "
                "comment) as the precondition for this control to mean "
                "anything — it does not. This control is stale; re-check "
                "whether the comment was removed/reworded."
            )
        else:
            violations = check_no_pull_request_target_in_text(
                real_text, "control:static-webapp-ci.yml"
            )
            if violations:
                cases_failed.append(
                    f"static_webapp_ci_comment_does_not_false_positive: "
                    f"the YAML-scoped check incorrectly flagged "
                    f"static-webapp-ci.yml ({violations!r}) — it should "
                    f"only ever look at the `on:` block, not comment text, "
                    f"and this file's `on:` block does not use "
                    f"pull_request_target"
                )
            else:
                print(
                    "gate-lints --self-test: static_webapp_ci_comment_does_not_false_positive "
                    "correctly reported clean (the YAML-scoped check does not "
                    "false-positive on the file's own prohibition-documenting "
                    "comment, unlike a bare substring grep would)"
                )

    # --- Positive controls: the three real docs (CHECK A) and all real
    # workflow files (CHECK B) must stay clean. ---
    for doc_path, doc_label, heading_substring in GATE_DOC_TARGETS:
        count, violations = check_environment_gate_in_doc(doc_path, doc_label, heading_substring)
        if count == 0:
            cases_failed.append(f"real_doc_clean__{doc_label}: no gated job found in the real doc")
        elif violations:
            cases_failed.append(f"real_doc_clean__{doc_label}: expected clean, got: {violations!r}")
        else:
            print(f"gate-lints --self-test: real_doc_clean__{doc_label} correctly reported clean (no false positive)")

    for path, label in collect_real_workflow_files():
        violations = check_no_pull_request_target_in_workflow(path, label)
        if violations:
            cases_failed.append(f"real_workflow_clean__{label}: expected clean, got: {violations!r}")
        else:
            print(f"gate-lints --self-test: real_workflow_clean__{label} correctly reported clean (no false positive)")

    if cases_failed:
        for c in cases_failed:
            print(f"gate-lints --self-test: FAIL: {c}", file=sys.stderr)
        return 1

    print(
        "gate-lints --self-test: PASS (both negative-test fixtures — a "
        "gated job missing environment:, and a workflow using "
        "pull_request_target — fail closed for the right, distinct "
        "reason; the YAML-scoped CHECK B design does not false-positive "
        "on static-webapp-ci.yml's own prohibition-documenting comment; "
        "all three real docs and all real workflow files stay clean)"
    )
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        sys.exit(run_self_test())
    sys.exit(main())
