# Contributing to hashira

Internal contributing notes for library maintainers.

## Extension contract: two axes

There are two independent ways hashira's extension contract gets used —
both are first-class (D10), and this file's checklists below cover the
**maintainer** axis only. The second, **consumer-composition** axis is
documented in full in
[`usage.md`](./usage.md#consumer-composition-axis--custom-jobs-alongside-the-shared-ci);
this section exists to point at it, not to duplicate it.

### Maintainer axis — adding a new flow to hashira itself

Covered below: add a CI reusable workflow + a CD composite action + a
`docs/flows/<flow>.md` page. New flows beyond the existing three (npm,
NuGet, static-webapp/Pages) are an explicit v2 non-goal — prove this
extension model on the existing three before growing the flow count.

### Consumer-composition axis — a consumer's own custom jobs

A reusable workflow has no step-injection point, and caller `env:` does not
propagate into it — a consumer needing a custom step *inside* the shared
pipeline cannot fork the library's `workflow_call` graph from the outside.
The supported pattern instead: the consumer adds **parallel jobs in their
own caller file**, alongside the `uses:` call to hashira's shared CI
reusable workflow, reusing hashira's composite-action building blocks
inside those jobs as needed. This is rogue's actual production pattern
(four custom jobs — `aot-publish`, `bench-smoke`, `license-check`,
`public-api` — alongside the shared `nuget-package-ci.yml` call) and is
now a documented, supported contract rather than an unsupported
workaround. See `usage.md`'s extension-contract section for the full
write-up, including the required-check × path-filter deadlock this
pattern can trigger and its mitigation.

This axis has **no maintainer-side checklist** — it requires no change to
hashira itself. It is listed here only so a maintainer reading this file
doesn't conclude the maintainer axis is the only supported extension path.

## Adding a new composite action

1. Create `.github/actions/<name>/action.yml`. Keep each action ≤ ~80 lines
   (NF1 size budget — if it grows past that, split or move logic to a
   sibling shim under `.github/actions/<name>/lib/`).
2. Declare every input explicitly with `description` + `required` + (where
   appropriate) `default`. Inputs that are unstable and may break in a minor
   version MUST be prefixed `x_` per the convention in
   [`usage.md`](./usage.md#x_-prefix-experimental-input-convention).
3. Pin every third-party action referenced inside `action.yml` by full
   commit SHA + a trailing `# v<x.y.z>` comment. Dependabot's weekly run
   refreshes these.
4. Tests live under `tests/<action-name>/`. Each action must have at least one
   smoke test that the self-CI workflow exercises.

## Adding a new reusable workflow

1. Name the CI half `.github/workflows/<flow>-package-ci.yml` (matches the
   existing `npm-package-ci.yml`/`nuget-package-ci.yml`/
   `static-webapp-ci.yml` convention). The CD half is **not** a second
   reusable workflow — it is a composite action under
   `.github/actions/<flow>-<verb>/` (e.g. `npm-release`, `nuget-push`,
   `pages-deploy`), invoked directly from the consumer's own caller job.
   This CI-reusable-workflow + CD-composite-action split is required per D2
   (a `workflow_call` boundary between the consumer's trusted-publisher-
   registered file and the OIDC token-exchange step breaks the OIDC
   `job_workflow_ref` claim) — see
   [`usage.md`](./usage.md#why-a-composite-action-not-a-reusable-workflow-for-cd).
   A CD composite action **MUST NOT** contain a `uses: <reusable-workflow>`
   step; doing so re-introduces the boundary D2 exists to avoid.
2. Declare a top-level `permissions:` block restricted to least privilege;
   widen per-job only where necessary. The CD composite action cannot
   declare `permissions:` at all (no GitHub Actions primitive for that on a
   composite action) — document the required caller-job grant in the
   action's own header comment instead.
3. Document every `inputs:`/`outputs:` (reusable workflow) and
   `inputs:`/`outputs:`/caller-permissions (composite action) entry in the
   matching `docs/flows/<flow>.md` page.

## Where docs live

- [`docs/usage.md`](./usage.md) — master cross-cutting contract (pin policy,
  gate model, secrets discipline, permissions baseline, evolution rules).
- `docs/flows/<flow>.md` — per-flow consumer-facing guide.

Do not duplicate cross-cutting concerns into per-flow docs; link back to
`usage.md`.

## Branch protection

Recommended ruleset for `main`:

- Require a PR with at least one approval before merging.
- `_self-ci.yml` jobs must pass (add `actionlint`, the shape-validation
  jobs, and any smoke jobs as required status checks once the workflow has
  produced its first green run on a PR — checks become selectable only
  after their first run).
- No direct pushes to `main`.

Configure via repo Settings → Branches → Add rule, or `gh api`.

## Pin discipline

Every third-party action — both in `.github/workflows/*.yml` and inside
composite actions under `.github/actions/*/action.yml` — must be pinned to a
full commit SHA with a `# v<x.y.z>` comment. Tag pins (`@v4`) and branch pins
(`@main`) are forbidden in this repo's own files. Dependabot refreshes the
pins weekly per `.github/dependabot.yml`; review and merge the bump PR after
self-CI passes.
