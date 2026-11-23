#!/usr/bin/env python3
"""
Fixture-diff lint: each fixture consumer's caller,
`tests/consumers/<flow>/.github/workflows/ci.yml`, is its flow's
`templates/<flow>/ci.yml` with only the differences the integration suite
needs. Anything else would mean the fixtures test a caller no consumer
copies, so the lint fails and names the file and the first key that differs.

Allowed differences:
  - the hashira CD step of the gated job (`publish` for npm and NuGet,
    `deploy` for static) may gain an `id:`, and for npm and NuGet may set
    or change the inputs that pick the publish target: `target`, `auth`,
    `npm_token`, `api_key` and `working_directory` (NuGet pushes from a
    directory whose nuget.config allows the throwaway HTTP feed);
  - for npm and NuGet only, a `services:` block on the gated job whose
    every service runs the flow's fake registry (Verdaccio, BaGetter),
    pinned by `@sha256:` digest;
  - the gated job's `environment:` may carry settings other than its name;
    the name must stay the same. Whether the environment has a required
    reviewer lives in the fixture repo's settings, not in YAML;
  - steps after the CD step: at least one, to verify what it published.

Everything else must be equal: the top-level keys, the job names, the
`ci` job, every other key of the gated job, the steps before the CD step,
and the CD step's other keys and inputs. Comments and key order do not
count. Every `skathio/hashira/...@<ref>` is compared without its `@<ref>`,
because hashira's integration job rewrites each ref to the commit under
test.

Run from the repo root:
  python3 tests/shape-lints/fixture-diff.py              # lint the repo
  python3 tests/shape-lints/fixture-diff.py --self-test  # negative fixtures

Needs python3 and PyYAML. Exits 0 on success, 1 on any difference.
"""

import os
import re
import sys

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FIXTURES = os.path.join(REPO_ROOT, "tests", "shape-lints", "fixtures", "fixture-diff")

# flow -> (gated job, hashira CD action, fake registry image name or None)
FLOWS = {
    "npm": ("publish", "npm-release", "verdaccio"),
    "nuget": ("publish", "nuget-push", "bagetter"),
    "static-webapp": ("deploy", "pages-deploy", None),
}
TARGET_INPUTS = {"target", "auth", "npm_token", "api_key", "working_directory"}
HASHIRA_REF = re.compile(r"(skathio/hashira/[^@\s'\"]+)@[^\s'\"]+")
DIGEST_PIN = re.compile(r"@sha256:[0-9a-f]{64}$")


class Difference(Exception):
    """The first difference found; its message names the key path."""


def normalized(value):
    """The YAML value with every `skathio/hashira/...@<ref>` cut at the `@`."""
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalized(item) for item in value]
    return HASHIRA_REF.sub(r"\1", value) if isinstance(value, str) else value


def load(path):
    with open(path, encoding="utf-8") as handle:
        return normalized(yaml.safe_load(handle))


def first_difference(want, have, where):
    """The key path of the first place `have` differs from `want`, or None."""
    if isinstance(want, dict) and isinstance(have, dict):
        keys = list(want) + [key for key in have if key not in want]
        children = ((want.get(key), have.get(key), f"{where}.{key}") for key in keys)
    elif isinstance(want, list) and isinstance(have, list) and len(want) == len(have):
        children = ((w, h, f"{where}[{i}]") for i, (w, h) in enumerate(zip(want, have)))
    else:
        return None if want == have else f"{where}: template has {want!r}, fixture has {have!r}"
    return next(filter(None, (first_difference(*child) for child in children)), None)


def require_equal(want, have, where):
    found = first_difference(want, have, where)
    if found:
        raise Difference(found)


def without(mapping, keys):
    return {key: value for key, value in (mapping or {}).items() if key not in keys}


def cd_index(steps, action, where):
    target = f"skathio/hashira/.github/actions/{action}"
    found = [i for i, step in enumerate(steps) if isinstance(step, dict) and step.get("uses") == target]
    if len(found) != 1:
        raise Difference(f"{where}.steps: expected one step using {target}, found {len(found)}")
    return found[0]


def env_name(environment):
    return environment.get("name") if isinstance(environment, dict) else environment


def check_services(services, registry, where):
    if not services:
        return
    if registry is None:
        raise Difference(f"{where}.services: only the npm and NuGet fixtures may run a fake registry")
    for name, service in services.items():
        image = str((service or {}).get("image", ""))
        if registry not in image.lower() or not DIGEST_PIN.search(image):
            raise Difference(f"{where}.services.{name}: image {image!r} is not {registry} pinned by @sha256 digest")


def check_cd_step(want, have, registry, where):
    require_equal(without(want, {"id", "with"}), without(have, {"id", "with"}), where)
    free = TARGET_INPUTS if registry else set()
    require_equal(without(want.get("with"), free), without(have.get("with"), free), f"{where}.with")


