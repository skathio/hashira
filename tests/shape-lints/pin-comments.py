#!/usr/bin/env python3
"""
Lint for the version comments of SHA-pinned actions.

CLAUDE.md pins every third-party action to a full 40-character commit SHA with a
version comment, `# vX.Y.Z` on the `uses:` line or `# owner/repo vX.Y.Z` in a
comment of the same step above it. A comment that names the wrong version tells a
reviewer, and a Dependabot diff, that the pin is something it is not, so this lint
holds three things over the shipped files (.github/, templates/, tests/consumers/,
docs/ and README.md):

  - every SHA pin has a version comment;
  - one SHA carries the same version comment everywhere it is pinned (offline);
  - each comment names a tag that points at its SHA in the action's repo, read
    from the GitHub API (`GET /repos/{owner}/{repo}/git/ref/tags/{tag}`; a pin may name an
    annotated tag's object or the commit it peels to). It needs GITHUB_TOKEN and fails closed
    when the API cannot be read.

Run from anywhere:
  python3 tests/shape-lints/pin-comments.py              # all three checks
  python3 tests/shape-lints/pin-comments.py --offline    # the first two only
  python3 tests/shape-lints/pin-comments.py --self-test  # negative cases, no network
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCOPE_DIRS = (".github", "templates", os.path.join("tests", "consumers"), "docs")
SCOPE_FILES = ("README.md",)
SKIP_DIRS = {"node_modules", ".git", ".hashira"}
EXTENSIONS = (".yml", ".yaml", ".md")
USES = re.compile(
    r"""^(\s*)(-\s+)?uses:\s*['"]?([A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+)@([0-9a-f]{40})\b['"]?(.*)$""")
VERSION = re.compile(r"\bv\d+\.\d+\.\d+\b")
API = "https://api.github.com"


def files_under(root, top):
    for folder, dirs, files in os.walk(os.path.join(root, top)):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        yield from (os.path.relpath(os.path.join(folder, n), root)
                    for n in sorted(files) if n.endswith(EXTENSIONS))


def scoped_files(root):
    yield from (n for n in SCOPE_FILES if os.path.isfile(os.path.join(root, n)))
    for top in SCOPE_DIRS:
        yield from files_under(root, top)


def comment_of(line):
    stripped = line.strip()
    return stripped[1:].strip() if stripped.startswith("#") else None


def is_step_start(line, indent):
    return line.strip().startswith("- ") and len(line) - len(line.lstrip()) < indent


def comments_inside_step(lines, index, indent):
    """The comments between a `uses:` that is not the step's `- ` line and that line, nearest
    first, and the index of the `- ` line."""
    found, i = [], index - 1
    while i >= 0 and lines[i].strip() and not is_step_start(lines[i], indent):
        found.extend(c for c in [comment_of(lines[i])] if c is not None)
        i -= 1
    return found, i


def step_comments(lines, index, indent, is_item):
    """The comments of the step holding lines[index], nearest first: those inside the step,
    then the comment lines right above its `- ` line."""
    found, i = ([], index) if is_item else comments_inside_step(lines, index, indent)
    i -= 1
    while i >= 0 and comment_of(lines[i]) is not None:
        found.append(comment_of(lines[i]))
        i -= 1
    return found


def pin_version(lines, index, match):
    indent, item, action, _sha, rest = match.groups()
    same_line = VERSION.search(rest.split("#", 1)[1]) if "#" in rest else None
    if same_line:
        return same_line.group(0)
    repo = "/".join(action.split("/")[:2])
    comments = step_comments(lines, index, len(indent), bool(item))
    for text in comments:
        named = re.search(re.escape(repo) + r"\s+(v\d+\.\d+\.\d+)\b", text)
        if named:
            return named.group(1)
    bare = next((VERSION.search(t) for t in comments if VERSION.search(t)), None)
    return bare.group(0) if bare else None


def pins_in(rel, text):
    lines = text.split("\n")
    for index, line in enumerate(lines):
        match = USES.match(line)
        if match:
            action, sha = match.group(3), match.group(4)
            yield {"where": f"{rel}:{index + 1}", "repo": "/".join(action.split("/")[:2]),
                   "sha": sha, "version": pin_version(lines, index, match)}


def collect(root):
    pins = []
    for rel in scoped_files(root):
        with open(os.path.join(root, rel), encoding="utf8") as fh:
            pins.extend(pins_in(rel, fh.read()))
    return pins


def offline_errors(pins):
    errors = [f"{p['where']}: {p['repo']}@{p['sha']} has no vX.Y.Z version comment"
              for p in pins if not p["version"]]
    seen = {}
    for pin in pins:
        if pin["version"]:
            seen.setdefault(pin["sha"], {}).setdefault(pin["version"], []).append(pin["where"])
    for sha, versions in sorted(seen.items()):
        if len(versions) > 1:
            named = "; ".join(f"{v} at {', '.join(w)}" for v, w in sorted(versions.items()))
            errors.append(f"{sha} is commented with {len(versions)} versions: {named}")
    return errors


