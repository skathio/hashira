# hashira

A library of reusable GitHub Actions workflows and composite actions for three CI/CD shapes: npm package publish,
NuGet package publish, and a static site on GitHub Pages. Consumers call it with
`uses: skathio/hashira/...@<ref>`. The repo is `skathio/hashira`. The README still says `hashira-ops` in places, but
every `uses:` ref must name `skathio/hashira`.

There is no application code. The product is YAML (`.github/workflows/`, `.github/actions/*/action.yml`), small
Node/shell helpers inside the actions, the docs, and a static project site in `site/`. The one build is hashira's own
Pages site, built with hashira's own `pages-site.yml`: `site/`, the `site-kit` files in `_kit/`, and the VitePress docs
that `docs-build` makes from `docs/` and `.github/pages.json`.

## Layout

- `.github/workflows/`: `npm-package-ci.yml`, `nuget-package-ci.yml` and `static-webapp-ci.yml` are the consumer-facing
  reusable CI workflows (`workflow_call`). `_self-ci.yml` is this repo's own CI. `release.yml` cuts a release (see
  Release flow). `pages-site.yml` is the consumer-facing reusable workflow that builds and deploys a project page with
  its docs (`docs/flows/pages.md`). `site.yml` deploys hashira's own landing page and docs by calling `pages-site.yml`,
  called from `release.yml` or run by hand.
  `homepage.yml` pings the org homepage when `.github/homepage.json` or `site/mark.svg` changes, and after a release.
- `.github/actions/<name>/action.yml`: the composite actions. The CD halves are `npm-release`, `nuget-push` and
  `pages-deploy`. The building blocks are `pages-upload`, `scan-suite`, `run-tests-js`, `run-tests-dotnet`,
  `coverage-report`, `dotnet-pack-version`, `version-resolver`, `docs-build` (builds the VitePress docs from `docs/**/*.md`
  and `.github/pages.json`, with VitePress pinned in its own `vitepress/` lockfile), `site-kit` (copies the shared `tokens.css`, `theme.js`
  and `<site-nav>` from its `kit/` into a site's `_kit/`) and `quality-gate` (SoMi's PR-scope quality check, installed
  from its own committed lockfile). Helpers live in `<name>/lib/`.
- `tests/<action-or-workflow>/`: Node `node:test` unit tests (`*.test.js`), Python shape lints (`shape-validate.py`,
  `lint.py`, `gate-lints.py` and others) with fixtures. The root `package.json` only pins `"type": "commonjs"` so the
  `lib/` requires resolve as CommonJS. Do not remove it.
- `docs/usage.md` is the cross-cutting contract: pin policy, gate model, secrets, permissions, the v1.x/v2 evolution
  rule. `docs/flows/{npm,nuget,static-webapp}.md` are the per-flow guides, and `docs/flows/pages.md` covers
  `pages-site.yml`, `docs-build`, `site-kit` and the `.github/pages.json` schema. `docs/catalog.md` lists every workflow and
  action with its inputs and outputs. `docs/migration-v2-to-v3.md` lists the v3 breaking changes. `docs/contributing.md`
  is the maintainer checklist for adding an action or a workflow.
- `site/` is the project page at https://skathio.github.io/hashira/: plain `index.html` and SVGs, with no build step of
  its own. It loads `_kit/tokens.css`, `_kit/theme.js` and `_kit/site-nav.js` (the `<site-nav>` header), which
  `site-kit` adds at build time, so `site/` must hold no `_kit` or `docs` folder. `site/theme.js` stays only so the old
  `/hashira/theme.js` URL keeps working.
- `.github/pages.json` describes the docs site at https://skathio.github.io/hashira/docs/: base `/hashira/docs/`,
  `getting-started.md` as the home page, the sidebar order and labels, `contributing.md` unpublished, and the header
  links `<site-nav>` repeats on the landing. `docs-build` (VitePress 1.6.4 from its own lockfile) stages `docs/`
  unchanged, sends links that leave `docs/` or reach an unpublished page to GitHub, shares the `theme` localStorage key
  with the landing, and builds with the dead-link check on. `node tests/pages-site/build-site.js` builds the whole site
  the way `site.yml` does and writes it to `artifacts/pages` (gitignored). Its tests are in `tests/pages-site/`
  (`hashira-*.test.*`, `theme-and-landing.test.mjs`, `homepage-manifest.test.mjs`).
