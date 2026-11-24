"""
Shared shape checks for the aggregate `passed` job of the three consumer CI
workflows (npm-package-ci, nuget-package-ci, static-webapp-ci). Each flow's
shape-validate.py imports this module, runs `check(doc)` on its workflow and,
in `--self-test` mode, `self_test(doc)`.

The job a branch ruleset requires as `ci / passed` must:
  - exist with id and name `passed`;
  - need exactly every other job of the workflow, so no result goes unjudged;
  - run with `if: always()`, so it reports when setup fails and when the run
    is cancelled (`!cancelled()` would not report on cancellation);
  - be the only job with `pull-requests: write`, since it writes the one CI
    summary comment;
  - check hashira out itself at `job.workflow_sha`, never through setup's
    `library_sha`, so it still runs when setup failed;
  - render through `./.hashira/.github/actions/ci-summary`;
  - set `timeout-minutes: 10`, so a hung comment call cannot hold the
    required check open for the runner's six-hour default;
  - not run actions/setup-node: ci-summary runs on the runner's own node,
    and every extra download is one more way for the required check to fail.
The `test` job's coverage-report step passes `comment: 'false'`, so the old
coverage comment is no longer written.
"""

import copy
import re

CI_SUMMARY = "./.hashira/.github/actions/ci-summary"
COVERAGE_REPORT = "./.hashira/.github/actions/coverage-report"


def _needs(job):
    needs = job.get("needs") or []
    return [needs] if isinstance(needs, str) else list(needs)


def _expression(value):
    text = str(value or "").strip()
    match = re.fullmatch(r"\$\{\{\s*(.*?)\s*\}\}", text)
    return (match.group(1) if match else text).replace(" ", "")


def _grants(job):
    perms = job.get("permissions")
    return perms if isinstance(perms, dict) else {}


def _steps(job):
    return job.get("steps") or []


def _check_passed(jobs, passed):
    errors = []
    if passed.get("name") != "passed":
        errors.append(f"job 'passed' must be named 'passed' (got {passed.get('name')!r})")
    needs = _needs(passed)
    if len(needs) != len(set(needs)):
        errors.append(f"job 'passed' lists a need twice: {needs}")
    expected = set(jobs) - {"passed"}
    if set(needs) != expected:
        errors.append(f"job 'passed' must need exactly every other job: missing "
                      f"{sorted(expected - set(needs))}, extra {sorted(set(needs) - expected)}")
    if _expression(passed.get("if")) != "always()":
        errors.append(f"job 'passed' must run with `if: always()` (got {passed.get('if')!r})")
    text = repr(passed)
    if "job.workflow_sha" not in text or "library_sha" in text:
        errors.append("job 'passed' must check hashira out at job.workflow_sha, not setup's library_sha")
    uses = [str(s.get("uses", "")) for s in _steps(passed)]
    if CI_SUMMARY not in uses:
        errors.append(f"job 'passed' must use {CI_SUMMARY}")
    return errors + _check_bounds(passed, uses)


def _check_bounds(passed, uses):
    errors = []
    if any(u.startswith("actions/setup-node@") for u in uses):
        errors.append("job 'passed' must not run actions/setup-node (ci-summary uses the runner's node)")
    if passed.get("timeout-minutes") != 10:
        errors.append(f"job 'passed' must set timeout-minutes: 10 (got {passed.get('timeout-minutes')!r})")
    return errors


def _check_test_job(jobs):
    reports = [s for s in _steps(jobs.get("test") or {}) if str(s.get("uses", "")) == COVERAGE_REPORT]
    if len(reports) != 1 or str((reports[0].get("with") or {}).get("comment")).lower() != "false":
        return ["job 'test' must call coverage-report once with comment: 'false'"]
    return []


def check(doc):
    """The list of problems with the `passed` job in workflow `doc`; empty when it is right."""
    jobs = doc.get("jobs") or {}
    passed = jobs.get("passed")
    if not isinstance(passed, dict):
        return ["missing job 'passed' (the `ci / passed` check a ruleset requires)"]
    errors = _check_passed(jobs, passed)
    writers = sorted(j for j, job in jobs.items() if _grants(job).get("pull-requests") == "write")
    if writers != ["passed"]:
        errors.append(f"only job 'passed' may hold pull-requests: write (held by {writers})")
    return errors + _check_test_job(jobs)


def _drop_need(doc, need):
    doc["jobs"]["passed"]["needs"] = [n for n in _needs(doc["jobs"]["passed"]) if n != need]


def _mutations():
    return {
        "passed job removed": lambda d: d["jobs"].pop("passed"),
        "passed renamed": lambda d: d["jobs"]["passed"].update(name="all-green"),
        "scan-suite need dropped": lambda d: _drop_need(d, "scan-suite"),
        "setup need dropped": lambda d: _drop_need(d, "setup"),
        "need listed twice": lambda d: d["jobs"]["passed"].update(needs=_needs(d["jobs"]["passed"]) + ["setup"]),
        "if weakened to !cancelled()": lambda d: d["jobs"]["passed"].update({"if": "${{ !cancelled() }}"}),
        "if removed": lambda d: d["jobs"]["passed"].pop("if"),
        "test gains pull-requests: write": lambda d: d["jobs"]["test"]["permissions"].update({"pull-requests": "write"}),
        "passed loses pull-requests: write": lambda d: d["jobs"]["passed"]["permissions"].pop("pull-requests"),
        "passed reads setup's library_sha": lambda d: d["jobs"]["passed"]["steps"].append(
            {"run": "echo ${{ needs.setup.outputs.library_sha }}"}),
        "ci-summary step removed": lambda d: d["jobs"]["passed"].update(
            steps=[s for s in _steps(d["jobs"]["passed"]) if s.get("uses") != CI_SUMMARY]),
        "passed runs setup-node": lambda d: d["jobs"]["passed"]["steps"].insert(
            0, {"uses": "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1"}),
        "passed timeout removed": lambda d: d["jobs"]["passed"].pop("timeout-minutes"),
        "passed timeout raised to 360": lambda d: d["jobs"]["passed"].update({"timeout-minutes": 360}),
        "test posts the coverage comment": lambda d: [s.get("with", {}).pop("comment", None)
                                                     for s in _steps(d["jobs"]["test"])],
    }


def self_test(doc):
    """(passed, messages): the real `doc` passes and each broken copy fails."""
    messages, ok = [], True
    real = check(doc)
    if real:
        return False, [f"precondition: the real workflow fails: {real}"]
    for name, mutate in _mutations().items():
        broken = copy.deepcopy(doc)
        mutate(broken)
        problems = check(broken)
        ok = ok and bool(problems)
        messages.append(f"{name}: {'correctly failed' if problems else 'WRONGLY PASSED'}"
                        f"{': ' + problems[0] if problems else ''}")
    return ok, messages


def report_check(doc, out):
    """Print each `check(doc)` problem to `out` as a FAIL line; True when there are none."""
    errors = check(doc)
    for err in errors:
        print(f"shape-validate: FAIL: {err}", file=out)
    return not errors


def report_self_test(doc, out, err_out):
    """Run `self_test(doc)`, print its messages to `out` and a FAIL line to
    `err_out` when a broken copy passed; True when every broken copy failed."""
    ok, messages = self_test(doc)
    for message in messages:
        print(f"shape-validate --self-test: passed job: {message}", file=out)
    if not ok:
        print("shape-validate --self-test: FAIL: a broken `passed` job passed the check", file=err_out)
    return ok
