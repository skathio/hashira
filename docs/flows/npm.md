# npm package flow — adoption walk-through

> **Audience**: a consumer adopting `hashira-ops` for an npm package repo.
> **Scope**: copy-paste-ready CI + Publish caller workflow templates, input
> tables, OIDC trusted-publisher onboarding, `production` Environment setup,
> common failure modes.
> **Status**: derived from the workflow YAML + D3 release walk-through + spec §8
> permissions matrix. The library has no live-publish evidence yet (rev-7
> defers real adoption to user post-v1); every inference is marked
> "inferred — confirm with first real adoption".

For cross-cutting concepts (pin policy, gate model, secret-passing model,
permissions baseline, OIDC trust onboarding narrative), see
[`../usage.md`](../usage.md).

---

## 1. CI caller workflow template

Copy this into `.github/workflows/ci.yml` in your npm package repo:

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
    # Pin to a SHA for reproducible builds.
    # Example: skathio/hashira-ops/.github/workflows/npm-package-ci.yml@<40-char-sha>
    # Use @v1 only after phase 4.4 cuts the rolling tag (currently pre-v1).
    uses: skathio/hashira-ops/.github/workflows/npm-package-ci.yml@main
    # Per-job grants MUST mirror the matrix below — reusable workflows
    # can only narrow the caller's grants, not broaden them.
    permissions:
      contents: read
      pull-requests: write       # commitlint sticky comment + coverage report
      security-events: write     # CodeQL (when scan_disable enables it)
    with:
      node_version: '20'
      test_command: 'npm test'
      coverage_path: 'coverage/lcov.info'
      # scan_disable defaults to 'codeql,actionlint'. Pass '' to enable
      # everything; pass a CSV to disable specific scans.
      # scan_disable: ''
      library_ref: 'main'  # PIN TO A SHA for reproducible builds.
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
    uses: skathio/hashira-ops/.github/workflows/npm-package-publish.yml@main
    permissions:
      id-token: write     # OIDC trusted-publishing token exchange
      contents: write     # tag push + CHANGELOG commit
      pull-requests: write # release notes comment
    with:
      node_version: '20'
      target: 'https://registry.npmjs.org'
      environment_name: 'production'    # MUST have >=1 required reviewer (see §7)
      # prerelease_branches: 'next,beta'
      # maintenance_branches: '1.x,2.x'
      library_ref: 'main'  # PIN TO A SHA for reproducible builds.
    secrets:
      # Omit NPM_TOKEN if OIDC trusted-publishing is configured (recommended; see §6).
      # NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

A two-workflow shape (CI in one file, Publish in another) is the canonical
shape per D8. CI runs on every PR/push; Publish runs on the consumer's
chosen trigger and is gated by the `production` GitHub Environment.

Alternative shape: single caller file with two jobs connected by `needs:`,
similar to the Pages flow (D12). The two-file shape is recommended for
npm because re-publishing without re-running CI is a common need.

## 3. Input table

Every input across both `npm-package-ci.yml` and `npm-package-publish.yml`,
with type, default, and meaning.

### CI inputs (`npm-package-ci.yml`)

| Input          | Type   | Default                | Meaning |
|----------------|--------|------------------------|---------|
| `node_version` | string | `"20"`                 | Node major to install via `actions/setup-node` before lint/test/scan/coverage. |
| `test_command` | string | `"npm test"`           | Shell command that runs the consumer's tests. **Trusted input (raw-shell sink per D10d)** — do NOT pass values derived from PR titles, issue bodies, branch names, or other external context. |
| `coverage_path` | string | `"coverage/lcov.info"` | Path to the lcov coverage file produced by `test_command`. Consumed by `coverage-report`. |
| `scan_disable` | string | `"codeql,actionlint"`  | Comma-separated list of scans to skip (per D10c). Pass `""` to enable everything. Values: `codeql`, `osv`, `gitleaks`, `dependency-review`, `actionlint`. |
| `library_ref`  | string | `"main"`               | SHA, tag, or branch of `skathio/hashira-ops` checked out into `.hashira/` for in-repo composite actions (D14). PIN TO A SHA for reproducible builds. |

### Publish inputs (`npm-package-publish.yml`)