- `docs/getting-started.md` takes a new consumer from nothing to a first release. It is the docs site's home page and
  links to the templates and flow guides instead of pasting a caller.
- `templates/<flow>/ci.yml` is each flow's one consumer caller. It is copied word for word as the first caller block of
  `docs/flows/<flow>.md` and as the flow's caller in `README.md` (`tests/templates/identity-lint.py`).
  `templates/dependabot.yml` is a template for consumers.
- `tests/consumers/<flow>/` holds the sources of the public fixture repos `skathio/hashira-fixture-{npm,nuget,static}`.
  Each fixture's `.github/workflows/ci.yml` is its flow's template plus only a fake registry (Verdaccio, BaGetter), the
  publish target and verification steps (`tests/shape-lints/fixture-diff.py`). Change a template and its fixture together.
  `_self-ci.yml`'s `consumer-integration` job (`tests/consumer-integration/lib/integrate.js`) pushes them to the fixture
  repos as branch `hashira/<sha>` and runs their CI and release path. Runs against one fixture repo take turns through
  an `integration-lock` branch there (`lib/lock.js`), not a concurrency group, which would cancel queued runs. It needs the GitHub App secrets `FIXTURE_APP_ID`
  and `FIXTURE_APP_PRIVATE_KEY`, so it only passes in GitHub Actions and fails on fork PRs.

## Commands (all verified locally: Node 26, Python 3.12 with PyYAML 6)

Run the tests individually, the way `_self-ci.yml` does. Only the docs builds install anything (`docs-build` runs
`npm ci` from its own lockfile in a temporary folder, which needs network access once):

```sh
# Node unit tests
node --test tests/coverage-report/parse-coverage.test.js
node --test tests/scan-suite/visibility-detect.test.js tests/scan-suite/visibility-detect-cjs-boundary.test.js
node --test tests/dotnet-pack-version/parse-nupkg-version.test.js
node --test tests/version-resolver/resolve-version.test.js
node --test tests/quality-gate/contract.test.js tests/quality-gate/report.test.js tests/quality-gate/run-gate.test.js
node --test tests/consumer-integration/plan.test.js tests/consumer-integration/integrate.test.js tests/consumer-integration/lock.test.js
node --test tests/docs-build/pages-config.test.js tests/docs-build/pages-config-edges.test.js tests/docs-build/pages-rules.test.js tests/docs-build/docs-build-lib.test.js tests/docs-build/markdown.test.js tests/docs-build/built-html.test.js tests/docs-build/links.test.mjs tests/pages-site/request-line-gaps.test.js
# The docs-build action run against fixture repos (installs VitePress from the action's lockfile; needs network once)
node --test tests/docs-build/docs-build-rules.test.js tests/docs-build/config-hardening.test.js
node --test tests/site-kit/site-kit-rules.test.js tests/site-kit/site-kit-action-edges.test.js
node --test tests/pages-site/pages-site-rules.test.js

# Python shape lints (need PyYAML); each prints "...: PASS" and exits 0
for f in tests/{npm-release,npm-package-ci,nuget-package-ci,pages-upload,pages-deploy,static-webapp-ci,catalog}/shape-validate.py \
         tests/static-webapp/docs-cross-ref.py tests/templates/identity-lint.py tests/shape-lints/fixture-diff.py \
         tests/shape-lints/no-nested-reusable-workflow.py tests/shape-lints/gate-lints.py; do python3 "$f" || echo "FAIL $f"; done
# The lint scripts also have negative-fixture self-tests
python3 tests/shape-lints/no-nested-reusable-workflow.py --self-test
python3 tests/shape-lints/gate-lints.py --self-test
python3 tests/catalog/shape-validate.py --self-test
python3 tests/templates/identity-lint.py --self-test
python3 tests/shape-lints/fixture-diff.py --self-test
# Pin version comments: offline (no comment, or one SHA with two) and online (each comment names a tag on its SHA,
# read from the GitHub API with GITHUB_TOKEN), and the lint's self-test
python3 tests/shape-lints/pin-comments.py --offline
GITHUB_TOKEN="$(gh auth token)" python3 tests/shape-lints/pin-comments.py
python3 tests/shape-lints/pin-comments.py --self-test
python3 tests/shape-lints/test_pin_comments_and_scan_default.py
# The library self-checkout contract (unittest)
python3 tests/library-self-sha/test_library_self_sha.py
# The v3 caller templates and docs contract (unittest)
python3 tests/v3-callers-docs/test_v3_callers_docs.py
# CI workflow inputs, the consumer-integration job, and the fixture sources and repos (unittest; the last reads the
# public fixture repos through an authenticated gh)
python3 tests/ci-workflow-inputs/test_ci_workflow_inputs.py
python3 tests/consumer-integration/test_consumer_integration.py
python3 tests/fixture-consumers/test_fixture_consumers.py
# Release decision logic (Node 20 safe), the release.yml lint and its self-test, and the release workflow contract
node --test tests/release/release.test.js tests/release/release-edges.test.js tests/release/request-gaps.test.mjs tests/release/hardening.test.mjs
python3 tests/shape-lints/release-lint.py
python3 tests/shape-lints/release-lint.py --self-test
python3 tests/release-workflow/test_release_workflow.py
python3 tests/release-workflow/test_release_gaps.py
# hashira's own Pages site, built the way site.yml builds it (VitePress's dead-link check fails the build), then the
# tests of every Pages piece, hashira's own site included, and the maintainer docs contract. CI runs these on Node 24,
# because VitePress 1.6 and the folder form of `node --test` need a current Node.
node tests/pages-site/build-site.js
node --test tests/docs-build/ tests/site-kit/ tests/pages-site/
python3 tests/maintainer-docs/test_maintainer_docs.py
# The getting-started page's contract (unittest)
python3 tests/getting-started/test_getting_started.py
```

