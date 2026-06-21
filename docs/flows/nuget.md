# NuGet package flow — adoption walk-through

> **Audience**: a consumer adopting `hashira-ops` for a NuGet package repo.
> **Scope**: copy-paste-ready CI + Publish caller workflow templates, MinVer
> PackageReference snippet, input/secret tables, OIDC federated-token
> onboarding (or API-key fallback), `production` Environment setup, release
> walk-through, common failure modes.
> **Status**: derived from the workflow YAML + D4 release walk-through + spec
> §8 permissions matrix. The library has no live-publish evidence yet (rev-7
> defers real adoption to user post-v1); every OIDC/onboarding inference is
> marked "inferred — confirm with first real adoption".

For cross-cutting concepts (pin policy, gate model, secret-passing model,
permissions baseline, OIDC trust onboarding narrative), see
[`../usage.md`](../usage.md).

---

## 1. CI caller workflow template

Copy this into `.github/workflows/ci.yml` in your NuGet package repo:

```yaml
# .github/workflows/ci.yml
name: ci
on:
  pull_request:
  push:
    branches: [main]

# Deny-all default; each job grants what it needs.
permissions: {}

jobs:
  ci:
    # MUST pin to a SHA — using `main` exposes you to library-repo
    # compromise (not just non-reproducible builds). See §11 for the
    # library-repo trust model.
    uses: skathio/hashira-ops/.github/workflows/nuget-package-ci.yml@<40-char-sha>
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
```

## 2. Publish caller workflow template

Copy this into `.github/workflows/publish.yml`:

```yaml
# .github/workflows/publish.yml
name: publish
on:
  push:
    branches: [main]
  # Optional: workflow_dispatch lets you trigger a publish manually.
  workflow_dispatch:

# Deny-all default.
permissions: {}

jobs:
  publish:
    # MUST pin to a SHA — see §11.
    uses: skathio/hashira-ops/.github/workflows/nuget-package-publish.yml@<40-char-sha>
    permissions:
      id-token: write     # required for OIDC trusted publishing (NuGet/login)
      contents: write     # gh release create tags + creates the GitHub Release
      pull-requests: write # gh release create --generate-notes may post on linked PRs
    with:
      project_path: 'src/MyLib/MyLib.csproj'
      target: 'https://api.nuget.org/v3/index.json'
      environment_name: 'production'    # MUST have >=1 required reviewer (see §8)
      # dotnet_version: '8.0.x'
      # prerelease_identifier: 'alpha'
      # version_increment: 'minor'   # one of: minor, major, '' (patch — default)
      library_ref: '<40-char-sha>'  # MUST be the SAME SHA as @<…> above.
      # OIDC trusted publishing (recommended): set nuget_user to your
      # nuget.org username and DO NOT pass the NUGET_API_KEY secret below.
      nuget_user: 'your-nuget-username'
    secrets:
      # Pick ONE auth path:
      #  - OIDC trusted publishing (above): omit this secret entirely.
      #  - API key: pass it here and leave `nuget_user` unset.
      NUGET_API_KEY: ${{ secrets.NUGET_API_KEY }}
```

The two-workflow shape (CI in one file, Publish in another) is the
canonical shape per D8. CI runs on every PR/push; Publish runs on the
consumer's chosen trigger and is gated by the `production` GitHub
Environment.

## 3. MinVer PackageReference snippet

The NuGet flow uses **MinVer** (per D4) for tag-driven version inference.
The library does NOT install MinVer for you — it's an MSBuild-integrated
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
`::warning::` and MSBuild falls back to whatever `<Version>` the project
declares (often `1.0.0` or `0.0.0`) — almost never what you want.

## 4. Input table

Every input across both `nuget-package-ci.yml` and
`nuget-package-publish.yml`, with type, default, and meaning.

### CI inputs (`nuget-package-ci.yml`)

