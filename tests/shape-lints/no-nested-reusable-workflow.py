#!/usr/bin/env python3
"""
Composite-shape invariant lint (phase 5 iteration 5.1; security.md B3/§2
corollary (1); decisions.md; FR-15).

Two related, structurally-checked invariants over hashira's three CD
composite actions (`nuget-push`, `npm-release`, `pages-deploy`):

  CHECK 1 — no nested reusable-workflow `uses:`
    NFR-Sec-1's corollary (1): a CD composite action MUST NOT contain a
    `uses:` step whose value resolves to a `.github/workflows/*.yml` path,
    same-repo (`./.github/workflows/foo.yml`) or cross-repo
    (`owner/repo/.github/workflows/foo.yml@ref`). A `workflow_call` boundary
    anywhere between the consumer's trusted-publisher-registered file and the
    OIDC token-exchange step breaks the OIDC token's `job_workflow_ref` claim
    (security.md §2) — re-introducing one INSIDE a composite that's supposed
    to run inline in the caller's job would silently reopen AP1 by a
    maintenance mistake, not an attacker. This is exactly why it must be
    mechanized rather than left to manual review forever (FR-15).

  CHECK 2 — no CD-side stamp
    Phase 3.4 established (NFR-Rel-1, the byte-identical-artifact guarantee)
    that `npm-release`/`nuget-push` must NEVER write `package.json`, a
    `.nuspec` file, or assembly-version metadata — these CD composites
    consume the CI-stamped artifact as-is; re-stamping or re-deriving a
    version on the CD side would defeat the "publish exactly what CI tested"
    guarantee, and a naive smoke test that only checks "the right version
    shows up" would not catch a reintroduced stamp step. This mechanizes
    that invariant as a lint, extending (not duplicating) the partial,
    fixture-less textual check `tests/npm-release/shape-validate.py` already
    carries for the npm side only (`FORBIDDEN_STAMP_OR_REPACK`, npm pkg
    set/npm pack) — generalized here to all three CD composites and to
    `.nuspec`/assembly-version metadata, WITH the negative-test fixtures and
    `--self-test` regression lock that check never had.

## Design decision: a fresh, focused shim — not an import of an existing one

This is a NEW file (`tests/shape-lints/no-nested-reusable-workflow.py`), not
an addition to `tests/npm-package-ci/shape-validate.py` and not an `import`
of it as a library. Reasoning:

  - `tests/npm-package-ci/shape-validate.py` targets ONE specific CI
    REUSABLE WORKFLOW file (`on.workflow_call` shape: inputs/outputs
    contract, job-output connectivity) and hardcodes that single path as a
    module-level constant; its `main()` is a script entry point, not a
    library API, and calling it would run irrelevant checks (workflow_call
    inputs/outputs/permissions) against files that don't have that shape at
    all (a composite action has no `on:`/`jobs:` block).
  - This lint's target set (three CD COMPOSITE ACTIONS) and its check
    semantics (structural `uses:` tree-reachability + a textual stamp scan)
    are different enough in shape from shape-validate.py's checks that
    importing would mean importing one fully decoupled helper
    (`collect_uses`) while ignoring everything else in that module — at that
    point a local ~15-line re-implementation is clearer than a cross-module
    dependency on a file that is itself a single-purpose script, not a
    shared library `shape-validate.py` was never designed to be (no
    `__all__`, no docstring promising API stability, every other
    `tests/<target>/shape-validate.py` in this repo is similarly
    self-contained — npm-release's, nuget-package-ci's, and this one all
    independently re-implement small structural helpers rather than share
    one common module).
  - What IS reused, deliberately, is the ARCHITECTURE: `collect_uses`'s
    exact recursive-tree-walk shape (per the diary's explicit instruction —
    this is a structural tree-reachability question, not dual-pin's lexical
    cross-node-string-equality question, so PyYAML + tree-walk is the
    correct tool, not regex/text-scan).

Targets checked (CHECK 1 and CHECK 2, both): the three CD composite actions
reachable from the npm, NuGet, and static-webapp publish/deploy flows:
  - .github/actions/nuget-push/action.yml
  - .github/actions/npm-release/action.yml
  - .github/actions/pages-deploy/action.yml

CHECK 2 runs against all three composites deliberately, even though the
no-CD-stamp invariant only has package-metadata sinks to violate on the
npm/NuGet paths (`pages-deploy` has no `package.json`/`.nuspec`/assembly
metadata of its own to stamp). This is intentional belt-and-suspenders, not
an oversight (pass-1 architecture review): running the same check
unconditionally across every CD composite costs nothing today and means a
future CD composite gains the check automatically just by being added to
CD_COMPOSITES, rather than needing someone to remember to also add it to a
narrower "package composites only" list.

Depth scope (explicit, per phases/05-self-ci-shape-lints.md iteration 5.1):
this lint is SINGLE-HOP by design — it inspects each composite's own
action.yml directly, not transitively through any local composite it itself
calls. None of the three current CD composites chain to another local
composite (verified: their only `uses:` steps target third-party actions —
`NuGet/login`, `actions/setup-node`, `actions/download-artifact`,
`actions/deploy-pages` — never `./.github/actions/...`), so single-hop
covers today's actual shape. If a future composite introduces
composite-calls-composite chaining, this lint's scope must be revisited
(documented follow-up, not a blocking gap today).

Corollary (2) of NFR-Sec-1 (the consumer's own publish file must itself be a
top-level workflow, not a reusable workflow called from elsewhere in their
repo) is explicitly OUT OF SCOPE for this lint — it is not mechanizable from
inside hashira, which has no visibility into a consumer's repo structure.
Documented as a consumer-side responsibility in docs/usage.md, not a gap in
this lint.

CHECK 2's honest limitations (test-pyramid honesty, the convention this
whole work item follows): this is a TEXTUAL pattern scan over each
composite's flattened `run:` step bodies, not a semantic/AST-level shell
parser. It catches the patterns named in the iteration brief and the
real-world idioms a maintainer would actually reach for:
  - `npm pkg set` (the documented npm version-stamp command)
  - `npm version` (an alternative npm version-bump command)
  - a shell redirect into `package.json` (`> package.json`, `>>
    package.json`, `package.json <<...` heredoc)
  - a shell redirect into a `.nuspec` file (`> *.nuspec`, `>> *.nuspec`)
  - `sed -i` (or `sed -i.bak`/`sed --in-place`) whose arguments mention
    `package.json`, `.nuspec`, or `AssemblyInfo`/`AssemblyVersion` —
    catches the in-place-edit idiom this iteration's brief calls out by name
  - direct mentions of assembly-version metadata sinks
    (`AssemblyVersion`/`AssemblyInfo.cs`/`Directory.Build.props`) paired
    with a write-shaped verb (`>`, `>>`, `sed -i`, `dotnet msbuild
    -p:Version`, `dotnet pack -p:Version`, `dotnet pack
    /p:PackageVersion`) — `dotnet pack -p:...`/`-p:PackageVersion=` is
    explicitly checked since that is exactly how a CD-side re-stamp would
    look on the NuGet path (re-deriving/overriding the version at pack
    time), distinct from passing an ALREADY-VALIDATED version straight to
    `dotnet nuget push`, which `nuget-push/action.yml` does today and must
    keep doing.
  COVERED (pass-1 review, Minor, added after the initial pattern list missed
  it): `jq` rewriting a sink file — its canonical idiom (`jq ... file > tmp
  && mv tmp file`) never puts the sink filename after a literal `>`, so a
  naive redirect pattern misses it; matched by `jq ... <sink-file>` appearing
  anywhere on the line instead. Also `tee <sink-file>`, which writes without
  any `>`/`>>` token at all.
  WHAT THIS STILL CANNOT CATCH (documented honestly, not silently assumed
  covered): an obfuscated write (e.g. piping through `base64 -d`, building
  the target filename via string concatenation/variable indirection so
  `package.json`/`.nuspec` never appears as a literal token, or shelling out
  to a helper script under `tests/`/`scripts/` whose OWN body does the write
  — this lint only inspects the composite's inline `run:` text, it does not
  recursively analyze scripts a `run:` step might invoke). This is the same
  class of limitation `shape-validate.py`'s own connectivity check documents
  for itself (a structural/textual check against the parsed YAML, not a
  full interpreter) — named here rather than overclaimed.

Run from repo root: python3 tests/shape-lints/no-nested-reusable-workflow.py
Exits 0 on success; non-zero with a clear, per-violation error otherwise.
`--self-test` proves both negative-test fixtures fail closed for the
correct, distinct reason (mirrors tests/dual-pin/lint.py's and
tests/npm-package-ci/shape-validate.py's `--self-test` convention).
"""

