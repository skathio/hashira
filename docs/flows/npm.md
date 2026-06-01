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

The publish step is a **composite action (`npm-release`) called from a job in
your own `publish.yml`** — NOT a reusable workflow. This is required: npm OIDC
trusted publishing validates the OIDC token's `workflow_ref` against the
trusted-publisher "Workflow filename", and a job in a reusable workflow carries
the *reusable workflow's* path as `workflow_ref` — which can never match your
`publish.yml`. A composite action runs in *your* job's context, so
`workflow_ref` = `publish.yml`, and OIDC works.

Recommended shape: a single `publish.yml` with a `ci` job gating a `publish`
job (one file, one `production` approval per release). Copy this:

```yaml
# .github/workflows/publish.yml
name: publish
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

# Deny-all default; each job grants the minimum it needs.
permissions: {}

jobs:
  ci:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<sha>  # v4.2.2
      - name: Validate + assert publishable
        run: |
          npm test            # your test/lint command
          npm publish --dry-run

  publish:
    needs: ci
    # Publish only on push-to-main or manual dispatch — never on PRs.
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'push' && github.ref == 'refs/heads/main')
    runs-on: ubuntu-latest
    environment: production   # single gate; configure >=1 required reviewer (see §7)
    permissions:
      id-token: write      # npm OIDC trusted-publishing token exchange
      contents: write      # semantic-release pushes the version tag
      issues: write        # @semantic-release/github failure issue
      pull-requests: write # @semantic-release/github release-note comment
    steps:
      - uses: actions/checkout@<sha>  # v4.2.2
        with:
          fetch-depth: 0           # semantic-release walks full history
          persist-credentials: true # REQUIRED: semantic-release core pushes the
                                   # version tag via these git credentials
      - uses: skathio/hashira/.github/actions/npm-release@v1
        with:
          node_version: '24'
          # target defaults to https://registry.npmjs.org (official registry → OIDC)
          # prerelease_branches: 'next,beta'
          # maintenance_branches: '1.x,2.x'
        # For a non-official registry or no OIDC, expose NPM_TOKEN as job/step env
        # (the action does not read secrets directly — composite actions can't):
        # env:
        #   NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Pin `@v1` to a `@<40-char-sha>` if you need reproducible builds across
rolling-tag moves (see `docs/usage.md` Pin policy). The `ci` job is the gate:
`publish` only runs after it passes, and only on push-to-main/dispatch.

## 3. Input table

Every input across the `npm-package-ci.yml` reusable workflow and the
`npm-release` composite action, with type, default, and meaning.

### CI inputs (`npm-package-ci.yml`)

| Input          | Type   | Default                | Meaning |
|----------------|--------|------------------------|---------|
| `node_version` | string | `"20"`                 | Node major to install via `actions/setup-node` before lint/test/scan/coverage. |
| `test_command` | string | `"npm test"`           | Shell command that runs the consumer's tests. **Trusted input (raw-shell sink per D10d)** — do NOT pass values derived from PR titles, issue bodies, branch names, or other external context. |
| `coverage_path` | string | `"coverage/lcov.info"` | Path to the lcov coverage file produced by `test_command`. Consumed by `coverage-report`. |
| `scan_disable` | string | `"codeql,actionlint"`  | Comma-separated list of scans to skip (per D10c). Pass `""` to enable everything. Values: `codeql`, `osv`, `gitleaks`, `dependency-review`, `actionlint`. |
| `library_ref`  | string | `"main"`               | SHA, tag, or branch of `skathio/hashira-ops` checked out into `.hashira/` for in-repo composite actions (D14). PIN TO A SHA for reproducible builds. |

### Publish inputs (`npm-release` composite action)

| Input                   | Type   | Default                          | Meaning |
|-------------------------|--------|----------------------------------|---------|
| `node_version`          | string | `"24"`                           | Node version for `actions/setup-node` (LTS; ships npm ≥ 11.5.1 for OIDC). The action fail-fasts on Node < 22.14 or npm < 11.5.1. Trusted input. |
| `target`                | string | `"https://registry.npmjs.org"`   | Registry URL to publish to. OIDC trusted publishing engages only for the official registry; others fall back to `NPM_TOKEN`. Trusted input. |
| `prerelease_branches`   | string | `""`                             | Comma-separated list of prerelease branch names (e.g. `"next,beta"`). Trusted input. |
| `maintenance_branches`  | string | `""`                             | Comma-separated list of maintenance branch names (e.g. `"1.x,2.x"`). Trusted input. |
| `working_directory`     | string | `"."`                            | Directory to run semantic-release in (must contain `package.json`). Trusted input. |
| `x_releaserc_overrides` | string | `""`                             | EXPERIMENTAL — JSON partial `.releaserc` deep-merged over the generated base (arrays replace). Trusted input. |

The GitHub Environment gate and reproducibility pin are now expressed in the
**consumer's own `publish.yml`**, not as action inputs: gating via
`environment: production` on the `publish` job (§7), and reproducibility via
the `@v1` / `@<sha>` ref on the `uses:` line.

## 4. Secret table

| Secret      | Required | Where | Purpose | OIDC obviates? |
|-------------|----------|-------|---------|----------------|
| `NPM_TOKEN` | optional | consumer `publish` job `env:` | Long-lived npm publish token (fallback / non-official registries). | Yes on the official registry — `@semantic-release/npm@13` does **native OIDC trusted publishing** (no token). Expose `NPM_TOKEN` as job/step `env` only for a custom registry or if OIDC is unavailable; the composite action cannot read `secrets.*` directly. |

The `npm-release` action sources the GitHub token from `${{ github.token }}`
itself (NF5) — you do not pass it. The `ci` job needs no secrets.

## 5. Permissions table

Per-job grants the consumer's workflows MUST set. Reusable workflows (the CI
half) can only NARROW the caller's grants, so the consumer mirrors them at the
caller job; the `npm-release` composite action inherits the `publish` job's
grants directly. Workflow-level `permissions: {}` (deny-all) baseline + per-job
grants (NF6).

### CI permissions

| Caller job calls           | `contents` | `pull-requests` | `security-events` | Why |
|----------------------------|------------|-----------------|-------------------|-----|
| `npm-package-ci.yml`       | `read`     | `write`         | `write`           | `pull-requests:write` for commitlint sticky comment + coverage-report sticky comment. `security-events:write` for CodeQL when enabled via `scan_disable`. `contents:read` for checkout. |

(If you hand-roll the `ci` job instead of calling `npm-package-ci.yml` — as the
§2 template does — it needs only `contents: read`.)

### Publish permissions

Set these on the consumer's `publish` job (the one that calls `npm-release`):

| Job                        | `contents` | `pull-requests` | `id-token` | `issues` | Why |
|----------------------------|------------|-----------------|------------|----------|-----|
| `publish` (calls `npm-release`) | `write` | `write`     | `write`    | `write`  | `id-token:write` for OIDC trusted-publishing token exchange. `contents:write` for semantic-release's version-tag push. `pull-requests:write` for the release-note PR comment. `issues:write` for `@semantic-release/github`'s failure issue. The `ci` job needs only `contents:read`. |

The consumer's workflow-level `permissions: {}` (deny-all) is recommended; the
per-job grants above are the minimum required. Granting more at workflow level
inflates the GITHUB_TOKEN's blast radius across every job in the file.

## 6. OIDC trusted-publisher onboarding (npm)

> Validated end-to-end against a real publish (`@skathio/somi-ai@0.2.0`,
> 2026-06-01): the OIDC token exchange + provenance attestation work as below.

OIDC trusted publishing eliminates long-lived `NPM_TOKEN` secrets by
exchanging a short-lived GitHub OIDC token for a publish token at publish
time. `@semantic-release/npm@13` (pinned inside `npm-release`) does this
**natively** — it requests the OIDC token (audience `npm:registry.npmjs.org`),
exchanges it at the registry's token-exchange endpoint, and publishes with a
signed provenance attestation. No `NPM_TOKEN`, no manual token handling.

> **Toolchain floor (load-bearing):** the publish runs `npm publish` via the
> **PATH npm CLI**, which must be ≥ 11.5.1 for trusted publishing — the npm
> bundled inside the plugin is NOT the binary that runs. `npm-release` defaults
> to Node 24 (ships npm 11.13.0) and fail-fasts otherwise.

Setup (one-time, on npmjs.com):

1. Sign in to <https://www.npmjs.com> and open the package page:
   `npmjs.com/package/<package-name>`.
2. Click **Settings** → **Publishing access** → **Automated publishing**.
3. Add a trusted publisher with these values:
   - **GitHub organization or user**: `<your-github-org-or-user>`
   - **Repository name**: `<your-package-repo-name>`
   - **Workflow filename**: `publish.yml` (matches the file you created in §2)
   - **Environment name** (optional but recommended): `production` (matches the
     `environment:` on your `publish` job)
4. Save the trusted publisher configuration.

**Verification**:

- `npm publish --dry-run` (the `ci` job) does NOT exercise the OIDC exchange —
  it only verifies the package is publishable. The real `publish` job triggers
  the OIDC token exchange; if the trusted-publisher config doesn't match
  (org/repo/workflow-filename/environment), the npm registry returns **401** at
  the publish step.
- `NPM_CONFIG_PROVENANCE=true` is set automatically by `npm-release`. With OIDC +
  provenance active, the published package carries a signed provenance
  attestation (`predicateType https://slsa.dev/provenance/v1`) logged to the
  sigstore transparency log, linking it to the GitHub Actions run.

