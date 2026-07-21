# Static webapp flow — adoption walk-through

> **Audience**: a consumer adopting `skathio/hashira` to build and deploy a
> static site to GitHub Pages.
> **Scope**: copy-paste-ready CI + Deploy caller workflow template, GitHub
> Pages enablement note, input/permissions tables, `github-pages`
> Environment setup, supported framework guidance, common failure modes.
> **Status**: derived directly from `.github/workflows/static-webapp-ci.yml`
> and `.github/actions/pages-deploy/action.yml` (v2 shape — the
> `static-webapp-deploy.yml` reusable workflow this flow used in v1 is
> deleted; `pages-deploy` is invoked directly from a `deploy` job in the
> consumer's own caller file). No live Pages deploy from the library itself
> (would conflict with the library's own purpose); A3's GitHub Pages
> `deploy-pages`-in-a-composite-shape verification is research-based PASS,
> not yet confirmed by a live deploy — see `progress.md`.

For cross-cutting concepts (pin policy, gate model, secret-passing model,
permissions baseline, OIDC trust onboarding narrative), see
[`../usage.md`](../usage.md).

---

## What changed from v1

v1's Deploy half was a separate **reusable workflow**,
`static-webapp-deploy.yml`, called via its own `uses:` line with its own
`inputs:` block (`environment_name`, `library_ref`). **That file is
deleted.** Its logic — invoke `actions/deploy-pages`, emit the deployed URL
to the run summary — moved into the `pages-deploy` **composite action**,
invoked directly from a `deploy` job in the consumer's own caller file,
brought under the same CI-reusable-workflow + CD-composite-action shape
every other flow uses (D2's architectural spine). `pages-deploy` takes no
`library_ref` — composite actions invoked with a literal local path or a
versioned `uses:` ref don't need the self-checkout mechanism the CI
reusable workflow uses to reach its own in-repo composite actions (D2's
CD-composite-never-self-checks-out rule); pin `pages-deploy`'s own `uses:`
ref the normal way (SHA or `@v2`).

Two security mechanisms also changed shape in this conversion:

- **The `pull_request`-event guard moved from a dedicated `preflight` job
  inside the old reusable workflow into `pages-deploy`'s own first step**
  (folded in during Phase 3, iteration 3.3). The composite refuses to run
  on a `pull_request`-triggered job even if the caller forgot to guard
  against it — see "Fork-PR guard" in §5.
- **`pull_request_target` is now an explicitly documented prohibition on
  the CI half** (`static-webapp-ci.yml`'s `build-and-upload` job) — see §8's
  failure-mode entry. This was always true in spirit (the job holds
  `id-token: write` + `pages: write`), but v2 states it explicitly rather
  than leaving it implicit.

## 1. Main caller workflow template (push-to-main deploy)

Copy this into `.github/workflows/deploy.yml` in your static webapp
repo. Like the npm/NuGet flows, this is **one file with two jobs connected
by `needs:`** — this keeps the Pages artifact handoff in the same workflow
run rather than relying on `workflow_run` (the wrong primitive: default-branch
context with default-branch secrets on PR-originating runs — see
[`../usage.md`](../usage.md#not-workflow_run)).

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
    # Pin to a SHA for reproducible builds (recommended), or @v2 for the
    # rolling tag. NEVER pin to @main — see docs/usage.md "Pin policy".
    uses: skathio/hashira/.github/workflows/static-webapp-ci.yml@<40-char-sha>
    # Per-job grants MUST mirror the matrix in §6 — reusable workflows
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
      library_ref: '<40-char-sha>'  # MUST be the SAME SHA as @<…> above.
  deploy:
    # The needs: ci edge is what makes the same-run artifact handoff work.
    # Without it, deploy starts before CI uploads the artifact and
    # deploy-pages fails with "no artifact found".
    needs: ci
    runs-on: ubuntu-latest
    environment: github-pages   # single gate; configure >=1 required reviewer (see §7)
    permissions:
      contents: read
      pages: write             # required by deploy-pages
      id-token: write          # required by deploy-pages for OIDC
    steps:
      # pages-deploy takes no library_ref/self-checkout (D2's
      # CD-composite-never-self-checks-out rule) — pin its own uses: ref
      # the normal way, same SHA convention as every other CD composite.
      - uses: skathio/hashira/.github/actions/pages-deploy@<40-char-sha-or-v2>
```

### Security callout — `library_ref` is an integrity control

`library_ref` (on the `ci` job only — `pages-deploy` doesn't take one) is
NOT just a reproducibility hint. It is an **integrity control against
library-repo compromise**. If an attacker compromises the
`skathio/hashira` library repo and you are pinned to `main` (or any other
moving ref), their code runs inside the `build-and-upload` job, which holds
`id-token: write` and `pages: write`. With those scopes the attacker can:

- exfiltrate the GitHub OIDC token from `${ACTIONS_ID_TOKEN_REQUEST_TOKEN}`
  / `${ACTIONS_ID_TOKEN_REQUEST_URL}` (which any cloud federation you
  have configured against your repo's OIDC subject will accept), and
- publish arbitrary content to your Pages site.

**Use the same 40-character commit SHA** for both `ci`-job references on
every consumer-side update:

1. The `uses:` ref on the `ci` job (`@<40-char-sha>`).
2. The `library_ref` input on the `ci` job.

The `deploy` job's `pages-deploy` `uses:` ref is a separate, independent
pin (it has no `library_ref` to keep in sync with it) — pin it to a SHA or
`@v2` like any other composite action reference, but it is not part of the
dual-pin invariant described in
[`../usage.md`](../usage.md#the-library_ref-dual-pin-invariant) (that
invariant is specific to reusable workflows that self-checkout via
`library_ref`; `pages-deploy` is a composite action with no such
mechanism).

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
    uses: skathio/hashira/.github/workflows/static-webapp-ci.yml@<40-char-sha>
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
> the **same** 40-character commit SHA from the `hashira` release you're
> pinning to. A `sed 's/<40-char-sha>/abc.../g'` substitution catches them
> all — except `pages-deploy`'s own `uses:` ref in §1, which is a separate,
> independent pin (see the security callout above).

Do **not** add `push: branches: [main]` to this file — that runs on the
same commits as `deploy.yml` and doubles your CI cost. Keep `pr.yml` as
the PR-only file and `deploy.yml` as the main-push file. `pr.yml` must
never call `pages-deploy` — see §8's `pull_request_target`/`pull_request`
failure-mode entries for why.

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
| `build_command` | string | `'npm run build'` | Shell command that builds the static site. Runs (via `eval`) in the same job that holds `id-token: write` + `pages: write` (D10d raw-shell sink). **MUST be a literal string set in your caller workflow — do NOT derive from PR titles, issue bodies, branch names, commit messages, fork-author-controlled tag names, or any other externally controlled context.** A consumer who violates this trust contract can have their GitHub OIDC token exfiltrated by attacker-controlled code; any cloud federation configured against this repo's OIDC subject is in the blast radius. |
| `output_dir` | string | `''` | Directory containing the built site (passed through to `pages-upload`'s `path` input). Empty (default) triggers autodetect among `dist/`, `build/`, `out/`, `public/` (first found wins). **MUST be a workspace-relative directory without `..` segments or a leading `/`.** |
| `test_command` | string | `'npm test'` | Shell command that runs the consumer's tests. Trusted input. |
| `coverage_path` | string | `'coverage/lcov.info'` | Path to the lcov coverage file produced by `test_command`. Trusted input. |
| `scan_disable` | string | `'codeql,actionlint'` | Comma-separated list of scans to skip (D10c). Pass `''` to enable all. Values: `codeql`, `osv`, `gitleaks`, `dependency-review`, `actionlint`. |
| `library_ref` | string | _(required, no default)_ | SHA, tag, or branch of `skathio/hashira` checked out into `.hashira/` for in-repo composite actions (D9/D14). **Required** — every caller must pin it explicitly. PIN TO A SHA — this is an integrity control, not just reproducibility. See the security callout in §1. |

This workflow takes **no secrets** (static webapps build from public
source; Pages deploy authenticates via OIDC).

### Deploy inputs (`pages-deploy` composite action)

| Input | Type | Default | Meaning |
|-------|------|---------|---------|
| `artifact_name` | string | `'github-pages'` | Artifact name to deploy. Defaults to match `pages-upload`'s own default. Override only if you uploaded under a non-default name. |

`pages-deploy` declares **no `library_ref` input** — unlike the CI
reusable workflow, a composite action invoked via `uses:` doesn't need the
self-checkout mechanism (no `workflow_call`-boundary `uses:`-expression
restriction applies to a composite action's own `uses:` line, which can
carry an expression-free literal ref directly). See "What changed from v1"
above.

### Deploy output (`pages-deploy`)

| Output | Meaning |
|--------|---------|
| `page_url` | URL of the deployed page (passed through from `actions/deploy-pages`'s own `page_url` output). |

This action takes **no secrets**. Deployment authenticates via OIDC
(`id-token: write`) against the `github-pages` Environment.

## 5. Fork-PR guard (B8)

`pages-deploy`'s **first step**, unconditionally, refuses to run when
`github.event_name == 'pull_request'` — regardless of whether the caller
already guards against it. This is folded in from the now-deleted
`static-webapp-deploy.yml` reusable workflow's `preflight` job (the one
safety mechanism worth preserving across the reusable-workflow → composite
conversion). Deploying on a `pull_request` event would run this action
(and its `pages: write` + `id-token: write` grants) inside a job that may
be triggered by a fork PR, exposing those scopes to PR-author-influenced
code. The recommended caller shape (§1/§2) is a separate
`push: branches: [main]`-only `deploy.yml` and a `pull_request`-triggered
`pr.yml` that only calls `static-webapp-ci.yml`, never `pages-deploy`.

`static-webapp-ci.yml`'s own `build-and-upload` job (CI half) carries the
analogous restriction as a **documentation prohibition** rather than a
runtime guard — see §8's `pull_request_target` entry for why and what the
asymmetry means in practice.

## 6. Permissions table

Per-job grants the consumer's caller workflow must set:

| Caller job calls | `contents` | `id-token` | `pages` | `pull-requests` | `security-events` |
|------------------|------------|------------|---------|-----------------|-------------------|
| `static-webapp-ci.yml` (the `ci` job) | `read` | `write` | `write` | `write` | `write` |
| `pages-deploy` (the `deploy` job) | — | `write` | `write` | — | — |

Why each is needed (and what breaks without it):

- **`contents: read` on the `ci` job** — `actions/checkout` reads the
  consumer tree and the library tree (via D14 self-checkout). Without it,
  the checkout step fails. **Not required on the `deploy` job** —
  `pages-deploy` reads the artifact, not the repo, and performs no
  checkout of its own.
- **`id-token: write` on `ci`** — required by
  `actions/upload-pages-artifact` to authenticate the artifact upload
  against the Pages backend via OIDC. This is **Pages-specific** and
  does NOT appear on the npm/NuGet CI workflows. Without it, the upload
  step fails with a permission error.
- **`pages: write` on `ci`** — also required by
  `actions/upload-pages-artifact`. Without it, the upload step fails.
- **`pull-requests: write` on `ci`** — for the `coverage-report` sticky
  comment on PRs. Optional if you don't want coverage comments; the
  job will degrade gracefully.
- **`security-events: write` on `ci`** — for CodeQL when enabled via
  `scan_disable`. Unused under the default
  `scan_disable='codeql,actionlint'` but granted so consumers who flip
  `scan_disable` to `''` don't hit a permissions error.
- **`id-token: write` + `pages: write` on `deploy`** — required by
  `actions/deploy-pages` (invoked inside `pages-deploy`) to authenticate
  the deploy against Pages via OIDC. Without either, the deploy step fails
  with a permission error.
- **NOT REQUIRED on `deploy`: `contents: write`** — `deploy-pages` reads
  the artifact, not the repo. This is intentionally absent (a narrower
  permissions surface than the npm/NuGet publish flows, which need
  `contents: write` for `gh release create` — the static-webapp flow has
  no analogous tag/Release step).

**Static-webapp CI `id-token: write` note**: `static-webapp-ci.yml` is the
only CI-half workflow in the library that requires `id-token: write` at the
caller job. npm and NuGet CI halves do NOT require it — that scope belongs
only on their Publish-half jobs. The asymmetry exists because
`actions/upload-pages-artifact` authenticates via OIDC and the upload must
happen in the same job as the build command (a cross-job handoff would
require `actions/upload-artifact` + `actions/download-artifact` instead —
see "Build artifact handoff" in `static-webapp-ci.yml`'s own header for the
trade-off). Practical consequence: the static-webapp consumer's CI caller
job holds `id-token: write` on every PR run, not only on deploy runs —
including PRs from forks. This is documented, accepted residual exposure,
mitigated by `pages-upload`/`pages-deploy` only ever running on
`pull_request` (never `pull_request_target`) and `pages-deploy` itself
refusing to run on a `pull_request` event regardless of caller wiring (§5's
runtime guard, not merely a documentation prohibition).

## 7. `github-pages` Environment setup checklist

The `deploy` job in your caller workflow declares `environment: github-pages`
(or whatever custom name you choose — see the magic-name quirk below).
That key IS the gate — configure the Environment BEFORE the first deploy
run, otherwise the job proceeds without pausing. The library does NOT
runtime-verify Environment configuration (the `gh api environments`
endpoint requires admin-tier scope `GITHUB_TOKEN` does not carry).

1. In your repo, open **Settings → Environments → New environment**.
2. Name it exactly **`github-pages`** (this is Pages's magic
   environment name — if you use another name, pass it explicitly via the
   `environment:` key on the `deploy` job; `pages-deploy` itself has no
   `environment_name` input to set since the Environment is declared on
   the caller's job, not inside the composite).
3. Under **Deployment protection rules**, enable **Required reviewers**
   and add at least one.
4. Optionally restrict **Deployment branches** to `main`.
5. Save.

**Verification**: trigger a deploy (push to `main`). The `deploy` job
should pause with "Waiting for review" — click **Review deployments** →
**Approve and deploy**.

**Magic environment name quirk**: GitHub Pages recognizes
`github-pages` as a special environment name and automatically
surfaces deployment status in the Pages UI. Using a different name
works for the gate but doesn't get the Pages-specific deployment URL
display.

### One-time `gh api` setup: require a reviewer (D12)

Run this once, with your own admin-scoped credentials, instead of (or in
addition to) the manual UI steps above:

```bash
# Require at least one reviewer on the `github-pages` Environment before
# the first deploy run. Replace OWNER/REPO and the numeric reviewer id
# (look it up via `gh api users/<username>`).
gh api --method PUT \
  repos/OWNER/REPO/environments/github-pages \
  -f wait_timer=0 \
  -F "reviewers[][type]=User" \
  -F "reviewers[][id]=<numeric-user-id>" \
  -F deployment_branch_policy='{"protected_branches":true,"custom_branch_policies":false}'
```

A misconfigured Environment (zero reviewers) runs the deploy job
immediately without pausing, and this is silent and indistinguishable from
working until something bad deploys — see
[`../usage.md`](../usage.md#environment-reviewer-gate--what-the-library-can-and-cannot-verify)
for the full defense-in-depth story (this snippet + a self-CI lint
asserting the gated job declares `environment:`).

## 8. Supported framework guidance

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

**Note on `node_modules`**: `static-webapp-ci.yml`'s `build-and-upload` and `test` jobs run
`npm ci` automatically before `build_command`/`test_command` — you do **not** need to fold
`npm install` into your own `build_command` (an earlier version of this doc recommended that
workaround; it's obsolete now that the flow installs dependencies itself, and doing it yourself
would just install twice).

**Lifecycle-hook hardening tradeoff**: this automatic `npm ci` does not pass `--ignore-scripts`,
so transitive-dependency postinstall hooks run inside the `id-token: write` job (the same
defense-in-depth the npm flow's publish path, the `npm-release` action, recommends guarding
against). There is currently no consumer-facing input to opt into `--ignore-scripts` here — if
this matters for your threat model, treat it as a known gap and flag it rather than trying to
route around it via `build_command` (the automatic install runs regardless, before your command).

## 9. Common failure modes

- **"No artifact found" on the deploy step.** Your caller workflow's
  `deploy:` job is missing `needs: ci`. The deploy step reads the
  `github-pages` artifact from the same workflow run; without
  `needs: ci`, the deploy job starts before CI uploads the artifact (or
  the artifact hasn't been uploaded at all). **Fix**: ensure the
  `deploy:` job declares `needs: ci` per §1.

- **`pages: write` or `id-token: write` denied on the `ci` job.** Your
  caller's `ci:` job is missing one of those grants in its
  `permissions:` block. **Fix**: add the missing scope per §6. Reusable
  workflows can only narrow caller grants; they cannot broaden them.

- **`pages: write` or `id-token: write` denied on the `deploy` job.**
  Same root cause on the deploy side — caller's `deploy:` job missing
  grants. **Fix**: add per §6.

- **Deploy succeeds but Pages doesn't update.** Pages is not enabled in
  your repo settings. **Fix**: Settings → Pages → Source = "GitHub
  Actions" (one-time per repo, see §3).

- **Deploy job runs without pausing for review.** The `github-pages`
  Environment is missing a required reviewer, or the Environment isn't
  configured at all. **Fix**: configure per §7. The library does NOT
  runtime-verify Environment configuration.

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
  into the public Pages artifact. **Fix**: pass a workspace-relative
  `output_dir` (e.g. `dist/`, not `/tmp/dist/` or `../out/`).

- **`pages-deploy` fails with "this action must not run on pull_request
  events".** Your caller wired the `deploy` job (or some other job calling
  `pages-deploy`) on a `pull_request`-triggered workflow. Deploy on PR
  from a fork would expose `pages: write` + `id-token: write` to
  PR-author-influenced code, so `pages-deploy`'s first step fails loudly
  regardless of caller wiring (§5). **Fix**: keep `deploy.yml` on
  `push: branches: [main]` per §1; use a separate `pr.yml` (§2) that calls
  only `static-webapp-ci.yml` for PR events. No deploy on PR.

- **`pull_request_target` used on the CI half → forbidden, not just
  discouraged.** `static-webapp-ci.yml`'s `build-and-upload` job MUST be
  triggered via `pull_request`, never `pull_request_target`.
  `pull_request_target` runs in the BASE repo's context — with the base
  repo's secrets and a token scoped to the base repo — even for a
  fork-originated PR, so a fork PR author's `build_command`/`test_command`
  (both raw-shell sinks) would execute with that elevated context instead
  of the fork's own restricted token. The job already holds
  `id-token: write`; combining that with `pull_request_target`'s base-repo
  context on every fork PR is exactly the escalation this prohibition
  exists to prevent. This is currently a **documentation prohibition**, not
  a runtime guard — unlike `pages-deploy`'s `pull_request` check (§5),
  `static-webapp-ci.yml`'s CI half has no equivalent self-enforced check
  yet. Use `pull_request` (read-only fork token, no secrets) for
  PR-triggered CI.

- **Deploy succeeds but the Pages UI deployment-status panel never
  updates** (despite the URL working). When your `deploy` job's
  `environment:` is set to a non-default value (i.e. not `github-pages`),
  GitHub's magic-name handling for the Pages UI deployment-status display
  may not engage — the deploy itself works (artifact published, URL serves
  content), but the **Settings → Pages → "Your site is live at..."**
  indicator and the deployment-status panel in the repo's Environments
  view do not update. **Fix**: leave the Environment name at `github-pages`
  unless you have a specific reason to override it; the magic-name handling
  expects the literal string. Double-check the `deploy` job has both
  `pages: write` and `id-token: write` per §6 — the magic-name handling
  requires both to write deployment status back to the Pages UI.

## 10. Pointer to `docs/usage.md`

Cross-cutting contract (pin policy, gate model, secret-passing model,
permissions baseline, OIDC trust onboarding, Environment configuration
adoption checklist) lives in [`../usage.md`](../usage.md).
