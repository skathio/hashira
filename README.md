# hashira-ops

[![_self-ci](https://github.com/skathio/hashira-ops/actions/workflows/_self-ci.yml/badge.svg)](https://github.com/skathio/hashira-ops/actions/workflows/_self-ci.yml)

`hashira-ops` is a reusable-workflow + composite-action library for the three
most common CI/CD shapes — **npm package publish**, **NuGet package publish**,
and **static webapp / GitHub Pages deploy**. Consumers compose 1–2 caller
workflows from pinned references; the library carries the SHA pins on
third-party actions, the deny-all permissions narrowing, the OIDC wiring, the
two-workflow CI + Publish/Deploy gate model, and the five-scan security suite.

**Status**: v1.0.0 — released 2026-05-28.

## The three flows

### npm package publish

CI runs on every PR; Publish runs on push-to-main, gated by a GitHub
Environment with a required reviewer. Release-creates-the-tag chain via
semantic-release (D4): pack → publish → idempotent `gh release create`.
OIDC trusted publishing supported (no long-lived `NPM_TOKEN` required when
the registry-side trust is configured).

```yaml
# .github/workflows/ci.yml
name: ci
on:
  pull_request:
  push:
    branches: [main]

permissions: {}

jobs:
  ci:
    # Pin to a SHA pre-v1; switch to @v1 once the rolling tag is cut.
    uses: skathio/hashira-ops/.github/workflows/npm-package-ci.yml@<40-char-sha>
    permissions:
      contents: read
      pull-requests: write
      security-events: write
    with:
      library_ref: '<40-char-sha>'    # same SHA as `uses:` ref above
```

See [`docs/flows/npm.md`](docs/flows/npm.md) for the full walk-through
(Publish workflow template, secret model, OIDC trusted-publisher
onboarding, Environment setup, common failure modes).

### NuGet package publish

Same two-workflow shape as npm. MinVer-driven versioning
(`dotnet-pack-version` composite); `dotnet nuget push --skip-duplicate`
for idempotency; `gh release view || gh release create` chain for
the tag + GitHub Release. nuget.org's federated tokens are **not**
auto-exchanged by `dotnet nuget push` on dotnet 8.0.x — consumers
either wire caller-side token exchange or use the long-lived
`NUGET_API_KEY` fallback (recommended for v1).

```yaml
# .github/workflows/ci.yml
name: ci
on:
  pull_request:
  push:
    branches: [main]

permissions: {}

jobs:
  ci:
    uses: skathio/hashira-ops/.github/workflows/nuget-package-ci.yml@<40-char-sha>
    permissions:
      contents: read
      pull-requests: write
      security-events: write
    with:
      project_path: 'src/MyPackage/MyPackage.csproj'
      library_ref: '<40-char-sha>'
```

See [`docs/flows/nuget.md`](docs/flows/nuget.md) for the full walk-through.

### Static webapp / GitHub Pages

One caller workflow with two jobs (`ci` + `deploy`) connected by
`needs: ci`. Pages deploy uses the same-run artifact handoff (D12 —
no `workflow_run`, no cross-run artifact lookup). Autodetects the
build output directory among `dist/` → `build/` → `out/` → `public/`.
Deploy authenticates via OIDC (no secrets).

```yaml
# .github/workflows/deploy.yml
name: deploy
on:
  push:
    branches: [main]
  pull_request:    # CI half runs on PRs; deploy is gated by `needs: ci` + Environment

permissions: {}

jobs:
  ci:
    uses: skathio/hashira-ops/.github/workflows/static-webapp-ci.yml@<40-char-sha>
    permissions:
      contents: read
      id-token: write
      pages: write
      pull-requests: write
      security-events: write
    with:
      build_command: 'npm run build'
      library_ref: '<40-char-sha>'
  deploy:
    needs: ci
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    uses: skathio/hashira-ops/.github/workflows/static-webapp-deploy.yml@<40-char-sha>
    permissions:
      contents: read
      pages: write
      id-token: write
    with:
      library_ref: '<40-char-sha>'
```

See [`docs/flows/static-webapp.md`](docs/flows/static-webapp.md) for the
full walk-through (security callout on `library_ref` as an integrity
control, framework guidance, Pages enablement steps, common failure
modes).

## Read this next

- **[`docs/usage.md`](docs/usage.md)** — cross-cutting concepts:
  [pin policy](docs/usage.md#pin-policy),
  [gate model](docs/usage.md#gate-model),
  [secret-passing model](docs/usage.md#secret-passing-model),
  [permissions baseline](docs/usage.md#permissions-baseline),
  [additive-only v1.x evolution rule](docs/usage.md#additive-only-v1x-evolution-rule),
  [`x_`-prefix experimental input convention](docs/usage.md#x_-prefix-experimental-input-convention),
  [Environment configuration checklist](docs/usage.md#environment-configuration-adoption-checklist),
  [OIDC trust onboarding](docs/usage.md#oidc-trust-onboarding),
  [scan-suite toggles](docs/usage.md#scan-suite-toggles),
  [coverage reporting](docs/usage.md#coverage-reporting).
- **[`docs/flows/`](docs/flows/)** — per-flow walk-throughs (one file each
  for npm, nuget, static-webapp); copy-paste-ready caller templates with
  the input table, permissions table, and common failure modes.
- **[`docs/contributing.md`](docs/contributing.md)** — library-internal
  development guide.

## Versioning

`hashira-ops` follows an **additive-only v1.x evolution rule**: inputs and
outputs can only be added (with defaults) in v1.x.y patch and minor releases.
Removing an input, renaming an input, changing a default, or broadening the
permissions matrix requires a v2.0.0 major bump. Inputs whose name starts
with `x_` are explicitly experimental and out of the v1 contract — they
may change semantics or disappear in any v1.x.y release. See
[`docs/usage.md#additive-only-v1x-evolution-rule`](docs/usage.md#additive-only-v1x-evolution-rule)
for the full contract.

## License

[MIT](LICENSE).