import os
import re
import sys

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# The three CD composite actions this lint inspects — npm, NuGet, and
# static-webapp's publish/deploy paths (security.md B3; phases/05's iter
# 5.1 scope). Each entry is (relative_path_for_display, absolute_path).
CD_COMPOSITES = [
    (
        ".github/actions/nuget-push/action.yml",
        os.path.join(REPO_ROOT, ".github", "actions", "nuget-push", "action.yml"),
    ),
    (
        ".github/actions/npm-release/action.yml",
        os.path.join(REPO_ROOT, ".github", "actions", "npm-release", "action.yml"),
    ),
    (
        ".github/actions/pages-deploy/action.yml",
        os.path.join(REPO_ROOT, ".github", "actions", "pages-deploy", "action.yml"),
    ),
]

FIXTURES_DIR = os.path.join(REPO_ROOT, "tests", "shape-lints", "fixtures")

# Matches a same-repo or cross-repo reusable-workflow `uses:` target:
#   - same-repo:  ./.github/workflows/foo.yml  (optionally @ref)
#   - cross-repo: owner/repo/.github/workflows/foo.yml@ref
# Both forms must be covered (risk pointer in phases/05) — a lint that only
# catches one gives false confidence.
REUSABLE_WORKFLOW_USES_RE = re.compile(
    r"^(?:\./)?(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/)?\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml(?:@.+)?$"
)

