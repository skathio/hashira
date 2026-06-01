# Using hashira

Cross-cutting contract for all flows. Per-flow specifics live under
[`flows/`](./flows/).

This document is the **master contract surface** for the library. Section
headings below are the stable table of contents; bodies are populated phase by
phase. Markers indicate where each section is filled in.

## Pin policy

The `uses:` ref on every consumer caller workflow (and the `library_ref`
input on every reusable workflow that exposes it per D14) controls
**both** reproducibility and supply-chain integrity. There are three
shapes the library supports for the ref, and they trade off differently:

### Pre-v1 (current state)

Until `v1.0.0` is cut and the rolling `v1` tag is published, **pin to a
full 40-character commit SHA**. `@main` works mechanically but is **not
reproducible** (two callers on different days resolve to different
commits) and — more importantly — is a **supply-chain integrity risk**:
if the library repo is compromised, every consumer pinned to `@main`
runs the attacker's code at the next workflow trigger. This concern is
elevated for the static-webapp flow (where the CI half holds
`id-token: write` + `pages: write`, see
[`flows/static-webapp.md`](./flows/static-webapp.md) §1) and for the
npm/NuGet Publish halves (where the release job holds
`contents: write` + `id-token: write` + `pull-requests: write`).

### Post-v1 (after `v1.0.0` is tagged)

Three options, in increasing order of integrity tightness:

1. **`@v1` rolling tag** — points at the latest `v1.x.y` release.
   Consumers auto-pick up additive minor/patch releases (which by the
   v1.x evolution rule cannot break their workflow) without a PR.
   Trade-off: byte-exact reproducibility is lost — two runs of the same
   caller commit may resolve to different library commits as new v1.x.y
   tags are rolled. Acceptable for most consumers.

2. **`@v1.X.Y` specific tag** — points at one release. Consumers
   explicitly opt in to each new release via PR. Stable until the
   consumer bumps it. Recommended for consumers who want a slower
   adoption cadence.

3. **`@<40-char-sha>` SHA pin** — strongest integrity option. Byte-exact
   reproducibility; an attacker compromising the library repo cannot
   silently shift the consumer's pinned code. Recommended for CI/CD
   provenance audits, regulated environments, and consumers who want
   the same SBOM artifact across re-runs. Dependabot's
   `github-actions` ecosystem can automate the bump PRs.

### Consistency between `uses:` and `library_ref`

D14 introduced `library_ref` as a workflow input so reusable workflows
can check out the same library version they themselves came from. The
two refs **MUST point at the same commit**. Pinning
`uses: ...@<sha-A>` while leaving `library_ref: 'main'` (or vice-versa)
is a footgun: the reusable workflow YAML is at SHA-A, but the in-repo
composite actions it invokes via `./.hashira/.github/actions/<name>`
resolve to whatever `main` is at the time the workflow runs. The
runtime contract document for each flow's caller template
([`flows/npm.md`](./flows/npm.md) §1, [`flows/nuget.md`](./flows/nuget.md)
§1, [`flows/static-webapp.md`](./flows/static-webapp.md) §1) shows the
expected paired-pin shape.

### Tag-roll dance (library-side, for future v1.x.y releases)

After each `v1.X.Y` release the library's owner rolls the `v1` tag
forward:

```bash
git tag -f v1 v1.X.Y
git push -f origin v1
```

The `-f` flag force-overwrites the existing `v1` tag — this is a
**deliberate, documented part of the library's release process**.
Consumers pinning to `@v1` are explicitly opting into rolling-tag
semantics; consumers who do not want force-pushed refs in their
provenance audit trail use the `@v1.X.Y` or `@<sha>` pin instead.
GitHub's marketplace-action convention (`actions/checkout@v4`,
`actions/setup-node@v4`) follows the same pattern, so consumers should
not be surprised by it. The library does NOT force-push tags other than
the major-version rolling tags (`v1`, eventually `v2`).

## Gate model

