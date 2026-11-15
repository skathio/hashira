# hashira

A library of reusable GitHub Actions workflows and composite actions for three CI/CD shapes: npm package publish,
NuGet package publish, and a static site on GitHub Pages. Consumers call it with
`uses: skathio/hashira/...@<ref>`. The repo is `skathio/hashira`. The README still says `hashira-ops` in places, but
every `uses:` ref must name `skathio/hashira`.

There is no application code and no build. The product is YAML (`.github/workflows/`, `.github/actions/*/action.yml`),
small Node/shell helpers inside the actions, the docs, and a static project site in `site/`.

## Layout

- `.github/workflows/`: `npm-package-ci.yml`, `nuget-package-ci.yml` and `static-webapp-ci.yml` are the consumer-facing
  reusable CI workflows (`workflow_call`). `_self-ci.yml` is this repo's own CI. `site.yml` deploys `site/` to Pages.
  `homepage.yml` pings the org homepage when `.github/homepage.json` or `site/mark.svg` changes.
- `.github/actions/<name>/action.yml`: the composite actions. The CD halves are `npm-release`, `nuget-push` and
  `pages-deploy`. The building blocks are `pages-upload`, `scan-suite`, `run-tests-js`, `run-tests-dotnet`,
  `coverage-report`, `dotnet-pack-version` and `version-resolver`. Helpers live in `<name>/lib/`.
- `tests/<action-or-workflow>/`: Node `node:test` unit tests (`*.test.js`), Python shape lints (`shape-validate.py`,
  `lint.py`, `gate-lints.py` and others) with fixtures. The root `package.json` only pins `"type": "commonjs"` so the
  `lib/` requires resolve as CommonJS. Do not remove it.
- `docs/usage.md` is the cross-cutting contract: pin policy, gate model, secrets, permissions, the v1.x/v2 evolution
  rule. `docs/flows/{npm,nuget,static-webapp}.md` are the per-flow guides. `docs/contributing.md` is the maintainer
  checklist for adding an action or a workflow.
- `site/` is the project page at https://skathio.github.io/hashira/: plain `index.html`, `theme.js` and SVGs. It has
  no build step and is deployed as is.
- `templates/dependabot.yml` is a template for consumers.

## Commands (all verified locally: Node 26, Python 3.12 with PyYAML 6)

There is no `npm install` and no build. Run the tests individually, the way `_self-ci.yml` does:

```sh
# Node unit tests
node --test tests/coverage-report/parse-coverage.test.js
node --test tests/scan-suite/visibility-detect.test.js tests/scan-suite/visibility-detect-cjs-boundary.test.js
node --test tests/dotnet-pack-version/parse-nupkg-version.test.js
node --test tests/version-resolver/resolve-version.test.js

# Python shape lints (need PyYAML); each prints "...: PASS" and exits 0
for f in tests/{npm-release,npm-package-ci,nuget-package-ci,pages-upload,pages-deploy,static-webapp-ci}/shape-validate.py \
         tests/static-webapp/docs-cross-ref.py tests/dual-pin/lint.py \
         tests/shape-lints/no-nested-reusable-workflow.py tests/shape-lints/gate-lints.py; do python3 "$f" || echo "FAIL $f"; done
# The lint scripts also have negative-fixture self-tests
python3 tests/dual-pin/lint.py --self-test
python3 tests/shape-lints/no-nested-reusable-workflow.py --self-test
python3 tests/shape-lints/gate-lints.py --self-test
```

The `actionlint` CI job installs actionlint v1.7.7 from its release tarball and checks the tarball's SHA-256. If
actionlint is on your PATH, run `actionlint` from the repo root. The `*-smoke` and `scan-suite-*` jobs only run in
GitHub Actions.

## CI

`_self-ci.yml` runs on every pull request and every push to main, 32 jobs: actionlint, the unit tests and shape
lints above, and smoke jobs that run the composite actions against fixtures (`tests/pages-fixture`,
`tests/run-tests-dotnet`, `tests/npm-release/dry-run-fixture`). Every job must be green before a merge. Wait for the
checks with `gh pr checks <n> --watch`. Read a failure with `gh run view <id> --log-failed`.