# CHECK 2: write-shaped textual patterns against the three prohibited
# sink-file classes (package.json, .nuspec, assembly-version metadata). See
# the module docstring's "CHECK 2's honest limitations" section for what
# this can and cannot catch. Each entry is (compiled_regex, human_label) so
# a hit names the SPECIFIC pattern that matched, not a generic "lint
# failed" message (per the iteration's observability requirement).
STAMP_PATTERNS = [
    (re.compile(r"\bnpm\s+pkg\s+set\b"), "npm pkg set"),
    (re.compile(r"\bnpm\s+version\b"), "npm version"),
    (re.compile(r">>?\s*package\.json\b"), "shell redirect into package.json"),
    (re.compile(r"package\.json\s*<<"), "heredoc write into package.json"),
    (re.compile(r">>?\s*\S*\.nuspec\b"), "shell redirect into a .nuspec file"),
    (
        re.compile(r"\bsed\s+(?:-i|--in-place)\S*\b[^\n]*\b(package\.json|\.nuspec|AssemblyInfo|AssemblyVersion)\b"),
        "sed -i targeting package.json/.nuspec/AssemblyInfo/AssemblyVersion",
    ),
    (
        re.compile(r"\bdotnet\s+(?:pack|msbuild)\b[^\n]*(?:-p:Version=|-p:PackageVersion=|/p:Version=|/p:PackageVersion=)"),
        "dotnet pack/msbuild re-deriving Version/PackageVersion at CD time",
    ),
    (
        re.compile(r">>?\s*\S*AssemblyInfo\.cs\b"),
        "shell redirect into an AssemblyInfo.cs file",
    ),
    (
        re.compile(r">>?\s*\S*Directory\.Build\.props\b"),
        "shell redirect into a Directory.Build.props file",
    ),
    (
        # jq cannot edit in place — its canonical idiom is `jq ... file >
        # tmp && mv tmp file`, where the literal redirect target is `tmp`,
        # not the sink file itself. A bare `>>?\s*package\.json` pattern
        # cannot catch this (pass-1 review, Minor: a realistic, non-
        # obfuscated idiom — jq is a first-class tool elsewhere in this
        # work item's own tooling story, security.md §5 — was previously
        # undocumented and uncovered). Match `jq` anywhere on a line that
        # also names one of the three sink-file classes, regardless of
        # redirect shape.
        re.compile(r"\bjq\b[^\n]*\b(package\.json|\.nuspec|AssemblyInfo|AssemblyVersion|Directory\.Build\.props)\b"),
        "jq rewriting a version-bearing sink file",
    ),
    (
        # `tee <file>` writes without needing a `>`/`>>` redirect token at
        # all — a second realistic gap named in the same pass-1 review.
        re.compile(r"\btee\b[^\n]*\b(package\.json|\.nuspec|AssemblyInfo|AssemblyVersion|Directory\.Build\.props)\b"),
        "tee writing a version-bearing sink file",
    ),
]