| Input                   | Type   | Default                          | Meaning |
|-------------------------|--------|----------------------------------|---------|
| `node_version`          | string | `"20"`                           | Node major to install via `actions/setup-node` before semantic-release. |
| `target`                | string | `"https://registry.npmjs.org"`   | Registry URL to publish to (D10b unified target). Trusted input. |
| `prerelease_branches`   | string | `""`                             | Comma-separated list of prerelease branch names (e.g. `"next,beta"`). Trusted input. |
| `maintenance_branches`  | string | `""`                             | Comma-separated list of maintenance branch names (e.g. `"1.x,2.x"`). Trusted input. |
| `environment_name`      | string | `"production"`                   | Name of the GitHub Environment to gate the release job on (D13). Must have >=1 required reviewer for the gate to be effective. Trusted input. |
| `library_ref`           | string | `"main"`                         | SHA, tag, or branch of `skathio/hashira-ops` checked out into `.hashira/` (D14). PIN TO A SHA for reproducible builds. |

## 4. Secret table

| Secret      | Required | Workflow                  | Purpose | OIDC obviates? |
|-------------|----------|---------------------------|---------|----------------|
| `NPM_TOKEN` | optional | `npm-package-publish.yml` | Long-lived npm publish token (legacy auth path). | Yes — if OIDC trusted-publishing is configured on the npm package, omit this secret entirely. `@semantic-release/npm` >= 11.0.0 (pinned inside `semantic-release-publish`) prefers OIDC under `NPM_CONFIG_PROVENANCE=true`. |

CI half has no required secrets (the workflow inherits the caller's
`GITHUB_TOKEN` only).

## 5. Permissions table

Per-job grants the consumer's caller workflow MUST set. The reusable
workflow declares these at the job level internally, but reusable workflows
can only NARROW the caller's grants, so the consumer must grant them at
the job level too. Cross-reference: NF6 deny-all baseline at the workflow
level + per-job grants.

### CI permissions

| Caller job calls           | `contents` | `pull-requests` | `security-events` | Why |
|----------------------------|------------|-----------------|-------------------|-----|
| `npm-package-ci.yml`       | `read`     | `write`         | `write`           | `pull-requests:write` for commitlint sticky comment + coverage-report sticky comment. `security-events:write` for CodeQL when enabled via `scan_disable`. `contents:read` for checkout. |

### Publish permissions

| Caller job calls           | `contents` | `pull-requests` | `id-token` | Why |
|----------------------------|------------|-----------------|------------|-----|
| `npm-package-publish.yml`  | `write`    | `write`         | `write`    | `id-token:write` for OIDC trusted-publishing token exchange. `contents:write` for semantic-release's tag push + CHANGELOG commit. `pull-requests:write` for release-note PR comment. |

The consumer's workflow-level `permissions: {}` (deny-all) is recommended;
the per-job grants above are the minimum required for the reusable
workflows to function. Granting more at workflow level inflates the
GITHUB_TOKEN's blast radius across every job in the caller file.

## 6. OIDC trusted-publisher onboarding (npm)

> **Inferred from npm documentation — confirm with first real adoption.**

OIDC trusted publishing eliminates long-lived `NPM_TOKEN` secrets by
exchanging a short-lived GitHub OIDC token for a publish token at publish
time. Setup (one-time, on npmjs.com):

1. Sign in to <https://www.npmjs.com> and open the package page:
   `npmjs.com/package/<package-name>`.
2. Click **Settings** → **Publishing access** → **Automated publishing**.
3. Add a trusted publisher with these values:
   - **GitHub organization or user**: `<your-github-org-or-user>`
   - **Repository name**: `<your-package-repo-name>`
   - **Workflow filename**: `publish.yml` (matches the file you created in §2)
   - **Environment name** (optional but recommended): `production` (matches
     the `environment_name` input from §2)
4. Save the trusted publisher configuration.

**Verification** (inferred — confirm with first real adoption):

- `npm publish --dry-run` locally does NOT exercise the OIDC exchange — it
  only verifies the package is publishable. The first real `gh workflow
  run publish` triggers the OIDC token exchange; if the trusted-publisher
  config doesn't match, the npm registry returns **401** at the publish
  step.
- `NPM_CONFIG_PROVENANCE=true` is set automatically by the publish
  workflow (see `npm-package-publish.yml`). When OIDC + provenance are
  active, the published package carries a signed provenance attestation
  linking it to the GitHub Actions run.