## Conventions and invariants (enforced by the shape lints)

- Pin every third-party action to a full 40-character commit SHA with a version comment, either `# vX.Y.Z` on the same
  line or `# actions/checkout v4.2.2` on the line above. Tag and branch pins are forbidden. Dependabot refreshes the
  pins weekly as one grouped PR.
- Permissions are deny-all at the top (`permissions: {}` or `contents: read`). Widen them per job, and say in a
  comment why each grant is needed.
- Never use `pull_request_target` (`gate-lints.py`). Every gated publish or deploy job declares `environment:`.
- A CD composite action must never `uses:` a reusable workflow. That would break the OIDC `job_workflow_ref` claim
  (`no-nested-reusable-workflow.py`). The CI is a reusable workflow and the CD is a composite action.
- `uses:` and `library_ref` must name the same SHA (`tests/dual-pin/lint.py`). No doc example may pin `@main`.
- Evolution is additive only within a major: add inputs with defaults, and never rename, remove or change a default
  without a major bump. Inputs prefixed `x_` are experimental. Document every input and output in `docs/flows/<flow>.md`,
  because the shape-validate scripts compare the docs with the YAML.
- Keep each composite action to about 80 lines and move logic to `lib/`. Each action has at least one test under
  `tests/<name>/` that `_self-ci.yml` runs.
- Workflow comments explain why. A new test or lint gets a job in `_self-ci.yml`, plus a `--self-test` mode when it is
  a lint.
- Branches are `feat/`, `fix/`, `ci/`, `chore/` or `docs/`. Commit subjects are short and imperative, often with a
  conventional prefix (`feat:`, `fix:`, `ci:`, `docs(site):`). Changes land through PRs to `main`, merged with a merge
  commit by the maintainer. Never push to `main`.
- `.editorconfig` sets LF, a final newline, and 2-space indentation (4 for `*.cs`).

## Release flow

Releases are cut by hand. Tag `vX.Y.Z` on main, create the GitHub Release (`gh release create`), then roll the major
tag forward (`git tag -f v2 vX.Y.Z && git push -f origin v2`). `v1` is frozen. The major tags are the only tags that
are ever force-pushed. See `.claude/skills/release/SKILL.md`. Pushing tags is the maintainer's call: never do it
unless asked.

The site deploys on every push to main that touches `site/**` (`site.yml`, `github-pages` environment, main only, no
second approval). `site.yml` pins hashira's own `pages-upload` and `pages-deploy` by SHA.

## Frontend: visual testing is mandatory

`site/` renders, and it supports light, dark and auto (`theme.js`, `data-theme` on `<html>`). For every change that
affects what renders (`site/**`, and `.github/homepage.json` or `site/mark.svg`, which feed the org homepage tile),
serve the site and take screenshots at phone width (390px) and desktop width (1440px), in both light and dark. Look at
every screenshot and check for horizontal scroll, overflow, contrast, and broken images or links. Then attach or
describe the screenshots in the PR. Follow `.claude/skills/visual-test-site/SKILL.md`.

## Pitfalls

- `.claude/` is gitignored except `.claude/skills/`. Local settings stay untracked. `.somi/` is gitignored too.
- `pages-deploy` refuses `pull_request` events on purpose (the B8 guard). The PR run of
  `pages-deploy-smoke-non-pull-request-dry-run` reports the guard firing, and that is correct.
- CI runs the unit tests on Node 20 and the `npm-release` dry-run and OIDC jobs on Node 24 (`setup-node`). Keep test
  and `lib/` code compatible with Node 20, even if your local Node is newer.
- A hook outside this repo can leave a literal `${CLAUDE_PROJECT_DIR}/` directory with an audit log in the repo root.
  It is gitignored. Never commit it, because it contains local paths.
- Editing an input or output means editing three things: the YAML, its `docs/flows/*.md` table, and possibly the
  shape-validate expectations. Change all three in one PR.
