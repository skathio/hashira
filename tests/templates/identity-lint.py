#!/usr/bin/env python3
"""
Template-identity lint: each flow's caller exists once, as
`templates/<flow>/ci.yml`, and is copied word for word into two places a
consumer reads it from:

  - the first fenced YAML block in `docs/flows/<flow>.md` that calls the
    flow's reusable CI workflow, and
  - the first fenced YAML block in `README.md` that calls it.

"Identical" means the same lines in the same order: the block between the
fences equals the template file, with no line added, removed or changed. A
copy that drifts would hand consumers a caller nobody tested, so the lint
fails and names the file and the first line that differs.

Run from the repo root:
  python3 tests/templates/identity-lint.py              # lint the repo
  python3 tests/templates/identity-lint.py --self-test  # negative fixtures

Needs only python3. Exits 0 on success, 1 on any difference.
"""

import os
import re
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FIXTURES = os.path.join(REPO_ROOT, "tests", "templates", "fixtures")

# flow -> the reusable CI workflow its caller calls.
FLOWS = {
    "npm": "npm-package-ci.yml",
    "nuget": "nuget-package-ci.yml",
    "static-webapp": "static-webapp-ci.yml",
}
YAML_FENCE = re.compile(r"^```(?:yaml|yml)\s*$")


def read_lines(root, rel):
    path = os.path.join(root, rel)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as handle:
        return handle.read().splitlines()


def yaml_blocks(lines):
    """(1-based line number of the first body line, body lines) of each
    fenced YAML block, in order."""
    blocks, i = [], 0
    while i < len(lines):
        if not YAML_FENCE.match(lines[i]):
            i += 1
            continue
        end = next((j for j in range(i + 1, len(lines)) if lines[j].strip() == "```"), len(lines))
        blocks.append((i + 2, lines[i + 1:end]))
        i = end + 1
    return blocks


def caller_block(lines, workflow, template):
    """The first YAML block calling `workflow`. When none does, as after a
    typo in its `uses:` line, the block sharing the most lines with the
    template, so the typo is reported as a differing line. (None, None)
    when the file has no block sharing a line with the template."""
    needle = f"skathio/hashira/.github/workflows/{workflow}@"
    blocks = yaml_blocks(lines)
    calling = [b for b in blocks if any(needle in line for line in b[1])]
    if calling:
        return calling[0]
    wanted = set(template)
    shared = [(len(wanted.intersection(body)), -start, start, body) for start, body in blocks]
    best = max(shared, default=None)
    return (best[2], best[3]) if best and best[0] else (None, None)


def first_difference(template, copy):
    """0-based index of the first line where the two differ, or None."""
    for index in range(max(len(template), len(copy))):
        left = template[index] if index < len(template) else None
        right = copy[index] if index < len(copy) else None
        if left != right:
            return index
    return None


def describe(line):
    return "(no line)" if line is None else repr(line)


def compare(template_rel, template, copy_rel, first_line, copy):
    index = first_difference(template, copy)
    if index is None:
        return []
    left = template[index] if index < len(template) else None
    right = copy[index] if index < len(copy) else None
    return [
        f"{copy_rel}:{first_line + index}: differs from {template_rel}:{index + 1}\n"
        f"    {template_rel}:{index + 1}: {describe(left)}\n"
        f"    {copy_rel}:{first_line + index}: {describe(right)}"
    ]


def check_flow(root, flow, workflow):
    template_rel = f"templates/{flow}/ci.yml"
    template = read_lines(root, template_rel)
    if template is None:
        return [f"{template_rel}: missing"]
    problems = []
    for copy_rel in (f"docs/flows/{flow}.md", "README.md"):
        lines = read_lines(root, copy_rel)
        if lines is None:
            problems.append(f"{copy_rel}: missing")
            continue
        first_line, body = caller_block(lines, workflow, template)
        if body is None:
            problems.append(f"{copy_rel}: no ```yaml block calls {workflow} or shares a line with {template_rel}; copy it there")
            continue
        problems += compare(template_rel, template, copy_rel, first_line, body)
    return problems


def lint(root, flows):
    return [p for flow, workflow in flows.items() for p in check_flow(root, flow, workflow)]


def self_test():
    """Each fixture root holds one npm flow (template, docs, README). `match`
    must pass; every other case must fail and name the given file and line."""
    flows = {"npm": FLOWS["npm"]}
    expected = {
        "template-changed": "docs/flows/npm.md:11: differs from templates/npm/ci.yml:6",
        "docs-changed": "docs/flows/npm.md:13: differs from templates/npm/ci.yml:8",
        "readme-changed": "README.md:12: differs from templates/npm/ci.yml:3",
        "docs-last-line-lost": "docs/flows/npm.md:13: differs from templates/npm/ci.yml:8",
        "docs-uses-typo": "docs/flows/npm.md:11: differs from templates/npm/ci.yml:6",
        "readme-missing-block": "README.md: no ```yaml block",
    }
    failures = []
    if lint(os.path.join(FIXTURES, "match"), flows):
        failures.append("match: the identical fixture failed")
    for case, marker in expected.items():
        problems = lint(os.path.join(FIXTURES, case), flows)
        if not any(marker in problem for problem in problems):
            failures.append(f"{case}: expected a failure naming {marker!r}, got {problems}")
    for failure in failures:
        print(f"identity-lint --self-test: FAIL: {failure}", file=sys.stderr)
    if failures:
        return 1
    print(f"identity-lint --self-test: PASS (1 identical fixture passed, {len(expected)} negative fixtures failed)")
    return 0


def main(argv):
    if "--self-test" in argv:
        return self_test()
    problems = lint(REPO_ROOT, FLOWS)
    for problem in problems:
        print(f"identity-lint: FAIL: {problem}", file=sys.stderr)
    if problems:
        return 1
    print(f"identity-lint: PASS ({len(FLOWS)} templates match docs/flows and README.md)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
