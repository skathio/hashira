# Changelog

All notable changes to hashira are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and hashira uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): within a major,
inputs are only added, with defaults that keep earlier behaviour. Callers pin
`@v3`, which moves to each v3 release. Releases before 3.4.0 are described in
their [GitHub Releases](https://github.com/skathio/hashira/releases).

## [3.4.0] - Unreleased

### Security

- `static-webapp-ci.yml`: the `build-and-upload` job, which runs the caller's
  `build_command`, no longer holds `id-token: write` or `pages: write`. It
  holds only `contents: read`: `upload-pages-artifact` needs neither grant.
  The OIDC token and the Pages grant are left only in the caller's `deploy`
  job. Callers may drop `id-token: write` and `pages: write` from their `ci`
  job (the template, `templates/static-webapp/ci.yml`, now does); callers that
  keep them still work.
- `pages-site.yml`: `released: true` skips the `production` approval only when
  this workflow run already holds an approved `production` review. The `check`
  job reads the run's approvals and refuses otherwise, and fails closed when
  they cannot be read. A caller that forwards a `workflow_dispatch` input as
  `released` no longer lets whoever dispatches skip the approval, so callers
  no longer need their own `github.workflow_ref` guard. A release job that
  calls `pages-site.yml` with `released: true` must pass the `production`
  approval earlier in the same run, as hashira's own release workflow does.
- `docs-build`: an SVG under `docs/`, `docs/public/` included, that holds a
  `<script>`, an `on*` handler, a `javascript:` URL, an `<!ENTITY>`
  declaration (or a `<!DOCTYPE>` with an internal subset), an
  `<?xml-stylesheet?>` instruction or XSLT, an `<iframe>`, `<embed>` or
  `<object>` element, or a `srcdoc` attribute fails the build: a browser
  that opens the file on its own would run it with the docs' origin. A
  plain `<!DOCTYPE>` and a `<foreignObject>`, as editors export them, stay
  allowed; what a `<foreignObject>` holds is checked like the rest.
- `docs-build`: an `output_dir` that holds a control character is refused,
  so it cannot add lines to the step's outputs or summary.

### Added

- `pages-site.yml`: a read-only `scan` job runs scan-suite's OSV and
  gitleaks on the commit being deployed, before `gate`, so nobody approves a
  commit that fails them. It is on by default and fails closed;
  `scan_disable` and `scan_fail_on_findings` work as in `static-webapp-ci`.
- `pages-site.yml`: `deploy` (default `true`); `false` builds, checks and
  uploads on any ref and event, pull requests included, with no main-only
  check, no `gate` and no deploy. The caller's job still names `pages: write`
  and `id-token: write`, which GitHub checks against the skipped `deploy`
  job before the run starts; `build` holds `contents: read` only. `prebuilt`
  (default `false`) deploys the `artifact_name` artifact (default
  `github-pages`) that an earlier job of the same run built, so a release
  builds once.
- `pages-site.yml`: `install_command`, `test_command` and `coverage_path`
  (all default `''`) around `site_build_command`, as in `static-webapp-ci`.
- `pages-site.yml`: the opt-in `build_token` secret, exposed as
  `BUILD_TOKEN` to the `site_build_command` step only, and `approval`
  (default `environment`, the `production` gate); `merge` deploys `main`
  with no gate on `push`, `schedule` and `repository_dispatch` runs only,
  never on `workflow_dispatch`.
- `pages-site.yml`: `source` (default `main`); `latest-release` builds the
  highest `vX.Y.Z` tag's tree, and fails when that tag's commit is not on
  `main`. Every run writes
  `deploying <ref>@<sha>, N commits after <tag>` to the step summary; a
  `deploy: false` run puts `build only (deploy: false), not` in front of it.
- `pages-site.yml`'s build checks that the site's pages reference only kit
  files `site-kit` ships, and caches npm on `docs-build`'s lockfile when it
  builds the docs (`docs: false` runs set Node up with no cache).
  `docs-build` writes the VitePress version and its lockfile's sha256 to the
  step summary, and hashira's CI and release check run OSV over that
  lockfile and fail on findings. The release check also runs the site
  deploy's own scan (OSV over the repo and gitleaks) before any tag, so a
  finding stops the release instead of leaving it published with its site
  not deployed.
- `templates/pages/own-build.yml`: a site's own build job with `site-kit`,
  `docs-build`, `pages-upload` and `pages-deploy`.
- `static-webapp-ci.yml`: `site_kit` (default `false`) runs `site-kit`
  after `build_command` and before the upload, so a pull request's artifact
  holds the same kit as the deployed site.
- `<site-nav>`: the nav links fold into a disclosure menu (a button with
  `aria-expanded`; Escape closes it) when the element's measured width
  cannot hold them, and always on phones. The brand stays left, and Docs,
  the extras, `home_link` and the theme toggle stay in a right group that
  does not shrink.
- `<site-nav>`: a link to the current page gets `aria-current="page"`, and
  the opt-in `scrollspy` attribute marks the `#section` link in view with
  `aria-current="location"`; the current link and the Docs link are styled
  in the accent.
- `<site-nav>`: a `slot="brand"` child replaces the logo and name inside the
  brand link, and `slot="fallback"` children show only until the element is
  defined. `tokens.css` reserves the bar's box for `site-nav:not(:defined)`,
  slotted links match the built-in ones, and a host with
  `role="navigation"` gets no second landmark. After its first render the
  element sets `ready` and fires `site-nav:ready`.
- `theme.js` sets `data-theme-resolved="light|dark"` on `<html>`, following
  the system while in auto, and the docs pages set it too. The docs get the
  same three-state theme control as the landing, on the shared `theme` key.
- `.github/pages.json`: `accent_dark` (`#rgb`/`#rrggbb`) for dark mode;
  `<site-nav>` sets `--site-accent-dark` from it. `docs-build` prints a
  warning, and still builds, when an accent has less than 4.5:1 contrast
  against its mode's canvas.
- `.github/pages.json`: `sidebar` takes groups (`label`, `items`,
  `collapsed`) nested up to 3 levels and folder sections (`label`, `dir`,
  `collapsed`) listing a folder's pages by their first heading (#46). A
  `pre_build_command` may write a generated sidebar to
  `$DOCS_STAGE/.sidebar.json`, checked with the same rules and limits.
- `docs-build`: `lib/cli.js` is the entry point the action runs and a local
  run uses too: `--check` validates `pages.json` and `docs/` with no install
  and no output, and `--out <dir> [--pre-build <cmd>]` builds. A JSON Schema
  for `pages.json`, `pages.schema.json`, can be named in `$schema`.
- `docs-build`: built pages get `og:title`, `og:description`, `og:url` and a
  canonical link. An in-page `#anchor` with no matching id prints a warning.
- `docs/flows/pages.md`: a `<site-nav>` reference (attributes, the
  precedence of attributes, `config` and the JSON child, kit paths, slots,
  parts, CSS variables, accessibility, the `#theme` hook and
  `window.siteTheme`, what semver covers), a `pages-site.yml` and
  `static-webapp-ci.yml` comparison, how the `pages-deploy` pin is updated,
  build-only, prebuilt, approval-on-merge and own-build recipes, local
  preview, an API reference recipe, the docs header's width budget, and
  migration notes for a repo leaving its own VitePress config.
  `docs/flows/static-webapp.md` links to `site-kit`.

### Changed

- `npm-package-ci.yml`, `nuget-package-ci.yml` and `static-webapp-ci.yml`:
  actionlint now runs by default. The `scan_disable` default changed from
  `'codeql,actionlint'` to `'codeql'`. This changes a default within v3, by
  the maintainer's decision: callers may see new actionlint findings, which
  fail the `scan-suite` job (and `ci / passed`) while
  `scan_fail_on_findings` is `true`. Fix the findings, or pass
  `scan_disable: 'codeql,actionlint'` to keep the old behaviour meanwhile.
  The `scan-suite` action's own default is unchanged.

- `theme.js` and the docs' theme control cycle auto, then the theme the
  system does not show, then the system's own, then auto, so the first press
  always changes what the page shows. The toggles show SVG icons.
- `docs-build`: with more than 2 `nav` entries the docs header holds them in
  one dropdown labelled with the site name, so it fits from 768px up. Docs
  is marked active through `activeMatch` instead of a plain self-link.
- `docs-build`: an empty `description` in `pages.json` defaults to
  `Guides for <name>`.

### Fixed

- The version comments of pinned actions named the wrong versions across the
  workflows, actions, templates and docs: `actions/checkout` `3d3c42e5` is
  v7.0.1 (not v4.2.2), `actions/setup-node` `949feb24` is v7.1.0 and
  `actions/setup-dotnet` `0f4a354d` is v6.1.0 (not v4.1.0), `a98b5685` is
  setup-dotnet v6.0.0 and `actions/upload-artifact` `cf430e03` is v7.0.2 (not
  v4.4.3). Only the comments changed; every pin stays on the same commit. A
  new lint, `tests/shape-lints/pin-comments.py`, checks each comment against
  the action's tags through the GitHub API, and that one SHA carries one
  comment everywhere.
- `<site-nav>` no longer scrolls sideways between phone and wide desktop
  widths, where the home link and the theme toggle used to scroll off
  screen; the bar has no `overflow-x` any more.
- `docs-build`: a link to a repo folder outside `docs/` opens it with
  `tree/HEAD/` instead of `blob/HEAD/`.
- `docs-build`: the built-page check no longer rejects `.bmp` images or
  small inlined `.ico` and `.bmp` images.

[3.4.0]: https://github.com/skathio/hashira/compare/v3.3.0...v3.4.0
