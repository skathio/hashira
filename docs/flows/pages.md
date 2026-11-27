# Pages site and docs flow — adoption walk-through

> **Audience**: a consumer publishing a project page and its docs to GitHub
> Pages with `skathio/hashira`: a static landing page, the shared header and
> theme of the skathio project pages, and a VitePress docs site built from
> the repo's `docs/`.
> **Scope**: the caller workflow, the `.github/pages.json` schema with its
> limits, defaults and errors, the landing page's site kit, the input and
> output tables of `pages-site.yml`, `docs-build` and `site-kit`, permissions,
> and the trusted-input warning.

For cross-cutting concepts (pin policy, gate model, permissions baseline),
see [`../usage.md`](../usage.md). For a site that a framework builds and
tests on every pull request, see the [static site flow](static-webapp.md).

---

## 1. What you get

`pages-site.yml` builds one GitHub Pages folder and deploys it:

- **The site.** `site_dir` (default `site`) copied as it is, or built by
  `site_build_command` into `site_output`. It is served at
  `https://<owner>.github.io/<repo>/`.
- **The site kit** in `_kit/` of the site (`site-kit`): `tokens.css`,
  `theme.js` and `site-nav.js`, the same files every skathio project page
  loads.
- **The docs** in `docs/` of the site (`docs-build`), unless `docs` is
  `false`: a VitePress site built from the repo's `docs/**/*.md` as they read
  on GitHub (no front matter, no link edits), described by
  `.github/pages.json`. It is served at `https://<owner>.github.io/<repo>/docs/`.

The jobs run `check` -> `source` -> `scan` -> `gate` -> `build` -> `deploy`.
`check` checks the inputs and refuses any ref but `main` before anyone is
asked to approve, `source` picks the commit to build and writes
`deploying <ref>@<sha>, N commits after <tag>` to the step summary, `scan`
runs OSV and gitleaks on that commit (read only, failing on findings by
default), `gate` waits for the `production` environment's approval, `build`
holds only `contents: read` and runs the install, build and test commands,
and `deploy` alone holds `pages: write` and `id-token: write`, in the
`github-pages` environment, one deploy at a time.

### `pages-site.yml` or `static-webapp-ci.yml`

Both publish a static site to GitHub Pages. `pages-site.yml` suits a
project page and its docs that deploy after an approval or a release;
[`static-webapp-ci.yml`](static-webapp.md) suits a framework site whose
tests run on every pull request and that deploys on each push to `main`.