def check_steps(want_job, have_job, flow, where):
    _, action, registry = FLOWS[flow]
    want, have = want_job.get("steps") or [], have_job.get("steps") or []
    at_want, at_have = cd_index(want, action, f"template {where}"), cd_index(have, action, where)
    require_equal(want[:at_want], have[:at_have], f"{where}.steps before {action}")
    check_cd_step(want[at_want], have[at_have], registry, f"{where}.steps[{at_have}]")
    after_want, after_have = want[at_want + 1:], have[at_have + 1:]
    require_equal(after_want, after_have[:len(after_want)], f"{where}.steps after {action}")
    if len(after_have) <= len(after_want):
        raise Difference(f"{where}.steps: no verification step after {action}")


def check_gated(want_job, have_job, flow, where):
    _, _, registry = FLOWS[flow]
    free = {"steps", "environment", "services"}
    require_equal(without(want_job, free), without(have_job, free), where)
    require_equal(env_name(want_job.get("environment")), env_name(have_job.get("environment")), f"{where}.environment.name")
    check_services(have_job.get("services"), registry, where)
    check_steps(want_job, have_job, flow, where)


def check_flow(flow, template, fixture):
    """Raises Difference on the first difference between two parsed callers."""
    gated = FLOWS[flow][0]
    require_equal(without(template, {"jobs"}), without(fixture, {"jobs"}), "")
    want_jobs, have_jobs = template.get("jobs") or {}, fixture.get("jobs") or {}
    require_equal(sorted(want_jobs), sorted(have_jobs), "job names")
    require_equal(want_jobs.get("ci"), have_jobs.get("ci"), "jobs.ci")
    check_gated(want_jobs[gated], have_jobs[gated], flow, f"jobs.{gated}")


def check_files(flow, template_path, fixture_path, label):
    """A list holding one problem naming `label`, or an empty list."""
    try:
        check_flow(flow, load(template_path), load(fixture_path))
    except (Difference, OSError, yaml.YAMLError, KeyError, AttributeError, TypeError) as error:
        return [f"{label}: {str(error).lstrip('.')}"]
    return []


def lint(root):
    problems = []
    for flow in FLOWS:
        fixture = f"tests/consumers/{flow}/.github/workflows/ci.yml"
        template = os.path.join(root, "templates", flow, "ci.yml")
        problems += check_files(flow, template, os.path.join(root, fixture), fixture)
    return problems


# case file -> (flow, text the failure must contain, or None when it must pass)
SELF_TEST_CASES = {
    "npm-match.yml": ("npm", None),
    "npm-extra-verification.yml": ("npm", None),
    "static-match.yml": ("static-webapp", None),
    "npm-renamed.yml": ("npm", "name: template has 'ci', fixture has 'cix'"),
    "npm-ci-input.yml": ("npm", "jobs.ci.with"),
    "npm-gated-grant.yml": ("npm", "jobs.publish.permissions.actions"),
    "npm-gated-if-removed.yml": ("npm", "jobs.publish.if"),
    "npm-step-before-cd.yml": ("npm", "jobs.publish.steps before npm-release"),
    "npm-cd-version-changed.yml": ("npm", "jobs.publish.steps[1].with.version"),
    "npm-no-verification.yml": ("npm", "no verification step after npm-release"),
    "npm-registry-unpinned.yml": ("npm", "not verdaccio pinned by @sha256 digest"),
    "npm-environment-renamed.yml": ("npm", "jobs.publish.environment.name"),
    "static-services.yml": ("static-webapp", "only the npm and NuGet fixtures may run a fake registry"),
    "static-cd-with.yml": ("static-webapp", "jobs.deploy.steps[0].with"),
}


def self_test_case(case, flow, marker):
    template = os.path.join(FIXTURES, f"template-{flow}.yml")
    problems = check_files(flow, template, os.path.join(FIXTURES, case), case)
    if marker is None:
        return [f"{case}: expected a pass, got {problems}"] if problems else []
    if not any(marker in problem for problem in problems):
        return [f"{case}: expected a failure naming {marker!r}, got {problems}"]
    return []


def self_test():
    """The `*-match` and `*-extra-verification` cases must pass; every other
    case must fail for its own named reason."""
    failures = [f for case, (flow, marker) in SELF_TEST_CASES.items() for f in self_test_case(case, flow, marker)]
    for failure in failures:
        print(f"fixture-diff --self-test: FAIL: {failure}", file=sys.stderr)
    if failures:
        return 1
    negatives = sum(1 for _, marker in SELF_TEST_CASES.values() if marker)
    print(f"fixture-diff --self-test: PASS ({len(SELF_TEST_CASES) - negatives} allowed fixtures passed, "
          f"{negatives} negative fixtures failed)")
    return 0


def main(argv):
    if "--self-test" in argv:
        return self_test()
    problems = lint(REPO_ROOT)
    for problem in problems:
        print(f"fixture-diff: FAIL: {problem}", file=sys.stderr)
    if problems:
        return 1
    print(f"fixture-diff: PASS ({len(FLOWS)} fixture callers differ from templates/ only where allowed)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