The `actionlint` CI job installs actionlint v1.7.7 from its release tarball and checks the tarball's SHA-256. If
actionlint is on your PATH, run `actionlint` from the repo root. The `*-smoke` and `scan-suite-*` jobs only run in
GitHub Actions.

## CI

`_self-ci.yml` runs on every pull request and every push to main, 63 jobs: actionlint, the unit tests and shape
lints above, hashira's own site build and its tests (`hashira-site`), the release checks (`release-logic-unit-tests`,
`release-lint`, `release-lint-self-test`), and smoke jobs that run the composite actions against fixtures
(`tests/pages-fixture`, `tests/run-tests-dotnet`, `tests/npm-release/dry-run-fixture`). Every job must be green
before a merge. Wait for the checks with `gh pr checks <n> --watch`. Read a failure with `gh run view <id> --log-failed`.

## Conventions and invariants (enforced by the shape lints)

- Pin every third-party action to a full 40-character commit SHA with a version comment, either `# vX.Y.Z` on the same
  line or `# actions/checkout v4.2.2` on the line above. Tag and branch pins are forbidden. Dependabot refreshes the
  pins weekly as one grouped PR.
- Permissions are deny-all at the top (`permissions: {}` or `contents: read`). Widen them per job, and say in a
  comment why each grant is needed.
- Never use `pull_request_target` (`gate-lints.py`). Every gated publish or deploy job declares `environment:`.
- A CD composite action must never `uses:` a reusable workflow. That would break the OIDC `job_workflow_ref` claim
  (`no-nested-reusable-workflow.py`). The CI is a reusable workflow and the CD is a composite action.
- The CI workflows have no `library_ref` input: each checks its composite actions out into `.hashira/` at its own
  commit (`job.workflow_sha`, resolved in `setup`; `tests/library-self-sha/`). No doc example may pin `@main`.
- Evolution is additive only within a major: add inputs with defaults, and never rename, remove or change a default
  without a major bump. Inputs prefixed `x_` are experimental. Document every input and output in `docs/flows/<flow>.md`
  and in `docs/catalog.md`, because the shape-validate scripts compare the docs with the YAML.
- Keep each composite action to about 80 lines and move logic to `lib/`. Each action has at least one test under
  `tests/<name>/` that `_self-ci.yml` runs.
- Workflow comments explain why. A new test or lint gets a job in `_self-ci.yml`, plus a `--self-test` mode when it is
  a lint.
- Branches are `feat/`, `fix/`, `ci/`, `chore/` or `docs/`. Commit subjects are short and imperative, often with a
  conventional prefix (`feat:`, `fix:`, `ci:`, `docs(site):`). Changes land through PRs to `main`, merged with a merge
  commit by the maintainer. Never push to `main`.
