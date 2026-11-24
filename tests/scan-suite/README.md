# scan-suite tests

This directory holds the unit tests for the `scan-suite` composite action's
JS shim (`.github/actions/scan-suite/lib/visibility-detect.js`).

## What's tested here

- `visibility-detect.test.js` — `node --test` unit tests for the
  public/private + GHAS detection helper. Covers the documented cases (see
  the test file for the exact list): public-no-field, public-disabled,
  private-enabled, private-no-field, private-disabled, forced override,
  forced=0 (no override), and missing-input defaults.

- `test_fail_on_findings.py` — runs the real `action.yml` steps and scanner
  sub-composites with a small local runner, stubbing only the third-party
  tools. Covers `fail_on_findings`: findings and errors fail the action after
  every enabled scanner ran and the summary was written; skips never fail it;
  the three CI workflows pass `'true'`.
- `test_fail_on_findings_guards.py` — a value other than `'true'`/`'false'`
  fails before any scanner runs, and the final check fails for a scanner that
  recorded no verdict.

Each scanner writes a `<name>\t<pass|fail|skipped>` line to
`${RUNNER_TEMP}/scan-suite-verdicts.tsv` next to its results row; the final
`Fail on findings` step reads that file.

## What's NOT tested here, and why

Each scan sub-composite under
`.github/actions/scan-suite/scans/<name>/action.yml` is a thin shell
orchestration around one third-party tool. There is no testable shell logic
"outside" of the single `uses:` call (codeql, osv, dependency-review) or
the single tool invocation (gitleaks, actionlint), so per-sub-step unit
tests in the off-runner sense don't exist. Their behavior is exercised by
the library self-CI in `.github/workflows/_self-ci.yml`:

- `scan-suite-default` — invokes the composite with the D10c default
  `scan_disable: 'codeql,actionlint'`. Asserts that the combined summary
  contains the expected ran/skipped markers for the five scans.
- `scan-suite-override` — invokes with an extended disable list including
  `gitleaks`. Asserts gitleaks appears as `skipped (consumer disabled)`.
- `scan-suite-codeql-skip-notice` — sets `HASHIRA_FORCE_PRIVATE_NO_GHAS=1` and
  enables codeql. Asserts codeql appears with the
  `CodeQL requires GHAS on private repos` skip notice.
- `visibility-detect-unit-tests` — runs the tests in this directory.

This is pragmatic, not ceremonial: the shell `case` blocks that map tool
exit codes to `ran/skipped/error` rows are the part with testable logic,
and they are exercised by the integration jobs above. Adding off-runner
shell harnesses (bats, mock GitHub context, etc.) would add maintenance
without catching bugs the integration runs miss.