**Precedence when both NPM_TOKEN and OIDC are configured**:

- `@semantic-release/npm` >= 11.0.0 with `NPM_CONFIG_PROVENANCE=true`
  prefers OIDC. If OIDC fails (registry-side trusted-publisher
  misconfigured), it falls back to `NPM_TOKEN` if set.
- Recommended: do NOT set `NPM_TOKEN` once OIDC is working. Setting both
  creates a fallback path that masks a misconfigured trusted-publisher
  during onboarding.

## 7. `production` Environment setup checklist

> **Inferred — confirm with first real adoption.**

The publish workflow gates the release job on a GitHub Environment named
`production` (or whatever `environment_name` you pass). Configure it
BEFORE the first publish run, otherwise the release proceeds without
pausing (per D13 the library does NOT runtime-verify Environment
configuration).

1. In your package repo, open **Settings** → **Environments** → **New
   environment**.
2. Name it `production` (or match the `environment_name` you set in §2).
3. Under **Deployment protection rules**, enable **Required reviewers**
   and add at least one reviewer (yourself, or your team).
4. Optionally restrict the **Deployment branches** to `main` (and any
   `prerelease_branches`/`maintenance_branches` you configured).
5. Save.

**Verification**: trigger a publish via `gh workflow run publish.yml`.
The release job should pause with "Waiting for review" — click **Review
deployments** → **Approve and deploy**. If the job proceeds without
pausing, the Environment is misconfigured (no required reviewers).

## 8. Release walk-through reference

See [`../../.somi/plans/shared-cicd-workflows/decisions.md#d3`](../../.somi/plans/shared-cicd-workflows/decisions.md#d3--npm-package-versioning-semantic-release-conventional-commits--auto-publish)
for the full end-to-end walk-through.

Summary: semantic-release runs wholly inside the gated `release` job as a
single process. Analyze commits → bump version → write CHANGELOG → git
commit → git tag → git push → npm publish → gh release create. All
atomically — the Environment gate gates ALL of this; once you click
"Approve and deploy", the entire chain runs. Point of no return is `npm
publish` (npm unpublish has a 72-hour window with caveats; recovery is
"publish a higher version with the fix").

## 9. Common failure modes

> **Inferred — confirm with first real adoption.**

- **Missing required reviewer on `production` Environment → ungated
  publish**. The release job proceeds immediately if no reviewer is
  configured on the Environment. Library does NOT runtime-verify this
  (per D13). Fix: configure the Environment per §7 BEFORE first run.

- **`NPM_TOKEN` set AND OIDC enabled → ambiguity**. `@semantic-release/npm`
  >= 11.0.0 with `NPM_CONFIG_PROVENANCE=true` prefers OIDC and falls back
  to the token. If trusted-publisher is misconfigured, the token path
  silently succeeds — masking the OIDC misconfiguration during onboarding.
  Fix: omit `NPM_TOKEN` once OIDC is working.

- **npm trusted-publisher misconfigured → 401 on publish step**. The OIDC
  token exchange succeeds (GitHub side), but npm registry rejects the
  publish because the trusted-publisher record doesn't match
  org/repo/workflow filename/environment. Re-check §6 fields against the
  actual `publish.yml` filename + `environment_name` input.

- **Empty `prerelease_branches` + `maintenance_branches` → only `main`
  triggers a release**. Commits to `next`, `1.x`, etc. won't bump a
  version unless those branches are listed. Fix: pass the branch names
  via the `prerelease_branches` / `maintenance_branches` inputs (CSV).

- **`library_ref: 'main'` in consumer → non-reproducible builds**. Every
  publish uses the latest `main` of `hashira-ops`. For production, pin
  `library_ref` to a SHA (or `@v1` after phase 4.4 cuts it).

- **Non-CC commits since last tag → no release this run**. semantic-release
  exits 0 with "no release this run". The inline commitlint step in the
  CI half warns (non-blocking) on PRs so contributors can fix forward.
  Re-run with conventional commit messages.

## 10. Pointer to `docs/usage.md`

For cross-cutting concepts (pin policy, gate model, secret-passing model,
permissions baseline, OIDC trust onboarding narrative), see
[`../usage.md`](../usage.md).