def fail(msg):
    print(f"no-nested-reusable-workflow: FAIL: {msg}", file=sys.stderr)


def collect_uses(node, acc):
    """Recursively collect every `uses:` string value in a parsed YAML
    tree. Re-implements the exact tree-walk shape of
    tests/npm-package-ci/shape-validate.py's `collect_uses` (per the
    diary's explicit architectural precedent for this iteration) rather
    than importing that module — see the module docstring's "Design
    decision" section for why a local re-implementation, not an import, is
    the right call here. This is a STRUCTURAL tree-reachability walk (does
    any node have a `uses:` key), not a lexical/regex scan — the correct
    tool for "is there a nested uses: anywhere in this composite's step
    tree," as opposed to tests/dual-pin/lint.py's lexical cross-node
    string-equality question.
    """
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "uses" and isinstance(value, str):
                acc.append(value)
            else:
                collect_uses(value, acc)
    elif isinstance(node, list):
        for item in node:
            collect_uses(item, acc)


def is_reusable_workflow_ref(ref):
    """Return True if `ref` (a `uses:` string value) resolves to a
    `.github/workflows/*.yml` path, same-repo or cross-repo — the exact
    prohibited shape (NFR-Sec-1 corollary (1))."""
    return bool(REUSABLE_WORKFLOW_USES_RE.match(ref.strip()))


def check_no_nested_reusable_workflow(label, doc):
    """CHECK 1. Returns a list of violation strings (empty = clean)."""
    uses_refs = []
    collect_uses(doc.get("runs", {}), uses_refs)
    violations = []
    for ref in uses_refs:
        if is_reusable_workflow_ref(ref):
            violations.append(
                f"[{label}] NESTED-REUSABLE-WORKFLOW violation (NFR-Sec-1 "
                f"corollary (1)): found `uses: {ref}`, which resolves to a "
                f"reusable-workflow path (.github/workflows/*.yml). A CD "
                f"composite action MUST NOT contain a `uses:` step "
                f"targeting a reusable workflow — that re-introduces a "
                f"`workflow_call` boundary inside a composite that's "
                f"supposed to run inline in the caller's job, breaking the "
                f"OIDC token's `job_workflow_ref` claim match (security.md "
                f"§2, B3) by a maintenance mistake, not an attacker."
            )
    return uses_refs, violations


def collect_run_bodies(node, acc):
    """Recursively collect every `run:` string value in a parsed YAML
    tree, alongside the step's `name:` if present (for attribution in the
    violation message). Mirrors `collect_uses`'s tree-walk shape, applied
    to the sibling `run:` key instead of `uses:`."""
    if isinstance(node, dict):
        if isinstance(node.get("run"), str):
            acc.append((node.get("name", "<unnamed step>"), node["run"]))
        for value in node.values():
            collect_run_bodies(value, acc)
    elif isinstance(node, list):
        for item in node:
            collect_run_bodies(item, acc)


def check_no_cd_stamp(label, doc):
    """CHECK 2. Returns a list of violation strings (empty = clean). See
    the module docstring's "CHECK 2" section for the patterns checked and
    their honest limitations."""
    run_bodies = []
    collect_run_bodies(doc.get("runs", {}), run_bodies)
    violations = []
    for step_name, run_text in run_bodies:
        for pattern, human_label in STAMP_PATTERNS:
            m = pattern.search(run_text)
            if m:
                violations.append(
                    f"[{label}] CD-SIDE-STAMP violation (NFR-Rel-1, Phase "
                    f"3.4): step '{step_name}' contains a write-shaped "
                    f"pattern ('{human_label}', matched text: "
                    f"{m.group(0)!r}). A CD composite action must consume "
                    f"the CI-stamped artifact byte-identical — it must "
                    f"never re-stamp or re-derive package.json/.nuspec/"
                    f"assembly-version metadata on the CD side."
                )
    return run_bodies, violations


