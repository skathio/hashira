# Migrating from v2 to v3

v3 is a major release: a v2 caller does not work unchanged. This guide lists
every breaking change, each with the v2 caller line and its v3 replacement.
`v2` is now frozen like `v1`: both tags stay resolvable, but neither gets any
further change, so moving to v3 is the only way to get fixes.

The fastest path is to replace your caller files with your flow's template
and then re-apply what you changed on purpose:

| Flow | v3 caller (one file, `.github/workflows/ci.yml`) |
|------|---------------------------------------------------|
| npm package | [`templates/npm/ci.yml`](../templates/npm/ci.yml) |
| NuGet package | [`templates/nuget/ci.yml`](../templates/nuget/ci.yml) |
| Static webapp | [`templates/static-webapp/ci.yml`](../templates/static-webapp/ci.yml) |

## 1. The `uses:` ref

Every hashira ref moves to v3, on the reusable workflow and on the publish
or deploy action alike. Keep pinning a 40-character SHA if you did; never
pin `@main`.

```yaml
# v2
    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@v2
      - uses: skathio/hashira/.github/actions/npm-release@v2
# v3
    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@v3
      - uses: skathio/hashira/.github/actions/npm-release@v3
```

## 2. `library_ref` is removed (all three CI workflows)

v2 asked the caller to repeat the `uses:` SHA as `library_ref`, so the
workflow could check its composite actions out at that commit. v3 resolves
its own commit and checks the actions out there by itself, so the composite
actions always come from the same commit as the workflow file. Passing
`library_ref` to a v3 workflow fails the run, because the input no longer
exists. Delete the line.

```yaml
# v2
    with:
      library_ref: '<40-char-sha>'    # same SHA as the uses: ref
# v3
    # (no line: the workflow checks its actions out at its own commit)
```

The new output `library_sha` reports the commit it used.

## 3. `coverage_path` defaults to `''` (all three CI workflows)

In v2 the default was the flow's file path (`coverage/lcov.info` for npm and
static-webapp, `coverage/cobertura.xml` for NuGet). In v3 the input has one
default in every flow, `''`, which means "the flow's standard path", the same
paths as before. A caller that left the input out sees no change. A caller
that passed the v2 default explicitly can drop the line.

```yaml
# v2
      coverage_path: 'coverage/lcov.info'
# v3
      coverage_path: ''    # or leave it out: '' uses the flow's standard path
```

## 4. `project_path` is optional (`nuget-package-ci.yml`)

v2 required `project_path`. v3 defaults it to `''`: the workflow then uses
the one `.csproj` in the repository that is not a test project (named
neither `*Test*.csproj` nor `*.Tests.csproj`), and fails listing the
candidates when there are none or several. A caller that passes it keeps
working; with a single packable project you can drop the line.

```yaml
# v2
      project_path: 'src/MyLib/MyLib.csproj'
# v3
      project_path: ''    # or leave it out when the repo has one non-test .csproj
```

## 5. `bump` and `seed_version` come from the dispatch (npm and NuGet)

v2 callers forwarded the dispatch inputs by hand. v3 reads `bump` and
`seed_version` from the caller's `workflow_dispatch` inputs when the caller
does not pass them; a value passed with `with:` still wins. The forwarding
lines keep working, and you can drop them. The caller still declares the two
`workflow_dispatch` inputs, as the templates do.

```yaml
# v2
      bump: ${{ inputs.bump }}
      seed_version: ${{ inputs.seed_version }}
# v3
      # (no lines: the workflow reads them from the workflow_dispatch event)
```

The publish job's condition can test the resolved version instead of the
dispatch input:

```yaml
# v2
    if: ${{ inputs.bump != '' }}
# v3
    if: needs.ci.outputs.resolved_version != ''
```

## 6. SoMi's quality gate is on by default (all three CI workflows)

v3 adds a `quality-gate` job that runs SoMi's quality check on what a pull
request changes and fails the run on a violation, at the `strict` level.
Only the change is scored, so debt already in the repository does not fail
a pull request. On `push` and `workflow_dispatch` the job passes with a
skip note. Two new inputs control it:

```yaml
# v2
    with:
      test_command: 'npm test'
# v3: keep the default (gate on, strict), or turn it down or off
    with:
      test_command: 'npm test'
      quality_gate: false        # turn the gate off
      quality_level: standard    # or: strict (default) | standard | relaxed
```

`quality_level` accepts exactly `strict`, `standard` or `relaxed`; any other
value, including `''`, fails the run's `setup` job.

## 7. Permissions

No v3 CI workflow requests a permission v2 did not: the workflows resolve
their own commit from `job.workflow_sha`, not from an OIDC token, so the
`ci` job needs no new `id-token: write` grant. The `ci` job grants stay:

| Flow | `ci` job grants |
|------|-----------------|
| npm | `contents: read`, `pull-requests: write`, `security-events: write` |
| NuGet | `contents: read`, `pull-requests: write`, `security-events: write` |
| Static webapp | `contents: read`, `id-token: write`, `pages: write`, `pull-requests: write`, `security-events: write` |

## 8. Static webapp: one caller file

v2's guide used two caller files, `deploy.yml` on push to `main` and
`pr.yml` on pull requests. v3 uses one, `.github/workflows/ci.yml`, whose
`deploy` job is skipped on pull requests:

```yaml
# v2 (deploy.yml)
on:
  push:
    branches: [main]
# v3 (ci.yml)
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
...
  deploy:
    needs: ci
    if: github.event_name != 'pull_request'
```

Delete `pr.yml` when you add `ci.yml`, or every pull request runs CI twice.
