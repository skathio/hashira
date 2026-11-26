# Contributing to hashira

Internal contributing notes for library maintainers.

## Extension contract: two axes

There are two independent ways hashira's extension contract gets used —
both are first-class (D10), and this file's checklists below cover the
**maintainer** axis only. The second, **consumer-composition** axis is
documented in full in
[`usage.md`](./usage.md#consumer-composition-axis--custom-jobs-alongside-the-shared-ci);
this section exists to point at it, not to duplicate it.

### Maintainer axis — adding a new flow to hashira itself

Covered below: add a CI reusable workflow + a CD composite action + a
`docs/flows/<flow>.md` page. New flows beyond the existing three (npm,
NuGet, static-webapp/Pages) are an explicit v2 non-goal — prove this
extension model on the existing three before growing the flow count.

### Consumer-composition axis — a consumer's own custom jobs

A reusable workflow has no step-injection point, and caller `env:` does not
propagate into it — a consumer needing a custom step *inside* the shared
pipeline cannot fork the library's `workflow_call` graph from the outside.
The supported pattern instead: the consumer adds **parallel jobs in their
own caller file**, alongside the `uses:` call to hashira's shared CI
reusable workflow, reusing hashira's composite-action building blocks
inside those jobs as needed. This is rogue's actual production pattern
(four custom jobs — `aot-publish`, `bench-smoke`, `license-check`,
`public-api` — alongside the shared `nuget-package-ci.yml` call) and is
now a documented, supported contract rather than an unsupported
workaround. See `usage.md`'s extension-contract section for the full
write-up, including the required-check × path-filter deadlock this
pattern can trigger and its mitigation.

This axis has **no maintainer-side checklist** — it requires no change to
hashira itself. It is listed here only so a maintainer reading this file
doesn't conclude the maintainer axis is the only supported extension path.

## Adding a new composite action

1. Create `.github/actions/<name>/action.yml`. Keep each action ≤ ~80 lines
   (NF1 size budget — if it grows past that, split or move logic to a
   sibling shim under `.github/actions/<name>/lib/`).
2. Declare every input explicitly with `description` + `required` + (where
   appropriate) `default`. Inputs that are unstable and may break in a minor
   version MUST be prefixed `x_` per the convention in
   [`usage.md`](./usage.md#x_-prefix-experimental-input-convention).
3. Pin every third-party action referenced inside `action.yml` by full
   commit SHA + a trailing `# v<x.y.z>` comment. Dependabot's weekly run
   refreshes these.
4. Tests live under `tests/<action-name>/`. Each action must have at least one
   smoke test that the self-CI workflow exercises.
5. Add a `### <name>` section to [`catalog.md`](./catalog.md): what it does,
   when a consumer uses it directly, its input table (name, required,
   default), its outputs and a `uses:` snippet. `tests/catalog/shape-validate.py`
   fails until the section matches the YAML.

## Adding a new reusable workflow

1. Name the CI half `.github/workflows/<flow>-package-ci.yml` (matches the
   existing `npm-package-ci.yml`/`nuget-package-ci.yml`/
   `static-webapp-ci.yml` convention). The CD half is **not** a second
   reusable workflow — it is a composite action under
   `.github/actions/<flow>-<verb>/` (e.g. `npm-release`, `nuget-push`,
   `pages-deploy`), invoked directly from the consumer's own caller job.
   This CI-reusable-workflow + CD-composite-action split is required per D2
   (a `workflow_call` boundary between the consumer's trusted-publisher-
   registered file and the OIDC token-exchange step breaks the OIDC
   `job_workflow_ref` claim) — see
   [`usage.md`](./usage.md#why-a-composite-action-not-a-reusable-workflow-for-cd).
   A CD composite action **MUST NOT** contain a `uses: <reusable-workflow>`
   step; doing so re-introduces the boundary D2 exists to avoid.
2. Declare a top-level `permissions:` block restricted to least privilege;
   widen per-job only where necessary. The CD composite action cannot
   declare `permissions:` at all (no GitHub Actions primitive for that on a
   composite action) — document the required caller-job grant in the
   action's own header comment instead.
3. Document every `inputs:`/`outputs:` (reusable workflow) and
   `inputs:`/`outputs:`/caller-permissions (composite action) entry in the
   matching `docs/flows/<flow>.md` page, and in a `### <name>` section of
   [`catalog.md`](./catalog.md) (`tests/catalog/shape-validate.py` checks it).
4. Give the workflow a job with id and name `passed` as its last job: it
   `needs` every other job, runs with `if: always()`, checks hashira out
   itself at `job.workflow_sha` (not through `setup`, so it still runs when
   `setup` failed) and calls the `ci-summary` action with `toJSON(needs)`
   and `toJSON(inputs)`. It is the one job with `pull-requests: write`, and
   consumers require it as `ci / passed`. A new job goes into its `needs`;
   a job that an input may skip gets a documented skip in
   `.github/actions/ci-summary/lib/verdict.js`, or the skip fails the
   check. `tests/shape-lints/passed_job.py` holds the shape; call it from
   the flow's `shape-validate.py`.
5. Write the flow's caller as `templates/<flow>/ci.yml` (at most 45
   non-blank, non-comment lines) and copy it word for word as the first
   caller block of `docs/flows/<flow>.md` and as the flow's caller in
   `README.md`. `tests/templates/identity-lint.py` fails, naming the file
   and the first differing line, when a copy drifts; change the template and
   both copies in the same PR.
6. Update the flow's fixture caller, `tests/consumers/<flow>/.github/workflows/ci.yml`,
   in the same PR. It must equal the template except for the fake registry,
   the publish target and the verification steps after the CD action;
   `tests/shape-lints/fixture-diff.py` names the first key that differs.

## Where docs live

- [`docs/usage.md`](./usage.md) — master cross-cutting contract (pin policy,
  gate model, secrets discipline, permissions baseline, evolution rules).
- `docs/flows/<flow>.md` — per-flow consumer-facing guide.
- [`docs/catalog.md`](./catalog.md) — every reusable workflow and composite
  action with its inputs, outputs and a `uses:` snippet.
- [`docs/migration-v2-to-v3.md`](./migration-v2-to-v3.md) — the breaking
  changes from v2.
- [`docs/getting-started.md`](./getting-started.md) — a new consumer's path
  from nothing to a first release; the docs site's home page.
- `templates/<flow>/ci.yml` — the one caller per flow, copied into the flow
  guide and the README.

Do not duplicate cross-cutting concerns into per-flow docs; link back to
`usage.md`.

## The docs site

hashira's own `pages-site.yml` builds `docs/**/*.md` into the VitePress
site at https://skathio.github.io/hashira/docs/, with the `docs-build`
action, next to the landing page in `site/` and the `site-kit` files in
`_kit/`. `.github/pages.json` describes the docs (see
[`flows/pages.md`](flows/pages.md)). The pages are read unchanged, so a page
reads the same on GitHub and on the site. This file is the one page left
out (`unpublished` in `.github/pages.json`): it is the maintainer checklist,
and links to it go to GitHub.

- Build it with `node tests/pages-site/build-site.js`, which builds the site
  the way `site.yml` does. It writes `artifacts/pages` (gitignored) and fails
  on a dead relative link. The `hashira-site` job in `_self-ci.yml` runs the
  same build and `node --test tests/pages-site/`.
- A new `docs/**/*.md` appears in the sidebar under its H1. To place it in
  the sidebar order, give it a short label, or leave it unpublished, edit
  `.github/pages.json`.
- A relative link that leaves `docs/` becomes a link to the file on GitHub.
  Every other relative link must resolve on the site.
- A change that affects what renders needs screenshots of the landing page
  and the docs pages: follow `.claude/skills/visual-test-site/SKILL.md`.
- The site deploys only through `site.yml`, which `release.yml` calls after a
  release. For a page-only fix between releases, run `site.yml` by hand on
  `main`; it waits for the `production` approval.

## Releases

`.github/workflows/release.yml` releases the current `main`. Dispatch it with
`bump` set to `patch`, `minor` or `major`:

```sh
gh workflow run release.yml --ref main -f bump=patch
```

It refuses, before any approval, when the latest `_self-ci.yml` run for
`main`'s HEAD is not green (it first waits up to 45 minutes for a run still
in progress, so you can dispatch right after a merge), when the version's major is 1 or 2, when a
`templates/*/ci.yml` pins another major than the release's, or when the tag
`vX.Y.Z` is already on another commit. It then builds the docs, waits for the
`production` approval, pushes the annotated tag `vX.Y.Z`, creates the GitHub
Release, points the major tag (`v3`) at the commit, deploys the site and pings
the org homepage. Re-running a release that failed partway finishes it. `v1`
and `v2` are frozen and are never moved. A major release needs a normal PR
first that moves the templates, docs and lints to the new major.

The decisions live in `tests/release/lib/release.js` (unit-tested in
`tests/release/`), and `tests/shape-lints/release-lint.py` checks the
workflow's shape. `.claude/skills/release/SKILL.md` keeps the manual commands
as the fallback when the workflow is down.

### One-time setup: the release GitHub App

`release.yml` pushes tags with a token from a dedicated GitHub App, not with
`GITHUB_TOKEN`, because the `release-tags` ruleset blocks updating and
deleting `v*` tags for everyone it does not list as a bypass actor. The App's
token is minted only in the `publish` job, after the `production` approval,
and only for `skathio/hashira`. A repository admin does these steps once:

1. Create the GitHub App under the `skathio` account (Settings → Developer
   settings → GitHub Apps → New GitHub App). Name it for its job, for example
   `hashira-release`. Turn the webhook off. Under Repository permissions, give
   it **Contents: Read and write** and nothing else. Allow installation only
   on this account.
2. On the App's **General** page, note its **Client ID** (`Iv23…`, not the
   numeric App ID: the token action deprecated `app-id`). Then open
   **Credentials** in the App's sidebar and choose **Generate a private key**,
   which downloads a `.pem` file.
