# Contributing to hashira

Internal contributing notes for library maintainers.

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

1. Name it `.github/workflows/<flow>-<phase>.yml` — e.g. `npm-ci.yml`,
   `npm-publish.yml`. The two-file split (CI vs Publish/Deploy) is required
   per D8.
2. Declare a top-level `permissions:` block restricted to least privilege;
   widen per-job only where necessary.
3. Document every `inputs:` and `secrets:` entry in the matching
   `docs/flows/<flow>.md` page.

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