def load_yaml(path, label):
    if not os.path.isfile(path):
        return None, f"target not found: {path} ({label})"
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    try:
        doc = yaml.safe_load(raw)
    except yaml.YAMLError as e:
        return None, f"YAML parse error in {label}: {e}"
    if not isinstance(doc, dict):
        return None, f"{label}: root is not a mapping"
    return doc, None


def run_checks_against_text(raw_text, label):
    """Run both checks against one in-memory YAML text blob. Returns
    (uses_refs, run_bodies, violations). Exposed separately from main() so
    --self-test can feed deliberately-broken fixtures without requiring
    them to live at one of the real CD_COMPOSITES paths."""
    try:
        doc = yaml.safe_load(raw_text)
    except yaml.YAMLError as e:
        return [], [], [f"[{label}] YAML parse error: {e}"]
    if not isinstance(doc, dict):
        return [], [], [f"[{label}] root is not a mapping"]
    uses_refs, v1 = check_no_nested_reusable_workflow(label, doc)
    run_bodies, v2 = check_no_cd_stamp(label, doc)
    return uses_refs, run_bodies, v1 + v2


def main():
    all_violations = []
    total_uses = 0
    total_run_steps = 0

    for label, path in CD_COMPOSITES:
        doc, err = load_yaml(path, label)
        if err:
            fail(err)
            return 1

        runs_block = doc.get("runs") or {}
        if runs_block.get("using") != "composite":
            fail(f"{label}: expected `runs.using: composite`, got {runs_block.get('using')!r}")
            return 1

        uses_refs, v1 = check_no_nested_reusable_workflow(label, doc)
        total_uses += len(uses_refs)
        for ref in uses_refs:
            print(f"no-nested-reusable-workflow: OK  {label}  uses: {ref}")

        run_bodies, v2 = check_no_cd_stamp(label, doc)
        total_run_steps += len(run_bodies)

        violations = v1 + v2
        if violations:
            all_violations.extend(violations)
        else:
            print(
                f"no-nested-reusable-workflow: OK  {label}  "
                f"({len(uses_refs)} uses: ref(s), no nested reusable-workflow; "
                f"{len(run_bodies)} run: step(s), no CD-side stamp pattern)"
            )

    if total_uses == 0:
        fail(
            "no `uses:` refs found across any CD composite — the no-nested- "
            "reusable-workflow check has nothing to check (this would "
            "silently pass with zero coverage, which is itself a failure "
            "of this lint's purpose)"
        )
        return 1

    if all_violations:
        for v in all_violations:
            fail(v)
        print(
            f"no-nested-reusable-workflow: FAIL ({len(all_violations)} "
            f"violation(s) across {len(CD_COMPOSITES)} CD composite(s))",
            file=sys.stderr,
        )
        return 1

    print(
        f"no-nested-reusable-workflow: PASS ({len(CD_COMPOSITES)} CD "
        f"composite(s) checked; {total_uses} total uses: ref(s), none "
        f"nested-reusable-workflow; {total_run_steps} total run: step(s), "
        f"none CD-side-stamp; single-hop scope per phases/05 iter 5.1)"
    )
    return 0