| Input              | Type   | Default                      | Meaning |
|--------------------|--------|------------------------------|---------|
| `dotnet_version`   | string | `"8.0.x"`                    | Dotnet SDK channel installed via `actions/setup-dotnet` before restore/build/test. |
| `project_path`     | string | _(required)_                 | Path (relative to your repo root) to the `.csproj` or `.sln` to restore/build/test. **Trusted input** — interpolated into `dotnet` CLI argv. |
| `test_filter`      | string | `""`                         | Optional `dotnet test --filter` expression. Empty string runs all tests. **Trusted input**. |
| `coverage_path`    | string | `"coverage/cobertura.xml"`   | Path where `dotnet test --collect:"XPlat Code Coverage"` writes the cobertura file. Consumed by `coverage-report`. |
| `scan_disable`     | string | `"codeql,actionlint"`        | Comma-separated list of scans to skip (per D10c). Pass `""` to enable everything. Values: `codeql`, `osv`, `gitleaks`, `dependency-review`, `actionlint`. |
| `library_ref`      | string | `"main"`                     | SHA, tag, or branch of `skathio/hashira-ops` checked out into `.hashira/` for in-repo composite actions (D14). **PIN TO A SHA** for reproducible builds. |

### Publish inputs (`nuget-package-publish.yml`)

| Input                  | Type   | Default                                  | Meaning |
|------------------------|--------|------------------------------------------|---------|
| `dotnet_version`       | string | `"8.0.x"`                                | Dotnet SDK channel installed via `actions/setup-dotnet` before pack/push. **Trusted input**. |
| `project_path`         | string | _(required)_                             | Path to the `.csproj` or `.sln` to pack. **Trusted input**. |
| `target`               | string | `"https://api.nuget.org/v3/index.json"`  | Feed URL to publish to (D10b unified target). **Trusted input**. |
| `prerelease_identifier`| string | `""`                                     | MinVer prerelease identifier (e.g. `alpha`, `beta`). Empty = MinVer default. **Trusted input**. |
| `version_increment`    | string | `""`                                     | MinVer auto-increment hint. One of `minor`, `major`, or empty (patch — MinVer default). **Trusted input**. |
| `environment_name`     | string | `"production"`                           | Name of the GitHub Environment to gate the pack-and-push job on (D13). Must have >=1 required reviewer for the gate to be effective. **Trusted input**. |
| `library_ref`          | string | `"main"`                                 | SHA, tag, or branch of `skathio/hashira-ops` checked out into `.hashira/` (D14). **PIN TO A SHA** for reproducible builds. |
| `nuget_user`           | string | `""`                                     | nuget.org username that owns the trusted-publishing policy. Set this (and leave `NUGET_API_KEY` unset) to publish via OIDC trusted publishing — `nuget-push` runs `NuGet/login` to mint a short-lived key. Empty = API-key path. **Trusted input**. See §7. |

## 5. Secret table

| Secret          | Required                                | Workflow                    | Purpose | OIDC obviates? |
|-----------------|-----------------------------------------|-----------------------------|---------|----------------|
| `NUGET_API_KEY` | only on the API-key path — omit it to use OIDC (see §7) | `nuget-package-publish.yml` | API key for `dotnet nuget push`. | Yes. Set the `nuget_user` input and leave this secret unset: `nuget-push` runs `NuGet/login` to mint a short-lived key from the job's OIDC token (see §7). |

CI half has no required secrets (the workflow inherits the caller's
`GITHUB_TOKEN` only).

## 6. Permissions table

Per-job grants the consumer's caller workflow MUST set. The reusable
workflow declares these at the job level internally, but reusable workflows
can only NARROW the caller's grants, so the consumer must grant them at
the job level too. Cross-reference: NF6 deny-all baseline at the workflow
level + per-job grants.

### CI permissions

