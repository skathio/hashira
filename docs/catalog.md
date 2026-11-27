# Catalog

Every reusable workflow and composite action in `skathio/hashira`, with what
it does, when a consumer would use it directly, its inputs (name, whether
it is required, its default) and outputs, and a minimal `uses:` snippet.
Most consumers need only a flow's caller (see the [README](../README.md));
the actions below are the parts the flows are built from, and each one
also works on its own.

The snippets follow `@v3`. Pin a 40-character commit SHA instead for
byte-exact runs, and never `@main` (see the
[pin policy](usage.md#pin-policy)). The tables are checked against the
YAML by `tests/catalog/shape-validate.py`.

## Reusable workflows

Called as a job with `uses:` at job level. Each one checks its own
composite actions out at the commit your `uses:` ref resolved to.

### npm-package-ci.yml

CI for an npm package: commitlint, tests with coverage, the scan suite, SoMi's quality gate on pull requests, and on a release run the resolved version and the packed tarball `npm-release` publishes.

**Use it directly**: As the `ci` job of an npm package repo's caller, `templates/npm/ci.yml`. Walk-through: [`flows/npm.md`](flows/npm.md).

| Input | Required | Default |
|-------|----------|---------|
| `node_version` | no | `20` |
| `test_command` | no | `npm test` |
| `coverage_path` | no | `''` |
| `scan_disable` | no | `codeql` |
| `scan_fail_on_findings` | no | `true` |
| `summary_comment` | no | `true` |
| `bump` | no | `''` |
| `seed_version` | no | `''` |
| `quality_gate` | no | `true` |
| `quality_level` | no | `strict` |

| Output | Meaning |
|--------|---------|
| `resolved_version` | The resolved, validated bare semver string (e.g. '1.3.0', no 'v' prefix). Empty when 'bump' was not provided. The workflow's only version output: the CD side derives the tag form and bump kind itself. |
| `library_sha` | The skathio/hashira commit this run checked its composite actions out at: the commit this workflow file was called at. |

```yaml
jobs:
  ci:
    uses: skathio/hashira/.github/workflows/npm-package-ci.yml@v3
```

### nuget-package-ci.yml

CI for a NuGet package: restore and build, tests with coverage, the scan suite, SoMi's quality gate on pull requests, and on a release run the resolved version and the packed `.nupkg` `nuget-push` pushes.

**Use it directly**: As the `ci` job of a NuGet package repo's caller, `templates/nuget/ci.yml`. Walk-through: [`flows/nuget.md`](flows/nuget.md).

| Input | Required | Default |
|-------|----------|---------|
| `dotnet_version` | no | `8.0.x` |
| `project_path` | no | `''` |
| `test_filter` | no | `''` |
| `coverage_path` | no | `''` |
| `scan_disable` | no | `codeql` |
| `scan_fail_on_findings` | no | `true` |
| `summary_comment` | no | `true` |
| `bump` | no | `''` |
| `seed_version` | no | `''` |
| `quality_gate` | no | `true` |
| `quality_level` | no | `strict` |

| Output | Meaning |
|--------|---------|
| `resolved_version` | The resolved, validated bare semver string (e.g. '1.3.0', no 'v' prefix). Empty when 'bump' was not provided. The workflow's only version output: the CD side derives the tag form and bump kind itself. |
| `library_sha` | The skathio/hashira commit this run checked its composite actions out at: the commit this workflow file was called at. |

```yaml
jobs:
  ci:
    uses: skathio/hashira/.github/workflows/nuget-package-ci.yml@v3
```

### static-webapp-ci.yml

CI for a static site on GitHub Pages: build, tests with coverage, the scan suite, SoMi's quality gate on pull requests, and the `github-pages` artifact `pages-deploy` deploys.

**Use it directly**: As the `ci` job of a static site repo's caller, `templates/static-webapp/ci.yml`. The `ci` job grants `contents: read`, `pull-requests: write` and `security-events: write`, and no `id-token` or `pages`: only the `deploy` job holds those. Walk-through: [`flows/static-webapp.md`](flows/static-webapp.md).

| Input | Required | Default |
|-------|----------|---------|
| `node_version` | no | `20` |
| `build_command` | no | `npm run build` |
| `output_dir` | no | `''` |
| `test_command` | no | `npm test` |
| `coverage_path` | no | `''` |
| `scan_disable` | no | `codeql` |
| `scan_fail_on_findings` | no | `true` |
| `summary_comment` | no | `true` |
| `quality_gate` | no | `true` |
| `quality_level` | no | `strict` |

| Output | Meaning |
|--------|---------|
| `library_sha` | The skathio/hashira commit this run checked its composite actions out at: the commit this workflow file was called at. |

```yaml
jobs:
  ci:
    uses: skathio/hashira/.github/workflows/static-webapp-ci.yml@v3
```

### pages-site.yml

Builds and deploys a project's GitHub Pages site: the static site (`site_dir` copied as-is, or built by `site_build_command` into `site_output`), the shared site kit in `_kit/` (`site-kit`) and, unless `docs` is false, the docs from `docs/` and `.github/pages.json` in `docs/` (`docs-build`), uploaded with `pages-upload` and deployed with `pages-deploy`. Jobs `check` -> `gate` -> `build` -> `deploy`: `check` refuses any ref but `main` before the approval, `gate` waits for the `production` environment's approval (skipped when `released` is true, which `check` accepts only when this run already holds an approved `production` review), `build` refuses any ref but `main` again and holds only `contents: read`, and `deploy` holds only `pages: write` and `id-token: write` in `github-pages`, one deploy at a time. A released run deploys only while its commit holds the highest `vX.Y.Z` tag. `build` fails when `<site_output>/docs` or `<site_output>/_kit` already exists after the site build.

**Use it directly**: As the job that publishes a project page, called by hand (`workflow_dispatch`) or from a release workflow after its tags with `released: true`. The caller grants `contents: read`, `pages: write` and `id-token: write`. `site_build_command` and `docs_pre_build_command` are trusted input: they run as shell, so never pass them values from PR titles, issue bodies, branch names or other outside context.

| Input | Required | Default |
|-------|----------|---------|
| `released` | no | `false` |
| `site_dir` | no | `site` |
| `site_build_command` | no | `''` |
| `site_output` | no | `''` |
| `docs` | no | `true` |
| `docs_pre_build_command` | no | `''` |
| `node_version` | no | `24` |
| `dotnet_version` | no | `''` |

An empty `site_output` means `site_dir`.

No outputs.

```yaml
jobs:
  site:
    permissions:
      contents: read
      pages: write
      id-token: write
    uses: skathio/hashira/.github/workflows/pages-site.yml@v3
```

## Composite actions

Called as a step with `uses:` inside a job of your own. A composite
action cannot declare permissions: the job that runs it grants them.

### npm-release

Publishes the tarball the same run's CI packed (`npm publish`, auth `oidc`, `token` or `auto`), then creates the `v<version>` tag and GitHub Release.

**Use it directly**: In the gated `publish` job of the npm caller. It must run in a job of your own workflow file, not inside a reusable workflow, so npm trusted publishing sees your `ci.yml`.

| Input | Required | Default |
|-------|----------|---------|
| `version` | yes | — |
| `node_version` | no | `24` |
| `target` | no | `https://registry.npmjs.org` |
| `auth` | no | `auto` |
| `npm_token` | no | `''` |
| `working_directory` | no | `.` |

| Output | Meaning |
|--------|---------|
| `released` | 'true' if a publish was performed this run, else 'false' (dry-run). |
| `version` | The published version (echo of the 'version' input) when released=='true', else empty. |

```yaml
- uses: skathio/hashira/.github/actions/npm-release@v3
  with:
    version: ${{ needs.ci.outputs.resolved_version }}
```

### nuget-push

Pushes a `.nupkg` with `--skip-duplicate` (auth `oidc`, `token` or `auto`), then creates the `v<version>` tag and GitHub Release.

**Use it directly**: In the gated `publish` job of the NuGet caller, after downloading the `nuget-package` artifact. It needs `dotnet` on the path and a checkout of your repository.

| Input | Required | Default |
|-------|----------|---------|
| `nupkg_path` | yes | — |
| `target` | no | `https://api.nuget.org/v3/index.json` |
| `auth` | no | `auto` |
| `api_key` | no | `''` |
| `nuget_user` | no | `''` |
| `version` | yes | — |
| `skip_duplicate` | no | `true` |
| `working_directory` | no | `.` |

No outputs.

```yaml
- uses: skathio/hashira/.github/actions/nuget-push@v3
  with:
    nupkg_path: ${{ runner.temp }}/nupkg/*.nupkg
    version: ${{ needs.ci.outputs.resolved_version }}
```

### pages-deploy

Deploys the same run's `github-pages` artifact to GitHub Pages and writes the page URL to the run summary. It refuses `pull_request` events.

**Use it directly**: In the gated `deploy` job of the static caller, in the `github-pages` Environment, with `pages: write` and `id-token: write`.

| Input | Required | Default |
|-------|----------|---------|
| `artifact_name` | no | `github-pages` |

| Output | Meaning |
|--------|---------|
| `page_url` | URL of the deployed page (passes through from actions/deploy-pages's `page_url` output). |

```yaml
- uses: skathio/hashira/.github/actions/pages-deploy@v3
```

### pages-upload

Packages a static site directory as the `github-pages` artifact, autodetecting `dist/`, `build/`, `out/` or `public/` when no path is given.

**Use it directly**: When you build the site in your own job instead of `static-webapp-ci.yml`, then deploy it with `pages-deploy`. That job needs only `contents: read`: the upload uses the runner's own token, so keep `id-token` and `pages` on the deploy job.

| Input | Required | Default |
|-------|----------|---------|
| `path` | no | `''` |
| `artifact_name` | no | `github-pages` |
| `retention_days` | no | `1` |

| Output | Meaning |
|--------|---------|
| `resolved_path` | The directory that was uploaded (either the explicit `path` input or the autodetected one). |
| `detection_mode` | Either `explicit` (caller-provided path) or `autodetect` (search order matched). |

```yaml
- uses: skathio/hashira/.github/actions/pages-upload@v3
```

### site-kit

Copies the shared site kit into `<dest>/_kit/`: `tokens.css` (the landing pages' colour, type and spacing variables in light and dark, with `--accent` and `--accent-soft` taken from `--site-accent`, and from `--site-accent-dark` in dark mode when set), `theme.js` (the `theme` localStorage key: `light`, `dark` or `auto`, anything else is `auto`; each press goes auto, the opposite of the system theme, the system theme, auto; `data-theme-resolved` on `<html>` names the theme shown) and `site-nav.js` (the `<site-nav>` custom element: brand, `nav` links, Docs, an extras slot, `home_link`, theme toggle). The kit comes from the action's own folder, so it is the kit at the commit your `uses:` ref resolved to. `dest` must be an existing workspace-relative directory without `..` and without a `_kit` in it.

**Use it directly**: After your own site build, before `pages-upload`, so the page can load `_kit/tokens.css`, `_kit/theme.js` (in `<head>`) and `_kit/site-nav.js`.

| Input | Required | Default |
|-------|----------|---------|
| `dest` | yes | — |

| Output | Meaning |
|--------|---------|
| `kit_path` | The directory the kit was copied to (`<dest>/_kit`). |

```yaml
- uses: skathio/hashira/.github/actions/site-kit@v3
  with:
    dest: dist
```

### docs-build

Builds a VitePress docs site from the repo's `docs/**/*.md`, described by `.github/pages.json` (name, base, home page, sidebar, unpublished pages, header links, `accent` and `accent_dark`, logo, `theme_css`). VitePress 1.6.4 and its lockfile live in the action and are installed with `npm ci --ignore-scripts` into `RUNNER_TEMP`, so the repo keeps no docs packages, and the build reads a staged copy of `docs/`, never `docs/` itself. Heading ids follow GitHub's slug rule, a `.md` link opens the published page, a link to an unpublished page or to a folder with no index opens it on GitHub, raw HTML and `${{ }}` render as text, and local search is on. The header's theme control has the same three states as the landing's, on the same `theme` key, and an accent below 4.5:1 against its mode's canvas prints a `::warning`. The sidebar lists `sidebar` in order, then every other page by path under its first H1. A missing or unpublished `sidebar` file, a `docs/index.md` beside the home page, or an `output_dir` that already exists fails the build. Needs Node 20 or later.

**Use it directly**: When your site is built in your own job: run it after the site build and before `pages-upload`, with `output_dir` set to the `docs/` folder of the site you upload. `pre_build_command` is trusted input: it runs as shell, so never pass it values from PR titles, issue bodies, branch names or other outside context.

| Input | Required | Default |
|-------|----------|---------|
| `pre_build_command` | no | `''` |
| `output_dir` | no | `artifacts/pages/docs` |

| Output | Meaning |
|--------|---------|
| `output_dir` | The folder the site was written to (the `output_dir` input). |

```yaml
- uses: skathio/hashira/.github/actions/docs-build@v3
  with:
    output_dir: dist/docs
```

### scan-suite

Runs the security scans (CodeQL, OSV-Scanner, gitleaks, dependency review, actionlint), each one switchable off.

**Use it directly**: In any repository's own workflow, to get the same scans the CI workflows run without the rest of the flow.

| Input | Required | Default |
|-------|----------|---------|
| `scan_disable` | no | `codeql,actionlint` |
| `codeql_languages` | no | `''` |
| `osv_paths` | no | `.` |
| `gitleaks_config` | no | `''` |
| `fail_on_findings` | no | `false` |

| Output | Meaning |
|--------|---------|
| `summary` | Multi-line summary: one '<name>\t<status>\t<details>' line per scan. |
| `verdicts` | One '<name>\t<pass\|fail\|skipped>' line per scanner, in the order the scanners ran. |

```yaml
- uses: skathio/hashira/.github/actions/scan-suite@v3
```

### run-tests-js

Runs a JavaScript test command and checks that it wrote its coverage file at the standard path.

**Use it directly**: In your own job when you want hashira's test and coverage handoff for a JavaScript project outside the npm or static flow.

| Input | Required | Default |
|-------|----------|---------|
| `command` | no | `npm test` |
| `coverage_path` | no | `coverage/lcov.info` |
| `working_directory` | no | `.` |

| Output | Meaning |
|--------|---------|
| `coverage_path` | Absolute path to the coverage file produced by the test command. |

```yaml
- uses: skathio/hashira/.github/actions/run-tests-js@v3
```

### run-tests-dotnet

Runs `dotnet test` with Coverlet and moves the cobertura coverage file to a standard path.

**Use it directly**: In your own job when you want hashira's test and coverage handoff for a .NET project outside the NuGet flow.

| Input | Required | Default |
|-------|----------|---------|
| `command` | no | `dotnet test --collect:"XPlat Code Coverage" --results-directory TestResults` |
| `coverage_path` | no | `coverage/cobertura.xml` |
| `results_directory` | no | `TestResults` |
| `working_directory` | no | `.` |

| Output | Meaning |
|--------|---------|
| `coverage_path` | Absolute path to the standardized cobertura coverage file. |

```yaml
- uses: skathio/hashira/.github/actions/run-tests-dotnet@v3
```

### coverage-report

Parses an lcov, cobertura or opencover report and shows it as a sticky pull request comment, a step summary and an artifact, and outputs the line and branch totals.

**Use it directly**: After your own test step, to report coverage the way the CI workflows do. Needs `pull-requests: write` for the comment; `comment: 'false'` turns the comment off (the CI workflows do, and show the totals in their CI summary comment instead).

| Input | Required | Default |
|-------|----------|---------|
| `coverage_path` | yes | — |
| `format` | no | `''` |
| `artifact_name` | no | `coverage` |
| `artifact_retention_days` | no | `30` |
| `comment` | no | `true` |

| Output | Meaning |
|--------|---------|
| `lines_pct` | Line coverage in percent, one decimal (e.g. `87.5`). |
| `branches_pct` | Branch coverage in percent, one decimal (e.g. `62.0`). |
| `files` | How many source files the report measured. `0` means the report held no coverage data, and the percentages are not a measurement. |

```yaml
- uses: skathio/hashira/.github/actions/coverage-report@v3
  with:
    coverage_path: coverage/lcov.info
```

### quality-gate

Runs SoMi's quality check on what a pull request changes (`quality --scope pr`, against the base) and fails on a violation; outside a pull request it passes with a skip note.

What it does not score is shown, never hidden. The job summary lists files SoMi skipped (generated, minified or in a skipped folder) and every limit a `somi-gate-allow` comment in the change waived, with its reason and expiry; each waived limit is also a warning annotation on its line. Neither fails the gate, so check them in review: an allow comment is written by the pull request's own author.

**Use it directly**: In your own workflow to gate pull requests on SoMi's limits without the rest of a flow. Check the repository out and have `node` on the path first; the base commit is fetched when missing.

| Input | Required | Default |
|-------|----------|---------|
| `level` | no | `strict` |

| Output | Meaning |
|--------|---------|
| `result` | `pass`, `fail` or `skipped` (not a pull_request event). |
| `violations` | The number of violations SoMi reported: an integer, `0` when skipped or when SoMi gave no report. |

```yaml
- uses: skathio/hashira/.github/actions/quality-gate@v3
```

### ci-summary

`ci-summary` judges the results of a CI workflow's jobs for the aggregate `passed` job (the `ci / passed` check), writes one line per job to the job summary, keeps one CI summary comment on the pull request (marker `<!-- hashira:ci-summary -->`, by `github-actions[bot]`, edited in place), and fails when the verdict is failure. A job passes when it succeeded; a skip passes only for `version` with no bump and `quality-gate` with `quality_gate: false`. A fork or Dependabot pull request, or any comment API error, puts the comment body in the job summary instead and never changes the verdict. Called with a `needs` value that holds no job, the action fails: a check that judged nothing is not a pass.

**Use it directly**: As the last job of your own workflow, with `needs` on every other job and `if: always()`, to get one required check and one summary comment. Needs `pull-requests: write` for the comment, and `node` on the path. The comment reads the job outputs the hashira CI workflows set (`lines_pct`, `branches_pct`, `coverage_files`, `verdicts`, `scan_summary`, `result`, `violations`, `commitlint_result`, `commitlint_report`); jobs without them show as not run.

| Input | Required | Default |
|-------|----------|---------|
| `needs` | yes | — |
| `workflow_inputs` | no | `{}` |
| `comment` | no | `true` |

| Output | Meaning |
|--------|---------|
| `conclusion` | `success` or `failure`: the verdict over the needed jobs. |

```yaml
- uses: skathio/hashira/.github/actions/ci-summary@v3
  with:
    needs: ${{ toJSON(needs) }}
    workflow_inputs: ${{ toJSON(inputs) }}
```

### version-resolver

Computes the next release version from the tag history and a bump kind, and outputs it as one bare semver string.

**Use it directly**: In your own release job when you tag releases the way hashira does but publish some other way.

| Input | Required | Default |
|-------|----------|---------|
| `tags` | no | `''` |
| `bump` | yes | — |
| `seed_version` | no | `''` |

| Output | Meaning |
|--------|---------|
| `version` | The resolved, validated bare semver string (e.g. `1.3.0`, no `v` prefix). The action's only output. |

```yaml
- uses: skathio/hashira/.github/actions/version-resolver@v3
  with:
    bump: patch
```

### dotnet-pack-version

Runs `dotnet pack` with MinVer versioning and outputs the version and the `.nupkg` path.

**Use it directly**: In your own job to pack a .NET project with a MinVer-derived version outside the NuGet flow.

| Input | Required | Default |
|-------|----------|---------|
| `project_path` | yes | — |
| `prerelease_identifier` | no | `''` |
| `version_increment` | no | `''` |
| `version_override` | no | `''` |
| `output_directory` | no | `./packages` |
| `working_directory` | no | `.` |

| Output | Meaning |
|--------|---------|
| `version` | Resolved package version (e.g. `1.2.3` or `1.2.3-alpha.0.4`). Empty if pack failed to produce a .nupkg. |
| `nupkg_path` | Path to the first .nupkg produced (relative to working_directory). |

```yaml
- uses: skathio/hashira/.github/actions/dotnet-pack-version@v3
  with:
    project_path: src/MyLib/MyLib.csproj
```