**Precedence when both NPM_TOKEN and OIDC are configured**:

- On the official registry, `@semantic-release/npm@13` establishes OIDC context
  and publishes via the exchanged token; it skips `NPM_TOKEN` auth entirely when
  OIDC succeeds.
- Recommended: do NOT set `NPM_TOKEN` once OIDC is working. Setting both creates
  a fallback path that can mask a misconfigured trusted-publisher during
  onboarding.

## 7. `production` Environment setup checklist

The `publish` job in your `publish.yml` declares `environment: production`. That
key IS the gate — configure the Environment BEFORE the first publish run,
otherwise the job proceeds without pausing.

1. In your package repo, open **Settings** → **Environments** → **New
   environment**.
2. Name it `production` (match the `environment:` on your `publish` job and the
   npm trusted-publisher's "Environment name").
3. Under **Deployment protection rules**, enable **Required reviewers** and add
   at least one reviewer (yourself, or your team).
4. Optionally restrict the **Deployment branches** to `main` (and any
   prerelease/maintenance branches you release from).
5. Save.

**Verification**: trigger a publish (merge to `main`, or
`gh workflow run publish.yml`). The `publish` job should pause with "Waiting for
review" — click **Review deployments** → **Approve and deploy**.

> Note: with `prevent_self_review` left at its default (off), GitHub
> auto-approves a deployment for the user who *triggered* the run, so a
> maintainer who dispatches the publish themselves won't see a pause. That's one
> approval per release by design; enable `prevent_self_review` if you require a
> second person.

## 8. Release walk-through

The whole release happens in **one process, in your own `publish` job** (after
the `ci` gate passes and the `production` Environment is approved):
analyze commits → derive next version → bump `package.json` in-tree →
`npm publish` via native OIDC (with provenance) → push the `v<version>` git tag
→ create the GitHub Release.

Tag-driven (no commit-back): `package.json`/`CHANGELOG` are NOT committed back
to the branch (`@semantic-release/git` is intentionally omitted), so the in-repo
version stays put while the git tag + npm advance. The point of no return is
`npm publish` (npm unpublish has a 72-hour window with caveats; recovery is
"publish a higher version with the fix").

**Orphan-tag recovery**: semantic-release pushes the version tag, then publishes.
If the publish step fails *after* the tag is pushed (e.g. a misconfigured
trusted-publisher → 401), the tag + GitHub Release exist but npm wasn't updated,
and the next run sees "no relevant changes" and publishes nothing. Recovery:
delete the orphan tag (`git push origin :refs/tags/v<X.Y.Z>`) and the matching
GitHub Release, fix the cause, and re-run.

## 9. Common failure modes

- **Green run, nothing published ("no relevant changes")**. semantic-release
  found no release-worthy commits since the last tag (only `chore:`/`docs:`/
  `ci:` etc.), so it exits 0 without publishing. Expected. Also check for an
  **orphan tag** from a prior failed publish (see §8 recovery) — a stale
  `v<X.Y.Z>` makes semantic-release think that version already shipped.

- **npm trusted-publisher misconfigured → 401 on the publish step**. The OIDC
  token exchange succeeds (GitHub side) but the registry rejects the publish
  because the trusted-publisher record doesn't match org / repo / workflow
  filename / environment. Re-check §6 fields against your actual `publish.yml`
  filename + the `environment:` on the `publish` job. Note: the version tag may
  already be pushed when this fails → §8 orphan-tag recovery.

- **Missing `id-token: write` on the `publish` job → publish fails late**. On
  the official registry with no `NPM_TOKEN`, the OIDC token request fails and
  npm has no credential → `ENEEDAUTH` at the publish step (after the tag is
  pushed). Fix: grant `id-token: write` (it's in the §2 template).

- **`persist-credentials: false` (or omitted) on checkout → tag push fails after
  publish**. semantic-release core pushes the version tag via the persisted git
  credentials; without them the publish can succeed but the tag push fails. Use
  `persist-credentials: true` + `fetch-depth: 0` (in the §2 template).

- **Node < 22.14 or npm < 11.5.1 → action fails fast**. `npm-release` enforces
  both floors (the PATH npm performs the OIDC exchange). Use `node_version: '24'`.

- **`NPM_TOKEN` set AND OIDC working → masks misconfig**. On the official
  registry OIDC is used and the token is redundant; leaving it set can hide a
  broken trusted-publisher during onboarding. Omit `NPM_TOKEN` once OIDC works.

- **Empty `prerelease_branches` + `maintenance_branches` → only `main` releases**.
  Commits to `next`, `1.x`, etc. won't bump a version unless those branches are
  listed. Fix: pass the branch names via the CSV inputs.

## 10. Pointer to `docs/usage.md`

For cross-cutting concepts (pin policy, gate model, secret-passing model,
permissions baseline, OIDC trust onboarding narrative), see
[`../usage.md`](../usage.md).
