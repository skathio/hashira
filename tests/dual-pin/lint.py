#!/usr/bin/env python3
"""
Dual-pin invariant lint (phase 4 iteration 4.1; decisions.md D9;
security.md §5/§6 AP8).

The invariant: for a consumer caller job that invokes one of hashira's CI
reusable workflows via `uses: <repo>/.github/workflows/<file>@<sha>` AND
passes a `library_ref:` input to that SAME job, the `uses:` ref and
`library_ref` MUST resolve to:
  (1) the SAME REPOSITORY — `skathio/hashira`, the name every kept CI
      reusable workflow's in-repo composite-action self-checkout is
      hardcoded to (D9; the self-checkout mechanism itself is D14 in
      `shared-cicd-workflows`'s decisions.md — a different decision file).
      A `uses:` ref naming any other repository invokes a different copy
      of the reusable workflow than the one this check can vouch for, even
      if the commit SHA looks right.
  (2) the SAME COMMIT — `uses:`'s SHA and `library_ref` must be identical.
      Three outcomes, not two: both real SHAs and equal (clean); both real
      SHAs and different (SAME-SHA violation, AP8's same-repo-different-
      commit attack); or exactly one side a real SHA and the other not (a
      moving branch ref like `main`, or the unresolved `<40-char-sha>`
      placeholder) — a NON-PINNED-LIBRARY-REF violation, its own distinct
      kind and AP8's single most acute case: a caller whose `uses:` line
      LOOKS fully pinned but whose `library_ref` is not fixed at all. The
      one case that stays clean despite neither side being a real SHA is
      BOTH sides being the identical placeholder — a legitimate template
      pair, not a real mismatch to assert.

This is deliberately a STATIC/TEXTUAL check, not a runtime one. GitHub
Actions resolves a `uses:` ref's `@<ref>` portion at workflow-parse time,
before any job runs — there is no runtime API for a workflow to
introspect its own (or a sibling job's) resolved `uses:` ref for
comparison. The source YAML text is the only place this is checkable.

Scope of this file's APPROACH, not just its check: the regex/text-scan
style below is scoped to LEXICAL, cross-node-string-equality checks ("does
this string equal that string"), which is all the dual-pin invariant ever
asks. A STRUCTURAL invariant (e.g. a future lint reachability-checking "is
there a nested `uses:` reusable-workflow reference inside a CD composite
action's call tree" — a graph question) should use the established PyYAML
tree-walk pattern instead (tests/npm-package-ci/shape-validate.py's
`collect_uses`-style approach), not copy this file's regex just because
it's the most recent precedent. This file's own regex-vs-PyYAML choice is
not being re-litigated (confirmed correct for this check by two
independent reviewers) — this note only scopes the choice for others.

Scope (phase 4.1's acceptance correction, carried from the phase file):
this lint validates hashira's OWN fixtures/templates for INTERNAL
consistency. It cannot reach into a live consumer's repository to read
their actual outer `uses:` SHA — that's invisible to hashira's self-CI by
construction. The real consumer-side proof that the dual-pin holds in
practice is Phase 6.3 (rogue's actual migration).

Targets checked:
  - tests/dual-pin/caller-fixture.yml — the canonical, lint-owned example
    of a correctly dual-pinned caller (must PASS).

Deliberately NOT checked here: docs/flows/*.md, README.md, docs/usage.md.
A first implementation pass also ran this lint's logic against those doc
caller templates as a "bonus" consistency net — and it correctly found
real, pre-existing `uses:` lines in README.md/docs/flows/{nuget,
static-webapp}.md still naming the library's pre-rename repository (28
occurrences total). That finding is real, but fixing it is iteration 4.4's
job (the full repo-wide naming-cleanup sweep), not 4.1's — 4.4 has its own
acceptance criterion and its own files-touched list, sequenced separately
from this lint job. Wiring this lint to also check docs would make 4.1's
self-CI job fail on work that is correctly still pending in a sibling
iteration — scope creep into 4.4's acceptance criterion, not 4.1's.
`run_self_test()`'s helper functions still operate generically over any
text blob, so re-pointing this lint at docs (once 4.4 lands) is a one-line
addition to `collect_targets()`, not a redesign — left as a note for
whoever picks that up, not done here.

Count-independent by construction: every occurrence of the
`uses: <repo>/.../<workflow>.yml@<sha>` + `library_ref:` pairing found in a
target is checked on its own merits via a loop over `len(matches)`
pairings — never a hardcoded expected count (decisions.md#d9's own
correction history: this exact "hand-counted, wrong twice" defect class is
what this lint must not repeat).

Run from repo root: python3 tests/dual-pin/lint.py
Exits 0 on success; non-zero with a clear, per-violation error otherwise.

Pure python3 standard library (re/glob/os) — no PyYAML dependency. The
dual-pin pattern spans a `uses:` line and a sibling `library_ref:` value
inside an adjacent `with:` block, which a full YAML parse doesn't make
meaningfully easier to extract than line-anchored regex does, and regex
extraction generalizes directly to the prose/markdown doc targets (which
aren't YAML documents at all — they're fenced code blocks inside .md
files), unlike tests/npm-package-ci/shape-validate.py's structural
job-graph checks, which need real YAML semantics (job/step/output
connectivity) that a markdown caller template never has to satisfy.
"""