| Caller job calls               | `contents` | `pull-requests` | `security-events` | Why |
|--------------------------------|------------|-----------------|-------------------|-----|
| `nuget-package-ci.yml`         | `read`     | `write`         | `write`           | `pull-requests:write` for coverage-report's sticky PR comment. `security-events:write` for CodeQL when enabled via `scan_disable`. `contents:read` for checkout. The `scan-suite` job carries `security-events:write` even when CodeQL is in the default skip list so consumers who enable it (`scan_disable: ''`) don't hit a permissions error — see iter-3.2 review Minor #3 cross-reference. |

### Publish permissions

| Caller job calls               | `contents` | `pull-requests` | `id-token` | Why |
|--------------------------------|------------|-----------------|------------|-----|
| `nuget-package-publish.yml`    | `write`    | `write`         | `write`    | `id-token:write` for OIDC scenarios the consumer wires externally. `contents:write` for `gh release create` (tag + GitHub Release). `pull-requests:write` because `--generate-notes` may post on linked PRs. |

The consumer's workflow-level `permissions: {}` (deny-all) is recommended;
the per-job grants above are the minimum required for the reusable
workflows to function. Granting more at workflow level inflates the
`GITHUB_TOKEN`'s blast radius across every job in the caller file.

## 7. NuGet federated-token onboarding walk-through

> **Inferred from NuGet documentation — confirm with first real adoption.**

Trusted publishing eliminates long-lived `NUGET_API_KEY` secrets by trading
a short-lived GitHub OIDC token for a nuget.org credential. `dotnet nuget
push` does not exchange the OIDC token itself, so the `nuget-push` action
runs the official `NuGet/login` action to mint the short-lived key — you do
NOT need a caller-side exchange step (see §7.2).

### 7.1 nuget.org trusted-publisher setup (one-time)

1. Sign in to <https://www.nuget.org> with the account that owns the package.
2. Open the package page: `nuget.org/packages/<package-id>`.
3. Open **Manage Package** → **Trusted Publishing** (or under your
   account: **Account** → **Trusted Publishers**).
4. Add a GitHub Actions trusted publisher with these values:
   - **Repository owner**: `<your-github-org-or-user>`
   - **Repository name**: `<your-nuget-package-repo-name>`
   - **Workflow file**: `publish.yml` (matches the file you created in §2)
   - **Environment** (optional but recommended): `production` (matches
     the `environment_name` input from §2)
5. Save the trusted-publisher configuration. `NuGet/login` matches the
   policy automatically by repository / workflow / environment — there is
   no publisher ID to copy into the workflow.

### 7.2 Built-in OIDC trusted publishing (recommended)

`nuget-package-publish.yml` has first-class OIDC support — **no caller-side
exchange step**. The `nuget-push` action runs the official `NuGet/login`
action, which trades the job's GitHub OIDC token for a short-lived nuget.org
API key scoped to the policy from §7.1, then hands it to `dotnet nuget push`.

In your `publish.yml` caller (§2):

1. Grant the `publish` job `id-token: write` (already in the §2 template).
2. Pass `nuget_user: '<your-nuget.org-username>'` in `with:`.
3. Do **not** pass the `NUGET_API_KEY` secret.
4. Keep `environment_name: 'production'` matching the Environment in your
   trusted-publishing policy (§7.1).

Every release mints a fresh key from OIDC — there is no long-lived secret to
store or rotate. (If `NUGET_API_KEY` is set it takes precedence and the OIDC
path is skipped, so set exactly one.)

### 7.3 API-key alternative

If you prefer a long-lived key, or your nuget.org tenant can't use trusted
publishing yet, skip §7.2 and use an API key instead:

1. Sign in to <https://www.nuget.org>.
2. Open **Account** → **API Keys** → **Create**.
3. Scope the key to **Push new packages and package versions** for the
   specific package ID (or glob pattern). Set a short expiry (≤ 90 days).
4. Save the key value somewhere immediately — nuget.org shows it only
   once.
5. In your package repo, open **Settings** → **Environments** →
   **production** → **Secrets** → **Add secret**. Name it
   `NUGET_API_KEY`; paste the value. Leave `nuget_user` unset.
