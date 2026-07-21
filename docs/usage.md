# Using hashira

Cross-cutting contract for all flows. Per-flow specifics live under
[`flows/`](./flows/).

This document is the **master contract surface** for the library. Section
headings below are the stable table of contents; bodies are populated phase by
phase. This revision documents the **v2** contract (CI reusable workflow +
CD composite action per flow, D2; explicit dispatch-driven versioning, D1).

## Versioning model

v2 unifies npm and NuGet on **one explicit, dispatch-driven release model**
(D1). This replaces v1's two divergent mechanisms — semantic-release's
hidden, commit-message-driven computation for npm, and MinVer's
manual-tag-trigger inference for NuGet — neither of which is used by v2's
release path.

### How a release version is determined

1. A maintainer triggers the flow's CI reusable workflow with `bump:
   patch|minor|major` set (every routine PR/push CI run leaves `bump` empty
   and is completely unaffected — the version-resolution job is gated at the
   job level on `inputs.bump != ''`).
2. The CI workflow's `version` job gathers the repo's tag list and invokes
   the `version-resolver` composite action
   ([`.github/actions/version-resolver`](../.github/actions/version-resolver/action.yml)),
   passing `bump` and (only when needed) `seed_version`.
3. `version-resolver` is a pure computation: it selects the latest *stable*
   tag (prerelease tags are ignored when picking the baseline) and applies
   the bump arithmetic —
   - `patch`/`minor` increment off the latest stable tag; if no stable tag
     exists, these are unsatisfiable and the job fails fast.
   - `major` produces the next major with minor/patch reset to `0`
     (`vX.y.z` → `v(X+1).0.0`).
   - **First release / no prior stable tag**: `seed_version` is required.
     The seed plays the role of the missing baseline tag — the chosen
     `bump` still applies arithmetic **on top of** the seed, it is not
     published literally (D14: `seed_version: 2.0.0` + `bump: major`
     resolves to `3.0.0`, not `2.0.0`). A maintainer who wants the seed
     itself as the first published version dispatches one bump-step below
     it (e.g. `seed_version: 0.0.0` + `bump: major` → `1.0.0`).
4. The resolver declares **exactly one output** (D8): `version`, the bare
   validated semver string (e.g. `1.3.0`, no `v` prefix). There is no
   second output for the `v`-prefixed tag form (the CD composite derives it
   by simple string concatenation) and no output re-emitting the bump kind
   (the caller already has it as a dispatch input).
5. The CI workflow surfaces the resolved version in the run summary
   **before** the build/pack step runs (NFR-DX-3), then **stamps it into
   the built artifact only**:
   - **npm**: the resolved version is written via `npm pkg set version=…`
     into an **isolated copy** of the working tree (never the checked-out
     tree itself), then `npm pack` produces the tarball from that copy.
   - **NuGet**: the resolved version is passed to the `dotnet-pack-version`
     composite action's `version_override` input, which the action wires
     into MinVer's own `MinVerVersionOverride` MSBuild property at pack
     time. MinVer is **kept**, but only as the packing mechanism — when
     `version_override` is non-empty, MinVer uses it verbatim instead of
     inferring from git tag history; explicit always wins over inferred.
     (MinVer's tag-driven inference, the part v1 actually used as the
     release model, plays no role in v2's release path.)
6. The packed, version-stamped artifact is uploaded via
   `actions/upload-artifact` under a stable name (`npm-tarball` for npm) in
   the **same workflow run**. The CD composite later downloads that exact
   artifact via `actions/download-artifact` and publishes it unmodified — it
   never re-packs or re-stamps (NFR-Rel-1: published bytes == the same-run
   CI artifact, byte-identical).
7. The CI→CD handoff for the version value itself is the workflow-level
   `resolved_version` output (`jobs.version.outputs.resolved_version` on
   the CI reusable workflow) — a consumer's CD job reads it via
   `needs.<ci-job-id>.outputs.resolved_version` and passes it straight into
   the CD composite's `version` input. **Nothing recomputes it** — the CD
   composite (`nuget-push`/`npm-release`) re-validates the value against the
   same strict-semver shape as its own checkpoint (B7's two-checkpoint
   pattern: once at the resolver, once at the privileged sink that
   tags/releases/publishes), but does not derive a different one.

### Stamp-only — no commit-back

The resolved version is **never written to the consumer's checked-out
working tree**. Both CI workflows pack from an isolated temp copy of the
working tree (an `rsync`'d staging directory under `$RUNNER_TEMP`); for
npm the version is stamped directly into that copy's `package.json`, while
for NuGet the resolved version additionally flows in as `version_override` →
MinVer's `MinVerVersionOverride` rather than rewriting the `.csproj` at all.
Both then assert (`git status --porcelain --untracked-files=no`) that the
tracked working tree is unchanged after the pack step. This preserves the
pre-v2 `npm-publish-redesign` decision to never push a version-bump commit
back to a protected branch from CI. If you want your repo's own source files
(e.g. a `CHANGELOG.md`) to track the released version, that remains a
separate, opt-in step in your own workflow — hashira does not do it for you.

### What this replaces

- **npm**: v1's `npm-release` composite ran `semantic-release` end-to-end —
  computing its own version from conventional-commit history, then
  publishing and tagging via `@semantic-release/npm`/`@semantic-release/github`.
  v2 removes `semantic-release` and all four of its plugins entirely; the
  composite now only *consumes* the CI-resolved `version` input.
- **NuGet**: v1 relied on MinVer's git-tag inference as the de facto release
  trigger (push a `v*` tag, MinVer infers the version at pack time). v2 keeps
  MinVer as the packing mechanism but drives it with an explicit
  `version_override` from the resolver — the maintainer's dispatch `bump`
  choice is what determines the release, not a manually-pushed tag.

## Gate model

Every flow uses the **CI reusable workflow + CD composite action** shape
(D2 — the architectural spine): a CI workflow runs on every PR/push
(always-on, no gate; the `version` job inside it only activates when `bump`
is set) and produces a same-run artifact. A separate **gated** `publish`/
`deploy` job — defined in the **consumer's own workflow file**, never a
reusable workflow the consumer calls — invokes the CD composite
(`npm-release`, `nuget-push`, or `pages-deploy`) and is protected by a
GitHub Environment with a required reviewer.

### Why a composite action, not a reusable workflow, for CD

OIDC trusted publishing validates the token's `job_workflow_ref` claim
against the consumer's own registered "Workflow filename" — a job running
inside a `workflow_call`-invoked reusable workflow has the **wrong**
`job_workflow_ref` and fails the registry's ref check (a `workflow_call`
boundary breaks the claim). A composite action runs **inline** in the
caller's own job, so no such boundary exists. Two corollaries the library
enforces (and one it cannot):

- **Mechanically enforced**: every CD composite (`nuget-push`, `npm-release`,
  `pages-deploy`) contains **no** `uses: <reusable-workflow>` step — verified
  by direct reading of each `action.yml` and asserted by Phase 5's self-CI
  shape lint. Re-introducing such a step would silently re-open the
  `job_workflow_ref` mismatch this entire shape exists to avoid.
- **Documented, not mechanizable**: the consumer's own `publish.yml`/
  `deploy.yml` job that invokes the CD composite must itself be a
  **top-level workflow**, not a reusable workflow called from elsewhere in
  the consumer's own repo. Hashira's self-CI has no way to see a consumer's
  repository structure, so this is a stated **consumer responsibility**,
  parallel to the Environment-reviewer caveat below — not silently assumed.

### Atomicity — tag/Release creation happens only after a successful publish

Both `nuget-push` and `npm-release` implement the same atomicity contract
(in service of FR-8's safe-re-run requirement), and it is identical in
shape across the two:

1. The publish step (`dotnet nuget push` / `npm publish`) is attempted
   first. On failure, the step exits non-zero and the composite halts —
   **no tag or Release is created**.
2. Only after a successful publish does the composite run its tag +
   GitHub Release step:
   ```bash
   tag="v${VERSION}"
   if gh release view "${tag}" --json id >/dev/null 2>&1; then
     # already exists (parallel run, or retry after an earlier partial
     # attempt) — do nothing.
   else
     gh release create "${tag}" --generate-notes --target "${GITHUB_SHA}"
   fi
   ```
3. This `gh release view` check makes the tag/Release step **idempotent**:
   re-running the gated job (FR-8's "cheap re-publish" path) after a
   partial earlier attempt does not fail on an already-existing tag/Release,
   and `dotnet nuget push --skip-duplicate` (NuGet) gives the same
   re-run-safety on the publish side. npm has no `--skip-duplicate`
   equivalent — see [`flows/npm.md`](./flows/npm.md) for the documented gap
   in re-publish behavior after a partial npm failure.

The net effect: the failure mode "tag created but publish failed" is
structurally impossible (the steps are sequential `shell: bash` steps in the
same composite, and a failed step halts the run), not merely discouraged by
convention.

### Release notes

Both CD composites' `gh release create` calls pass **`--generate-notes`**
(D13) — GitHub's own server-side PR/commit-range heuristic populates the
Release body. This requires no new resolver output (it runs entirely
server-side, independent of the resolved `version` scalar) and replaces the
auto-generated notes v1's npm flow got for free from a semantic-release
plugin. **Expect a content-character change**, not just a mechanism change:
`--generate-notes` summarizes from merged-PR titles/labels, not from
conventional-commit message parsing — consumers whose PR titles aren't
curated will see different (not necessarily worse, but different) Release
notes than semantic-release produced. See each flow's `docs/flows/<name>.md`
for the per-flow migration note.

### Environment-reviewer gate — what the library can and cannot verify

The reviewer click in the GitHub UI is the explicit gate. The library
**cannot** runtime-verify that a gated Environment has a required reviewer
configured — the `gh api environments` endpoint requires admin-tier scope
that the workflow's `GITHUB_TOKEN` does not carry (carried forward unchanged
from v1). A misconfigured Environment runs the gated job immediately
without pausing, and this is **silent and indistinguishable from working**
until something bad publishes. The library does not accept this residual
risk by fiat (D12) — it adds defense-in-depth on the part that actually is
mechanizable:

1. **Consumer setup, one-time** — run this once per gated Environment (you
   need admin scope on your repo; the workflow token does not have it):

   ```bash
   # Require at least one reviewer on the gated Environment before the
   # first publish/deploy run. Replace OWNER/REPO and ENVIRONMENT_NAME.
   # reviewers: pass an array of {"type":"User"|"Team","id":<id>}; the
   # example below requires a single user reviewer (look up their numeric
   # GitHub user id via `gh api users/<username>`).
   gh api --method PUT \
     repos/OWNER/REPO/environments/ENVIRONMENT_NAME \
     -f wait_timer=0 \
     -F "reviewers[][type]=User" \
     -F "reviewers[][id]=<numeric-user-id>" \
     -F deployment_branch_policy='{"protected_branches":true,"custom_branch_policies":false}'
   ```

   Each flow's `docs/flows/<name>.md` instantiates this snippet for that
   flow's actual Environment name (`production` for npm/NuGet,
   `github-pages` for static-webapp) — this section gives the general shape
   only.

2. **Self-CI / template lint** — a static-shape check (Phase 5) asserts
   that every gated `publish`/`deploy` job in the library's own templates
   declares an `environment:` key. This catches a real, cheap-to-detect
   defect class (a maintainer accidentally dropping `environment:` from a
   template) without needing admin-tier API access into anyone's live repo.
   It does **not** catch "Environment declared but has zero required
   reviewers" — that half of the risk is shrunk, not closed, and stays a
   documented consumer responsibility.

An explicit first-adoption acknowledgement input (a boolean a consumer sets
to confirm they configured a reviewer) was considered and **rejected** as
security theater (D12): a consumer can set it to `true` without having done
the underlying setup, so it changes no real risk.

### Not `workflow_run`

No flow uses `workflow_run`. `workflow_run` runs in default-branch context
with default-branch secrets even when triggered by a PR-originating run —
contributors who can influence the CI workflow's behavior could otherwise
trigger a deploy under default-branch context, a privilege-escalation path
v1 already avoided and v2 does not reintroduce. The shape every flow uses
instead is: two separate caller files (`ci.yml` + `publish.yml`) for
npm/NuGet, or one caller file with two `needs:`-linked jobs for
static-webapp — same-run handoff, no cross-run secret exposure.

Per-flow gate details:

- **npm Publish** — GitHub Environment (recommended `production`); CD =
  `npm-release` composite invoked from the consumer's own `publish` job. See
  [`flows/npm.md`](./flows/npm.md).
- **NuGet Publish** — GitHub Environment (recommended `production`); CD =
  `nuget-push` composite invoked from the consumer's own `publish` job. See
  [`flows/nuget.md`](./flows/nuget.md).
- **Static webapp Deploy** — GitHub Environment (`github-pages`, the magic
  Pages environment name, or a custom name passed explicitly); CD =
  `pages-deploy` composite invoked from a `deploy` job in the same caller
  file as CI, linked via `needs:`. See
  [`flows/static-webapp.md`](./flows/static-webapp.md).

## Auth model — `auth: oidc | token | auto`

All three publish-capable CD composites (`nuget-push`, `npm-release`; the
static-webapp `pages-deploy` composite uses Pages' own OIDC mechanism and has
no equivalent `auth` input) take an explicit `auth` input (D3/D11) — there is
no silent downgrade from the secure path:

- **`auth: oidc`** — always attempt OIDC trusted publishing. On failure,
  **fails loud** — never falls back to a long-lived secret, even if one is
  configured. This is the secure, recommended setting.
- **`auth: token`** — always use the long-lived secret directly; OIDC is
  never attempted. An explicit opt-out.
- **`auth: auto`** *(default)* — attempt OIDC first; if it fails **and** a
  token is present, fall back to the token with an `::warning::` annotation.
  If OIDC fails and no token is present, fails loud, same as `auth: oidc`.
  This is the old v1 default behavior, now opt-in rather than unconditional
  — `auth: auto`'s fallback is a posture downgrade (no long-lived secret →
  long-lived secret) and is no longer silent.

The two composites enforce this with mechanisms shaped by what each
ecosystem's tooling exposes:

- **`nuget-push`** observes a separate, explicit `NuGet/login` step's
  outcome before deciding which credential to use — OIDC is a distinct,
  observable step here.
- **`npm-release`** has no equivalent separate login step: npm's own native
  OIDC trusted-publishing exchange happens *inside* `npm publish` itself,
  and npm's `oidc()` function is designed to never throw on failure — it
  silently falls through to whatever credential it can find. `npm-release`
  therefore enforces `auth` via **environment hygiene** on the publish
  subprocess instead of observing an outcome: under `auth: oidc`, every
  credential npm could fall back to is positively scrubbed from the
  subprocess's environment (`NPM_TOKEN`/`NODE_AUTH_TOKEN` unset, every
  `npm_config_*`/`NPM_CONFIG_*` var cleared, a throwaway empty
  `--userconfig`/`--globalconfig`, and a clean throwaway `cwd` so no
  project-level `.npmrc` is found) — with genuinely zero reachable
  credentials, a real OIDC failure surfaces as npm's own `ENEEDAUTH`,
  fail-loud **by construction**, not by branching on an observed result.

Each flow's `docs/flows/<name>.md` documents the exact onboarding steps and
failure-mode triage per ecosystem.

## Pin policy

The `uses:` ref on every consumer caller workflow, and the `library_ref`
input on every CI reusable workflow that exposes it, together control both
reproducibility and supply-chain integrity. hashira is past `v1.0.0`
(tagged) and `v2` is the in-development major this document describes (D6:
in-place `@v2`, `@v1` stays frozen and resolvable through the migration
window — a long-lived mixed `@v1`/`@v2` state across consumers is an
explicitly supported outcome, not a failure).

### Recommended pin shapes, in increasing order of integrity tightness

1. **`@v2` rolling tag** — points at the latest `v2.x.y` release. Consumers
   auto-pick up additive minor/patch releases without a PR. Trade-off:
   byte-exact reproducibility is lost across re-runs as the tag rolls
   forward. Acceptable for most consumers.
2. **`@v2.X.Y` specific tag** — one release; the consumer opts in to each
   new release explicitly via PR.
3. **`@<40-char-sha>` SHA pin** — strongest integrity option: byte-exact
   reproducibility; a compromised library repo cannot silently shift a
   SHA-pinned consumer's code. Recommended for provenance audits, regulated
   environments, and consumers who want a stable SBOM across re-runs.
   Dependabot's `github-actions` ecosystem can automate the bump PRs.

After each `v2.X.Y` release the library owner rolls the `v2` tag forward
(`git tag -f v2 v2.X.Y && git push -f origin v2`) — a deliberate, documented
part of the release process, matching the convention every major GitHub
Actions marketplace action follows (`actions/checkout@v4`,
`actions/setup-node@v4`). Consumers who do not want force-pushed refs in
their provenance audit trail use the `@v2.X.Y` or SHA pin instead. The
library does not force-push tags other than the major-version rolling tags
(`v1`, `v2`).

**No consumer-facing doc example may pin a `uses:`/`library_ref` reference
to `@main`** — an `@main` pin is mechanically reproducible-looking but is
not reproducible (resolves to whatever commit `main` happens to be at when
the workflow runs) and is exactly the revocable-redirect-shaped,
supply-chain-integrity risk this policy exists to close. (`docs/flows/*.md`'s
adoption examples are corrected to a SHA or `@v2` pin in iteration 4.3/4.4 —
if you find a doc example still pinned `@main`, that is a defect, not an
accepted shape.)

### The `library_ref` dual-pin invariant

Every kept CI reusable workflow (`npm-package-ci.yml`, `nuget-package-ci.yml`,
`static-webapp-ci.yml`) self-checks-out the library into a local `.hashira/`
directory so it can invoke its own composite sub-actions via a **literal**
`uses: ./.hashira/.github/actions/<name>` path — GitHub Actions rejects an
interpolated/variable ref on a `uses:` line, which is *why* this
self-checkout mechanism exists at all, not an arbitrary design choice. The
consumer supplies the ref to check out via the `library_ref` input
(**required**, no default — every caller must pin it explicitly).

This creates two refs in play for the same library code, which must agree:

- The **outer `uses:` pin** on the consumer's caller workflow
  (`uses: skathio/hashira/.github/workflows/<flow>-ci.yml@<sha-or-tag>`).
- The **inner `library_ref`** input passed to that same job.

**Precise framing of the invariant** (corrected during this phase from an
earlier, looser "both refs must independently name the same repository"
description — re-verified directly against all three kept workflows):
`library_ref` itself carries **no repository component** — it is consumed
only as the `ref:` of a checkout step whose `repository:` field is
**hardcoded** to `skathio/hashira` in every kept workflow. The invariant
therefore splits into one genuine two-ref comparison and one one-sided
property, not two symmetric checks:

1. **Same-SHA** (a real comparison between two values) — the outer `uses:`
   pin's commit and `library_ref`'s resolved commit must be identical. If
   they diverge, the reusable-workflow YAML being executed is at one commit
   while the in-repo composite actions it invokes via
   `./.hashira/.github/actions/<name>` resolve to a **different** commit —
   a pinned-looking caller silently running unknown action code.
2. **Same-repository** (a unilateral property of `uses:` alone) — the outer
   `uses:` ref must name the canonical `skathio/hashira`. There is nothing
   on the `library_ref` side to compare this against, because `library_ref`
   has no repository information of its own; it is checked against the
   fixed point every kept workflow's self-checkout is hardcoded to.

Pinning `uses: …@<sha-A>` while leaving `library_ref: 'main'` (or any
non-pinned ref) is the **most acute violation**: the outer ref *looks* fully
pinned, but `library_ref` resolves to whatever `main` happens to be at
workflow-run time — a caller that appears reproducible is not. The library's
self-CI lints this (`tests/dual-pin/lint.py`, iteration 4.1) — see
"Self-CI-checkable scope" below for exactly what that lint can and cannot
see. Each flow's caller template
([`flows/npm.md`](./flows/npm.md) §1, [`flows/nuget.md`](./flows/nuget.md)
§1, [`flows/static-webapp.md`](./flows/static-webapp.md) §1) shows the
expected paired-pin shape.

#### Self-CI-checkable scope vs. the real cross-repo guarantee

The self-CI dual-pin lint validates hashira's **own** fixtures/templates for
internal consistency — it cannot reach into a live consumer's repository to
read their actual outer `uses:` SHA, because GitHub Actions gives no API for
a library to introspect a consumer's caller-file content. This is a
documented scope limit, not an oversight: the lint proves the invariant is
*checkable and enforceable where it can be checked*; it is **not** a live
guarantee that any given consumer's actual pin pair is currently correct.
The real consumer-side proof that the dual-pin holds in practice is each
ecosystem's validation release during migration (somi for npm, rogue for
NuGet) — a live release succeeding with the documented pin shape is the
closest thing to an end-to-end check this invariant gets.

#### Why self-checkout is kept in v2 (not eliminated)

Moving to published-action refs (eliminating self-checkout, and with it the
dual-pin class entirely) was considered and **deferred to v2.x** (D9): v2
already changes the versioning model, the CI/CD split, and all three flows'
internal shape simultaneously — stacking a fourth simultaneous change to the
composition mechanism itself would multiply the diagnostic search space if
the first real v2 releases fail, with no corresponding mitigation. Revisit
once the extension model (see "Extension contract" below) is proven across a
full v2 release cycle on both consumers.

## Secret-passing model

Reusable workflows declare every secret they require explicitly in their
`secrets:` block at the top of the workflow YAML. Consumers pass only the
secrets the workflow declares, via the `secrets:` map on the caller's
`uses:` invocation. **`secrets: inherit` is discouraged** — it propagates
every secret in the caller repo into the reusable workflow, broadening the
blast radius unnecessarily (this carries forward unchanged from v1; it is
not a recommended pattern in any v2 template).

For the npm flow, the only secret is an npm registry token (optional — if
OIDC trusted publishing is configured and `auth` is `oidc` or `auto`, no
secret is required at all). The `GITHUB_TOKEN`/`github.token` used for the
tag + Release step is the runner-provided token; composite actions have no
`secrets:` context, so it is sourced from the `github` context, not a
`secrets:` block.

For the NuGet flow, the only secret is a NuGet API key (required when
`auth: token`, or as the `auth: auto` fallback; not required when
`auth: oidc` and trusted publishing is configured).

CI workflows (the always-on half) require **no secrets at all** in either
flow — only the gated CD composite, invoked from the consumer's own
publish/deploy job, ever touches a registry credential.

Per-flow secrets are documented in each flow's `docs/flows/<name>.md` secret
table.

Example consumer secret-passing — the CD half of every flow is a **composite
action** called from the consumer's own job (not a reusable workflow with a
`secrets:` map). A composite action's own steps cannot read the ambient
`secrets.*` context directly (NF5) — but the *caller's* `with:` block is
evaluated in the calling workflow's context, where `secrets.*` IS available,
so any fallback token is passed as a `with:` input, not as `env:`:

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    needs: ci
    environment: production
    permissions:
      id-token: write          # OIDC token exchange (auth: oidc/auto)
      contents: write           # gh release create tags the commit
      pull-requests: read       # --generate-notes reads merged-PR metadata
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: true }
      - uses: skathio/hashira/.github/actions/npm-release@v2
        with:
          version: ${{ needs.ci.outputs.resolved_version }}
          # Only if auth=token, or as the auth=auto fallback. This is a
          # declared composite-action INPUT, not an env var — npm-release
          # never reads `secrets.*`/`env.*` for the token, only `inputs.npm_token`.
          npm_token: ${{ secrets.NPM_TOKEN }}
```

## Permissions baseline

Every CI reusable workflow declares `permissions: {}` at workflow level
(deny-all baseline) and grants the minimum per job. Every CD composite
action **cannot** declare `permissions:` at all (no GitHub Actions
primitive for that on a composite action) — the grant lives entirely on the
**consumer's own job** that invokes it. Consumers must mirror the per-job
grants below at their caller's job-level `permissions:` block — reusable
workflows can only NARROW the caller's grants, never broaden them, so an
under-granted caller job fails with a permission error inside the called
workflow's steps.

v2's shape is **CI reusable workflows + CD composite actions** — there are
no CD reusable workflows left in this library (`nuget-package-publish.yml`
and `static-webapp-deploy.yml` were both retired in Phase 3; their logic
moved into the `nuget-push` and `pages-deploy` composites respectively, and
the *permission grant* moved with it to the consumer's own job, since a
composite cannot hold its own `permissions:` block).

| Component | Shape | Caller-job permissions required |
|-----------|-------|----------------------------------|
| `npm-package-ci.yml` | CI reusable workflow | `contents: read`, `pull-requests: write`, `security-events: write` (the `version` job, when `bump` is set, needs only `contents: read`) |
| `npm-release` (consumer's own `publish` job) | CD composite action | `contents: write`, `pull-requests: read`, `id-token: write` (for `auth: oidc`/`auto`) |
| `nuget-package-ci.yml` | CI reusable workflow | `contents: read`, `pull-requests: write`, `security-events: write` |
| `nuget-push` (consumer's own `publish` job) | CD composite action | `contents: write`, `pull-requests: read`, `id-token: write` (for `auth: oidc`/`auto`) |
| `static-webapp-ci.yml` | CI reusable workflow | `contents: read`, `id-token: write`, `pages: write`, `pull-requests: write`, `security-events: write` |
| `pages-deploy` (consumer's own `deploy` job) | CD composite action | `pages: write`, `id-token: write` (no `contents: write` — `deploy-pages` reads the artifact, not the repo) |

**`pull-requests: read`, not `write`, on the publish/deploy job**: both
`nuget-push` and `npm-release`'s `gh release create --generate-notes` step
only **reads** merged-PR metadata to compose the Release notes — it does
not write to or comment on PRs. v1's deleted `nuget-package-publish.yml`
over-granted `pull-requests: write` here; v2's composites correct this to
`read` (least-privilege).

**`GITHUB_TOKEN`, not `GH_TOKEN`**: both CD composites source the token the
`gh` CLI uses from `github.token` via an `env: GITHUB_TOKEN: ${{ github.token
}}` block (composite actions have no `secrets:` context to read from
directly) — `gh` itself checks `GH_TOKEN` then `GITHUB_TOKEN`; the
composites use the latter name, consistently across both flows.

**Static-webapp CI `id-token: write` note**: `static-webapp-ci.yml` is the
only CI-half workflow that requires `id-token: write` at the caller job. npm
and NuGet CI halves do NOT require `id-token: write` — that scope belongs
only on their Publish-half jobs. The asymmetry exists because
`actions/upload-pages-artifact` authenticates the artifact upload via OIDC
and the upload must happen in the same job as the build command
(cross-job artifact handoff would require `actions/upload-artifact` +
`actions/download-artifact` instead — see
[`flows/static-webapp.md`](./flows/static-webapp.md) §1 for the trade-off).
Practical consequence: the static-webapp consumer's CI caller job holds
`id-token: write` on every PR run, not only on deploy runs — including PRs
from forks. This is documented, accepted residual exposure (B8), mitigated
by `pages-upload`/`pages-deploy` only ever running on `pull_request` (never
`pull_request_target`) and `pages-deploy` itself refusing to run on a
`pull_request` event regardless of caller wiring (a runtime guard folded in
during Phase 3, not merely a documentation prohibition).

Detailed per-job grant breakdowns live in each flow's `docs/flows/<name>.md`
permissions table. The workflow-level `permissions: {}` deny-all default is
recommended for every consumer caller workflow.

## Extension contract

Two independent axes, both first-class (D10):

### Maintainer axis — adding a new flow

To add a new flow to hashira itself: add a CI reusable workflow + a CD
composite action + a `docs/flows/<flow>.md` page (the existing
`scan-suite`/sub-scan pattern is the precedent). Every input/secret/output
must be explicitly declared with a `description`. See
[`contributing.md`](./contributing.md) for the maintainer-side checklist.
New flows beyond the existing three (npm, NuGet, static-webapp/Pages) are an
explicit v2 non-goal — prove this extension model on the existing three
before growing the flow count.

### Consumer-composition axis — custom jobs alongside the shared CI

A reusable workflow has no step-injection point, and caller `env:` does not
propagate into it — a consumer needing a custom step *inside* the shared
pipeline has historically had to fork or duplicate it (copy-and-rot
pressure). v2 documents the **supported** alternative explicitly, rather
than leaving it an unsupported workaround: a consumer adds **parallel jobs
in their own caller file**, alongside the `uses:` call to hashira's shared
CI reusable workflow, reusing hashira's **composite-action building
blocks** (the same units the library's own flows are built from) inside
those custom jobs as needed.

This is the actual pattern rogue's NuGet caller workflow already runs in
production: four custom jobs (`aot-publish`, `bench-smoke`, `license-check`,
`public-api`) alongside the shared `nuget-package-ci.yml` call — this
section codifies that as a documented contract, not an unsupported
workaround. The worked example, with rogue's actual job names, lives in
[`flows/nuget.md`](./flows/nuget.md).

Deep per-step injection into a reusable workflow's own internal job graph
remains a non-goal — it is not a primitive GitHub Actions exposes, so there
is no engineering alternative being given up by documenting "parallel jobs"
as the supported shape instead.

#### Required-check × path-filter deadlock

The parallel-jobs pattern, combined with branch-protection required checks,
can produce a real deadlock: if a required status check's job is
path-filtered (e.g. only runs when certain files change) and a given PR
doesn't touch those paths, the check never reports and the PR can become
permanently un-mergeable despite being otherwise green. This is a documented
risk of the consumer-composition pattern, not unique to hashira, but worth
calling out here because adopting parallel custom jobs increases the chance
of hitting it. The mitigation — one aggregating required check rather than
requiring every path-filtered job individually — is a **consumer-side
branch-protection setting**, not something hashira's own files can fix on a
consumer's behalf.

hashira's own self-CI (`_self-ci.yml`) was audited for this exact risk
(work-item Phase 5.3): it is the repo's only `pull_request`-triggered
workflow, and **none of its jobs are path-filtered** — every job runs on
every PR regardless of which files changed, so the deadlock cannot occur
there. Confirmed-sufficient, not a hypothetical: verified directly against
the actual `on:`/`if:` conditions of all 34 jobs, not assumed. If a future
job in this file ever gains a `paths:`/path-conditional `if:`, re-audit
this section — the structural guarantee that makes "no change needed" true
today would no longer hold.

## Additive-only v1.x evolution rule

The name of this rule predates v2 and is kept unchanged here (so existing
cross-references, e.g. from `README.md`, keep resolving) — the rule itself
is **not** v1-specific. It applies per-major: the contract guarantees that
consumer caller workflows pinned to a given major (`@v1` or `@v2`, or any
specific `@<major>.X.Y`) keep working without modification across that
major's entire `.x.y` series. The library commits to:

**Allowed in a `.x.y` patch and minor release (additive only)**:

- Add a **new** input to a reusable workflow's `inputs:` block (with a
  sensible default; consumers who don't set it get the prior behavior).
- Add a **new** input or output to a composite action's `inputs:` /
  `outputs:` blocks.
- Add a **new** reusable workflow or composite action.
- Fix bugs that bring observed behavior in line with documented behavior.
- Refresh third-party action SHA pins inside composite actions (treated as
  internal — consumers do not see the pinned versions across the contract
  boundary).
- **Narrow** the permissions matrix (better default; strictly safer for
  consumers).

**NOT allowed within a major's `.x.y` series — requires the next major
bump**:

- Remove or rename an input.
- Change the default value of an existing input.
- Remove a reusable workflow file or composite action.
- Change documented user-observable behavior without a corresponding new
  input.
- **Broaden** the permissions matrix (new attack surface; consumers' caller
  workflows must explicitly broaden to match — a silent broadening violates
  the deny-all baseline narrative).

**Not covered by the contract** (the library may change these freely within
a major):

- Implementation details of composite actions that don't surface in
  inputs/outputs.
- Internal step names, summary message formatting, and the exact text of
  `::warning::` / `::error::` annotations.
- The number, ordering, and naming of jobs in a reusable workflow's internal
  `jobs:` graph (consumers don't reference these by name).
- Third-party action SHA pins inside composite actions (refreshed in-place
  as those projects ship security fixes).

If you depend on any "not covered" detail (e.g., parsing the workflow
summary in a downstream automation), pin to a specific SHA or
`@<major>.X.Y` tag instead of the rolling major tag. The rolling tag's
stability guarantee covers the input/output/permissions contract only.

`v1` and `v2` are independent majors under this rule: `@v1` callers are
unaffected by anything documented in this revision, and stay frozen
(security backports only) until every consumer has validated and migrated
off it (D6).

## `x_`-prefix experimental input convention

Inputs whose name starts with `x_` are **explicitly out of the stable
contract**. The library uses this prefix to ship a feature behind a flag and
gather feedback before promoting it to the stable input surface.

`x_`-prefixed inputs:

- MAY change semantics between any two `.x.y` releases within a major.
- MAY change defaults between any two `.x.y` releases within a major.
- MAY disappear entirely in a future `.x.y` release without a major bump.

Consumers who use `x_` inputs explicitly accept that risk. The benefit is
early access to features that aren't yet ready for the stable freeze; the
cost is that the consumer must track each `x_` input's evolution in the
library's CHANGELOG and update their caller workflow when the input
changes.

When an `x_` input graduates to the stable surface, the library adds the
stable (non-prefixed) input in an additive minor release; the `x_` version
is kept for at least one minor release as a deprecation shim (emitting a
`::warning::` when set) and then removed in a subsequent release. The
graduation event is called out in the CHANGELOG.

**v2 ships with no `x_`-prefixed inputs** at the time of this revision. Any
input you find on a current `v2` reusable workflow or composite action that
is not `x_`-prefixed is part of the stable contract per the additive-only
rule above.

## Environment configuration adoption checklist

Per-flow Environment checklists, including the instantiated `gh api`
setup snippet from the "Gate model" section above, live in each flow's
`docs/flows/<name>.md`. See [`flows/npm.md`](./flows/npm.md) for npm's
`production` Environment, [`flows/nuget.md`](./flows/nuget.md) for NuGet's
`production` Environment, and
[`flows/static-webapp.md`](./flows/static-webapp.md) for the `github-pages`
Environment (which carries the magic Pages environment name and
deployment-status-display quirks).

## OIDC trust onboarding

OIDC trusted publishing eliminates long-lived publish tokens by exchanging a
short-lived GitHub OIDC token for a registry-side publish token at publish
time. Each flow's `docs/flows/<name>.md` contains the registry-specific
onboarding steps; this section describes the generic narrative — see "Auth
model" above for the precise `auth: oidc|token|auto` semantics.

For npm: native npm OIDC trusted publishing happens **inside** `npm publish`
itself (the npm CLI on `PATH` performs the token exchange; no separate login
step exists to observe). `npm-release` enforces the `auth` contract via
environment hygiene on the publish subprocess rather than branching on an
observed login outcome — see "Auth model" above. The publish runs in the
**consumer's own job** so the OIDC `workflow_ref` matches the
trusted-publisher config. Step-by-step onboarding lives in
[`flows/npm.md`](./flows/npm.md).

For NuGet: `nuget-push` attempts OIDC via a separate, observable `NuGet/login`
step when `auth` is `oidc` or `auto` (with `nuget_user` set); the resulting
key (or the configured `api_key`, depending on mode) is what
`dotnet nuget push` actually uses. Step-by-step onboarding lives in
[`flows/nuget.md`](./flows/nuget.md).

When OIDC is configured correctly under `auth: auto`, the consumer can omit
the long-lived token secret entirely. When OIDC fails under `auth: auto`,
the workflow falls back to the long-lived token if set, and emits a
`::warning::` so the consumer is alerted to the misconfiguration. Under
`auth: oidc`, there is no fallback at all — a failure is loud, by design.
The recommendation is to use `auth: oidc` once trusted publishing is
confirmed working, rather than leaving `auth: auto` indefinitely — `auto`'s
silent-downgrade-with-a-warning posture is meant for onboarding, not as a
permanent steady state.

## Scan-suite toggles

The CI half of every package/webapp flow includes a `scan-suite` job that
runs five security scans against the consumer's repo:

| Scan | What it checks | Skipped by default? |
|------|----------------|---------------------|
| `codeql` | CodeQL static analysis (language-specific) | **Yes** |
| `osv` | OSV-Scanner — known-vulnerable dependencies | No |
| `gitleaks` | Secrets committed to git history | No |
| `dependency-review` | New dependency changes on PRs (CVE / license) | No (PR-only) |
| `actionlint` | GitHub Actions workflow lint | **Yes** |

The `scan_disable` input is a **comma-separated string** of scan names to
skip (CSV-string format chosen over a list to keep the reusable-workflow
input contract scalar).

### Default value

`scan_disable: 'codeql,actionlint'`

- **`codeql` is skipped by default** because most consumer repos don't have
  CodeQL enabled (Settings → Security → Code scanning). Running CodeQL
  against a repo where it isn't enabled emits a confusing permission error
  rather than a useful finding.
- **`actionlint` is skipped by default** because the consumer's repo may not
  be a workflow library — actionlint findings against application-shaped
  workflows are typically noise rather than signal.

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

The `scan-suite` job grants `security-events: write` even under the default
skip-list. This is deliberate: consumers who flip `codeql` on (by setting
`scan_disable: ''`) should not also have to remember to broaden their
caller's permissions matrix. The grant is unused while `codeql` is in the
skip-list, which is the honest trade-off documented inline in each CI
workflow (`npm-package-ci.yml`, `nuget-package-ci.yml`,
`static-webapp-ci.yml`).

## Coverage reporting

The CI half of every package/webapp flow ends its `test` job with a
`coverage-report` step that parses the consumer's coverage file and renders
a sticky PR comment with per-file coverage percentages and a delta against
the PR's base.

### Supported formats

`coverage-report` auto-detects the coverage format from the file extension
and content:

- **lcov** (`coverage/lcov.info`) — standard JS / TypeScript output from
  Jest, Vitest, c8, nyc, etc.
- **cobertura** (`coverage/cobertura.xml`) — .NET output from
  `coverlet.msbuild`'s default format; also Python `coverage.py`'s cobertura
  output.
- **opencover** (`coverage.opencover.xml`) — .NET output from
  `coverlet.collector` with `CollectCoverage=true` and
  `CoverletOutputFormat=opencover`.

### `coverage_path` input

The consumer configures the path via `coverage_path`. Defaults differ per
flow:

| Flow | `coverage_path` default |
|------|--------------------------|
| `npm-package-ci.yml` | `coverage/lcov.info` |
| `nuget-package-ci.yml` | `coverage/cobertura.xml` |
| `static-webapp-ci.yml` | `coverage/lcov.info` |

If the file at `coverage_path` doesn't exist, the job emits a `::warning::`
and skips the comment rather than failing — coverage reporting is
informational, not a gate.

### Sticky comment mechanism

The sticky comment uses a **hidden HTML anchor** embedded in the comment
body (not a marker comment) to identify itself across consecutive runs. On
subsequent CI runs on the same PR, the `actions/github-script`-based step
finds the existing comment by anchor and **updates it in place** rather than
spawning a duplicate. This keeps PR threads clean even on heavily-iterated
PRs.

The anchor format is internal and may change between releases within a
major; consumers should not script against it.

### Codecov / external coverage services

Codecov upload is deliberately out of scope for this library (see
follow-ups in the work item's `progress.md`). The GitHub-native
sticky-comment is the only coverage UI hashira provides. Consumers who want
historical coverage trends should opt in to Codecov outside the library's
reusable workflow (typically a `codecov/codecov-action@<sha>` step in the
caller); the library does not interfere with that path.
