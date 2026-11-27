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

### Changed

- `npm-package-ci.yml`, `nuget-package-ci.yml` and `static-webapp-ci.yml`:
  actionlint now runs by default. The `scan_disable` default changed from
  `'codeql,actionlint'` to `'codeql'`. This changes a default within v3, by
  the maintainer's decision: callers may see new actionlint findings, which
  fail the `scan-suite` job (and `ci / passed`) while
  `scan_fail_on_findings` is `true`. Fix the findings, or pass
  `scan_disable: 'codeql,actionlint'` to keep the old behaviour meanwhile.
  The `scan-suite` action's own default is unchanged.

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

[3.4.0]: https://github.com/skathio/hashira/compare/v3.3.0...v3.4.0