The library uses the **two-workflow shape per flow** (D8): a CI workflow runs
on every PR/push (always-on, no gate), and a Publish (or Deploy) workflow runs
on the consumer's chosen trigger (e.g. `on: push: branches: [main]` or
`workflow_dispatch`) and is **gated by a GitHub Environment** with a required
reviewer.

The reviewer click in the GitHub UI is the explicit gate. There is no
library-side runtime check that the Environment has a required reviewer
configured (per D13 — the `gh api environments` endpoint requires
admin-tier scope on private repos, which the workflow `GITHUB_TOKEN`
doesn't carry; the library can't reliably defend the mixed-visibility
consumer set, so it doesn't try). **Consumer responsibility**: configure
your Environment with at least one required reviewer before the first
publish/deploy run. A misconfigured Environment runs the gated job
immediately without pausing.

This is NOT `workflow_run`. `workflow_run` runs in default-branch context
with default-branch secrets even when triggered by PR-originating CI runs,
which is a security concern (PR contributors who can influence the CI
workflow's behavior can effectively trigger a deploy under default-branch
context). The shape the library recommends is two separate caller files
(`ci.yml` + `publish.yml`) for npm/NuGet, or a single caller file with two
jobs connected by `needs:` for static-webapp (per D12 — keeps the
artifact handoff in the same workflow run).

Per-flow gate details:

- **npm Publish**: GitHub Environment (default `production`); see
  [`flows/npm.md`](./flows/npm.md) §7.
- **NuGet Publish**: GitHub Environment (default `production`); see
  [`flows/nuget.md`](./flows/nuget.md) §8. Release-creates-the-tag chain
  per D4 (pack → push → idempotent `gh release create`).
- **Static webapp Deploy**: GitHub Environment (`github-pages` or custom)
  + caller-side `needs:` between CI and Deploy jobs in one file (D12);
  see [`flows/static-webapp.md`](./flows/static-webapp.md) (phase 4).

## Secret-passing model

Reusable workflows declare every secret they require explicitly in their
`secrets:` block at the top of the workflow YAML. Consumers pass only the
secrets the workflow declares, via the `secrets:` map on the caller's
`uses:` invocation. **`inherit` is discouraged** — it propagates every
secret in the caller repo into the reusable workflow, broadening the
GITHUB_TOKEN's effective blast radius unnecessarily.

For the npm flow, the only secret is `NPM_TOKEN` (optional — if OIDC
trusted publishing is configured, the workflow uses OIDC and the secret
can be omitted entirely). The `GITHUB_TOKEN` is auto-provided by the
runner and does not need to be passed explicitly.

For the NuGet flow, the only secret is `NUGET_API_KEY` (required for
nuget.org unless the consumer wires a caller-side federated-token →
short-lived API key conversion before invoking the Publish workflow;
`dotnet nuget push` does NOT auto-exchange OIDC tokens on dotnet 8.0.x).
See [`flows/nuget.md`](./flows/nuget.md) §7.

Per-flow secrets are documented in each flow's `docs/flows/<name>.md`
secret table. The reusable workflow's `secrets:` block carries the
machine-readable contract (every secret has a `description:` per the
D10 contract surface).

Example consumer secret-passing — reusable workflows take a `secrets:` map
(e.g. the NuGet publish flow); the npm **publish** flow is a composite action
(`npm-release`) called from the consumer's own job, so any fallback `NPM_TOKEN`
is passed as job/step `env` instead (the action cannot read `secrets.*`). On the
official npm registry, OIDC trusted publishing needs no token at all:

```yaml
jobs:
  publish:
    # ... environment: production, id-token: write, etc.
    steps:
      - uses: actions/checkout@<sha>
        with: { fetch-depth: 0, persist-credentials: true }
      - uses: skathio/hashira/.github/actions/npm-release@v1
        # Only for a non-official registry / no OIDC:
        # env:
        #   NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## Permissions baseline

Every reusable workflow declares `permissions: {}` at workflow level
(deny-all baseline per NF6) and grants the minimum per job. Consumers
must mirror the per-job grants at their caller's job-level `permissions:`
block — reusable workflows can only NARROW the caller's grants, never
broaden them, so if the consumer's deny-all default isn't selectively
broadened at the call site, the reusable workflow's internal steps fail
with permission errors.

Per-flow grants required at the consumer's caller job:

| Flow                          | Caller job permissions required |
|-------------------------------|---------------------------------|
| `npm-package-ci.yml`          | `contents: read`, `pull-requests: write`, `security-events: write` |
| npm publish — `npm-release` action (consumer `publish` job) | `contents: write`, `pull-requests: write`, `id-token: write`, `issues: write` |
| `nuget-package-ci.yml`        | `contents: read`, `pull-requests: write`, `security-events: write` |
| `nuget-package-publish.yml`   | `contents: write`, `pull-requests: write`, `id-token: write` |
| `static-webapp-ci.yml`        | `contents: read`, `id-token: write`, `pages: write`, `pull-requests: write`, `security-events: write` |
| `static-webapp-deploy.yml`    | `contents: read`, `id-token: write`, `pages: write` |

**Static-webapp CI `id-token: write` note**: `static-webapp-ci.yml` is the only CI-half workflow
that requires `id-token: write` at the caller job. npm and NuGet CI halves do NOT require
`id-token: write` — that scope belongs only on their Publish-half release jobs. The asymmetry
exists because `actions/upload-pages-artifact` authenticates the artifact upload via OIDC and the
upload must happen in the same job as `build_command` (cross-job artifact handoff would require
`actions/upload-artifact` + `actions/download-artifact` — a class of "wrong directory packaged"
failure modes plus an extra third-party SHA pin; the trade-off is documented in
[`flows/static-webapp.md`](./flows/static-webapp.md) §1 and the `static-webapp-ci.yml` header's
`## Build artifact handoff` section). Practical consequence: the static-webapp consumer's CI caller
job holds `id-token: write` on every PR run, not only on deploy runs.

Detailed per-job grant breakdowns live in each flow's
`docs/flows/<name>.md` permissions table. The workflow-level
`permissions: {}` deny-all default is recommended for every consumer
caller workflow.

## Additive-only v1.x evolution rule

The v1 contract guarantees that consumer caller workflows pinned to
`@v1` (or any `@v1.X.Y`) keep working without modification across the
entire v1.x.y series. The library commits to:

**Allowed in `v1.x.y` patch and minor releases (additive only)**:

- Add a **new** input to a reusable workflow's `inputs:` block (with a
  sensible default; consumers who don't set it get the prior behavior).
- Add a **new** input or output to a composite action's `inputs:` /
  `outputs:` blocks.
- Add a **new** reusable workflow or composite action.
- Fix bugs that bring observed behavior in line with documented
  behavior.
- Refresh third-party action SHA pins inside composite actions
  (treated as internal — v1.x can bump them; consumers do not see the
  pinned versions across the contract boundary).
- **Narrow** the permissions matrix (better default; strictly safer
  for consumers).

**NOT allowed in `v1.x.y` — requires a `v2.0.0` major bump**:

- Remove or rename an input.
- Change the default value of an existing input.
- Remove a reusable workflow file or composite action.
- Change documented user-observable behavior without a corresponding
  new input.
- **Broaden** the permissions matrix (new attack surface; consumers'
  caller workflows must explicitly broaden to match — a silent
  broadening violates the deny-all baseline narrative).

**Not covered by the contract** (the library may change these freely
within v1.x):

- Implementation details of composite actions that don't surface in
  inputs/outputs.
- Internal step names, summary message formatting, and the exact text
  of `::warning::` / `::error::` annotations.
- The number, ordering, and naming of jobs in a reusable workflow's
  internal `jobs:` graph (consumers don't reference these by name).
- Third-party action SHA pins inside composite actions (refreshed
  in-place as those projects ship security fixes).

If you depend on any "not covered" detail (e.g., parsing the workflow
summary in a downstream automation), pin to a specific SHA or
`@v1.X.Y` tag instead of `@v1`. The rolling tag's stability guarantee
covers the input/output/permissions contract only.

## `x_`-prefix experimental input convention

Inputs whose name starts with `x_` are **explicitly out of the v1
contract**. The library uses this prefix to ship a feature behind a flag
and gather feedback before promoting it to the stable input surface.

`x_`-prefixed inputs:

- MAY change semantics between any two v1.x.y releases.
- MAY change defaults between any two v1.x.y releases.
- MAY disappear entirely in a future v1.x.y release without a major
  bump.

Consumers who use `x_` inputs explicitly accept that risk. The benefit
is early access to features that aren't yet ready for the v1 freeze; the
cost is that the consumer must track each `x_` input's evolution in the
library's CHANGELOG and update their caller workflow when the input
changes.

When an `x_` input graduates to the stable surface, the library adds the
stable (non-prefixed) input in an additive minor release; the `x_`
version is kept for at least one minor release as a deprecation shim
(emitting a `::warning::` when set) and then removed in a subsequent
v1.x.y release. The graduation event is called out in the CHANGELOG.

**v1.0.0 ships with no `x_`-prefixed inputs.** The contract audit at
v1.0.0 (see this document's release diary entry) explicitly excluded the
prefix from the v1 freeze; consumers can assume every input on a v1.0.0
reusable workflow is stable.

## Environment configuration adoption checklist

Per-flow Environment checklists live in each flow's
`docs/flows/<name>.md`. See [`flows/npm.md`](./flows/npm.md) §7 for
npm's `production` Environment, [`flows/nuget.md`](./flows/nuget.md) §8
for NuGet's `production` Environment, and
[`flows/static-webapp.md`](./flows/static-webapp.md) §6 for the
`github-pages` Environment (which carries the magic Pages environment
name and deployment-status-display quirks).

## OIDC trust onboarding

OIDC trusted publishing eliminates long-lived publish tokens by exchanging
a short-lived GitHub OIDC token for a registry-side publish token at
publish time. Each flow's `docs/flows/<name>.md` contains the
registry-specific onboarding steps; this section describes the generic
narrative.

For npm: the `npm-release` composite action pins `@semantic-release/npm@13`,
which performs npm OIDC trusted publishing natively (requests the OIDC token,
exchanges it at the registry, publishes with `NPM_CONFIG_PROVENANCE=true` so the
package carries a signed provenance attestation). The publish runs in the
**consumer's own `publish.yml` job** so the OIDC `workflow_ref` matches the
trusted-publisher config. Step-by-step onboarding lives in
[`flows/npm.md`](./flows/npm.md) §6.

For NuGet: nuget.org supports trusted-publishing (federated tokens) as a
preview feature, but `dotnet nuget push` on dotnet SDK 8.0.x does NOT
auto-exchange the GitHub OIDC token — consumers must either wire a
caller-side federated-token → short-lived API key conversion before
invoking `nuget-package-publish.yml`, or use the long-lived
`NUGET_API_KEY` fallback (recommended for v1). The library's contract is
identical either way: `NUGET_API_KEY` carries whatever the consumer
provides. Step-by-step onboarding (federation + fallback) lives in
[`flows/nuget.md`](./flows/nuget.md) §7.

When OIDC is configured correctly, the consumer can omit the long-lived
token secret entirely. When OIDC fails (registry-side trust
misconfigured), the workflow falls back to the long-lived token if set,
and emits a `::warning::` so the consumer is alerted to the
misconfiguration. The recommendation is to NOT set the long-lived token
once OIDC is working — leaving both creates a silent fallback path that
masks OIDC misconfiguration during onboarding.

## Scan-suite toggles

The CI half of every package/webapp flow includes a `scan-suite` job
that runs five security scans against the consumer's repo:

| Scan | What it checks | Skipped by default? |
|------|----------------|---------------------|
| `codeql` | CodeQL static analysis (language-specific) | **Yes** |
| `osv` | OSV-Scanner — known-vulnerable dependencies | No |
| `gitleaks` | Secrets committed to git history | No |
| `dependency-review` | New dependency changes on PRs (CVE / license) | No (PR-only) |
| `actionlint` | GitHub Actions workflow lint | **Yes** |

The `scan_disable` input is a **comma-separated string** of scan names
to skip (D10c — CSV-string format chosen over a list to keep the
reusable-workflow input contract scalar).

### Default value

`scan_disable: 'codeql,actionlint'`

- **`codeql` is skipped by default** because most consumer repos don't
  have CodeQL enabled (Settings → Security → Code scanning). Running
  CodeQL against a repo where it isn't enabled emits a confusing
  permission error rather than a useful finding.
- **`actionlint` is skipped by default** because the consumer's repo
  may not be a workflow library — actionlint findings against
  application-shaped workflows are typically noise rather than signal.

### Enabling everything

Pass an empty string to enable all scans (recommended once CodeQL is
configured on the repo):

```yaml
with:
  scan_disable: ''
```

### Disabling additional scans

Append the scan name(s) to the default CSV:

```yaml
with:
  scan_disable: 'codeql,actionlint,osv'    # also skip OSV-Scanner
```

### Permissions asymmetry note

The `scan-suite` job grants `security-events: write` even under the
default skip-list. This is deliberate: consumers who flip `codeql` on
(by setting `scan_disable: ''`) should not also have to remember to
broaden their caller's permissions matrix. The grant is unused while
`codeql` is in the skip-list, which is the honest trade-off documented
inline in each CI workflow (`npm-package-ci.yml`, `nuget-package-ci.yml`,
`static-webapp-ci.yml`).

## Coverage reporting

The CI half of every package/webapp flow ends with a `coverage-report`
job that parses the consumer's coverage file and renders a sticky PR
comment with per-file coverage percentages and a delta against the
PR's base.

### Supported formats

`coverage-report` auto-detects the coverage format from the file
extension and content:

- **lcov** (`coverage/lcov.info`) — standard JS / TypeScript output
  from Jest, Vitest, c8, nyc, etc.
- **cobertura** (`coverage/cobertura.xml`) — .NET output from
  `coverlet.msbuild`'s default format; also Python `coverage.py`'s
  cobertura output.
- **opencover** (`coverage.opencover.xml`) — .NET output from
  `coverlet.collector` with `CollectCoverage=true` and
  `CoverletOutputFormat=opencover`.

### `coverage_path` input

The consumer configures the path via `coverage_path`. Defaults differ
per flow:

| Flow | `coverage_path` default |
|------|-------------------------|
| `npm-package-ci.yml` | `coverage/lcov.info` |
| `nuget-package-ci.yml` | `coverage/cobertura.xml` |
| `static-webapp-ci.yml` | `coverage/lcov.info` |

If the file at `coverage_path` doesn't exist, the job emits a
`::warning::` and skips the comment rather than failing — coverage
reporting is informational, not a gate.

### Sticky comment mechanism

The sticky comment uses a **hidden HTML anchor** embedded in the
comment body (not a marker comment) to identify itself across
consecutive runs. On subsequent CI runs on the same PR, the
`actions/github-script`-based step finds the existing comment by anchor
and **updates it in place** rather than spawning a duplicate. This
keeps PR threads clean even on heavily-iterated PRs.

The anchor format is internal and may change between v1.x.y releases;
consumers should not script against it.

### Codecov / external coverage services

Codecov upload was deliberately deferred from v1 (see follow-ups in the
work item's `progress.md`). For v1, the GitHub-native sticky-comment is
the only coverage UI. Consumers who want historical coverage trends
should opt in to Codecov outside the library's reusable workflow
(typically a `codecov/codecov-action@<sha>` step in the caller); the
library does not interfere with that path.
