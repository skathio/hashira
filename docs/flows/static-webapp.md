# Static webapp flow — adoption walk-through

> **Audience**: a consumer adopting `hashira-ops` to build and deploy a
> static site to GitHub Pages.
> **Scope**: copy-paste-ready CI + Deploy caller workflow template,
> GitHub Pages enablement note, input tables, permissions table,
> `github-pages` Environment setup, supported framework guidance,
> common failure modes.
> **Status**: derived from the workflow YAML + D12 (caller-side `needs:`
> CI→Deploy handoff) + D13 (Environment-is-the-gate) + spec §8
> permissions matrix. No live Pages deploy from the library itself (per
> phase 4.1 — would conflict with the library's own purpose); every
> inference is marked "Inferred — confirm with first real adoption"
> where appropriate.

For cross-cutting concepts (pin policy, gate model, secret-passing
model, permissions baseline, OIDC trust onboarding narrative), see
[`../usage.md`](../usage.md).

---

## 1. Main caller workflow template (push-to-main deploy)

Copy this into `.github/workflows/deploy.yml` in your static webapp
repo. Unlike the npm/NuGet flows (two caller files), the static-webapp
flow uses **one file with two jobs connected by `needs:`** per D12 —
this keeps the Pages artifact handoff in the same workflow run rather
than relying on `workflow_run` (rev-2 reviewers flagged that as the
wrong primitive — default-branch context with default-branch secrets
on PR-originating runs).

```yaml
# .github/workflows/deploy.yml
name: deploy
on:
  push:
    branches: [main]

# Deny-all default; each job grants what it needs.
permissions: {}

jobs:
  ci:
    # Pin to a SHA for reproducible builds. Use the SAME SHA for the
    # `uses:` ref and `library_ref` below — see security callout.
    # Example: skathio/hashira-ops/.github/workflows/static-webapp-ci.yml@<40-char-sha>
    # Use @v1 only after phase 4.4 cuts the rolling tag (currently pre-v1).
    uses: skathio/hashira-ops/.github/workflows/static-webapp-ci.yml@<40-char-sha>
    # Per-job grants MUST mirror the matrix in §5 — reusable workflows
    # can only narrow the caller's grants, not broaden them.
    permissions:
      contents: read
      id-token: write          # required by upload-pages-artifact
      pages: write             # required by upload-pages-artifact
      pull-requests: write     # coverage-report sticky comment
      security-events: write   # CodeQL (when scan_disable enables it)
    with:
      node_version: '20'
      build_command: 'npm run build'
      # output_dir: 'dist'  # uncomment if autodetect doesn't match your framework
      # test_command: 'npm test'
      # coverage_path: 'coverage/lcov.info'
      # scan_disable defaults to 'codeql,actionlint'. Pass '' to enable all.
      library_ref: '<40-char-sha>'
  deploy:
    # The needs: ci edge is what makes the same-run artifact handoff work
    # (D12). Without it, deploy starts before CI uploads the artifact and
    # the deploy step fails with "no artifact found".
    needs: ci
    uses: skathio/hashira-ops/.github/workflows/static-webapp-deploy.yml@<40-char-sha>
    permissions:
      contents: read
      pages: write             # required by deploy-pages
      id-token: write          # required by deploy-pages for OIDC
    with:
      # environment_name defaults to 'github-pages' (Pages's magic env name).
      # Override only if you use a different Environment name in §6.
      library_ref: '<40-char-sha>'
```

### Security callout — `library_ref` is an integrity control

`library_ref` is NOT just a reproducibility hint. It is an **integrity
control against library-repo compromise**. If an attacker compromises
the `skathio/hashira-ops` library repo and you are pinned to `main` (or
any other moving ref), their code runs inside the `build-and-upload`
job, which holds `id-token: write` and `pages: write`. With those
scopes the attacker can:

- exfiltrate the GitHub OIDC token from `${ACTIONS_ID_TOKEN_REQUEST_TOKEN}`
  / `${ACTIONS_ID_TOKEN_REQUEST_URL}` (which any cloud federation you
  have configured against your repo's OIDC subject will accept), and
- publish arbitrary content to your Pages site.

**Use the same 40-character commit SHA** for all three references on
every consumer-side update:

1. The `uses:` ref on the `ci` job (`@<40-char-sha>`).
2. The `library_ref` input on the `ci` job.
3. The `uses:` ref on the `deploy` job (`@<40-char-sha>`).
4. The `library_ref` input on the `deploy` job.

Pinning all four to the same SHA means the upstream commit you reviewed
is the only code that runs. Moving refs (`main`, `v1`, even a branch
name) defeat this control.

## 2. PR-only workflow template

For pull-request CI without deploying, add a separate file:

```yaml
# .github/workflows/pr.yml
name: pr
on:
  pull_request:

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
      node_version: '20'
      build_command: 'npm run build'
      library_ref: '<40-char-sha>'
```

> **Placeholder substitution callout**: replace **every** `<40-char-sha>`
> occurrence above (on `uses:` lines AND in `library_ref:` inputs) with
> the **same** 40-character commit SHA from the `hashira-ops` release
> you're pinning to. The same string goes in all four positions — see
> the §1 security callout for why. A `sed 's/<40-char-sha>/abc.../g'`
> substitution catches them all.

Do **not** add `push: branches: [main]` to this file — that runs on the
same commits as `deploy.yml` and doubles your CI cost. Keep `pr.yml` as
the PR-only file and `deploy.yml` as the main-push file.

## 3. GitHub Pages enablement (one-time consumer setup)

Before the first deploy will succeed, you must enable Pages in your
repository settings:

1. Open your repo's **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Save.

Without this, the deploy step fails with a "Pages not enabled" / "Pages
site not yet created" error. Pages is **not** automatically enabled
when the workflow runs — the deploy workflow assumes Pages is already
on.

## 4. Input table

### CI inputs (`static-webapp-ci.yml`)

| Input | Type | Default | Meaning |
|-------|------|---------|---------|
| `node_version` | string | `'20'` | Node major to install via `actions/setup-node`. Trusted input. |
| `build_command` | string | `'npm run build'` | Shell command that builds the static site. Runs in the consumer's repo root via `eval` (D10d raw-shell sink). **MUST be a literal string set in your caller workflow — do NOT derive from PR titles, issue bodies, branch names, commit messages, fork-author-controlled tag names, or any other externally controlled context.** Because this command runs in the same job that holds `id-token: write` + `pages: write`, a consumer who violates this trust contract can have their GitHub OIDC token exfiltrated by attacker-controlled code; any cloud federation configured against this repo's OIDC subject is in the blast radius. |
| `output_dir` | string | `''` | Directory containing the built site (passed through to `pages-upload`'s `path` input). Empty (default) triggers autodetect among `dist/`, `build/`, `out/`, `public/` (first found wins). **MUST be a workspace-relative directory without `..` segments or a leading `/`.** |
| `test_command` | string | `'npm test'` | Shell command that runs the consumer's tests. Trusted input. |
| `coverage_path` | string | `'coverage/lcov.info'` | Path to the lcov coverage file produced by `test_command`. Trusted input. |
| `scan_disable` | string | `'codeql,actionlint'` | Comma-separated list of scans to skip (D10c). Pass `''` to enable all. Values: `codeql`, `osv`, `gitleaks`, `dependency-review`, `actionlint`. |
| `library_ref` | string | `'main'` | SHA, tag, or branch of `skathio/hashira-ops` for in-repo composite actions (D14). **PIN TO A SHA — this is an integrity control, not just reproducibility.** See the security callout in §1. |

This workflow takes **no secrets** (static webapps build from public
source; Pages deploy authenticates via OIDC).

### Deploy inputs (`static-webapp-deploy.yml`)

| Input | Type | Default | Meaning |
|-------|------|---------|---------|
| `environment_name` | string | `'github-pages'` | Name of the GitHub Environment to gate the deploy job on (per D13 the Environment IS the gate). Default `github-pages` matches Pages's magic environment name. Trusted input. |
| `library_ref` | string | `'main'` | SHA, tag, or branch of `skathio/hashira-ops` for in-repo composite actions (D14). **PIN TO A SHA — this is an integrity control, not just reproducibility.** Same framing as the CI half — see security callout in §1. |

This workflow takes **no secrets**. Deployment authenticates via OIDC
(`id-token: write`) against the magic `github-pages` environment.

## 5. Permissions table

Per-job grants the consumer's caller workflow must set:

| Caller job calls | `contents` | `id-token` | `pages` | `pull-requests` | `security-events` |
|------------------|------------|------------|---------|-----------------|-------------------|
| `static-webapp-ci.yml` (the `ci` job) | `read` | `write` | `write` | `write` | `write` |
| `static-webapp-deploy.yml` (the `deploy` job) | `read` | `write` | `write` | — | — |

Why each is needed (and what breaks without it):

- **`contents: read` on both jobs** — `actions/checkout` reads the
  consumer tree (CI) and the library tree (both, via D14
  self-checkout). Without it, the checkout step fails.
- **`id-token: write` on CI** — required by
  `actions/upload-pages-artifact` to authenticate the artifact upload
  against the Pages backend via OIDC. This is **Pages-specific** and
  does NOT appear on the npm/NuGet CI workflows. Without it, the upload
  step fails with a permission error.
- **`pages: write` on CI** — also required by
  `actions/upload-pages-artifact`. Without it, the upload step fails.
- **`pull-requests: write` on CI** — for the `coverage-report` sticky
  comment on PRs. Optional if you don't want coverage comments; the
  job will degrade gracefully.
- **`security-events: write` on CI** — for CodeQL when enabled via
  `scan_disable`. Unused under the default
  `scan_disable='codeql,actionlint'` but granted so consumers who flip
  `scan_disable` to `''` don't hit a permissions error.
- **`id-token: write` + `pages: write` on Deploy** — required by
  `actions/deploy-pages` to authenticate the deploy against Pages via
  OIDC. Without either, the deploy step fails with a permission error.
- **NOT REQUIRED on Deploy: `contents: write`** — `deploy-pages` reads
  the artifact, not the repo. This is intentionally absent (a narrower
  permissions surface than the npm/NuGet publish flows, which need
  `contents: write` for `gh release create`).

## 6. `github-pages` Environment setup checklist

Per D13, the GitHub Environment IS the gate — the library does NOT
runtime-verify the Environment's configuration (the
`gh api environments` endpoint requires admin-tier scope on private
repos which `GITHUB_TOKEN` does not carry). Configure it before the
first deploy:

1. In your repo, open **Settings → Environments → New environment**.
2. Name it exactly **`github-pages`** (this is Pages's magic
   environment name — if you use another name, pass it as
   `environment_name` in §1's `with:` block on the `deploy` job).
3. Under **Deployment protection rules**, enable **Required reviewers**
   and add at least one.
4. Optionally restrict **Deployment branches** to `main`.
5. Save.

**Magic environment name quirk**: GitHub Pages recognizes
`github-pages` as a special environment name and automatically
surfaces deployment status in the Pages UI. Using a different name
works for the gate but doesn't get the Pages-specific deployment URL
display.

**Consumer responsibility note** (per D13): the library does NOT
runtime-verify that the Environment has a required reviewer configured.
A misconfigured Environment (zero reviewers) will run the deploy job
immediately without pausing. Inferred — confirm with first real
adoption.

## 7. Supported framework guidance

Build command and output directory for common static-site frameworks.
Autodetect covers the common cases (search order: `dist/` → `build/` →
`out/` → `public/`, first found wins):

| Framework | `build_command` | `output_dir` | Autodetect? |
|-----------|-----------------|--------------|-------------|
| Vite | `npm run build` | `dist/` | Yes (first in search order) |
| Next.js static export | `npm run build` (requires `output: 'export'` in `next.config.js` for Next 13.5+; for older Next versions use `npm run build && next export`) | `out/` | Yes (3rd in search order) |
| Astro | `npm run build` | `dist/` | Yes (first in search order) |
| Hugo | `hugo` | `public/` | Yes (last in search order) |
| Create React App | `npm run build` | `build/` | Yes (2nd in search order) |
| Custom | `npm run build && ./postprocess.sh` | explicit | Explicit `output_dir` required |

If your build output directory is not one of `dist/` / `build/` /
`out/` / `public/`, pass `output_dir` explicitly. The path must be
workspace-relative and must not contain `..` segments or a leading `/`
(rejected loudly by `pages-upload`).

**Note on `node_modules` and lifecycle hooks**: for frameworks that
require `node_modules` at build time, `build_command` may include
`npm install && npm run build`. Consumers who want to harden against
transitive-dependency lifecycle hooks (postinstall scripts running
inside the `id-token: write` job) can add `--ignore-scripts` to the
install step: `npm install --ignore-scripts && npm run build`. This is
the same defense-in-depth the npm flow's publish path (the `npm-release`
action) recommends.

## 8. Common failure modes

Inferred from the design + the iter-4.2 reviews + the `pages-deploy`
action's own failure-triage block. Confirm with first real adoption.

- **"No artifact found" on the deploy step.** Your caller workflow's
  `deploy:` job is missing `needs: ci`. The deploy workflow reads the
  `github-pages` artifact from the same workflow run; without
  `needs: ci`, the deploy job starts before CI uploads the artifact (or
  the artifact hasn't been uploaded at all). **Fix**: ensure the
  `deploy:` job declares `needs: ci` per §1.

- **`pages: write` or `id-token: write` denied on the build job.** Your
  caller's `ci:` job is missing one of those grants in its
  `permissions:` block. **Fix**: add the missing scope per §5. Reusable
  workflows can only narrow caller grants; they cannot broaden them.

- **`pages: write` or `id-token: write` denied on the deploy job.**
  Same root cause on the deploy side — caller's `deploy:` job missing
  grants. **Fix**: add per §5.

- **Deploy succeeds but Pages doesn't update.** Pages is not enabled in
  your repo settings. **Fix**: Settings → Pages → Source = "GitHub
  Actions" (one-time per repo, see §3).

- **Deploy job runs without pausing for review.** The `github-pages`
  Environment is missing a required reviewer, or the Environment isn't
  configured at all. **Fix**: configure per §6. The library does NOT
  runtime-verify Environment configuration (per D13).

- **Wrong directory packaged as the Pages artifact.** Either autodetect
  picked the wrong directory (pass `output_dir` explicitly) or the
  build failed silently and the output directory is empty. **Fix**:
  check the `pages-upload: resolved path '<dir>' (mode: <explicit|autodetect>)`
  line in the `build-and-upload` job's summary to see what was uploaded.

- **`build_command` fails with "npm run build failed".** Check your
  `package.json`'s `build` script. The build runs in the consumer-tree
  checkout; any environment-specific dependency (e.g. Node version
  mismatch) surfaces here. Set `node_version` to match your dev
  environment.

- **`deploy-pages` fails with "Your Page build returned a non-2xx
  response".** Typically the artifact contained files that triggered a
  GitHub Pages content restriction — e.g. files exceeding the per-file
  artifact limit, or a repository size that exceeds Pages's site-size
  limit. Trim the artifact and retry.

- **`output_dir` rejected as path-traversal or absolute.** Error message
  surfaces from the `pages-upload` composite, not from `static-webapp-ci`
  directly: `pages-upload: path must be a workspace-relative directory ...
  (got: '...')`. The composite rejects `..` segments and a leading `/`
  before resolving the path to prevent the wrong directory being packaged
  into the public Pages artifact (closes iter-4.2 security review m2).
  **Fix**: pass a workspace-relative `output_dir` (e.g. `dist/`, not
  `/tmp/dist/` or `../out/`).

- **`static-webapp-deploy.yml` rejected with "this workflow should not be
  called on pull_request events".** Your caller wired the deploy workflow
  on a `pull_request` trigger. Deploy on PR from a fork would expose
  `pages: write` + `id-token: write` to PR-author-influenced code, so the
  deploy workflow's `preflight` job fails loudly. **Fix**: keep deploy on
  `push: branches: [main]` per §1; use a separate `pr.yml` (§2) that calls
  only `static-webapp-ci.yml` for PR events. No deploy on PR.

- **Deploy succeeds but the Pages UI deployment-status panel never
  updates** (despite the URL working). When `environment_name` is set to
  a non-default value (i.e. not `github-pages`), GitHub's magic-name
  handling for the Pages UI deployment-status display may not engage —
  the deploy itself works (artifact published, URL serves content), but
  the **Settings → Pages → "Your site is live at..."** indicator and the
  deployment-status panel in the repo's Environments view do not update.
  **Fix**: leave `environment_name` at its default `github-pages` unless
  you have a specific reason to override it; the magic-name handling
  expects the literal string. Double-check the deploy job has both
  `pages: write` and `id-token: write` per §5 — the magic-name handling
  requires both to write deployment status back to the Pages UI.

## 9. Pointer to `docs/usage.md`

Cross-cutting contract (pin policy, gate model, secret-passing model,
permissions baseline, OIDC trust onboarding, Environment configuration
adoption checklist) lives in [`../usage.md`](../usage.md).
