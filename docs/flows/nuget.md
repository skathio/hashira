# NuGet package flow — adoption walk-through

> **Audience**: a consumer adopting `skathio/hashira` for a NuGet package repo.
> **Scope**: copy-paste-ready CI + Publish caller workflow templates, MinVer
> PackageReference snippet, input/secret/permission tables, OIDC
> trusted-publishing onboarding (or API-key fallback), `production`
> Environment setup, release walk-through, common failure modes.
> **Status**: derived directly from `.github/workflows/nuget-package-ci.yml`
> and `.github/actions/nuget-push/action.yml` (v2 shape — the
> `nuget-package-publish.yml` reusable workflow this flow used in v1 is
> deleted; `nuget-push` is invoked directly from the consumer's own job).
> rogue is this flow's live consumer; its actual migration to v2 is Phase 6
> of this work item and has not yet happened — every OIDC/onboarding
> mechanism below is otherwise unchanged from the design `nuget-push`
> already implements (A2's nuget.org-OIDC-on-dotnet-10 verification is
> research-based PASS, not yet confirmed by a live publish — see
> `progress.md`).

For cross-cutting concepts (pin policy, gate model, secret-passing model,
permissions baseline, OIDC trust onboarding narrative, the versioning model
end-to-end), see [`../usage.md`](../usage.md).

---

## What changed from v1

v1's Publish half was a separate **reusable workflow**,
`nuget-package-publish.yml`, called via its own `uses:` line with its own
`inputs:`/`secrets:` block. **That file is deleted.** Its logic — pack via
MinVer, push, tag + Release — moved into the `nuget-push` **composite
action**, invoked directly from a job in the consumer's own caller file
(D2's architectural spine: OIDC trusted publishing requires the publish to
run with no `workflow_call` boundary between it and the consumer's
trusted-publisher-registered workflow file — see
[`../usage.md`](../usage.md#why-a-composite-action-not-a-reusable-workflow-for-cd)).

The version is also no longer MinVer's tag-inference acting as the de facto
release trigger. v2 resolves the version once, in CI, via the
`version-resolver` composite action (D1/D8) and passes it into
`dotnet-pack-version`'s `version_override` input, which sets MinVer's own
`MinVerVersionOverride` MSBuild property — MinVer is **kept** as the packing
mechanism, but explicit (the resolver's output) always wins over inferred
(MinVer's git-tag walk) when `version_override` is non-empty. See
[`../usage.md`](../usage.md#versioning-model) for the full versioning
narrative, including D14's seed-plus-bump-on-top semantics.

The auth model also changed: v1 distinguished OIDC vs. API-key implicitly
("API key empty means OIDC"); v2 has an explicit `auth: oidc|token|auto`
enum (D3/D11) with no silent downgrade from the secure path — see §7 below.

## 1. CI caller workflow template

Copy this into `.github/workflows/ci.yml` in your NuGet package repo:

```yaml
# .github/workflows/ci.yml
name: ci
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      bump:
        description: "Set to cut a release: patch | minor | major. Leave empty for a routine CI run."
        type: choice
        options: ['', patch, minor, major]
        default: ''
      seed_version:
        description: "Bare semver baseline (e.g. '0.0.0'). Only needed for the first release / no prior stable tag."
        type: string
        default: ''

# Deny-all default; each job grants what it needs.
permissions: {}

jobs:
  ci:
    # Pin to a SHA for reproducible builds (recommended), or @v2 for the
    # rolling tag. NEVER pin to @main — see docs/usage.md "Pin policy".
    uses: skathio/hashira/.github/workflows/nuget-package-ci.yml@<40-char-sha>
    # Per-job grants MUST mirror the matrix below — reusable workflows
    # can only narrow the caller's grants, not broaden them.
    permissions:
      contents: read
      pull-requests: write       # coverage-report sticky comment
      security-events: write     # CodeQL (when scan_disable enables it)
    with:
      project_path: 'src/MyLib/MyLib.csproj'
      # Optional overrides shown for clarity:
      # dotnet_version: '8.0.x'
      # test_filter: ''
      # coverage_path: 'coverage/cobertura.xml'
      # scan_disable: 'codeql,actionlint'
      library_ref: '<40-char-sha>'  # MUST be the SAME SHA as @<…> above.
      bump: ${{ inputs.bump }}
      seed_version: ${{ inputs.seed_version }}
```

`bump`/`seed_version` are passed straight through to the CI workflow's
`version` job, which only runs when `bump` is non-empty (every routine
PR/push run leaves it empty and is unaffected). The maintainer triggers a
release via `gh workflow run ci.yml -f bump=minor` (or the Actions UI's "Run
workflow" form).

## 2. Publish caller workflow template

The publish step is a **composite action (`nuget-push`) called from a job
in your own `ci.yml`** — NOT a reusable workflow (the v1
`nuget-package-publish.yml` reusable workflow this used to be is deleted).
This is required for the same reason as every other flow's CD half: a job
running inside a `workflow_call`-invoked reusable workflow carries the
*reusable workflow's own* path as its OIDC `job_workflow_ref` claim, which
can never match nuget.org's trusted-publisher policy for *your* workflow
file. A composite action runs inline in *your* job's context, so the claim
matches (D2 — see [`../usage.md`](../usage.md#gate-model)).

Because the gated `publish` job lives in the **same caller file** as `ci`
(linked via `needs:`), the CD job reads the resolved version straight off
the CI job's output — `needs.<job-id>.outputs.resolved_version` — there is
nothing to recompute. Append this job to the same `ci.yml` file from §1:

```yaml
# .github/workflows/ci.yml (continued — same file as §1)
  publish:
    needs: ci
    if: ${{ inputs.bump != '' }}
    runs-on: ubuntu-latest
    environment: production   # single gate; configure >=1 required reviewer (see §8)
    permissions:
      id-token: write       # NuGet/login OIDC token exchange (auth: oidc/auto)
      contents: write        # gh release create tags the commit
      pull-requests: read    # --generate-notes reads merged-PR metadata (read-only)
    steps:
      - uses: actions/checkout@<sha>  # v4.2.2
        with:
          persist-credentials: true  # REQUIRED: gh release create needs git
                                      # credentials on this job. checkout's default,
                                      # but set it explicitly — a consumer who
                                      # hardens with persist-credentials:false gets
                                      # a SILENT tag/release failure AFTER push.
      - uses: actions/setup-dotnet@<sha>
        with:
          dotnet-version: '8.0.x'
      # Download the same-run, byte-identical .nupkg that CI's `version` job
      # packed and uploaded (NFR-Rel-1) — never re-pack here.
      - uses: actions/download-artifact@<sha>
        with:
          name: nuget-package
          path: ${{ runner.temp }}/nuget-download
      - uses: skathio/hashira/.github/actions/nuget-push@<40-char-sha-or-v2>
        with:
          nupkg_path: ${{ runner.temp }}/nuget-download/*.nupkg
          version: ${{ needs.ci.outputs.resolved_version }}  # D8 — consumed, not recomputed
          # auth defaults to 'auto'. Use 'oidc' once trusted publishing is
          # confirmed working (no silent downgrade); 'token' to opt out of
          # OIDC entirely.
          # auth: oidc
          # Required when auth=oidc; used as the auto-attempt user when
          # auth=auto. Your nuget.org username that owns the trusted-
          # publishing policy.
          nuget_user: 'your-nuget-username'
          # Pick ONE auth path:
          #  - OIDC trusted publishing (above): omit this input entirely.
          #  - API key (auth: token, or as the auto fallback): pass it here.
          # This is a declared composite-action INPUT (with:), not a
          # secrets: map — composite actions have no secrets: syntax on
          # their uses: line. nuget-push never reads secrets.* directly,
          # only inputs.api_key.
          api_key: ${{ secrets.NUGET_API_KEY }}
```

The `ci` job (§1) is the gate: `publish` only runs after it passes, and only
when `bump` was set on the dispatch. One `production` approval per release.

## 3. MinVer PackageReference snippet

The NuGet flow uses **MinVer** for tag-driven version inference at the
foundation, but v2's release path always overrides it with the resolver's
explicit version (`version_override`, set by `dotnet-pack-version` whenever
the CI `version` job runs — see "What changed from v1" above). The library
does NOT install MinVer for you — it's an MSBuild-integrated
PackageReference your `.csproj` must carry. Add this to the project file
you pass as `project_path`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <IsPackable>true</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="MinVer" Version="5.0.0" PrivateAssets="All" />
  </ItemGroup>
</Project>
```

If you omit the MinVer PackageReference, `dotnet-pack-version` emits a
`::warning::` and falls back to whatever `<Version>` the project declares
when `version_override` is also empty — this only matters for routine
(non-release) `dotnet pack` invocations outside the resolver-driven release
path, since the release path's `version_override` is always non-empty and
wins regardless.

## 4. Input table

Every input across both `nuget-package-ci.yml` and the `nuget-push`
composite action, with type, default, and meaning — verified field-by-field
against the actual shipped YAML.

### CI inputs (`nuget-package-ci.yml`)

| Input | Type | Default | Meaning |
|-------|------|---------|---------|
| `dotnet_version` | string | `"8.0.x"` | Dotnet SDK channel installed via `actions/setup-dotnet` before restore/build/test. |
| `project_path` | string | _(required)_ | Path to the `.csproj` or `.sln` to restore/build/test/pack. **Trusted input** — interpolated into `dotnet` CLI argv. |
| `test_filter` | string | `""` | Optional `dotnet test --filter` expression. Empty string runs all tests. **Trusted input**. |
| `coverage_path` | string | `"coverage/cobertura.xml"` | Path where `dotnet test --collect:"XPlat Code Coverage"` writes the cobertura file. Consumed by `coverage-report`, which runs inside the `test` job. |
| `scan_disable` | string | `"codeql,actionlint"` | Comma-separated list of scans to skip (D10c). Pass `""` to enable everything. Values: `codeql`, `osv`, `gitleaks`, `dependency-review`, `actionlint`. |
| `library_ref` | string | _(required, no default)_ | SHA, tag, or branch of `skathio/hashira` checked out into `.hashira/` for in-repo composite actions (D9/D14). **Required** — every caller must pin it explicitly. PIN TO A SHA for reproducible builds; see the dual-pin invariant in [`../usage.md`](../usage.md#the-library_ref-dual-pin-invariant). |
| `bump` | string | `""` | One of `patch`\|`minor`\|`major`. Optional — leave empty for routine PR/push CI runs that aren't cutting a release. When set, the `version` job resolves the next version, surfaces it in the run summary, and packs it via `dotnet-pack-version`'s `version_override` (D1/D8). |
| `seed_version` | string | `""` | Bare semver baseline (e.g. `"0.0.0"`) for a major/initial release with no prior stable tag (FR-3). Passed through to `version-resolver` unchanged; ignored when a stable tag already exists or `bump` is empty. D14: the chosen `bump` still applies arithmetic **on top of** the seed — it is not published literally. |

### CI output (`nuget-package-ci.yml`)

| Output | Meaning |
|--------|---------|
| `resolved_version` | The resolved, validated bare semver string (e.g. `"1.3.0"`, no `v` prefix). Empty when `bump` was not provided. The workflow's **only** output (D8) — there is no second output for the `v`-prefixed tag form (derive it yourself: `v${{ needs.ci.outputs.resolved_version }}`) or for the bump kind (already your own dispatch input). |

### Publish inputs (`nuget-push` composite action)

| Input | Type | Default | Meaning |
|-------|------|---------|---------|
| `nupkg_path` | string | _(required)_ | Path to the `.nupkg` file (or glob) to push. Point this at the same-run artifact downloaded via `actions/download-artifact` (see §2) — never a freshly re-packed file (NFR-Rel-1). **Trusted input**. |
| `target` | string | `"https://api.nuget.org/v3/index.json"` | Feed URL to push to. **Trusted input**. |
| `auth` | string | `"auto"` | `oidc` \| `token` \| `auto` (D3/D11). See "Auth model" in §7. Trusted input. |
| `api_key` | string | `""` | NuGet API key. Pass via a **`with:` input** sourced from `secrets:` in the caller — **not** a `secrets:` map (composite actions have no `secrets:` map syntax on their `uses:` line); `nuget-push` never reads `secrets.*` directly, only `inputs.api_key`. Required (and used directly) when `auth=token`; usable as the `auto` fallback; ignored when `auth=oidc`. Trusted input (secret). |
| `nuget_user` | string | `""` | nuget.org username that owns the trusted-publishing policy. Required when `auth=oidc`; used as the auto-attempt user when `auth=auto`. Used as the `NuGet/login` action's `user` input. Trusted input. |
| `version` | string | _(required)_ | The resolved, validated bare semver string (e.g. `"1.3.0"`) to tag-and-release. Consumed as-is from the CI workflow's `resolved_version` output (D8) — this action does not compute or re-derive a version. Re-validated against strict semver here as the action's own checkpoint-2 (B7). |
| `skip_duplicate` | string | `"true"` | If `"true"`, adds `--skip-duplicate` to `dotnet nuget push` — makes a retry after a partial publish safe (FR-8). Trusted input. |
| `working_directory` | string | `"."` | Directory to run `dotnet nuget push`/`gh release create` from (must be the consumer's checked-out repo). Trusted input. |

### Publish outputs (`nuget-push`)

`nuget-push` declares no `outputs:` block — there is nothing to surface
beyond the run summary lines it writes (push result, tag/Release creation).

## 5. Secret table

| Secret | Required | Where | Purpose | OIDC obviates? |
|--------|----------|-------|---------|-----------------|
| `NUGET_API_KEY` (your name; passed as the `api_key` `with:` input) | optional — omit to use OIDC (see §7) | consumer's `publish` job, passed via `with: api_key: ${{ secrets.NUGET_API_KEY }}` | NuGet API key for `dotnet nuget push` (fallback / `auth: token`). | Yes under `auth: oidc`/`auto` — `nuget-push` runs the official `NuGet/login` action, which exchanges the job's GitHub OIDC token for a short-lived nuget.org key. Pass `api_key` only for `auth: token` or as the `auto` fallback. |

`nuget-push` sources the GitHub token for `gh release create` from
`${{ github.token }}` itself via an `env: GITHUB_TOKEN: ...` block
(composite actions have no `secrets:` context to read from directly) — you
do not pass it. The CI half needs no secrets at all.

## 6. Permissions table

Per-job grants the consumer's workflows MUST set, verified field-by-field
against the actual `permissions:` blocks in `nuget-package-ci.yml` and the
caller-job contract documented in `nuget-push/action.yml`'s header.
Reusable workflows (the CI half) can only NARROW the caller's grants, so the
consumer mirrors them at the caller job; the `nuget-push` composite action
cannot declare its own `permissions:` at all (no GitHub Actions primitive
for that on a composite action) — the grant lives entirely on the
**consumer's own job** that invokes it.

### CI permissions

| Caller job calls | `contents` | `pull-requests` | `security-events` | Why |
|-------------------|------------|------------------|---------------------|-----|
| `nuget-package-ci.yml` | `read` | `write` | `write` | `pull-requests:write` for the `coverage-report` sticky comment (runs inside the `test` job). `security-events:write` for CodeQL when enabled via `scan_disable`. `contents:read` for checkout. The `version` job (when `bump` is set) needs only `contents: read` — it never writes to the working tree (D1 stamp-only). |

### Publish permissions

Set these on the consumer's `publish` job (the one that calls
`nuget-push`):

| Job | `contents` | `pull-requests` | `id-token` | Why |
|-----|------------|------------------|------------|-----|
| `publish` (calls `nuget-push`) | `write` | `read` | `write` | `id-token:write` for `NuGet/login`'s OIDC token exchange (`auth: oidc`/`auto`). `contents:write` for `gh release create`'s tag + Release creation. `pull-requests:read` because `--generate-notes` (D13) only **reads** merged-PR metadata to compose notes — it does not write to or comment on PRs. v1's deleted `nuget-package-publish.yml` over-granted `pull-requests: write` here; v2 corrects this to `read` (least-privilege). |

The consumer's workflow-level `permissions: {}` (deny-all) is recommended;
the per-job grants above are the minimum required. Granting more at
workflow level inflates the `GITHUB_TOKEN`'s blast radius across every job
in the file.

## 7. NuGet trusted-publishing onboarding walk-through

Trusted publishing eliminates long-lived `NUGET_API_KEY` secrets by trading
a short-lived GitHub OIDC token for a nuget.org credential. `dotnet nuget
push` does not exchange the OIDC token itself, so `nuget-push` runs the
official `NuGet/login` action as a **separate, observable step** before
ever invoking `dotnet nuget push` — `nuget-push` branches on that step's
`outcome` to decide which credential to use (unlike the npm flow, where
the equivalent decision has no separate step to observe — see
[`../usage.md`](../usage.md#auth-model--auth-oidc--token--auto)).

### 7.1 nuget.org trusted-publisher setup (one-time)

1. Sign in to <https://www.nuget.org> with the account that owns the package.
2. Open the package page: `nuget.org/packages/<package-id>`.
3. Open **Manage Package** → **Trusted Publishing** (or under your
   account: **Account** → **Trusted Publishers**).
4. Add a GitHub Actions trusted publisher with these values:
   - **Repository owner**: `<your-github-org-or-user>`
   - **Repository name**: `<your-nuget-package-repo-name>`
   - **Workflow file**: `ci.yml` (matches the file you created in §1/§2 —
     CI and the gated `publish` job live in the same caller file)
   - **Environment** (optional but recommended): `production` (matches the
     `environment:` on your `publish` job)
5. Save the trusted-publisher configuration. `NuGet/login` matches the
   policy automatically by repository / workflow / environment — there is
   no publisher ID to copy into the workflow.

### 7.2 Auth model — `auth: oidc | token | auto`

There is no silent downgrade from the secure path (D3/D11):

- **`auth: oidc`** — always attempt `NuGet/login` (OIDC trusted publishing).
  Requires `nuget_user` non-empty. On failure (no key minted), **fails
  loud** — never falls back to `api_key`, even if one is set. The secure,
  recommended setting once trusted publishing is confirmed working.
- **`auth: token`** — always use `api_key` directly. Requires `api_key`
  non-empty. Never attempts `NuGet/login`/OIDC. An explicit opt-out.
- **`auth: auto`** *(default)* — attempt OIDC if `nuget_user` is set; if
  OIDC fails and `api_key` is present, fall back to it with an
  `::warning::` annotation. If OIDC fails and no `api_key` is present,
  fails loud, same as `auth: oidc`.

In your `ci.yml`'s `publish` job (§2):

1. Grant `id-token: write` (already in the §2 template).
2. Pass `nuget_user: '<your-nuget.org-username>'` in `with:`.
3. Omit the `api_key` secret entirely (or pass it anyway as the `auto`
   fallback — but see the precedence note below).
4. Keep `environment: production` matching the Environment in your
   trusted-publishing policy (§7.1).

Every release mints a fresh key from OIDC — there is no long-lived secret to
store or rotate.

**Precedence under `auth: auto`**: `NuGet/login` always runs first (gated
on `nuget_user` being set); `api_key` is only consulted if that step's
outcome is not `success` or it minted no key. Recommended: do NOT pass
`api_key` once OIDC is working — leaving it set can mask a misconfigured
trusted-publisher during onboarding; move to `auth: oidc` once confirmed
rather than leaving `auto` as a permanent steady state.

### 7.3 API-key alternative

If you prefer a long-lived key, or your nuget.org tenant can't use trusted
publishing yet, set `auth: token` and skip §7.1/§7.2:

1. Sign in to <https://www.nuget.org>.
2. Open **Account** → **API Keys** → **Create**.
3. Scope the key to **Push new packages and package versions** for the
   specific package ID (or glob pattern). Set a short expiry (≤ 90 days).
4. Save the key value somewhere immediately — nuget.org shows it only
   once.
5. In your package repo, open **Settings** → **Environments** →
   **production** → **Secrets** → **Add secret**. Name it
   `NUGET_API_KEY`; paste the value. Leave `nuget_user` unset (or leave
   `auth` at `auto` if you want OIDC tried first anyway).
6. Rotate the key on schedule (Dependabot does not rotate NuGet API
   keys; this is on your calendar).

The library's contract is identical either way — only the `auth` input and
which credential ends up populated change.

## 8. `production` Environment setup checklist

The `publish` job in your caller workflow declares `environment: production`.
That key IS the gate — configure the Environment BEFORE the first publish
run, otherwise the job proceeds without pausing.

1. In your package repo, open **Settings** → **Environments** → **New
   environment**.
2. Name it `production` (match the `environment:` on your `publish` job and
   the nuget.org trusted-publisher's "Environment" field, if you set one).
3. Under **Deployment protection rules**, enable **Required reviewers**
   and add at least one reviewer (yourself, or your team).
4. Optionally restrict the **Deployment branches** to `main`.
5. Under **Environment secrets**, add `NUGET_API_KEY` (per §7.3, if using
   the API-key path) so the secret is scoped to this Environment and is
   not accessible from the CI workflow's jobs.
6. Save.

**Verification**: trigger a release (`gh workflow run ci.yml -f bump=patch`).
The `publish` job should pause with "Waiting for review" — click **Review
deployments** → **Approve and deploy**.

### One-time `gh api` setup: require a reviewer (D12)

The library **cannot** runtime-verify that your `production` Environment has
a required reviewer configured — the `gh api environments` endpoint needs
admin-tier scope the workflow's `GITHUB_TOKEN` doesn't carry. Run this once,
with your own admin-scoped credentials, instead of (or in addition to) the
manual UI steps above:

```bash
# Require at least one reviewer on the `production` Environment before the
# first publish run. Replace OWNER/REPO and the numeric reviewer id (look it
# up via `gh api users/<username>`).
gh api --method PUT \
  repos/OWNER/REPO/environments/production \
  -f wait_timer=0 \
  -F "reviewers[][type]=User" \
  -F "reviewers[][id]=<numeric-user-id>" \
  -F deployment_branch_policy='{"protected_branches":true,"custom_branch_policies":false}'
```

A misconfigured Environment (zero reviewers) runs the gated job immediately
without pausing, and this is silent and indistinguishable from working until
something bad publishes — see [`../usage.md`](../usage.md#environment-reviewer-gate--what-the-library-can-and-cannot-verify)
for the full defense-in-depth story (this snippet + a self-CI lint asserting
the gated job declares `environment:`).

## 9. Release walk-through

The whole release happens in **one workflow run**, across two jobs in the
same caller file (`ci` → `publish`, linked via `needs:`):

1. A maintainer dispatches `ci.yml` with `bump` set (e.g. `minor`).
2. The `version` job (inside `nuget-package-ci.yml`) resolves the next
   version from tag history, surfaces it in the run summary, packs the
   project via `dotnet-pack-version` with `version_override` set to the
   resolved version (MinVer reads it verbatim instead of inferring from git
   tags), and uploads the `.nupkg` as the `nuget-package` artifact (D1/D8 —
   see [`../usage.md`](../usage.md#versioning-model)).
3. Once `ci` succeeds and the `production` Environment is approved, the
   `publish` job downloads that exact `.nupkg` (never re-packed), pushes it
   via `dotnet nuget push --skip-duplicate` under the chosen `auth` mode,
   then — only after a successful push — creates the `v<version>` tag and
   GitHub Release (`--generate-notes`).

**Atomicity — tag/Release creation happens only after a successful
push**: the `dotnet nuget push` step is attempted first; on failure, the
composite halts and **no tag or Release is created** (FR-8's safe-re-run
requirement — see [`../usage.md`](../usage.md#atomicity--tagrelease-creation-happens-only-after-a-successful-publish)).
Only after a successful push does the tag/Release step run, and it is
idempotent (`gh release view` first) — re-running the gated job after a
partial earlier failure does not fail on an already-existing tag/Release.
`--skip-duplicate` (default `true`) makes the push side of a retry safe
too: a re-push of an already-published version exits 0 instead of
crashing.

**Point of no return**: `dotnet nuget push`. Once a version exists on the
feed, nuget.org's unlist/delete policies apply (unlist is the standard
recourse; delete is restricted). Recovery is "publish a higher version
with the fix."

### Release notes (D13)

`nuget-push`'s tag/Release step passes `--generate-notes` to
`gh release create` — GitHub's own server-side PR/commit-range heuristic
populates the Release body. See [`../usage.md`](../usage.md#release-notes)
for the cross-cutting framing; this is shared mechanism with the npm flow.

## 10. Common failure modes

- **Missing MinVer PackageReference → routine (non-release) packs land at
  `0.0.0`/`1.0.0`**. `dotnet-pack-version` emits a `::warning::` but does
  not fail the build. The release path is unaffected (`version_override`
  always wins when `bump` triggers a release), but a `dotnet pack` run
  outside the release path with no MinVer reference and no override will
  carry whatever `<Version>` the `.csproj` declares. Fix: add the MinVer
  PackageReference per §3.

- **`--skip-duplicate` swallows real errors → check workflow log**.
  `dotnet nuget push --skip-duplicate` exits 0 both for fresh pushes and
  for "already exists" cases. `nuget-push` parses the log and surfaces the
  distinction in the step summary (`nuget-push: pushed …` vs
  `nuget-push: skipped (duplicate)`). For any other failure mode (401
  auth, 5xx feed error) `dotnet nuget push` exits non-zero and the job
  fails — but always read the log on a green run to confirm you actually
  pushed.

- **`gh release create` racing with a parallel run → idempotent guard
  explained**. Two simultaneous publish runs would both attempt
  `gh release create v<X.Y.Z>`. `nuget-push` runs `gh release view
  "v${VERSION}" --json id` first and only creates the release if that
  lookup fails, so the second arrival sees the existing release and exits
  0. Net effect: no orphan tags, no duplicate releases.

- **`api_key` set but malformed → 401 at push step**. nuget.org rejects
  the push with HTTP 401. `--skip-duplicate` does NOT swallow 401 (only
  the duplicate-version status). The job fails with the underlying error
  in the log. Fix: rotate the key per §7.3.

- **`auth: oidc` failed — `NuGet/login` did not mint a key**. Common
  causes: a ref/job-workflow mismatch with the configured nuget.org
  trusted-publishing policy, missing `id-token: write` on the calling job,
  or no matching policy at all. `auth: oidc` never falls back to `api_key`,
  even if one is set. Re-check §7.1's fields against your actual caller
  workflow filename + `environment:`.

- **Missing required reviewer on `production` Environment → ungated
  publish**. The `publish` job proceeds immediately if no reviewer is
  configured on the Environment. The library does NOT runtime-verify this
  (D12) — see §8's `gh api` snippet. Fix: configure the Environment per §8
  BEFORE the first run.

- **`library_ref` not pinned to a SHA → non-reproducible builds AND
  supply-chain exposure**. Every CI run checks out `skathio/hashira` at
  whatever `library_ref` resolves to at runtime. Pin `library_ref` to a SHA
  (or `@v2` for the rolling tag) and keep it identical to the outer
  `uses:` pin — see [`../usage.md`](../usage.md#the-library_ref-dual-pin-invariant)
  for the dual-pin invariant this protects.

- **"Build twice" cost in CI (~30-60s per run)**. The `test` job in
  `nuget-package-ci.yml` re-runs `dotnet restore` + `dotnet build` rather
  than consuming a build artifact from `restore-build`. Cross-job
  build-artifact passing would require a new third-party SHA pin
  (`actions/upload-artifact` / `actions/download-artifact`) outside the
  set already verified for this purpose. Trade-off intentional; revisit if
  your CI minute budget becomes a concern. The `restore-build → test`
  ordering still serves as a fail-fast compile gate.

## 11. Pointer to `docs/usage.md`

For cross-cutting concepts (pin policy, gate model, secret-passing model,
permissions baseline, OIDC trust onboarding narrative, the full versioning
model, the `library_ref` dual-pin invariant), see
[`../usage.md`](../usage.md).
