# hashira

[![_self-ci](https://github.com/skathio/hashira/actions/workflows/_self-ci.yml/badge.svg)](https://github.com/skathio/hashira/actions/workflows/_self-ci.yml)

`skathio/hashira` is a library of reusable GitHub Actions workflows and
composite actions for three CI/CD shapes: **npm package publish**, **NuGet
package publish**, and **static webapp on GitHub Pages**. A consumer adds
one caller file, `.github/workflows/ci.yml`, and gets the whole pipeline:
build, tests, coverage, the security scan suite, SoMi's quality gate on
pull requests, and a gated publish or deploy job.

The library carries the SHA pins on third-party actions, deny-all
permissions widened per job, the OIDC wiring, and the gate model: CI is a
reusable workflow, publish or deploy is a composite action in a job of your
own file, behind a GitHub Environment.

**Status**: v3. `v1` and `v2` are frozen: they stay resolvable, and get no
further changes. Moving from v2 is covered in the
[migration guide](docs/migration-v2-to-v3.md).

## Callers

Each caller below is the complete `.github/workflows/ci.yml` for its flow,
and the same file as `templates/<flow>/ci.yml`. Copy it as is: every input
has a default, so it sets only what the flow needs. It follows the `@v3`
tag; pin a 40-character commit SHA instead for byte-exact, reproducible
runs, and never `@main` (see the [pin policy](docs/usage.md#pin-policy)).

Pull requests and pushes to `main` run CI. To release a package, run the
workflow with a bump, for example `gh workflow run ci.yml -f bump=patch`
(add `-f seed_version=0.0.0` for the first release when there is no stable
tag). The static webapp deploys on every push to `main` and manual run.

### npm package publish

The `publish` job runs `npm-release` with npm OIDC trusted publishing (no
long-lived token once the trusted publisher is configured), then creates
the `v<version>` tag and GitHub Release. Create a `production` Environment
with a required reviewer first.

```yaml
# .github/workflows/ci.yml: the hashira npm package flow.
# Pull requests and pushes run CI. To release, run this workflow with a bump:
#   gh workflow run ci.yml -f bump=patch
name: ci
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      bump:
        description: "Cut a release: patch, minor or major. none runs CI only."
        type: choice
        options: [none, patch, minor, major]
      seed_version:
        description: "Baseline for the first release when no stable tag exists, e.g. 0.0.0."
        type: string

permissions: {}

jobs:
  ci:
    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@v3
    permissions:
      contents: read # check out the repository
      pull-requests: write # CI summary comment on the pull request
      security-events: write # upload CodeQL results when CodeQL is enabled
  publish:
    needs: ci
    if: needs.ci.outputs.resolved_version != ''
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: write # create the release tag and GitHub Release
      id-token: write # npm trusted publishing exchanges an OIDC token
      pull-requests: read # release notes read the merged pull requests
    steps:
      # actions/checkout v7.0.1
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      - uses: skathio/hashira/.github/actions/npm-release@v3
        with:
          version: ${{ needs.ci.outputs.resolved_version }}
```

Walk-through: [`docs/flows/npm.md`](docs/flows/npm.md) (trusted publisher
setup, Environment setup, failure modes).

### NuGet package publish

The `ci` job finds the repository's one non-test `.csproj` by itself (set
`project_path` with `with:` when there are several). The `publish` job
pushes the same-run `.nupkg` with the `NUGET_API_KEY` secret, then creates
the tag and GitHub Release. Create a `production` Environment with a
required reviewer first.

```yaml
# .github/workflows/ci.yml: the hashira NuGet package flow.
# Pull requests and pushes run CI. To release, run this workflow with a bump:
#   gh workflow run ci.yml -f bump=patch
name: ci
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      bump:
        description: "Cut a release: patch, minor or major. none runs CI only."
        type: choice
        options: [none, patch, minor, major]
      seed_version:
        description: "Baseline for the first release when no stable tag exists, e.g. 0.0.0."
        type: string

permissions: {}

jobs:
  ci:
    uses: skathio/hashira/.github/workflows/nuget-package-ci.yml@v3
    permissions:
      contents: read # check out the repository
      pull-requests: write # CI summary comment on the pull request
      security-events: write # upload CodeQL results when CodeQL is enabled
  publish:
    needs: ci
    if: needs.ci.outputs.resolved_version != ''
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: write # create the release tag and GitHub Release
      pull-requests: read # release notes read the merged pull requests
    steps:
      # actions/checkout v7.0.1
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      # actions/setup-dotnet v6.0.0
      - uses: actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68
        with:
          dotnet-version: '8.0.x'
      # actions/download-artifact v4.3.0: the .nupkg the ci job packed
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          name: nuget-package
          path: ${{ runner.temp }}/nupkg
      - uses: skathio/hashira/.github/actions/nuget-push@v3
        with:
          nupkg_path: ${{ runner.temp }}/nupkg/*.nupkg
          version: ${{ needs.ci.outputs.resolved_version }}
          auth: token
          api_key: ${{ secrets.NUGET_API_KEY }}
```

Walk-through: [`docs/flows/nuget.md`](docs/flows/nuget.md) (OIDC trusted
publishing, MinVer, Environment setup, failure modes).

### Static webapp on GitHub Pages

The `ci` job builds (`npm run build`), tests, and uploads the Pages
artifact; the `deploy` job runs `pages-deploy` in the `github-pages`
Environment on pushes and manual runs, never on pull requests. Set the
repository's Pages source to GitHub Actions first.

```yaml
# .github/workflows/ci.yml: the hashira static webapp flow (GitHub Pages).
# Pull requests run CI only. Pushes to main and manual runs also deploy.
name: ci
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

permissions: {}

jobs:
  ci:
    uses: skathio/hashira/.github/workflows/static-webapp-ci.yml@v3
    permissions:
      contents: read # check out the repository
      pull-requests: write # CI summary comment on the pull request
      security-events: write # upload CodeQL results when CodeQL is enabled
  deploy:
    needs: ci
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    environment: github-pages
    permissions:
      id-token: write # deploy-pages authenticates to Pages with OIDC
      pages: write # deploy-pages publishes the site
    steps:
      - uses: skathio/hashira/.github/actions/pages-deploy@v3
```

Walk-through: [`docs/flows/static-webapp.md`](docs/flows/static-webapp.md)
(Pages enablement, framework guidance, failure modes).

### Project page and docs on GitHub Pages

For a project page with docs, rather than a framework app: `pages-site.yml`
copies your `site/` (or runs your build), adds the shared site kit in
`_kit/` (`site-kit`: colour tokens, the theme toggle and the `<site-nav>`
header) and builds a VitePress docs site from your `docs/` into `docs/`
(`docs-build`, described by `.github/pages.json`), then deploys it after the
`production` approval, or with `released: true` from a release job that
already passed it. hashira's own page at
https://skathio.github.io/hashira/ is built this way.

```yaml
jobs:
  site:
    permissions:
      contents: read   # build: checkout
      pages: write     # deploy: deploy-pages
      id-token: write  # deploy: deploy-pages authenticates via OIDC
    uses: skathio/hashira/.github/workflows/pages-site.yml@v3
```

Walk-through: [`docs/flows/pages.md`](docs/flows/pages.md) (the
`.github/pages.json` schema, defaults, errors, and the trusted-input
warning).

## The parts

The three CI workflows and `pages-site.yml` are built from composite actions
you can also use on their own: `scan-suite`, `run-tests-js`, `run-tests-dotnet`,
`coverage-report`, `quality-gate`, `ci-summary`, `version-resolver`,
`dotnet-pack-version`, `pages-upload`, `docs-build` (a VitePress docs
site from `docs/` and `.github/pages.json`), `site-kit` (the shared page
header, theme toggle and colour tokens), and the publish and deploy actions
`npm-release`, `nuget-push` and `pages-deploy`. Each CI workflow ends with
the job `passed`, which reports as the one check to require in a branch
ruleset, `ci / passed`, and keeps one CI summary comment on the pull
request ([details](docs/usage.md#the-ci--passed-check)). The
[catalog](docs/catalog.md) lists every workflow and action with what it
does, when to use it directly, its inputs and outputs, and a `uses:`
snippet.

## Read this next

- **[`docs/catalog.md`](docs/catalog.md)**: every reusable workflow and
  composite action, with inputs, outputs and a `uses:` snippet.
- **[`docs/migration-v2-to-v3.md`](docs/migration-v2-to-v3.md)**: every
  breaking change from v2, with the v2 caller line and its v3 replacement.
- **[`docs/usage.md`](docs/usage.md)**: cross-cutting concepts:
  [pin policy](docs/usage.md#pin-policy),
  [gate model](docs/usage.md#gate-model),
  [secret-passing model](docs/usage.md#secret-passing-model),
  [permissions baseline](docs/usage.md#permissions-baseline),
  [evolution rule](docs/usage.md#additive-only-v1x-evolution-rule),
  [`x_`-prefix experimental inputs](docs/usage.md#x_-prefix-experimental-input-convention),
  [Environment checklist](docs/usage.md#environment-configuration-adoption-checklist),
  [OIDC trust onboarding](docs/usage.md#oidc-trust-onboarding),
  [scan-suite toggles](docs/usage.md#scan-suite-toggles),
  [the `ci / passed` check](docs/usage.md#the-ci--passed-check),
  [coverage reporting](docs/usage.md#coverage-reporting).
- **[`docs/flows/`](docs/flows/)**: one walk-through per flow, with the
  input, permissions and secret tables and common failure modes.
- **[`docs/contributing.md`](docs/contributing.md)**: the maintainer
  checklist for adding an action or a workflow.

## Versioning

Within a major, evolution is additive only: inputs and outputs can be added
with defaults, and removing or renaming an input, changing a default, or
broadening the permissions a caller must grant needs the next major. Inputs
whose name starts with `x_` are experimental and outside the contract. See
[`docs/usage.md`](docs/usage.md#additive-only-v1x-evolution-rule) for the
full rule.

## License

[MIT](LICENSE).