6. Rotate the key on schedule (Dependabot does not rotate NuGet API
   keys; this is on your calendar).

The library's contract is identical either way.

## 8. `production` Environment setup checklist

> **Inferred — confirm with first real adoption.**

The publish workflow gates the `pack-and-push` job on a GitHub Environment
named `production` (or whatever `environment_name` you pass). Configure
it BEFORE the first publish run, otherwise the release proceeds without
pausing (per D13 the library does NOT runtime-verify Environment
configuration).

1. In your package repo, open **Settings** → **Environments** → **New
   environment**.
2. Name it `production` (or match the `environment_name` you set in §2).
3. Under **Deployment protection rules**, enable **Required reviewers**
   and add at least one reviewer (yourself, or your team).
4. Optionally restrict the **Deployment branches** to `main` (and any
   `prerelease_identifier` branches you actually use).
5. Under **Environment secrets**, add `NUGET_API_KEY` (per §7.3) so the
   secret is scoped to this Environment and is not accessible from the CI
   workflow's jobs.
6. Save.

**Verification**: trigger a publish via `gh workflow run publish.yml`.
The pack-and-push job should pause with "Waiting for review" — click
**Review deployments** → **Approve and deploy**. If the job proceeds
without pausing, the Environment is misconfigured (no required reviewers).

## 9. Release walk-through reference

See
[`../../.somi/plans/shared-cicd-workflows/decisions.md#d4--nuget-package-versioning-minver-tag-driven-msbuild-native`](../../.somi/plans/shared-cicd-workflows/decisions.md#d4--nuget-package-versioning-minver-tag-driven-msbuild-native)
for the full end-to-end walk-through.

Summary: the **release creates the tag** (D4). Inside the gated
`pack-and-push` job:

1. `dotnet-pack-version` runs `dotnet pack` with MinVer in scope. MinVer
   reads the last reachable git tag (e.g. `v1.2.3`) + commit height and
   computes the next version (e.g. `v1.2.4` or `v1.3.0-alpha.0.2`
   depending on `prerelease_identifier` / `version_increment` inputs).
2. `nuget-push` runs `dotnet nuget push <nupkg> --source <target>
   --skip-duplicate`. `--skip-duplicate` makes retries safe — a partial
   push followed by re-trigger exits 0 instead of crashing.
3. **Only after push succeeds**, the tag step runs:
   ```bash
   gh release view "v${VERSION}" --json id 2>/dev/null \
     || gh release create "v${VERSION}" --generate-notes --target "${GITHUB_SHA}"
   ```
   Idempotent: if a parallel run already created the release, this step
   exits 0 without creating a duplicate.

**Atomicity**: the tag is created AFTER successful push, so the failure
mode "tag exists but no published package" cannot occur. The reverse
("push succeeded, tag failed") is recoverable on retry: `--skip-duplicate`
absorbs the push, and the idempotent `gh release view || create` handles
the tag.

**Point of no return**: `dotnet nuget push`. Once a version exists on the
feed, nuget.org's unlist/delete policies apply (unlist is the standard
recourse; delete is restricted). Recovery is "publish a higher version
with the fix".

## 10. Common failure modes

> **Inferred — confirm with first real adoption.**

- **Missing MinVer PackageReference → version stuck at 0.0.0 (or 1.0.0)**.
  `dotnet-pack-version` emits a `::warning::` (per iter-3.1) but does not
  fail the build. The packed `.nupkg` carries whatever `<Version>` the
  `.csproj` declares (often `0.0.1` or `1.0.0`), and your next publish
  attempt either re-pushes the same version (caught by `--skip-duplicate`
  with a "package already exists" message) or pushes a wrong version
  forever. Fix: add the MinVer PackageReference per §3.

- **`--skip-duplicate` swallows real errors → check workflow log**.
  `dotnet nuget push --skip-duplicate` exits 0 both for fresh pushes and
  for "already exists" cases. `nuget-push` (iter 3.1) parses the log and
  surfaces the distinction in the step summary (`nuget-push: pushed …`
  vs `nuget-push: skipped (duplicate)`). For any other failure mode (401
  auth, 5xx feed error) `dotnet nuget push` exits non-zero and the job
  fails — but always read the log on a green run to confirm you actually
  pushed.