- `.editorconfig` sets LF, a final newline, and 2-space indentation (4 for `*.cs`).

## Release flow

Releases go through `.github/workflows/release.yml`: dispatch it on `main` with `bump` set to `patch`, `minor` or
`major` (`gh workflow run release.yml --ref main -f bump=patch`). Its `check` job refuses, before any approval, a ref
other than `main`, a `_self-ci.yml` run for `main`'s HEAD that is not green (it waits up to 45 minutes for one still
running, so a dispatch right after a merge works), a v1 or v2 version, a `templates/*/ci.yml`
that pins another major than the release's, and a `vX.Y.Z` tag already on another commit. The version comes from
hashira's own `version-resolver`; the decisions are in `tests/release/lib/release.js`. The `docs` job builds the docs
with the `docs-build` action at the released commit, so a broken docs build stops the release before any tag. The `publish` job waits for the
`production` environment's approval (the hashira-owners team), mints a token from the release GitHub App
(`RELEASE_APP_CLIENT_ID`, `RELEASE_APP_PRIVATE_KEY`, secrets of `production` only), then pushes the annotated tag `vX.Y.Z`,
creates the GitHub Release with generated notes and points the lightweight major tag (`v3`) at the commit. Re-running a
release that failed partway finishes it. A major release (`bump=major`) needs the templates, docs and lints to name the
new major in a normal PR first. `v1` and `v2` are frozen and never move: moving `v2` onto a v3 commit would break every
v2 consumer, whose callers still pass `library_ref`. The current major tag is the only tag that is ever force-pushed,
and a major release leaves the previous major's tag where it was. Follow `.claude/skills/release/SKILL.md`; its manual
commands are the fallback when the workflow is down. Dispatching a release or pushing tags is the maintainer's call:
never do it unless asked. The App's one-time setup is in `docs/contributing.md`.

The site deploys only through `site.yml`: `release.yml` calls it after the tags and the Release, with no second
approval, so the published docs match the released version, and then starts `homepage.yml` as a run of its own (a called workflow would not see its environment secret), whose failed ping only
warns. A page-only fix can run `site.yml` by hand, which waits for the `production` approval (its `released` input is
refused on a hand run). It does not deploy on push. `site.yml` is one call of `./.github/workflows/pages-site.yml`,
whose build job holds only `contents: read`, uses `site-kit`, `docs-build` and `pages-upload` from the same commit and
uploads the site; its deploy job pins `pages-deploy` by SHA (the v3.0.0 commit).

## Frontend: visual testing is mandatory

`site/` and the docs site render, and both support light, dark and auto (`_kit/theme.js`, `data-theme` on `<html>`,
and the docs' theme bridge, which share the `theme` localStorage key). For every change that affects what renders
(`site/**`, `docs/**`, `.github/pages.json`, the `site-kit` and `docs-build` actions, and `.github/homepage.json` or
`site/mark.svg`, which feed the org homepage tile), build with `node tests/pages-site/build-site.js`, serve
`artifacts/pages`, and take screenshots of the landing page and the docs pages at
phone width (390px) and desktop width (1440px), in both light and dark. Look at every screenshot and check for
horizontal scroll, overflow, contrast, and broken images or links. Then attach or describe the screenshots in the PR. Follow `.claude/skills/visual-test-site/SKILL.md`.

## Pitfalls

- `.claude/` is gitignored except `.claude/skills/`. Local settings stay untracked. `.somi/` is gitignored too.
- `pages-deploy` refuses `pull_request` events on purpose (the B8 guard). The PR run of
  `pages-deploy-smoke-non-pull-request-dry-run` reports the guard firing, and that is correct.
- CI runs the unit tests on Node 20 and the `npm-release` dry-run and OIDC jobs on Node 24 (`setup-node`). Keep test
  and `lib/` code compatible with Node 20, even if your local Node is newer.
- A hook outside this repo can leave a literal `${CLAUDE_PROJECT_DIR}/` directory with an audit log in the repo root.
  It is gitignored. Never commit it, because it contains local paths.
- Editing an input or output means editing four things: the YAML, its `docs/flows/*.md` table, its `docs/catalog.md`
  table, and possibly the shape-validate expectations. Change all four in one PR.
