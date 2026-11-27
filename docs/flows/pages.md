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

The jobs run `check` -> `gate` -> `build` -> `deploy`. `check` refuses any
ref but `main` before anyone is asked to approve, `gate` waits for the
`production` environment's approval, `build` holds only `contents: read`
and runs the build commands, and `deploy` alone holds `pages: write` and
`id-token: write`, in the `github-pages` environment, one deploy at a time.

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
| `description` | string | at most 200 characters | `''` |
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

The file itself may be at most 64 KB. An unknown field fails, at the top
level and inside a `sidebar` entry (a group's or a folder section's too), a
`nav` entry or `home_link`.

- **`name`** is the docs' site title and the brand of the header.
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

### How the docs read

The pages are the `docs/` files as GitHub renders them. Heading ids follow
GitHub's rule, so a link's `#anchor` lands on the site as it does on
GitHub. A link to another published page opens that page; a link that
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
Local search is on, and VitePress's dead-link check fails the build on a
link to a page that does not exist. The docs and the landing share one
theme choice: the `theme` key in `localStorage`. Both have the same
three-state control. Each press goes from auto to the theme the system does
not show, then to the system's own theme, then back to auto. So the first
press always changes what the page shows. In auto the page follows the
system theme as it changes.

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
  `data-theme-resolved` when a rule needs the shown theme. Load it in
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

`pages-site.yml` has no outputs and takes no secrets.

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
the upload:

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
| `check`, `gate` | none | They only read `github.ref` and wait for the approval. |
| `build` | `contents: read` | Checkout. It runs the build commands and npm packages, so it holds nothing else. |
| `deploy` | `pages: write`, `id-token: write` | `actions/deploy-pages` and its OIDC token. |

The caller's job grants all three; a called workflow's jobs get no more.

## 7. Trusted input

`site_build_command`, `docs_pre_build_command` and `docs-build`'s
`pre_build_command` run as shell. They are **trusted input**: write them
in your workflow file, and never pass them values from PR titles, issue
bodies, branch names or other context someone outside the repo controls.
They run only in `build`, which holds `contents: read` and no secrets.

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
| `pre_build_command exited with code <n>.` / `site_build_command exited with code <n>.` | A build command failed. |
| `'<site_output>/docs' already exists after the site build` | The site holds its own `docs` or `_kit` folder. |
| `site-kit: '<dest>/_kit' already exists` | The kit would replace the site's own `_kit`. |
| `pages-site: deploys main only; this run is on <ref>.` | A run on another branch, refused before the approval. |
| `pages-site: released refused: this run has no approved review for the 'production' environment. ...` | `released: true` in a run with no approved `production` review: a hand or dispatched run that set it, or a release job outside the `production` environment or before its approval. Run with `released: false` to wait at `gate`. |
| `pages-site: released refused: could not read <url> (...)` | `released: true`, and the run's approvals could not be read, with the job's token or without one: a private repo, or GitHub unreachable. Nothing is deployed. |
| `pages-site: could not fetch skathio/hashira at <sha>, so released: true cannot be checked.` | `released: true`, and hashira's approval check could not be fetched. |
| `the latest release <tag> is on <sha>, not <sha>; this run is stale.` | A released run of an older release. |
| `pages-site: could not read this repo's tags; released: true needs a public repo.` | `released: true` in a private repo, or GitHub unreachable. |
