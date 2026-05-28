# tests/semantic-release-publish

Unit tests + dry-run fixture for the `semantic-release-publish` composite action.

## Files

- `releaserc-builder.test.js` — `node:test` cases for the
  `.github/actions/semantic-release-publish/lib/build-releaserc.js` shim.
  Run locally:
  ```
  node --test tests/semantic-release-publish/releaserc-builder.test.js
  ```
- `dry-run-fixture/` — minimal `package.json` (private, version 0.0.0, no
  source code) used by the `semantic-release-publish-dry-run` self-CI job
  to exercise the action end-to-end without ever publishing. Since the
  fixture has no conventional-commit history, semantic-release in dry-run
  reports "no release this run" — that is the expected baseline.

## Why no per-plugin unit tests?

Each pinned plugin is a third-party module with its own test suite; this
library's contract is the inputs/outputs of the composite action +
shape-of-the-generated-`.releaserc`. The releaserc-builder tests cover
the shape exhaustively; the dry-run self-CI job covers the runtime wiring
(setup-node → npm baseline check → install → semantic-release exec).
Real publish behavior is covered by the consumer's first real run
(deferred per rev-7 scope).