- **`gh release create` racing with a parallel run → idempotent guard
  explained**. Two simultaneous publish runs (e.g. consumer manually
  triggers a `workflow_dispatch` while a `push: branches: [main]` run is
  in flight) would both attempt `gh release create v<X.Y.Z>`. The
  workflow uses `gh release view "v${VERSION}" --json id 2>/dev/null ||
  gh release create …` so the second arrival sees the existing release
  and exits 0. Net effect: no orphan tags, no duplicate releases.

- **`NUGET_API_KEY` set but malformed → 401 at push step**. nuget.org
  rejects the push with HTTP 401. `--skip-duplicate` does NOT swallow
  401 (only the duplicate-version status). The job fails with the
  underlying error in the log. Fix: rotate the key per §7.3.

- **`dotnet nuget push` does NOT auto-exchange OIDC tokens →
  federation requires external wiring**. The most common adoption
  surprise. Even with `id-token: write` granted and a nuget.org
  trusted-publisher configured, the dotnet CLI on 8.0.x does NOT pick
  up the GitHub OIDC token. Either wire an exchange step (§7.2) or use
  the API-key fallback (§7.3). The `nuget-push` action emits a
  `::notice::` when `api_key` is empty explaining this.

- **Missing required reviewer on `production` Environment → ungated
  publish**. The pack-and-push job proceeds immediately if no reviewer
  is configured on the Environment. Library does NOT runtime-verify
  this (per D13). Fix: configure the Environment per §8 BEFORE first
  run.

- **`library_ref: 'main'` in consumer → non-reproducible builds AND
  supply-chain exposure**. Every publish uses the latest `main` of
  `hashira-ops`, which is mutable. Pin `library_ref` to a SHA (or `@v1`
  after phase 4.4 cuts it). See §11.

- **"Build twice" cost in CI (~30-60s per run)**. The `test` job in
  `nuget-package-ci.yml` re-runs `dotnet restore` + `dotnet build`
  rather than consuming a build artifact from `restore-build`. Cross-job
  build-artifact passing would require a new third-party SHA pin
  (`actions/upload-artifact` / `actions/download-artifact`) outside the
  set we verified in iter 1.2. Trade-off intentional for v1; revisit if
  your CI minute budget becomes a concern. The `restore-build → test`
  ordering still serves as a fail-fast compile gate.

## 11. Library-repo trust model

`hashira-ops` is part of your supply chain. Two pins control the integrity
boundary:

1. The reusable-workflow `uses:` ref:
   `skathio/hashira-ops/.github/workflows/<flow>.yml@<sha>`.
2. The `library_ref` input, which the workflow uses to check out
   `skathio/hashira-ops` into `.hashira/` (D14) so its composite actions
   are available at the literal path `./.hashira/.github/actions/<name>`.

**MUST**: pin BOTH to the SAME SHA. If you pin only the `uses:` ref but
leave `library_ref: 'main'`, the workflow loads a known-good orchestrator
but pulls in unknown composite-action code at runtime — defeating the
pin. A reviewer should be able to verify the entire bundle by hash from
a single SHA.

Using `main` for either pin exposes you to **library-repo compromise**
(not just non-reproducible builds): a malicious commit to `hashira-ops/main`
would land on your next publish without review.

After phase 4.4 cuts the rolling `v1` tag, you can pin both to `@v1` for
convenience — `v1` is force-moved by hashira-ops maintainers as v1.x
patches ship. SHA pinning remains the security-tighter alternative.

## 12. Pointer to `docs/usage.md`

For cross-cutting concepts (pin policy, gate model, secret-passing model,
permissions baseline, OIDC trust onboarding narrative), see
[`../usage.md`](../usage.md).