import os
import re
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# The three kept CI reusable workflows whose in-repo composite-action
# self-checkout `repository:` field must all agree — this is the fixed
# point CANONICAL_REPO below is derived from, not a value frozen into a
# comment and trusted forever (the exact "hardcoded fact baked into a
# comment" shape decisions.md#d9 was corrected for, one layer up from the
# count it already avoided hardcoding).
KEPT_CI_WORKFLOWS = [
    "npm-package-ci.yml",
    "nuget-package-ci.yml",
    "static-webapp-ci.yml",
]

REPOSITORY_FIELD_RE = re.compile(r"^\s*repository:\s*(\S+)\s*$", re.MULTILINE)


def derive_canonical_repo():
    """Read the actual `repository:` field out of each of the three kept CI
    workflows' self-checkout steps and assert they all agree. Returns that
    single agreed-upon value — the fixed point the "same repository" half
    of the dual-pin invariant checks a caller's `uses:` ref against.
    Fails loudly (raises) rather than falling back to a guessed default if
    the files disagree or none can be found, since a silent fallback here
    would reintroduce exactly the staleness risk this self-validation
    exists to close.
    """
    seen = {}
    for fname in KEPT_CI_WORKFLOWS:
        path = os.path.join(REPO_ROOT, ".github", "workflows", fname)
        if not os.path.isfile(path):
            raise RuntimeError(
                f"dual-pin-lint: cannot derive CANONICAL_REPO — kept CI "
                f"workflow not found at {path}"
            )
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        values = set(REPOSITORY_FIELD_RE.findall(text))
        if not values:
            raise RuntimeError(
                f"dual-pin-lint: cannot derive CANONICAL_REPO — no "
                f"`repository:` field found in {fname}"
            )
        seen[fname] = values

    all_values = set()
    for values in seen.values():
        all_values |= values
    if len(all_values) != 1:
        raise RuntimeError(
            f"dual-pin-lint: cannot derive CANONICAL_REPO — the kept CI "
            f"workflows' `repository:` fields disagree: {seen!r}. This "
            f"must be resolved (a real naming-drift regression) before "
            f"the dual-pin invariant can be checked against a single "
            f"fixed point."
        )
    return all_values.pop()


# The canonical, post-Phase-1 repository name every kept CI reusable
# workflow's in-repo composite-action self-checkout is hardcoded to
# (decisions.md D9; the self-checkout mechanism itself is D14 in
# `shared-cicd-workflows`'s decisions.md). Self-validated at import time
# against the three kept CI workflows' actual `repository:` fields, rather
# than trusted as a value frozen into a comment — see derive_canonical_repo
# above. This is the fixed point the "same repository" half of the
# invariant checks the caller's `uses:` ref against.
CANONICAL_REPO = derive_canonical_repo()

# A real hex SHA: 40 lowercase hex characters.
SHA_RE = r"[0-9a-f]{40}"

# Both regexes capture their ref token GENERICALLY (`[^\s'"]+`) rather than
# enumerating which ref shapes may form a pairing. Pass 2 instead widened an
# allowlist (SHA | placeholder | literal `main`) — and that allowlist was
# itself the bug: any value outside it (`develop`, `v2`, a garbage string)
# failed to match, so find_pairings() never formed a pairing for it, so
# check_pairing() never ran — the silent-skip pass 1 named, just narrowed to
# one input. Classifying a ref as a real SHA or not is check_pairing()'s
# job (via re.fullmatch(SHA_RE, ...)), generically, for ANY captured value —
# the regex's only job is to capture, not pre-judge.