| | `pages-site.yml` | `static-webapp-ci.yml` |
|---|---|---|
| What runs | `check`, `source`, `scan` (OSV and gitleaks), `gate`, `build` (`install_command`, `site_build_command`, `test_command`, then `site-kit`, `docs-build` and `pages-upload`) and `deploy` (`pages-deploy`), all in the one call | `setup`, `build-and-upload` (`npm ci`, `build_command`, `site-kit` with `site_kit: true`, `pages-upload`), `test` (`test_command`, coverage), `scan-suite` (OSV, gitleaks, actionlint, dependency-review, CodeQL when enabled), `quality-gate` and `passed`; the deploy is the caller's own `deploy` job running `pages-deploy` |
| Events | `workflow_dispatch` (waits at `gate`), a `workflow_call` from a release with `released: true`, `push` to `main` with `approval: merge`; `pull_request` and any other ref only with `deploy: false` (build, no deploy) | `pull_request` (CI only; `pages-deploy` refuses it), `push` to `main` and `workflow_dispatch` (CI, then the caller's `deploy` job) |
| Caller grants | `contents: read`, `pages: write`, `id-token: write`, with `deploy: false` too (GitHub checks the grants of every job of a called workflow before the run starts, the skipped `deploy` included) | `ci` job: `contents: read`, `pull-requests: write`, `security-events: write`, no `id-token`; `deploy` job: `pages: write`, `id-token: write` |
| Where the build runs | `build`, with `contents: read` only | `build-and-upload`, with `contents: read` only |
| Approval | the `production` environment at `gate`, or the release's own approval | the `github-pages` environment's reviewers, on the caller's `deploy` job |

## 2. Caller workflow

Before the first run, create the repo's environments under **Settings ->
Environments**:

- **`production`** with at least one **required reviewer**. `gate` waits
  for this environment's approval; without a required reviewer, GitHub
  creates the environment on the first run with no protection, and `gate`
  passes without anyone approving.
- **`github-pages`** with a deployment branch policy that allows `main`
  only, so no other branch can deploy, whatever the workflow says.

A project page that deploys after an approved hand run:

```yaml
name: site

on:
  workflow_dispatch:

permissions: {}

jobs:
  site:
    permissions:
      contents: read   # build: checkout
      pages: write     # deploy: deploy-pages
      id-token: write  # deploy: deploy-pages authenticates via OIDC
    uses: skathio/hashira/.github/workflows/pages-site.yml@v3
```

From a release workflow, call it after the release's tags are pushed with
`released: true`. The release job's own approval then stands for this one:
`gate` is skipped, and `deploy` deploys only while the commit holds the
highest `vX.Y.Z` tag, so re-running an old release never puts an older site
over a newer one. `deploy` reads the tags with an unauthenticated
`git ls-remote` and holds no `contents` grant, so `released: true` works for a
public repo only: in a private repo, `deploy` fails rather than deploy.

`pages-site.yml` enforces the approval itself: its `check` job, which holds
no grant, reads this run's approvals
(`GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals`; a called
workflow runs in its caller's run) and refuses `released: true` unless one
of them approved the `production` environment. It fails closed: no such
approval, or approvals the API will not give, stop the run before anything
is built or deployed. So callers no longer need their own guard, such as a
`github.workflow_ref` check, against a dispatcher who sets `released`: a
`workflow_dispatch` input forwarded as `released` cannot skip the approval.
The release job that passes `production` must run in the same workflow run,
before the call.

```yaml
  site:
    needs: publish
    permissions:
      contents: read
      pages: write
      id-token: write
    uses: skathio/hashira/.github/workflows/pages-site.yml@v3
    with:
      released: true
```

One `site.yml` that serves both: run by hand it waits at `gate`, and called
from the release workflow after its approved `publish` job it deploys with
no second approval. It forwards `released` as it is, with no guard of its
own: a hand run that sets `released` has no `production` approval in its
run, so `check` refuses it.

```yaml
name: site

on:
  workflow_dispatch:
    inputs:
      released:
        description: "Leave unchecked; a hand run waits for the production approval."
        type: boolean
        default: false
  workflow_call:
    inputs:
      released:
        type: boolean
        default: false

permissions: {}

jobs:
  site:
    permissions:
      contents: read   # build: checkout
      pages: write     # deploy: deploy-pages
      id-token: write  # deploy: deploy-pages authenticates via OIDC
    uses: skathio/hashira/.github/workflows/pages-site.yml@v3
    with:
      released: ${{ inputs.released }}
```

The release workflow calls it with `uses: ./.github/workflows/site.yml`,
`needs:` its `publish` job (in the `production` environment) and
`released: true`.

### Approval on merge

`approval: merge` deploys `main` with no `gate`, so a merged pull request is
the approval: set it when every change reaches `main` through reviewed pull
requests and you want each merge live without a second click. It skips
`gate` only on `push`, `schedule` and `repository_dispatch` runs of
`refs/heads/main`, events that start from what is already on `main`. A
`workflow_dispatch` run, which anyone with write access can start on any
commit of `main`, still waits at `gate`, as does every other event, and an
unknown `approval` value is refused. The trade-off: with `merge`, whoever
can merge to `main` (or push to it, if branch protection allows) can
deploy, and the `production` reviewers no longer see each deploy. The
`scan` job and the `github-pages` environment's branch policy still apply.

```yaml
on:
  push:
    branches: [main]

jobs:
  site:
    permissions:
      contents: read
      pages: write
      id-token: write
    uses: skathio/hashira/.github/workflows/pages-site.yml@v3
    with:
      approval: merge
```

### Build only, in pull requests and release pre-checks

`deploy: false` runs `check`, `source`, `scan` and `build` on any ref and
event, pull requests included: there is no main-only check, no `gate` and
no deploy. The build adds the kit and the docs, checks the kit references
and uploads the artifact, so a pull request sees the same build, scan and
checks the deploy will run:

```yaml
on:
  pull_request:

jobs:
  site:
    permissions:
      contents: read
      pages: write    # for the skipped deploy job
      id-token: write # for the skipped deploy job
    uses: skathio/hashira/.github/workflows/pages-site.yml@v3
    with:
      deploy: false
```

The caller's job still names all three grants. GitHub checks, before a run
starts, that the calling job grants what every job of the called workflow
asks for, the skipped `deploy` job included, and refuses the run otherwise
("The nested job 'deploy' is requesting ..."). The grants go no further
than that check: `build`, the one job that runs the pull request's
commands, declares `contents: read` and gets nothing else, and no job that
holds `pages` or `id-token` runs. A pull request from a fork or from
Dependabot gets a read-only token whatever the caller declares, so GitHub
may refuse to start such a run; for those, build with `site-kit`,
`docs-build` and `pages-upload` in a job of your own
([Your own build](#your-own-build)).

A release can build once and deploy that artifact after its approval: a
`deploy: false` call before the release job builds, checks and uploads the
site, and a second call with `prebuilt: true` after it deploys the
artifact named `artifact_name` from the same run, without building again
(`site-kit`, `docs-build` and `pages-upload` do not run). Give the two
calls the same `artifact_name`, and make the second call wait for the first
through `needs:`:

```yaml
jobs:
  site-check:
    permissions:
      contents: read
      pages: write    # for the skipped deploy job
      id-token: write # for the skipped deploy job
    uses: skathio/hashira/.github/workflows/pages-site.yml@v3
    with:
      deploy: false
      artifact_name: site
  publish:
    needs: site-check
    environment: production
    # ... tags and the release
  site:
    needs: publish
    permissions:
      contents: read
      pages: write
      id-token: write
    uses: skathio/hashira/.github/workflows/pages-site.yml@v3
    with:
      released: true
      prebuilt: true
      artifact_name: site
```

### What is built

`source: main` (the default) builds the run's own commit. `source:
latest-release` builds the tree of the highest `vX.Y.Z` tag (pre-releases
and other tags never count) while the workflow runs from `main`, so a page
fix merged to `main` waits for the next release; with no such tag, nothing
is built or deployed. That tag's commit must be on `main`: a tag pushed onto
a side branch fails the run instead of being built. Either way `source` writes
`deploying <ref>@<sha>, N commits after <tag>` to the run's summary, and
`scan`, `build` and the released tag check all use that commit. A
`deploy: false` run writes the same text after `build only (deploy: false),
not`, and a repo with no `vX.Y.Z` tag gets `no vX.Y.Z tag yet` in place of
the count.

`install_command` runs before `site_build_command`, and `test_command` after
it, before the kit and the docs are added; a non-zero exit of either fails
the build. `coverage_path` names the coverage file `test_command` writes,
which coverage-report adds to the build's summary.

A build that needs a token, such as one that reads a private package, gets
it through the opt-in `build_token` secret, which pages-site exposes as
`BUILD_TOKEN` to the `site_build_command` step only, not to
`install_command`, `test_command` or the docs build:

```yaml
    uses: skathio/hashira/.github/workflows/pages-site.yml@v3
    with:
      site_build_command: npm run build
    secrets:
      build_token: ${{ secrets.PACKAGES_TOKEN }}
```

Pass it only to a build you trust with it. `install_command` runs earlier in
the same job and can change what the later steps run (through `GITHUB_ENV` or
files on disk), so it, and the install scripts of the packages it installs,
are trusted with the token too. With `deploy: false` on a pull request, the
token reaches that pull request's build.

### Your own build

When `pages-site.yml` does not fit your build, keep your own job and add
hashira's pieces to it: [`templates/pages/own-build.yml`](../../templates/pages/own-build.yml)
builds the site, adds the kit with `site-kit` (and the docs with
`docs-build`), uploads with `pages-upload` and deploys with `pages-deploy`
in the `github-pages` environment. You then own what `pages-site.yml` does
for you: the main-only check, the approval, the scan and the kit-reference
check.

Pin `@v3` for the rolling major or a full 40-character commit SHA for a
reproducible build. The kit and docs-build come from the same commit as the
workflow: `pages-site.yml` checks hashira out at `job.workflow_sha`.

## 3. `.github/pages.json`

`docs-build` reads `.github/pages.json` from the repo root. Every field is
optional, so `{}` is a valid file. Nothing in it reaches a shell: it is data
a pull request can edit, checked before anything is installed.

| Field | Type | Limit | Default |
|-------|------|-------|---------|
| `name` | string | 1 to 40 characters | `name` of `.github/homepage.json`, else the repo name |
| `$schema` | string | 1 to 2048 characters | none: read by editors only |
| `description` | string | at most 200 characters | `Guides for <name>`, also when `''` |
| `base` | string | at most 100 characters, starts and ends with `/`, letters, digits and `. _ ~ % -` between single `/`s | `/<repo>/docs/` |
| `home_page` | `.md` path under `docs/` | must exist | `getting-started.md` |
| `sidebar` | list of pages `{ "file", "label" }`, groups `{ "label", "items", "collapsed" }` and folder sections `{ "label", "dir", "collapsed" }` | at most 100 entries in each list, groups nested at most 3 deep, `file` a `.md` path under `docs/`, `dir` a folder path under `docs/`, `label` 1 to 60 characters, `collapsed` a boolean | `[]` |
| `unpublished` | list of paths under `docs/` | at most 100 entries | `[]` |
| `nav` | list of `{ "label", "href" }` | at most 8 entries, `label` 1 to 30 characters | `[]` |
| `home_link` | `{ "label", "href" }` | `label` 1 to 30 characters | none |
| `accent` | `#rgb` or `#rrggbb` | — | `colour` of `.github/homepage.json`, else `#1e7d69` |
| `accent_dark` | `#rgb` or `#rrggbb` | — | none: `accent` in dark mode too |
| `logo` | repo-relative `.svg` or `.png` | must exist | `image` of `.github/homepage.json`, else none |
| `theme_css` | repo-relative `.css` | must exist | none |

The file may name its JSON Schema, which hashira publishes next to the
action, so an editor checks it as you type. The schema gives the same verdict
as the build on every field and limit; only the checks that need the repo
(a named file exists, stays in the repo, is not both in `sidebar` and
`unpublished`) are the build's alone:

```json
{ "$schema": "https://raw.githubusercontent.com/skathio/hashira/v3/.github/actions/docs-build/pages.schema.json" }
```

The file itself may be at most 64 KB. An unknown field fails, at the top
level and inside a `sidebar` entry (a group's or a folder section's too), a
`nav` entry or `home_link`.

- **`name`** is the docs' site title and the brand of the header.
- **`description`** is each page's `<meta name="description">` and
  `og:description`. Left out or empty, it is `Guides for <name>`. Each page
  also gets `og:title` (its first heading and `name`), `og:url` and a
  canonical link, both the page's GitHub Pages address,
  `https://<owner>.github.io<base><page>`. With a custom domain, GitHub
  Pages redirects that address to it. A build that cannot tell the owner
  (a local build with no `GITHUB_REPOSITORY` and no github.com `origin`)
  leaves out `og:url` and the canonical link.
- **`base`** is where the docs are served. The landing is the folder above
  it: `/<repo>/` for the default `/<repo>/docs/`.
- **`home_page`** opens at the docs base. It is published as the docs'
  `index.html`, so a `docs/index.md` next to it fails the build.
- **`sidebar`** lists pages in order with a short label. An entry is one of
  three shapes, and one entry mixing them (a `file` with `items`, say) fails:
  - a page, `{ "file": "guide.md", "label": "Guide" }`;
  - a group, `{ "label": "Flows", "items": [ ... ], "collapsed": false }`,
    whose `items` are entries of any shape. Groups nest up to 3 levels, and a
    group needs at least one item;
  - a folder section, `{ "label": "API", "dir": "api/", "collapsed": true }`,
    which lists the published pages under `docs/api/` (sub-folders included)
    in path order, each under its first H1. It also takes the pages
    `pre_build_command` writes there, and leaves out a page the sidebar
    already lists as a page or in an earlier folder section. A folder section
    with no page left to list fails the build.

  `collapsed` left out gives a group that is always open; `false` one that
  opens and can be folded; `true` one that starts folded. Every other
  published page follows the sidebar, by path, under its first H1, so each
  page is listed once. A `sidebar` file that is missing, or also in
  `unpublished`, fails the build. A `pre_build_command` may write a generated
  sidebar instead (see "API reference with docfx or typedoc" below).
- **`unpublished`** names pages, or folders (`internal` or `internal/`),
  that get no page and no search entry. A link to one opens it on GitHub.
- **`nav`** and **`home_link`** are the header links, shown on the docs and
  read by the landing's `<site-nav>`. An `href` starts with `https://`,
  `http://`, `/`, `./`, `../` or `#`, and holds no backslash or control
  character; a docs header resolves it against the
  landing, so `#flows` opens the landing's `flows` section.
- **The docs header's width budget.** VitePress shows its header links one by
  one from 768px up and folds them into its menu only below that, so a long
  row would scroll the page sideways at tablet widths. With up to 2 `nav`
  entries the header holds them, Docs and `home_link` one by one, as before.
  With 3 or more it holds one dropdown labelled with `name`, which lists the
  `nav` entries, followed by Docs and `home_link`; a long `name` is cut
  short with an ellipsis in the dropdown's button. Docs is marked as the
  current section on every docs page. Keep `name` short, since the site title
  shows it in full: with 8 `nav` entries the header fits from 768px up with a
  `name` of up to about 20 characters and a short `home_link` label, such as
  `← skathio`. With 2 entries or fewer, the labels in the row count as well. The landing's `<site-nav>` folds its links into a
  menu of its own when they do not fit.
- **`accent`** is the brand colour in light mode, and **`accent_dark`** the
  one in dark mode. The default `#1e7d69` with no `accent_dark` keeps
  hashira's own pair: the darker green in light mode, a lighter one
  (`#4fd1b5`) in dark mode. Another `accent` with no `accent_dark` is used in
  both modes. Each mode's hover and soft shades are mixed from that mode's
  colour. Links are text in the accent, so the build prints a `::warning`
  (and still succeeds) when a mode's link colour has less than 4.5:1
  contrast against that mode's canvas (`#f7f6f2` light, `#101216` dark):
  pick a darker `accent` or a lighter `accent_dark`. Give `<site-nav>` the
  same pair as `accent` and `accent_dark`.
- **`logo`** is copied into the docs and shown as the logo and the favicon.
- **`theme_css`** is published as it is, as `site-theme.css` at the docs
  base, and loaded after the shared theme, so its rules win. The build does
  not read its `url()` or `@import` paths: the browser resolves them against
  the published docs, so a relative path must name a published file, such as
  one in `docs/public/`.

Paths are relative to the repo (`logo`, `theme_css`) or to `docs/`
(`home_page`, `sidebar` files and `dir`s, `unpublished`): no leading `/`, no
`..` segment, no `.` or empty segment (`./a.md`, `a//b.md`), no backslash,
and no symlink that leaves the repo. A folder in `unpublished`, or a `dir`,
may end in one `/`.

Hashira's own file, for reference:

```json
{
  "name": "hashira",
  "base": "/hashira/docs/",
  "home_page": "getting-started.md",
  "sidebar": [{ "file": "getting-started.md", "label": "Getting started" }],
  "unpublished": ["contributing.md"],
  "nav": [{ "label": "Flows", "href": "#flows" }],
  "home_link": { "label": "← skathio", "href": "https://skathio.github.io/" },
  "accent": "#1e7d69",
  "logo": "site/mark.svg"
}
```

### API reference with docfx or typedoc

A generated API reference has a page per type, too many to list by hand and
renamed with the code. Two ways keep the sidebar in step with it:

- **A folder section.** Have `pre_build_command` write the Markdown into the
  stage, and list the folder in `pages.json`:

  ```yaml
  # in the caller of pages-site.yml (or docs-build)
  pre_build_command: ./scripts/api-docs.sh   # e.g. typedoc --plugin typedoc-plugin-markdown --out "$DOCS_STAGE/api"
  ```

  ```json
  { "sidebar": [{ "file": "getting-started.md", "label": "Getting started" },
                { "label": "API", "dir": "api/", "collapsed": true }] }
  ```

  Each generated page is listed under its first H1, in path order.

- **A generated sidebar.** When the tool also knows the grouping (namespaces,
  modules), `pre_build_command` may write the whole sidebar to
  `$DOCS_STAGE/.sidebar.json`: a JSON array of entries in the same shape as
  `pages.json`'s `sidebar`. When the file is there it replaces `pages.json`'s
  `sidebar`. It is data, not code: it is checked with the same rules and
  limits (64 KB, 100 entries in each list, 3 levels, the unknown-field rule),
  its errors name `DOCS_STAGE/.sidebar.json`, every page it names must be in
  the stage after `pre_build_command`, it must be a regular file (not a
  symlink), and it is never published. Only `pre_build_command` can write it:
  a `docs/.sidebar.json` in the repo is not staged, so a pull request that
  edits data files cannot set it. A docfx build, for example, can convert its
  `toc.yml` into this file with a short script.

Keep the generating commands in a script of the repo, so a local build runs
the same steps.

### Local preview

`lib/cli.js` is the entry point `docs-build`'s `action.yml` runs, so a local
check or build is the one CI runs. From the repo root, with hashira checked
out next to it (or at a ref of your choice, in any folder):

```sh
# Check .github/pages.json and the files under docs/: no install, nothing written.
node ../hashira/.github/actions/docs-build/lib/cli.js --check
# Build the docs as CI does into a new folder (npm, and network once, needed).
node ../hashira/.github/actions/docs-build/lib/cli.js --out preview/docs --pre-build ./scripts/api-docs.sh
```

`--out` takes a repo-relative folder that must not exist yet, as
`output_dir` does, and `--pre-build` is `pre_build_command`. The page URLs
come from `GITHUB_REPOSITORY` (`owner/name`) when it is set, else from the
GitHub repo of the `origin` remote. To preview the landing too, copy the kit
at a ref into the site's `_kit/` with one command, then serve the folder
above `docs/` (`site/` must not keep `_kit/`, so add it to `.gitignore`):

```sh
REF=v3.4.0; mkdir -p site/_kit && curl -fsSL "https://codeload.github.com/skathio/hashira/tar.gz/${REF}" | tar -xz -C site/_kit --strip-components=5 "hashira-${REF#v}/.github/actions/site-kit/kit"
```

### How the docs read

The pages are the `docs/` files as GitHub renders them. Heading ids follow
GitHub's rule, so a link's `#anchor` lands on the site as it does on
GitHub. An in-page `#anchor` that matches no id on its page gives a
`::warning::` naming the page and the anchor; the build goes on. A link to another published page opens that page; a link that
leaves `docs/`, or reaches an unpublished page or a folder with no index
page, opens the file on GitHub, at `HEAD`. A link to a folder of the repo,
such as `../templates` or `../tests/`, opens it as a folder (`tree/HEAD/...`):
the build looks the path up in the checkout, so the link needs no trailing
`/`, and one that ends in `/` always opens as a folder. Raw HTML, `{attr="..."}` blocks and
`${{ }}` render as text, and front matter adds nothing to the page: a
page's title is its first heading. Only YAML front matter is read: a page
whose opening `---` names another language, such as `---js`, fails the
build. A `<<< file` line renders as text, and a
page holding a VitePress `@include` comment fails the build, because both
would read files from outside the docs. Nothing on a page is compiled as a
Vue template, `-vue` fences and code-group titles included, and a fence's
language, a code-group title and the title of a `> [!NOTE]` alert are shown
as text. Each page as Markdown renders it may hold only the tags Markdown
writes, with every tag closed, and each built page is then
checked: it may hold only the scripts, stylesheets and images VitePress
writes under `base`, images from the web, and no event handler, frame, form
or `javascript:` link. A page that holds more fails the build. An image is a
`https://` or `http://` URL, or a path to a file in the docs (`img/a.png`, or
`/a.png` for a file in `docs/public/`) with no `?` query: any other image
fails the build. An image in a container's title (`::: tip ![x](...)`) must
be a URL or such a `/` path, since the title has no page to resolve a
relative path against. A symlink under `docs/` may not point into `.git`, another dot
folder or `node_modules`. `docs/` may hold only Markdown pages and static
files (images, fonts, PDF, text and CSV), with no `[` or `]` in a name:
VitePress runs code it finds beside the pages, so any other file fails the
build, before it starts and again after `pre_build_command`. `docs/public/`
is for files served as they are, so a `.md` there fails too.
An SVG under `docs/`, `docs/public/` included, or written there by
`pre_build_command` fails the build, naming the file, when it holds a
`<script>` element, an `on*` event handler, a `javascript:` URL, an
`<!ENTITY>` declaration (or a `<!DOCTYPE>` with an internal subset), an
`<?xml-stylesheet?>` instruction or XSLT, an `<iframe>`, `<embed>` or
`<object>` element, or a `srcdoc` attribute: a browser that opens the
file on its own would run it with the docs' origin. A plain `<!DOCTYPE>`
and a `<foreignObject>`, as editors export them, are allowed, and what a
`<foreignObject>` holds is checked like the rest of the file. Images
may be PNG, JPEG, GIF, WebP, AVIF, SVG, ICO or BMP, inlined or as files.
Local search is on, and VitePress's dead-link check fails the build on a
link to a page that does not exist. The docs and the landing share one
theme choice: the `theme` key in `localStorage`. Both have the same
three-state control. Each press goes from auto to the theme the system does
not show, then to the system's own theme, then back to auto. So the first
press always changes what the page shows. In auto the page follows the
system theme as it changes.

A repo moving here from a VitePress config of its own should read
"Migrating from your own VitePress config" (section 9) first: heading ids,
and so `#anchors`, can change.

## 4. The landing page and the site kit

`site-kit` copies three files into `_kit/` of the built site. Load them
from the landing page:

```html
<link rel="stylesheet" href="_kit/tokens.css">
<script src="_kit/theme.js"></script>
<script src="_kit/site-nav.js" defer></script>
```

- **`tokens.css`**: the colour, type and spacing variables in light, system
  dark and forced dark. Set `--site-accent` (and `--site-accent-dark`) on
  `:root` for another accent. `<site-nav>` sets both from its `accent` and
  `accent_dark`.
- **`theme.js`**: auto, light or dark under the `theme` key, with the cycle
  in section 3. It sets `data-theme="light|dark"` on `<html>` for a choice
  (none in auto) and `data-theme-resolved="light|dark"` for the theme the
  page shows, which follows `prefers-color-scheme` while in auto. Style on
  `data-theme-resolved` when a rule needs the shown theme; the docs pages
  set the same attribute, next to VitePress's `dark` class. Load it in
  `<head>` with no `defer`, `async` or `type=module`, so a stored choice
  applies before first paint.
- **`site-nav.js`**: the `<site-nav>` header. Give it the same `name`, `nav`
  and `home_link` as `pages.json`, and `docs="docs/"` for the Docs link. The
  recommended markup makes the element itself the navigation landmark, so it
  renders no second one inside:

```html
<site-nav role="navigation" aria-label="Site" name="hashira" logo="mark.svg" docs="docs/">
  <script type="application/json">{"nav":[{"label":"Flows","href":"#flows"}],"home_link":{"label":"← skathio","href":"https://skathio.github.io/"}}</script>
</site-nav>
```

The brand stays on the left, and Docs, the extras, `home_link` and the theme
toggle stay on the right at every width. When the `nav` links do not fit the
element's own width, and always when the element is narrower than 640px, they
fold behind a menu button (`aria-expanded`; Escape closes it). The page's own
children of `<site-nav>` are extras, shown at every width, except two named
slots: a `slot="brand"` child replaces the logo and name inside the brand
link, and a `slot="fallback"` child shows only until `site-nav.js` defines the
element (`tokens.css` reserves the bar's height until then). A nav or Docs
link to the current page gets `aria-current="page"`; add the `scrollspy`
attribute to mark the `#section` link in view with `aria-current="location"`.
After its first render the element sets a `ready` attribute and fires
`site-nav:ready`, which screenshot tools can wait on.

The site must not hold a `_kit` or a `docs` folder of its own: the build
fails rather than write over either.

An org-root site, the `<owner>.github.io` repo served at `/`, must reserve
`_kit` at its root: no page, route or folder of its own named `_kit`, and
no project repo named `_kit` with Pages on, since GitHub serves that repo at
`/_kit/` too. The folder name is fixed: `site-kit` has no input to change it.

### The `<site-nav>` reference

**Kit paths.** Each page loads the kit relative to itself. From the root
page, `index.html`:

```html
<link rel="stylesheet" href="_kit/tokens.css">
<script src="_kit/theme.js"></script>
<script src="_kit/site-nav.js" defer></script>
<site-nav role="navigation" aria-label="Site" name="hashira" logo="mark.svg" docs="docs/"></site-nav>
```

From a sub-page, such as `guides/index.html`, go one folder up for the kit,
the logo, the brand link (`root`) and Docs:

```html
<link rel="stylesheet" href="../_kit/tokens.css">
<script src="../_kit/theme.js"></script>
<script src="../_kit/site-nav.js" defer></script>
<site-nav role="navigation" aria-label="Site" name="hashira" logo="../mark.svg" root="../" docs="../docs/"></site-nav>
```

`pages-site.yml`'s build fails when a page names a `_kit/` file that
`site-kit` does not ship.

**Attributes.** Each attribute has a field of the same name in the JSON
child and the `config` property:

| Attribute | Value | Default |
|-----------|-------|---------|
| `name` | the brand's text | `''` |
| `logo` | the brand's image URL, `http(s)` or relative | none |
| `root` | the brand link's href | `./` |
| `docs` | the Docs link's href; empty, or `true` in the JSON child or `config`, means `docs/` | no Docs link |
| `nav` | JSON list of `{ "label", "href" }`, as in `pages.json` | `[]` |
| `home_link` | JSON `{ "label", "href" }`, as in `pages.json` | none |
| `accent` | `#rgb` or `#rrggbb`, the light-mode accent; sets `--site-accent` on `<html>` | `tokens.css`'s green |
| `accent_dark` | `#rgb` or `#rrggbb`, the dark-mode accent; sets `--site-accent-dark` on `<html>` | `accent` |
| `scrollspy` | present or absent (attribute only) | absent |

The element also sets a `ready` attribute itself, after its first render.
An `href` or `logo` with a scheme other than `http(s)` is dropped, and every
label is set as text, never as markup.

**Where the values come from.** Three sources, merged field by field:
attributes win over the `config` property (an object, which a framework such
as React 19 sets directly), and the property wins over an inline
`<script type="application/json">` child holding the same field names. A
field left out of a higher source keeps the lower one's value, so a static
page can keep `nav` in the JSON child and set `name` as an attribute. A
`config` set before `site-nav.js` loads is picked up when the element is
defined.

**Slots.** The element's own children are extras, shown at every width in
the right group, after Docs. Two named slots change that: a `slot="brand"`
child replaces the logo and name inside the brand link (the link and its
`root` href stay the kit's), and a `slot="fallback"` child shows only until
`site-nav.js` defines the element, and is never slotted after. Give the
fallback a plain link to the site root, so the page has a way home if the
script fails to load.

```html
<site-nav role="navigation" aria-label="Site" docs="docs/">
  <span slot="brand"><img src="mark.svg" alt="" width="24" height="24"> hashira <small>v3</small></span>
  <a slot="fallback" href="./">hashira</a>
  <a href="https://github.com/skathio/hashira">GitHub</a>
</site-nav>
```

**Parts.** Style the shadow DOM through these parts, from the page's own
stylesheet: `brand` (the brand link), `menu` (the menu button), `link` (each
`nav` link), `docs` (the Docs link), `home` (the `home_link`), `toggle` (the
theme toggle) and `bar` (the row that holds them all).

```css
site-nav::part(docs) { border-radius: 6px; }
site-nav::part(link):hover { text-decoration: underline; }
```

**CSS variables.** The bar reads `--nav-gap` (space between items),
`--nav-pad` (the bar's padding) and `--nav-h` (its minimum height) from
`tokens.css`, which also sets smaller values on phones; set them on
`site-nav` or `:root` to change them. It reads the theme's `--canvas`,
`--ink`, `--muted`, `--line`, `--accent` and `--accent-soft`, and from
`accent` and `accent_dark` it sets `--site-accent` and `--site-accent-dark`
on `<html>`, from which `tokens.css` derives `--accent` in each mode.

**Accessibility.** The recommended markup,
`<site-nav role="navigation" aria-label="Site">`, makes the element itself
the navigation landmark, so it renders a plain bar inside. Without
`role="navigation"` it renders its own `<nav aria-label="Site">`, so a page
never gets two. When the links fold, the menu button (labelled "Menu") is a
disclosure: `aria-expanded` says whether it is open, Enter and Space toggle
it, Escape closes it and returns focus to the button, and a click outside
the element or on a link closes it. Every item is a link or a button in
tab order, with a visible `:focus-visible` outline. A link to the current
page gets `aria-current="page"`, and with `scrollspy` the `#section` link
of the section in view gets `aria-current="location"`; both are styled in
the accent. The theme toggle's `aria-label` is `Theme: <choice>`.

**The theme API.** `theme.js` sets `window.siteTheme`, which `<site-nav>`
uses for its toggle and a page may use too: `get()` gives the choice
(`auto`, `light` or `dark`), `set(value)` stores and applies one, `next()`
steps the cycle, `label(value)`, `word(value)` and `icon(value)` give the
toggle's texts and its fixed SVG, and `wire(button)` turns a button of the
page into a toggle. After each change it fires `site-theme` on `document`,
with the choice in `event.detail.theme`. A page without `<site-nav>` can
use the `#theme` hook instead: theme.js wires a `<button id="theme">` up as
a toggle when the page loads, and shows it if it was `hidden`.

**Versioning.** The `<site-nav>` public API is covered by semver
(semantic versioning): its slots (the default slot, `brand` and `fallback`), its parts,
its attributes and the `config` property, the `ready` attribute and the
`site-nav:ready` event, the CSS variables above, `window.siteTheme` and the
`theme` storage key. So is the bar's box: sticky at the top, its height
(`--nav-h`), its padding (`--nav-pad`) and its bottom line, which
`site-nav:not(:defined)` in `tokens.css` reserves. Within v3 these change
only by addition; a rename, a removal or another bar box waits for v4.
Colours, spacing between items and the width at which the links fold may
change in a minor release.

`@v3` gives each v3 release's kit as soon as the `v3` tag moves. To hold the
kit still, pin `pages-site.yml` (or `site-kit`) to a full 40-character
commit SHA: the kit is copied from that commit byte for byte, and changes
only when you move the pin.

## 5. Inputs and outputs

### `pages-site.yml` inputs

| Input | Type | Default | Meaning |
|-------|------|---------|---------|
| `released` | boolean | `false` | `true` only from a release job that already passed the approval: skips `gate`; `deploy` then deploys only while the commit holds the highest `vX.Y.Z` tag. |
| `site_dir` | string | `site` | Repo-relative folder holding the static site. |
| `site_build_command` | string | `''` | Shell command that builds the site into `site_output`, run from the repo root. Empty copies `site_dir` as it is. Trusted input. |
| `site_output` | string | `''` | Repo-relative folder the built site is in. Empty means `site_dir`. |
| `docs` | boolean | `true` | Build the docs into `<site_output>/docs`. |
| `docs_pre_build_command` | string | `''` | Shell command run before VitePress, with `DOCS_STAGE` set to the staged docs folder. Trusted input. |
| `node_version` | string | `24` | Node version for `setup-node`. |
| `dotnet_version` | string | `''` | .NET SDK version, for a build that needs it. Empty installs none. |
| `install_command` | string | `''` | Shell command run from the repo root before `site_build_command`, such as `npm ci`. Trusted input. |
| `test_command` | string | `''` | Shell command run after `site_build_command`, before the kit and the docs are added. A non-zero exit fails the build. Trusted input. |
| `coverage_path` | string | `''` | Coverage file `test_command` writes, added to the build's summary by coverage-report. Empty reports none. |
| `deploy` | boolean | `true` | `false` builds, checks and uploads on any ref and event, pull requests included, with no main-only check, no `gate` and no deploy. |
| `prebuilt` | boolean | `false` | Deploy the `artifact_name` artifact an earlier job of the run uploaded, without building. Needs `deploy: true`. |
| `artifact_name` | string | `github-pages` | Name of the Pages artifact the build uploads and the deploy deploys. |
| `approval` | string | `environment` | `environment` waits for `production` at `gate`; `merge` deploys `main` with no `gate` on push, schedule and repository_dispatch runs only. |
| `source` | string | `main` | `main` builds the run's commit; `latest-release` builds the highest `vX.Y.Z` tag's tree. |
| `scan_disable` | string | `codeql,dependency-review,actionlint` | Comma-separated scan-suite scans the `scan` job skips. CodeQL never runs there: it needs `security-events: write`. |
| `scan_fail_on_findings` | boolean | `true` | Fail `scan`, before `gate`, on findings or a scanner error. `false` reports them and goes on. |

`pages-site.yml` has no outputs. It takes one optional secret, `build_token`,
exposed as `BUILD_TOKEN` to the `site_build_command` step only.

### `docs-build` inputs and outputs

| Input | Default | Meaning |
|-------|---------|---------|
| `pre_build_command` | `''` | Shell command run from the repo root before VitePress, with `DOCS_STAGE` set to the staged docs folder; Markdown it writes there is published. Trusted input. |
| `output_dir` | `artifacts/pages/docs` | Repo-relative folder the docs are written to. It must not exist yet. |

| Output | Meaning |
|--------|---------|
| `output_dir` | The folder the docs were written to. |

### `site-kit` inputs and outputs

| Input | Default | Meaning |
|-------|---------|---------|
| `dest` | required | Workspace-relative folder of the built site. The kit lands in `<dest>/_kit/`. |

| Output | Meaning |
|--------|---------|
| `kit_path` | The folder the kit was copied to (`<dest>/_kit`). |

### On their own

Build the site in a job of your own, then add the kit and the docs before
the upload (the whole workflow is
[`templates/pages/own-build.yml`](../../templates/pages/own-build.yml)):

```yaml
      - uses: skathio/hashira/.github/actions/site-kit@v3
        with:
          dest: dist
      - uses: skathio/hashira/.github/actions/docs-build@v3
        with:
          output_dir: dist/docs
      - uses: skathio/hashira/.github/actions/pages-upload@v3
        with:
          path: dist
```

`docs-build` needs Node 20 or later on the runner.

## 6. Permissions

| Job | Grants | Why |
|-----|--------|-----|
| `check`, `gate` | none | They only read the inputs and `github.ref`, and wait for the approval. |
| `source` | `contents: read` | A full-history checkout, for the tags and the commits since the latest one. |
| `scan` | `contents: read` | Checkout of the commit being deployed, which OSV and gitleaks read. |
| `build` | `contents: read` | Checkout. It runs the build commands and npm packages, so it holds nothing else. |
| `deploy` | `pages: write`, `id-token: write` | `actions/deploy-pages` and its OIDC token. |

The caller's job grants all three; a called workflow's jobs get no more.

`deploy` runs `pages-deploy` from a SHA pin of its own, not from the commit
the workflow was called at: it holds no `contents` grant, so it cannot
check hashira out at `job.workflow_sha` as the other jobs do, and a `uses:`
ref cannot be an expression. The pin names a hashira release commit with
its tag as the comment (today `@2c8d5252...  # v3.0.0`), so `pages-deploy`
stays on that release while the rest of the workflow follows your `@v3` or
SHA. It is updated only when `pages-deploy` itself changes: a hashira pull
request moves the SHA and its comment together to the release that holds
the change, and `tests/shape-lints/pin-comments.py` checks that the comment
names a tag on that SHA. You do not update it: it moves with the
`pages-site.yml` you pin.

## 7. Trusted input

`install_command`, `site_build_command`, `test_command`,
`docs_pre_build_command` and `docs-build`'s `pre_build_command` run as
shell. They are **trusted input**: write them in your workflow file, and
never pass them values from PR titles, issue bodies, branch names or other
context someone outside the repo controls. They run only in `build`, which
holds `contents: read`, and only `site_build_command`'s step sees the
`build_token` secret.

`.github/pages.json` is the opposite: a pull request can change it, so it
never reaches a shell, every path in it must stay inside the repo, and an
`href` may only use the schemes listed above.

## 8. Errors

Each failure is a `::error::` annotation that names the field or the input,
and stops the build before anything is deployed.

| Message | Cause |
|---------|-------|
| `docs-build: .github/pages.json not found in <repo>` | The file is missing. `{}` is enough. |
| `.github/pages.json: is <n> bytes; the limit is 64 KB` | The file is over 64 KB. |
| `.github/pages.json: invalid JSON at line <l> column <c>: ...` | The file is not JSON. |
| `.github/pages.json: must hold a JSON object` | The top level is a list, string or number. |
| `.github/pages.json: unknown field <field> (allowed: ...)` | A misspelled or unsupported field. |
| `<field> must be a <type>, got <type>` | A field of the wrong type. |
| `<field> must not be empty` / `must be at most <n> characters` / `must have at most <n> entries` | A value outside the limits in section 3. |
| `base must start and end with '/'` / `base must be a URL path of letters, digits and . _ ~ % -` | `base` is not a plain path folder. |
| `<field>.href must start with one of https:// http:// / ./ ../ #` | A header link with another scheme, such as `javascript:`. |
| `accent must be #rgb or #rrggbb` / `accent_dark must be #rgb or #rrggbb` | A colour in another form. |
| `logo must end in .svg or .png` / `theme_css must end in .css` / `home_page must end in .md` / `sidebar[<i>].file must end in .md` | A file of another kind. |
| `<field> must be a relative path` / `must not contain a '..' segment` / `must not contain a backslash or NUL` | A path that could leave the repo. |
| `<field> must be a normalized path, with no '.' or empty segment` | A path with another spelling, such as `./a.md` or `a//b.md`. |
| `docs-build: <page>: <!--@include--> is not supported` | A published page includes another file. |
| `docs-build: <page>: image "<src>" must be a URL or a path to a file in the docs, with no query` | An image path that leaves the docs or carries a Vite query such as `?raw`. |
| `docs-build: <page>: <tag> is not written by Markdown` / `does not close the open tag` | A page renders HTML that Markdown does not write, such as a tag in a plugin's title. |
| `docs-build: docs/<path>.svg: an SVG that could run a script is not published: ...` | An SVG with a `<script>`, an `on*` handler or a `javascript:` URL. |
| `docs-build: <page>: <problem>` (from the built-page check) | A built page holds a script, handler, frame, form or file reference that VitePress did not write. |
| `<field>: <path> resolves into .git` / `resolves to a file of another kind` | A `logo` or `theme_css` symlink into `.git` or `node_modules`, or to a file with another extension. |
| `docs-build: <page>: front matter in <language> is not supported` | Front matter in JavaScript, JSON or another language than YAML. |
| `docs-build: docs/<path>: only Markdown pages and static files ... are published` / `a [ or ] in a name makes a VitePress dynamic route` | A code file, or a dynamic route, under `docs/` or written by `pre_build_command`. |
| `docs/<path> is a symlink into <folder>, which is never published.` | A symlink under `docs/` into `.git`, another dot folder or `node_modules`. |
| `<field>: <path> not found` / `resolves outside the repo` / `is not a file` | A `logo`, `theme_css` or `home_page` that is not a file in the repo. |
| `sidebar: files not found in docs/: <files>` | A `sidebar` page is missing. |
| `sidebar[<i>] must have exactly one of file (a page), items (a group) or dir (a folder section)` | A sidebar entry of no shape, or mixing two. |
| `sidebar[<i>]...: sidebar groups nest at most 3 levels deep` / `sidebar[<i>].items must not be empty` | A group nested 4 deep, or one with no items. |
| `sidebar folder section <dir> lists no page` | No published page under the folder that the sidebar does not already list. |
| `sidebar files missing from the docs after pre_build_command: <files>` | A sidebar page, from `pages.json` or the generated sidebar, is not in the stage. |
| `DOCS_STAGE/.sidebar.json: <problem>` | The generated sidebar is not valid: the same messages as for `sidebar`, or `is not a regular file`. |
| `sidebar files are also in unpublished: <files>` | A page both listed and hidden. |
| `.github/homepage.json: invalid JSON` | The homepage tile file the defaults come from is broken. |
| `.github/homepage.json: must hold a JSON object` / `.github/homepage.json: is <n> bytes; the limit is 64 KB` | The homepage tile file is a list or a value, or over 64 KB. |
| `<field>.href must not contain a backslash or a control character` | A header link a browser would read as another host or split. |
| `docs/index.md exists and would collide with docs/<home_page>` | The home page is published as the docs index. |
| `output_dir '<dir>' already exists; docs-build never writes over it.` | The docs folder is already there. |
| `output_dir must not hold a control character` | A newline, tab or other control character in `output_dir`, which would add lines to the step's outputs. |
| `pre_build_command exited with code <n>.` / `site_build_command exited with code <n>.` | A build command failed. |
| `'<site_output>/docs' already exists after the site build` | The site holds its own `docs` or `_kit` folder. |
| `site-kit: '<dest>/_kit' already exists` | The kit would replace the site's own `_kit`. |
| `pages-site: deploys main only; this run is on <ref>.` | A run on another branch, refused before the approval. Use `deploy: false` to build without deploying. |
| `pages-site: approval must be 'environment' or 'merge', not '<value>'.` / `source must be 'main' or 'latest-release', not '<value>'.` | An unknown `approval` or `source`, refused before anything is built. |
| `pages-site: prebuilt deploys an artifact built earlier in the run; with deploy: false there is nothing to do.` | `prebuilt: true` with `deploy: false`. |
| `pages-site: source: latest-release found no vX.Y.Z tag; nothing is built or deployed.` | No release tag to build. |
| `pages-site: source: latest-release: <tag> (<sha>) is not on main; only a release tag on main is built.` / `source: latest-release cannot find main ...` | The highest tag sits on a commit `main` does not contain, or the clone has no `main` to check it against. |
| `scan-suite: <scanner> reported findings or an error` (the `scan` job) | OSV or gitleaks found something; nothing is approved or deployed. Fix it, or turn the scanner off with `scan_disable`. |
| `pages-site: install_command exited with code <n>.` / `test_command exited with code <n>.` | The install or the tests failed. |
| `pages-site: <page>: <ref> names no kit file (site-kit copies ...)` / `resolves outside the site` | A page loads a `_kit/` file site-kit does not ship, such as a typo. |
| `pages-site: released refused: this run has no approved review for the 'production' environment. ...` | `released: true` in a run with no approved `production` review: a hand or dispatched run that set it, or a release job outside the `production` environment or before its approval. Run with `released: false` to wait at `gate`. |
| `pages-site: released refused: could not read <url> (...)` | `released: true`, and the run's approvals could not be read, with the job's token or without one: a private repo, or GitHub unreachable. Nothing is deployed. |
| `pages-site: could not fetch skathio/hashira at <sha>, so released: true cannot be checked.` | `released: true`, and hashira's approval check could not be fetched. |
| `the latest release <tag> is on <sha>, not <sha>; this run is stale.` | A released run of an older release. |
| `pages-site: could not read this repo's tags; released: true needs a public repo.` | `released: true` in a private repo, or GitHub unreachable. |

## 9. Migrating from your own VitePress config

A repo that built its docs with a VitePress config of its own (a
`docs-site/` or `docs/.vitepress/` folder) moves to `.github/pages.json`
and `docs-build` like this:

- **Anchors.** After the migration, heading ids follow GitHub's slug rule,
  not VitePress's default slugify. GitHub keeps each run of hyphens (`## Hello, World & Co.`
  is `#hello-world--co`, where VitePress made `#hello-world-co`) and keeps
  accented letters as they are, so check the `#anchors` your pages and other
  sites link to. The build's anchor warnings name each in-page `#anchor`
  that no longer matches; links from other sites are yours to check.
- **Sidebar.** Move `themeConfig.sidebar` into `pages.json`'s `sidebar`:
  `{ text, link }` becomes `{ "label", "file" }` (a `.md` path under
  `docs/`, not a URL), `{ text, items, collapsed }` a group, and a folder
  you listed page by page can become a folder section (`dir`). A sidebar a
  script generated goes to `$DOCS_STAGE/.sidebar.json` from
  `docs_pre_build_command` (section 3). `themeConfig.nav` becomes `nav` and
  `home_link`.
- **Theme CSS.** A `.vitepress/theme/custom.css` becomes `theme_css`, loaded
  after the shared theme. Its `url()` paths resolve against the published
  docs, so move the files they name into `docs/public/`. Custom Vue
  components, layouts and `enhanceApp` have no equivalent: pages render as
  GitHub shows them.
- **Pre-build.** Steps that ran before `vitepress build` (generated API
  pages, copied files) go in `docs_pre_build_command`. Keep that command in
  a script of the repo, such as `scripts/docs-pre-build.sh`, and pass only
  the script's path: the workflow input stays one line, and `cli.js --out
  ... --pre-build ./scripts/docs-pre-build.sh` runs the same steps locally.
- **Dependabot.** Remove the `npm` entry for your docs folder from
  `.github/dependabot.yml` along with the folder: VitePress is now pinned by
  `docs-build`'s own lockfile, which hashira's Dependabot keeps fresh and
  which reaches you through `@v3`. Keep the `github-actions` entry, which
  moves a SHA pin of `pages-site.yml`.
- **OSV.** Your own OSV scan no longer sees VitePress, since its lockfile is
  in hashira, not in your repo. hashira's CI and its release check run OSV
  over `.github/actions/docs-build/vitepress/package-lock.json` and fail on
  findings, and `pages-site.yml`'s `scan` job runs OSV and gitleaks over
  your repo's own lockfiles before the approval.
- **Front matter and `index.md`.** Front matter adds nothing to a page, and
  `docs/index.md` next to `home_page` fails the build: the home page is
  published as the docs' index.

Check the result with `cli.js --check` before the first run (section 3,
"Local preview").
