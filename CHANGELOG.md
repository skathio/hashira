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

[3.4.0]: https://github.com/skathio/hashira/compare/v3.3.0...v3.4.0
