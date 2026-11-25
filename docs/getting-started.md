# Getting started

This page takes a repository with no CI at all to its first release through
hashira. It is the short path: each step links to the flow guide or to
[`usage.md`](./usage.md) for the detail behind it.

You need admin access to the repository (to create an Environment) and, for a
package, owner access to the package on its registry.

## 1. Choose a flow

hashira has three flows. Pick the one that matches what your repository ships.

| You ship | Flow | Guide | Caller template |
| --- | --- | --- | --- |
| An npm package | npm | [npm flow](./flows/npm.md) | [`templates/npm/ci.yml`](../templates/npm/ci.yml) |
| A NuGet package | NuGet | [NuGet flow](./flows/nuget.md) | [`templates/nuget/ci.yml`](../templates/nuget/ci.yml) |
| A static site on GitHub Pages | Static site | [Static site flow](./flows/static-webapp.md) | [`templates/static-webapp/ci.yml`](../templates/static-webapp/ci.yml) |

Each flow is one caller file in your repository. Its `ci` job calls hashira's
reusable CI workflow, and its gated job (`publish` for a package, `deploy` for
a site) runs hashira's CD composite action in your own job, behind an
Environment approval.

## 2. Copy the caller

Copy your flow's template word for word to `.github/workflows/ci.yml` in your
repository. Keep the file name `ci.yml`: the trusted-publisher setup below
names it, and the registry rejects a trusted publish from any other workflow
file.

The template is already complete. Change it only where the flow guide says you
may, for example to pass CI inputs or, for NuGet, to switch from an API key to
trusted publishing. Each guide's input, secret and permissions tables list
what every job needs and why.

Open a pull request with the file. The `ci` job runs and reports the check
`ci / passed`, which you can make a required check on `main`.

## 3. Pin the library

Every `uses: skathio/hashira/...` line in your caller names a ref. The
templates use `@v3`, the rolling tag for the current major. You have three
choices, from loosest to tightest:

- `@v3` picks up every additive v3 minor and patch release without a PR.
- `@v3.X.Y` pins one release, and you take each new one through a PR.
- A full 40-character commit SHA is byte-exact and cannot be moved under you.
  Dependabot's `github-actions` ecosystem keeps it current with bump PRs.

Never pin `@main`. It resolves to whatever `main` is when the run starts, so
it is neither reproducible nor safe from a change you did not review. Pin
every third-party action in your own jobs to a full SHA too, as the templates
do. The trade-offs are in [Pin policy](./usage.md#pin-policy).

## 4. Set up the gate and the registry

The gated job declares an Environment, and that Environment is the release
gate. Create it before the first release, or the gated job runs without
pausing.

### Packages: the `production` environment

For npm and NuGet, the `publish` job declares `environment: production`.

1. In your repository, open **Settings**, then **Environments**, then **New
   environment**, and name it `production`.
2. Under **Deployment protection rules**, turn on **Required reviewers** and
   add at least one reviewer.
3. Restrict **Deployment branches** to `main` if you want only `main` to
   publish.

hashira cannot check that the Environment has a reviewer, so the flow guides
give a one-time `gh api` command that sets one. See the `production`
Environment checklist in the [npm flow](./flows/npm.md) or the
[NuGet flow](./flows/nuget.md).

### Packages: OIDC trusted publishing

With trusted publishing, the `publish` job trades a short-lived GitHub OIDC
token for a registry credential at publish time, so no long-lived publish
token is stored in the repository. On the registry, register a trusted
publisher for your repository with the workflow file `ci.yml` and the
environment `production`.

- **npm**: the npm template already grants `id-token: write` and publishes
  through OIDC with no token. Add the trusted publisher on npmjs.com under the
  package's **Settings**. npm only lets you add one to a package that already
  exists, so a package that has never been published needs its first version
  published with a token (`auth: token`, with `npm_token` read from an
  `NPM_TOKEN` secret on the `production` environment), and OIDC from then on. The steps are in the
  [npm flow](./flows/npm.md).
- **NuGet**: the template ships with an API key (`auth: token` and a
  `NUGET_API_KEY` secret on the `production` environment). To use trusted
  publishing instead, add the trusted publisher on nuget.org, grant
  `id-token: write` on the `publish` job and pass `nuget_user`. The steps are
  in the [NuGet flow](./flows/nuget.md).

[OIDC trust onboarding](./usage.md#oidc-trust-onboarding) explains the
`auth: oidc | token | auto` modes for both registries.

### Static sites: Pages and the `github-pages` environment

A static site does not publish to a registry. Under **Settings**, then
**Pages**, set the source to **GitHub Actions**, then create the
`github-pages` Environment with a required reviewer. The
[Static site flow](./flows/static-webapp.md) has both checklists.

## 5. Cut the first release

A package release is a dispatch of your `ci.yml` with a `bump`. Pull requests
and pushes leave `bump` empty and only run CI.

The first release has no earlier version tag to bump from, so give it a
`seed_version`. The bump applies on top of the seed, so a seed of `0.0.0` with
`major` releases `1.0.0`, and with `minor` releases `0.1.0`:

```sh
gh workflow run ci.yml -f bump=minor -f seed_version=0.0.0
```

Later releases need only the bump:

```sh
gh workflow run ci.yml -f bump=patch
```

The run resolves the version, builds and packs it, and waits for the
`production` approval. After you approve, the `publish` job publishes that
exact package, then creates the `vX.Y.Z` tag and a GitHub Release with
generated notes. A publish that fails creates no tag, so a re-run is safe.
[Versioning model](./usage.md#versioning-model) covers how the version is
resolved.

A static site has no version to resolve. Merging to `main` deploys it after
the `github-pages` approval, and a dispatch with no inputs deploys it again:

```sh
gh workflow run ci.yml
```

## Next steps

- Your flow's guide: the [npm flow](./flows/npm.md), the
  [NuGet flow](./flows/nuget.md) or the
  [Static site flow](./flows/static-webapp.md), for every input, secret,
  permission and common failure.
- [Using hashira](./usage.md) for the cross-cutting contract: the gate model,
  secrets, permissions and how hashira evolves within a major.
- The [Catalog](./catalog.md) for every workflow and action with its inputs
  and outputs.