def api_get(path, token):
    request = urllib.request.Request(API + path, headers={
        "Accept": "application/vnd.github+json", "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "pin-comments-lint"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def tag_targets(repo, tag, token):
    """The SHAs tag `tag` names in `repo`: the ref's object and, for an annotated tag, each
    object it peels to down to the commit. A pin may name the tag object or the commit, as
    `git ls-remote` lists both. Empty when there is no such tag."""
    try:
        ref = api_get(f"/repos/{repo}/git/ref/tags/{urllib.parse.quote(tag)}", token)
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return set()
        raise
    target, shas = ref["object"], set()
    for _ in range(5):
        shas.add(target["sha"])
        if target["type"] != "tag":
            return shas
        target = api_get(f"/repos/{repo}/git/tags/{target['sha']}", token)["object"]
    raise RuntimeError(f"{repo} tag {tag} nests more than 5 annotated tags")


def tag_error(pin, shas):
    actual = f"on {', '.join(sorted(shas))}" if shas else f"not a tag of {pin['repo']}"
    return (f"{pin['where']}: {pin['repo']}@{pin['sha']} is commented {pin['version']}, "
            f"but that tag is {actual}")


def online_errors(pins, resolve):
    """One error per pin whose comment names no tag on its SHA; each tag is resolved once."""
    keys = sorted({(p["repo"], p["version"]) for p in pins if p["version"]})
    tags = {key: resolve(*key) for key in keys}
    return [tag_error(p, tags[(p["repo"], p["version"])])
            for p in pins if p["version"] and p["sha"] not in tags[(p["repo"], p["version"])]]


def run(root, offline):
    pins = collect(root)
    if not pins:
        return [f"no SHA pins found under {root}"], 0
    errors = offline_errors(pins)
    if offline:
        return errors, len(pins)
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        return errors + ["GITHUB_TOKEN is not set: the tag check needs the GitHub API "
                         "(run with --offline to skip it)"], len(pins)
    try:
        errors += online_errors(pins, lambda repo, tag: tag_targets(repo, tag, token))
    except (urllib.error.URLError, OSError, KeyError, ValueError, RuntimeError) as err:
        errors.append(f"the GitHub API could not be read, so no tag was checked: {err}")
    return errors, len(pins)


SHA_A, SHA_B = "a" * 40, "b" * 40
GOOD = f"""steps:
  - uses: actions/checkout@{SHA_A} # v1.0.0
  # actions/setup-node v2.0.0
  - uses: actions/setup-node@{SHA_B}
  - name: Checkout again
    # actions/checkout v1.0.0
    uses: actions/checkout@{SHA_A}
"""
CASES = {
    "a pin with no comment": (GOOD.replace(f"{SHA_A} # v1.0.0", SHA_A), "offline"),
    "one SHA with two comments": (GOOD.replace("checkout v1.0.0", "checkout v1.0.1"), "offline"),
    "comments that agree on a tag of another SHA": (GOOD.replace("v1.0.0", "v9.0.0"), "online"),
    "a comment naming no tag": (GOOD.replace("v2.0.0", "v2.0.9"), "online"),
}
FAKE_TAGS = {("actions/checkout", "v1.0.0"): {SHA_A}, ("actions/checkout", "v9.0.0"): {SHA_B},
             ("actions/setup-node", "v2.0.0"): {"c" * 40, SHA_B}}


def check_text(text):
    pins = list(pins_in("fixture.yml", text))
    return offline_errors(pins), online_errors(pins, lambda r, t: FAKE_TAGS.get((r, t), set()))


def case_failure(name, text, kind):
    """None when the broken fixture fails the `kind` check, else why the self-test fails."""
    off, on = check_text(text)
    caught = off if kind == "offline" else on
    if not caught:
        return f"{name}: the {kind} check did not fail"
    print(f"pin-comments --self-test: {name}: correctly failed: {caught[0]}")
    return None


def self_test():
    off, on = check_text(GOOD)
    failures = [] if not (off or on) and len(list(pins_in("fixture.yml", GOOD))) == 3 else [
        f"the good fixture did not pass cleanly: {off + on}"]
    failures += [f for f in (case_failure(n, t, k) for n, (t, k) in CASES.items()) if f]
    for failure in failures:
        print(f"pin-comments --self-test: FAIL: {failure}", file=sys.stderr)
    if failures:
        return 1
    print(f"pin-comments --self-test: PASS ({len(CASES)} broken fixtures failed)")
    return 0


def main(argv):
    if "--self-test" in argv:
        return self_test()
    offline = "--offline" in argv
    errors, count = run(REPO_ROOT, offline)
    for error in errors:
        print(f"pin-comments: FAIL: {error}", file=sys.stderr)
    if errors:
        return 1
    mode = "offline" if offline else "online"
    print(f"pin-comments: PASS ({count} SHA pins have one version comment each, checked {mode})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
