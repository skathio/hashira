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
over a newer one. Pass `released: true` only from a job that already passed
the `production` approval. `deploy` reads the tags with an unauthenticated
`git ls-remote` and holds no `contents` grant, so `released: true` works for a
public repo only: in a private repo, `deploy` fails rather than deploy.

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
| `sidebar` | list of `{ "file", "label" }` | at most 100 entries, `file` a `.md` path under `docs/`, `label` 1 to 60 characters | `[]` |
| `unpublished` | list of paths under `docs/` | at most 100 entries | `[]` |
| `nav` | list of `{ "label", "href" }` | at most 8 entries, `label` 1 to 30 characters | `[]` |
| `home_link` | `{ "label", "href" }` | `label` 1 to 30 characters | none |
| `accent` | `#rgb` or `#rrggbb` | — | `colour` of `.github/homepage.json`, else `#1e7d69` |
| `logo` | repo-relative `.svg` or `.png` | must exist | `image` of `.github/homepage.json`, else none |
| `theme_css` | repo-relative `.css` | must exist | none |

The file itself may be at most 64 KB. An unknown field fails, at the top
level and inside a `sidebar`, `nav` or `home_link` entry.

- **`name`** is the docs' site title and the brand of the header.
- **`base`** is where the docs are served. The landing is the folder above
  it: `/<repo>/` for the default `/<repo>/docs/`.
- **`home_page`** opens at the docs base. It is published as the docs'
  `index.html`, so a `docs/index.md` next to it fails the build.
- **`sidebar`** lists pages in order with a short label. Every other
  published page follows, by path, under its first H1. A `sidebar` file
  that is missing, or also in `unpublished`, fails the build.
- **`unpublished`** names pages, or folders (`internal` or `internal/`),
  that get no page and no search entry. A link to one opens it on GitHub.
- **`nav`** and **`home_link`** are the header links, shown on the docs and
  read by the landing's `<site-nav>`. An `href` starts with `https://`,
  `http://`, `/`, `./`, `../` or `#`, and holds no backslash or control
  character; a docs header resolves it against the
  landing, so `#flows` opens the landing's `flows` section.
- **`accent`** is the brand colour. The default `#1e7d69` keeps hashira's
  own pair: the darker green in light mode, a lighter one in dark mode. Any
  other colour is used in both modes, with the hover and soft shades mixed
  from it.
- **`logo`** is copied into the docs and shown as the logo and the favicon.
- **`theme_css`** is published as it is, as `site-theme.css` at the docs
  base, and loaded after the shared theme, so its rules win. The build does
  not read its `url()` or `@import` paths: the browser resolves them against
  the published docs, so a relative path must name a published file, such as
  one in `docs/public/`.

Paths are relative to the repo (`logo`, `theme_css`) or to `docs/`
(`home_page`, `sidebar` files, `unpublished`): no leading `/`, no `..`
segment, no `.` or empty segment (`./a.md`, `a//b.md`), no backslash, and no
symlink that leaves the repo. A folder in `unpublished` may end in one `/`.

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

### How the docs read

The pages are the `docs/` files as GitHub renders them. Heading ids follow
GitHub's rule, so a link's `#anchor` lands on the site as it does on
GitHub. A link to another published page opens that page; a link that
leaves `docs/`, or reaches an unpublished page or a folder with no index
page, opens the file on GitHub. Raw HTML, `{attr="..."}` blocks and
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
theme choice: the `theme` key in `localStorage`.

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
  `:root` for another accent.
- **`theme.js`**: auto, light or dark under the `theme` key. Load it in
  `<head>` with no `defer`, `async` or `type=module`, so a stored choice
  applies before first paint.
- **`site-nav.js`**: the `<site-nav>` header. Give it the same `name`, `nav`
  and `home_link` as `pages.json`, and `docs="docs/"` for the Docs link:

```html
<site-nav name="hashira" logo="mark.svg" docs="docs/">
  <script type="application/json">{"nav":[{"label":"Flows","href":"#flows"}],"home_link":{"label":"← skathio","href":"https://skathio.github.io/"}}</script>
</site-nav>
```

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
| `accent must be #rgb or #rrggbb` | A colour in another form. |
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
| `the latest release <tag> is on <sha>, not <sha>; this run is stale.` | A released run of an older release. |
| `pages-site: could not read this repo's tags; released: true needs a public repo.` | `released: true` in a private repo, or GitHub unreachable. |
