#!/usr/bin/env python3
"""
Shape lint for .github/workflows/release.yml, the workflow that pushes
hashira's release tags.

What it holds, because each one guards a tag consumers pin to:
  - release.yml runs only by workflow_dispatch.
  - Exactly one job mints the release App's token
    (actions/create-github-app-token), and that job declares the
    `production` environment, so nothing is pushed before the owner approval.
    No other job is in `production`.
  - No job but that one reads a secret or passes `secrets:`, so the App's key
    never reaches a job that runs before the approval or runs npm code.
  - No step names v1 or v2. Those majors are frozen: their consumers still
    pass `library_ref`, and moving either tag would break them.
  - Nothing deletes a tag.
  - The docs build runs before the push, so a broken build stops the release.

Run from anywhere: python3 tests/shape-lints/release-lint.py
`--self-test` mutates the real release.yml in memory and checks that each
mutation fails for its own reason, and that the real file stays clean.
Needs PyYAML, as the other shape lints do.
"""

import os
import re
import sys

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RELEASE = os.path.join(REPO_ROOT, ".github", "workflows", "release.yml")
APP_TOKEN = "actions/create-github-app-token"
FROZEN = re.compile(r"\bv[12]\b")
TAG_DELETE = re.compile(
    r"git\s+tag\s+(-d|--delete)\b|git\s+push\b[^\n]*(\s-d\b|--delete\b|\s:refs/tags/)"
    r"|-X\s*DELETE[^\n]*git/refs|--method\s+DELETE[^\n]*git/refs")


def dump(node):
    return yaml.safe_dump(node, default_flow_style=False, width=10000)


def steps(job):
    return job.get("steps") or []


def env_name(job):
    env = job.get("environment")
    return env.get("name") if isinstance(env, dict) else env


def needs(job):
    value = job.get("needs") or []
    return [value] if isinstance(value, str) else list(value)


def ancestors(jobs, name):
    seen, todo = set(), needs(jobs[name])
    while todo:
        parent = todo.pop()
        if parent not in seen and parent in jobs:
            seen.add(parent)
            todo.extend(needs(jobs[parent]))
    return seen


def triggers(doc):
    # PyYAML reads the bare key `on` as the boolean True.
    on = doc.get("on", doc.get(True)) or {}
    if isinstance(on, str):
        return {on}
    return set(on)


def push_jobs(jobs):
    return [n for n, j in jobs.items() if any(APP_TOKEN in str(s.get("uses", "")) for s in steps(j))]


def check_push_job(jobs):
    pushers = push_jobs(jobs)
    if len(pushers) != 1:
        return None, [f"exactly one job must mint the App token, found {pushers}"]
    push = pushers[0]
    errors = []
    if env_name(jobs[push]) != "production":
        errors.append(f"job {push} pushes tags but does not declare environment production")
    others = [n for n, j in jobs.items() if n != push and env_name(j) == "production"]
    if others:
        errors.append(f"only the pushing job may be in production, also: {others}")
    return push, errors


def check_secrets(jobs, push):
    errors = []
    for name, job in jobs.items():
        if name != push and ("secrets" in job or "secrets." in dump(job)):
            errors.append(f"job {name} reads or passes a secret; only {push} may")
    return errors


def check_frozen(jobs):
    return [f"a step of job {name} names v1 or v2, which are frozen"
            for name, job in jobs.items() for step in steps(job) if FROZEN.search(dump(step))]


def check_docs_first(jobs, push):
    docs = [n for n, j in jobs.items()
            if any("docs-site/build.sh" in str(s.get("run", "")) for s in steps(j))]
    if not docs or not push or not set(docs) & ancestors(jobs, push):
        return ["the docs build (docs-site/build.sh) must run in a job the pushing job needs"]
    return []


def lint_text(text):
    """Every violation in a release.yml text; empty when it is clean."""
    doc = yaml.safe_load(text) or {}
    jobs = doc.get("jobs") or {}
    errors = []
    if triggers(doc) != {"workflow_dispatch"}:
        errors.append(f"release.yml must run only by workflow_dispatch, has {sorted(map(str, triggers(doc)))}")
    if TAG_DELETE.search(text):
        errors.append("release.yml must never delete a tag")
    push, push_errors = check_push_job(jobs)
    errors += push_errors + check_frozen(jobs) + check_docs_first(jobs, push)
    if push:
        errors += check_secrets(jobs, push)
    return errors


def main():
    with open(RELEASE, encoding="utf-8") as handle:
        errors = lint_text(handle.read())
    for error in errors:
        print(f"release-lint: FAIL: {error}", file=sys.stderr)
    if errors:
        return 1
    print("release-lint: PASS")
    return 0


def first_step_of(text, job, step_lines):
    """`text` with a step inserted first in `job`'s steps."""
    lines = text.splitlines(keepends=True)
    head = next(i for i, line in enumerate(lines) if re.match(rf"^  {re.escape(job)}:\s*$", line))
    at = next(i for i in range(head + 1, len(lines)) if lines[i].strip() == "steps:")
    pad = lines[at + 1][:len(lines[at + 1]) - len(lines[at + 1].lstrip())]
    block = [f"{pad}- {step_lines[0]}\n"] + [f"{pad}  {s}\n" for s in step_lines[1:]]
    return "".join(lines[:at + 1] + block + lines[at + 1:])


def mutations(text):
    jobs = (yaml.safe_load(text) or {}).get("jobs") or {}
    push = push_jobs(jobs)[0]
    other = next(n for n, j in jobs.items() if steps(j) and n != push)
    return {
        "pushing job without production": (re.sub(r"\bproduction\b", "staging", text), "production"),
        "step naming v1": (first_step_of(text, other, ["run: git tag -f v1 HEAD"]), "frozen"),
        "step naming v2": (first_step_of(text, other, ["run: git push origin HEAD:refs/tags/v2"]), "frozen"),
        "secret outside the pushing job": (first_step_of(text, other, [
            "run: echo ok", "env:", "  LEAK: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}"]), "secret"),
        "a push trigger": (text.replace("\non:\n", "\non:\n  push:\n", 1), "workflow_dispatch"),
        "a tag deletion": (first_step_of(text, push, ["run: git push --delete origin v9"]), "delete"),
    }


def run_self_test():
    with open(RELEASE, encoding="utf-8") as handle:
        text = handle.read()
    failed = []
    if lint_text(text):
        failed.append(f"the real release.yml is not clean: {lint_text(text)}")
    for label, (mutated, reason) in mutations(text).items():
        errors = lint_text(mutated)
        if not any(reason in e for e in errors):
            failed.append(f"{label}: expected a '{reason}' failure, got {errors}")
        else:
            print(f"release-lint --self-test: {label} fails closed")
    for case in failed:
        print(f"release-lint --self-test: FAIL: {case}", file=sys.stderr)
    if failed:
        return 1
    print("release-lint --self-test: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(run_self_test() if "--self-test" in sys.argv[1:] else main())