# Matches a caller job's `uses: <repo>/.github/workflows/<file>@<ref>` line.
# `<repo>` and `<ref>` are both captured generously/generically — rejecting
# a mismatched repo or an unpinned ref is check_pairing()'s job, not the
# regex's.
USES_RE = re.compile(
    r"^\s*uses:\s*([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/\.github/workflows/"
    r"([A-Za-z0-9_.-]+\.ya?ml)@([^\s'\"]+)\s*(?:#.*)?$",
    re.MULTILINE,
)

# Matches a `library_ref:` input value, quoted or bare — same generic
# capture as USES_RE's ref group above, same reason.
LIBRARY_REF_RE = re.compile(
    r"^\s*library_ref:\s*['\"]?([^\s'\"]+)['\"]?",
    re.MULTILINE,
)

PLACEHOLDER = "<40-char-sha>"


def fail(msg):
    print(f"dual-pin-lint: FAIL: {msg}", file=sys.stderr)


def find_pairings(text, source_label):
    """Find every (uses_repo, uses_workflow, uses_sha, library_ref_value)
    pairing in `text` by walking line-by-line and associating each `uses:`
    match with the nearest following `library_ref:` match that appears
    before the next `uses:` match (i.e. within the same job's `with:`
    block). Returns a list of dicts — count-independent: however many
    pairings are found, each is checked on its own.

    A `uses:` match with no following `library_ref:` before the next
    `uses:` (or EOF) is not a dual-pin occurrence at all (e.g. a
    third-party action `uses:` with no `library_ref` sibling) and is
    skipped — this lint only asserts the invariant where BOTH halves of
    the pattern are actually present, per the iteration's scope (a caller
    invoking a hashira CI reusable workflow with a `library_ref` input).
    """
    uses_matches = list(USES_RE.finditer(text))
    pairings = []
    for i, um in enumerate(uses_matches):
        start = um.end()
        end = uses_matches[i + 1].start() if i + 1 < len(uses_matches) else len(text)
        window = text[start:end]
        lrm = LIBRARY_REF_RE.search(window)
        if not lrm:
            continue
        pairings.append({
            "source": source_label,
            "uses_repo": um.group(1),
            "uses_workflow": um.group(2),
            "uses_sha": um.group(3),
            "library_ref": lrm.group(1),
        })
    return pairings