3. Install the App on `skathio/hashira` only (Install App → Only select
   repositories).
4. Add the App as a bypass actor on the `release-tags` ruleset (repo Settings
   → Rules → Rulesets → `release-tags` → Bypass list → Add bypass → the App,
   mode **Always**). Without it, moving `v3` is refused. Keep the ruleset's
   target (`refs/tags/v*`) and its rules (restrict updates and deletions) as
   they are.
5. Store the two values as secrets of the `production` environment only, not
   as repository secrets, so no job outside `production` can read them:

   ```sh
   gh secret set RELEASE_APP_CLIENT_ID --env production --repo skathio/hashira --body '<client id>'
   gh secret set RELEASE_APP_PRIVATE_KEY --env production --repo skathio/hashira < hashira-release.private-key.pem
   ```

   Then delete the local `.pem` file.
6. Check that `production` still requires the hashira-owners team's review
   and allows only `main`, and that `github-pages` allows `main`.

To rotate the key, generate a new private key on the App, replace
`RELEASE_APP_PRIVATE_KEY`, then delete the old key on the App.

## Branch protection

Recommended ruleset for `main`:

- Require a PR with at least one approval before merging.
- `_self-ci.yml` jobs must pass (add `actionlint`, the shape-validation
  jobs, and any smoke jobs as required status checks once the workflow has
  produced its first green run on a PR — checks become selectable only
  after their first run).
- No direct pushes to `main`.

Configure via repo Settings → Branches → Add rule, or `gh api`.

## Pin discipline

Every third-party action — both in `.github/workflows/*.yml` and inside
composite actions under `.github/actions/*/action.yml` — must be pinned to a
full commit SHA with a `# v<x.y.z>` comment. Tag pins (`@v4`) and branch pins
(`@main`) are forbidden in this repo's own files. Dependabot refreshes the
pins weekly per `.github/dependabot.yml`; review and merge the bump PR after
self-CI passes.