def run_self_test():
    """`--self-test`: proves both required negative-test fixtures fail
    closed for the correct, distinct reason, and that the three real CD
    composites stay clean. Mirrors tests/dual-pin/lint.py's and
    tests/npm-package-ci/shape-validate.py's --self-test convention.
    """
    cases_failed = []

    def load_fixture(filename):
        path = os.path.join(FIXTURES_DIR, filename)
        if not os.path.isfile(path):
            return None, f"fixture not found: {path}"
        with open(path, "r", encoding="utf-8") as f:
            return f.read(), None

    def expect_violation_kind(filename, kind_substr, case_name, must_not_contain=None):
        text, err = load_fixture(filename)
        if err:
            cases_failed.append(f"{case_name}: {err}")
            return
        uses_refs, run_bodies, violations = run_checks_against_text(text, filename)
        if not violations:
            cases_failed.append(
                f"{case_name}: expected a violation in {filename}, but the "
                f"lint reported it as clean — negative fixture is NOT "
                f"failing closed"
            )
            return
        if not any(kind_substr in v for v in violations):
            cases_failed.append(
                f"{case_name}: {filename} produced violation(s) "
                f"{violations!r}, but none mention '{kind_substr}' — "
                f"failing for the WRONG reason"
            )
            return
        if must_not_contain and any(must_not_contain in v for v in violations):
            cases_failed.append(
                f"{case_name}: {filename} produced a violation containing "
                f"'{must_not_contain}', which this case must NOT trigger — "
                f"the two checks are conflated: {violations!r}"
            )
            return
        print(
            f"no-nested-reusable-workflow --self-test: {case_name} "
            f"correctly failed closed for the right reason "
            f"('{kind_substr}'): {violations[0]}"
        )

    def expect_clean(filename_or_path, case_name, real_target=False):
        if real_target:
            label, path = filename_or_path
            doc, err = load_yaml(path, label)
            if err:
                cases_failed.append(f"{case_name}: {err}")
                return
            text = None
        else:
            text, err = load_fixture(filename_or_path)
            if err:
                cases_failed.append(f"{case_name}: {err}")
                return
            label = filename_or_path

        if real_target:
            uses_refs, v1 = check_no_nested_reusable_workflow(label, doc)
            run_bodies, v2 = check_no_cd_stamp(label, doc)
            violations = v1 + v2
        else:
            uses_refs, run_bodies, violations = run_checks_against_text(text, label)

        if not uses_refs:
            cases_failed.append(
                f"{case_name}: expected at least one uses: ref in {label}, "
                f"found none — fixture/target is not exercising check 1 at all"
            )
            return
        if violations:
            cases_failed.append(
                f"{case_name}: expected {label} to be clean, got: "
                f"{violations!r} — false positive"
            )
            return
        print(f"no-nested-reusable-workflow --self-test: {case_name} correctly reported clean (no false positive)")

    # Negative fixture 1: nested same-repo reusable-workflow `uses:`.
    expect_violation_kind(
        "nested-reusable-workflow-same-repo.yml",
        "NESTED-REUSABLE-WORKFLOW violation",
        "same_repo_nested_uses_fails_closed",
        must_not_contain="CD-SIDE-STAMP",
    )

    # Negative fixture 1b: nested cross-repo reusable-workflow `uses:` — the
    # risk pointer in phases/05 explicitly calls out that BOTH the
    # same-repo and cross-repo forms must be covered, or the lint gives
    # false confidence on the form it doesn't check.
    expect_violation_kind(
        "nested-reusable-workflow-cross-repo.yml",
        "NESTED-REUSABLE-WORKFLOW violation",
        "cross_repo_nested_uses_fails_closed",
        must_not_contain="CD-SIDE-STAMP",
    )

    # Negative fixture 2: a deliberately introduced package.json-write step.
    expect_violation_kind(
        "cd-side-stamp-package-json.yml",
        "CD-SIDE-STAMP violation",
        "package_json_stamp_fails_closed",
        must_not_contain="NESTED-REUSABLE-WORKFLOW",
    )

    # Negative fixture 2b: a deliberately introduced .nuspec-write step
    # (the NuGet-side equivalent — the brief explicitly asks for this shape
    # too, not just the npm package.json case).
    expect_violation_kind(
        "cd-side-stamp-nuspec.yml",
        "CD-SIDE-STAMP violation",
        "nuspec_stamp_fails_closed",
        must_not_contain="NESTED-REUSABLE-WORKFLOW",
    )

    # Positive controls: the three REAL CD composites must all stay clean
    # under both checks — this is the lint's actual happy-path target.
    for label, path in CD_COMPOSITES:
        expect_clean((label, path), f"real_composite_clean__{label}", real_target=True)

    if cases_failed:
        for c in cases_failed:
            print(f"no-nested-reusable-workflow --self-test: FAIL: {c}", file=sys.stderr)
        return 1

    print(
        "no-nested-reusable-workflow --self-test: PASS (both negative-test "
        "fixture families — nested reusable-workflow uses: in same-repo and "
        "cross-repo form, and a CD-side stamp in package.json and .nuspec "
        "form — each fail closed for the right, distinct reason; all three "
        "real CD composites stay clean under both checks)"
    )
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        sys.exit(run_self_test())
    sys.exit(main())