def check_pairing(p):
    """Assert both halves of the invariant for one pairing. Returns a list
    of violation strings (empty list = invariant holds). Each violation
    names the specific field and which half of the invariant it violates,
    per the iteration's observability requirement — never a generic
    "lint failed" message.
    """
    violations = []

    uses_repo = p["uses_repo"]
    uses_sha = p["uses_sha"]
    lib_ref = p["library_ref"]

    # Half 1: SAME REPOSITORY. The caller's `uses:` ref must target the
    # canonical repository the library's own in-repo composite-action
    # self-checkout (D9; the self-checkout mechanism itself is documented
    # as D14 in `shared-cicd-workflows`'s decisions.md, a different decision
    # file from this work item's) is hardcoded to. (library_ref carries no
    # repository component of its own post-D14 — it's a bare ref consumed by
    # a hardcoded `repository: skathio/hashira` checkout step inside the
    # called workflow — so this half is checked against the canonical name,
    # not against library_ref's value.)
    if uses_repo != CANONICAL_REPO:
        violations.append(
            f"[{p['source']}] SAME-REPOSITORY violation: `uses:` targets "
            f"repository '{uses_repo}' for workflow '{p['uses_workflow']}', "
            f"but the library's own in-repo composite-action self-checkout "
            f"is hardcoded to '{CANONICAL_REPO}' (D9). A caller pinned to "
            f"any other repository invokes a different copy of the reusable "
            f"workflow than the one this check can vouch for, even though "
            f"library_ref='{lib_ref}' may look correctly pinned."
        )

    # Half 2: SAME COMMIT. The outer `uses:` SHA and `library_ref` must be
    # identical hex SHAs. Three cases, not two:
    #   (a) both real SHAs, equal            -> clean (the happy path).
    #   (b) both real SHAs, different        -> SAME-SHA violation (AP8),
    #       the same-repo-different-commit attack.
    #   (c) exactly one side is a real SHA and the other is NOT (a moving
    #       branch ref like `main`, or the literal `<40-char-sha>`
    #       placeholder) -> NON-PINNED-LIBRARY-REF violation (AP8), its own
    #       distinct kind. This is NOT skipped: a real-SHA `uses:` pin next
    #       to `library_ref: main` is a pinned-LOOKING caller that actually
    #       executes whatever `main` resolves to at call time — the single
    #       most acute instance of AP8, and silently skipping it (the
    #       lint's original behavior) defeated the whole check.
    # The ONLY case that stays clean despite neither side being a real SHA
    # is BOTH sides being the identical `<40-char-sha>` placeholder — that
    # is a legitimate doc/template pair expressing "same as itself"
    # generically, not a real pairing with a real mismatch to report.
    uses_sha_is_real = bool(re.fullmatch(SHA_RE, uses_sha))
    lib_ref_is_real = bool(re.fullmatch(SHA_RE, lib_ref))
    both_placeholder = uses_sha == PLACEHOLDER and lib_ref == PLACEHOLDER

    if uses_sha_is_real and lib_ref_is_real:
        if uses_sha != lib_ref:
            violations.append(
                f"[{p['source']}] SAME-SHA violation (AP8): `uses:` pins workflow "
                f"'{p['uses_workflow']}' to commit '{uses_sha}', but "
                f"library_ref='{lib_ref}' resolves to a DIFFERENT commit in the "
                f"SAME repository ('{CANONICAL_REPO}'). The in-repo composite "
                f"actions this call actually executes are determined by "
                f"library_ref, not by the `uses:` pin a reviewer reads — this is "
                f"the same-repository-different-commit attack the dual-pin "
                f"invariant exists to close."
            )
    elif not both_placeholder:
        violations.append(
            f"[{p['source']}] NON-PINNED-LIBRARY-REF violation (AP8): `uses:` "
            f"pins workflow '{p['uses_workflow']}' to "
            f"{'commit ' + repr(uses_sha) if uses_sha_is_real else 'a non-SHA value ' + repr(uses_sha)}, "
            f"and library_ref={lib_ref!r} is "
            f"{'a real commit' if lib_ref_is_real else 'NOT a real, fixed commit'} — "
            f"the two sides are not both real, equal SHAs. A caller whose "
            f"`uses:` line looks pinned (a real 40-char SHA) but whose "
            f"`library_ref` is a moving branch name, tag, or unresolved "
            f"placeholder actually executes whatever that moving ref "
            f"resolves to at call time inside the in-repo composite actions — "
            f"this is the single most acute instance of AP8: a caller that "
            f"LOOKS fully pinned but is not."
        )

    return violations


def collect_targets():
    """Return [(path, label)] for every file this lint inspects. See the
    module docstring's "Targets checked" section for why this is currently
    just the one owned fixture, not docs/flows/*.md or README.md.
    """
    fixture = os.path.join(REPO_ROOT, "tests", "dual-pin", "caller-fixture.yml")
    return [(fixture, "tests/dual-pin/caller-fixture.yml")]


def run_against_text(text, label):
    """Run the lint against one in-memory text blob. Returns a list of
    violation strings (empty = clean). Exposed separately from main() so
    --self-test can feed deliberately-broken text without touching disk.
    """
    pairings = find_pairings(text, label)
    violations = []
    for p in pairings:
        violations.extend(check_pairing(p))
    return pairings, violations


def main():
    targets = collect_targets()
    total_pairings = 0
    all_violations = []

    for path, label in targets:
        if not os.path.isfile(path):
            fail(f"target not found: {path}")
            return 1
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        pairings, violations = run_against_text(text, label)
        total_pairings += len(pairings)
        for p in pairings:
            print(
                f"dual-pin-lint: found pairing in {label}: "
                f"uses={p['uses_repo']}/.../{p['uses_workflow']}@{p['uses_sha']}  "
                f"library_ref={p['library_ref']}"
            )
        all_violations.extend(violations)

    if total_pairings == 0:
        fail(
            "no uses:+library_ref pairings found across any target — the "
            "lint has nothing to check (this would silently pass with zero "
            "coverage, which is itself a failure of this lint's purpose)"
        )
        return 1

    if all_violations:
        for v in all_violations:
            fail(v)
        print(
            f"dual-pin-lint: FAIL ({len(all_violations)} violation(s) across "
            f"{total_pairings} pairing(s) checked)",
            file=sys.stderr,
        )
        return 1

    print(
        f"dual-pin-lint: PASS ({total_pairings} uses:+library_ref pairing(s) "
        f"checked across {len(targets)} target(s); same-repository holds for "
        f"every pairing, and every pairing is either both-real-SHAs-and-equal "
        f"or the shared `<40-char-sha>` placeholder template on both sides)"
    )
    return 0


def run_self_test():
    """`--self-test`: confirms the lint's THREE violation classes (same-repo
    mismatch; same-repo-different-SHA / AP8; asymmetric real-SHA-vs-not
    mismatch / AP8) are each individually detectable, each asserted to fail
    for ITS OWN kind and NOT the other SHA-comparison kind (no conflation
    between SAME-SHA and NON-PINNED-LIBRARY-REF). The asymmetric class is
    exercised by THREE cases: `library_ref: main` (original repro),
    `library_ref: develop` (pass 3's regression lock — a non-`main` branch,
    proving the fix is a generic ref capture, not another single-value
    allowlist entry), and the MIRROR direction (outer `uses:` itself
    unpinned, `library_ref` a real SHA). Also confirms the canonical
    positive fixture and a synthetic placeholder-vs-placeholder pairing
    produce ZERO violations. The regression lock referenced by the
    iteration's diary entry: proves the lint fails closed on every
    negative-test shape for the SPECIFIC reason, and a correct (or
    template) dual-pin does not spuriously trip any check.
    """
    cases_failed = []

    def load(path_rel_or_text, case_name, in_memory):
        # Shared by expect_violation_kind/expect_clean below.
        if in_memory:
            return path_rel_or_text, case_name
        path = os.path.join(REPO_ROOT, path_rel_or_text)
        if not os.path.isfile(path):
            cases_failed.append(f"{case_name}: fixture not found at {path_rel_or_text}")
            return None
        with open(path, "r", encoding="utf-8") as f:
            return f.read(), path_rel_or_text

    def expect_violation_kind(path_rel, kind_substr, case_name, must_not_contain=None, in_memory=False):
        loaded = load(path_rel, case_name, in_memory)
        if loaded is None:
            return
        text, label = loaded
        pairings, violations = run_against_text(text, label)
        if not pairings:
            cases_failed.append(
                f"{case_name}: expected at least one uses:+library_ref "
                f"pairing in {label}, found none — fixture is not "
                f"exercising the lint's parser at all"
            )
            return
        if not violations:
            cases_failed.append(
                f"{case_name}: expected a violation in {label}, but the "
                f"lint reported the invariant as holding — negative fixture "
                f"is NOT failing closed"
            )
            return
        if not any(kind_substr in v for v in violations):
            cases_failed.append(
                f"{case_name}: {label} produced violation(s) "
                f"{violations!r}, but none mention '{kind_substr}' — the "
                f"fixture is failing for the WRONG reason, not the one it's "
                f"named for"
            )
            return
        if must_not_contain and any(must_not_contain in v for v in violations):
            cases_failed.append(
                f"{case_name}: {label} produced a violation containing "
                f"'{must_not_contain}', which this case must NOT trigger — "
                f"the two violation kinds are conflated, not distinct: "
                f"{violations!r}"
            )
            return
        print(
            f"dual-pin-lint --self-test: {case_name} correctly failed closed "
            f"for the right reason ('{kind_substr}'): {violations[0]}"
        )

    def expect_clean(path_rel_or_text, case_name, in_memory=False):
        loaded = load(path_rel_or_text, case_name, in_memory)
        if loaded is None:
            return
        text, label = loaded
        pairings, violations = run_against_text(text, label)
        if not pairings:
            cases_failed.append(
                f"{case_name}: expected at least one uses:+library_ref "
                f"pairing in {label}, found none"
            )
            return
        if violations:
            cases_failed.append(
                f"{case_name}: expected {label} to be clean (no "
                f"violations), got: {violations!r} — false positive"
            )
            return
        print(f"dual-pin-lint --self-test: {case_name} correctly reported clean (no false positive)")

    # Negative fixture 1: same-repository mismatch.
    expect_violation_kind(
        "tests/dual-pin/fixtures/same-repo-mismatch.yml",
        "SAME-REPOSITORY violation",
        "same_repo_mismatch_fails_closed",
    )

    # Negative fixture 2: same-repository, different-SHA (AP8).
    expect_violation_kind(
        "tests/dual-pin/fixtures/same-repo-different-sha.yml",
        "SAME-SHA violation (AP8)",
        "same_repo_different_sha_fails_closed_ap8",
        must_not_contain="NON-PINNED-LIBRARY-REF",
    )

    # Negative fixture 3: asymmetric mismatch — a real-SHA `uses:` paired
    # with `library_ref: main` (pass 1 review's convergent Major: this exact
    # scenario was previously silently SKIPPED, producing zero violations,
    # the single most acute instance of AP8). Must fail with its OWN
    # distinct violation kind, not be conflated with the SAME-SHA kind
    # above (there is no second real SHA here to "differ" from).
    expect_violation_kind(
        "tests/dual-pin/fixtures/non-pinned-library-ref.yml",
        "NON-PINNED-LIBRARY-REF violation (AP8)",
        "non_pinned_library_ref_fails_closed_ap8",
        must_not_contain="SAME-SHA violation",
    )

    # Negative fixture 4: the same asymmetric mismatch with a non-`main`
    # branch (`develop`) — pass 3's regression lock for the gap a regex
    # allowlist left open (pass 2 only recognized the literal `main`).
    expect_violation_kind(
        "tests/dual-pin/fixtures/non-pinned-library-ref-branch.yml",
        "NON-PINNED-LIBRARY-REF violation (AP8)",
        "non_pinned_library_ref_branch_fails_closed_ap8",
        must_not_contain="SAME-SHA violation",
    )

    # Synthetic in-memory control: the MIRROR direction — outer `uses:`
    # itself unpinned (a branch), `library_ref` a real SHA. USES_RE had the
    # identical allowlist gap; confirms check_pairing()'s existing
    # uses_sha_is_real/lib_ref_is_real branching already classifies this
    # combination correctly with zero logic changes.
    expect_violation_kind(
        "    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@main\n"
        "    with:\n"
        "      library_ref: '4c1f3a8b2e6d9057a1c4f8e3b6d2a9c7e5f01234'\n",
        "NON-PINNED-LIBRARY-REF violation (AP8)",
        "mirror_unpinned_uses_fails_closed_ap8",
        must_not_contain="SAME-SHA violation",
        in_memory=True,
    )

    # Synthetic in-memory control: a `uses:` line carrying a trailing inline
    # comment (e.g. a human-readable version annotation, common in real
    # caller snippets and in iteration 4.4's eventual doc targets). USES_RE
    # was previously end-anchored with no comment tolerance, so this shape
    # alone formed ZERO pairings — the same silent-skip class this iteration
    # has been closing, just on the comment axis rather than the ref-value
    # axis. Currently unreachable by this lint's sole on-disk target
    # (caller-fixture.yml has no trailing comments), but locked in now
    # rather than left to be rediscovered once 4.4 points this lint at
    # doc/README caller templates that do carry version comments.
    expect_violation_kind(
        "    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@4c1f3a8b2e6d9057a1c4f8e3b6d2a9c7e5f01234  # v1.2.3\n"
        "    with:\n"
        "      library_ref: develop\n",
        "NON-PINNED-LIBRARY-REF violation (AP8)",
        "uses_with_trailing_comment_still_forms_pairing",
        must_not_contain="SAME-SHA violation",
        in_memory=True,
    )

    # Positive control: the canonical fixture must be clean.
    expect_clean(
        "tests/dual-pin/caller-fixture.yml",
        "canonical_fixture_is_clean",
    )

    # Synthetic in-memory control: placeholder-vs-placeholder (the
    # legitimate template shape) must stay clean despite neither side being
    # a real SHA — distinguishing it from the asymmetric-mismatch cases
    # above (any of which DOES trip the new check; only the literal,
    # identical `<40-char-sha>` placeholder on both sides is exempt).
    expect_clean(
        "    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@<40-char-sha>\n"
        "    with:\n"
        "      library_ref: '<40-char-sha>'\n",
        "placeholder_vs_placeholder_stays_clean",
        in_memory=True,
    )

    if cases_failed:
        for c in cases_failed:
            print(f"dual-pin-lint --self-test: FAIL: {c}", file=sys.stderr)
        return 1

    print("dual-pin-lint --self-test: PASS (all negative fixtures/cases fail closed for the right, distinct reason — including a non-main branch ref and the mirror unpinned-uses direction; positive fixture and the placeholder-template shape both stay clean)")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        sys.exit(run_self_test())
    sys.exit(main())
