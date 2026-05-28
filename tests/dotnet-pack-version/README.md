# tests/dotnet-pack-version

Unit tests + synthetic .csproj fixtures for the `dotnet-pack-version` composite
action (and indirectly the `nuget-push` action, which is exercised via the
dry-run hook against a fake `.nupkg` path in the self-CI smoke).

## Files

- `parse-nupkg-version.test.js` — `node:test` cases for the
  `.github/actions/dotnet-pack-version/lib/parse-nupkg-version.js` shim
  (MinVer-reference detection + .nupkg filename parsing). Run locally:
  ```
  node --test tests/dotnet-pack-version/parse-nupkg-version.test.js
  ```

- `fixtures/minimal/` — minimal .csproj + Class1.cs with a
  `<PackageReference Include="MinVer" Version="5.0.0" />`. The
  `dotnet-pack-version-smoke` self-CI job invokes the action against this
  fixture and asserts (a) the `version` output is non-empty,
  (b) `$GITHUB_STEP_SUMMARY` contains `dotnet-pack-version: produced`.
  Targets `net8.0` (matches the SDK pinned by setup-dotnet in `_self-ci.yml`).

- `fixtures/no-minver/` — same shape as `minimal/` but WITHOUT the MinVer
  PackageReference. The smoke job invokes the action against this fixture
  and asserts the `::warning::` notice is emitted. The fixture pins
  `<Version>0.0.1</Version>` directly so `dotnet pack` still produces a
  .nupkg (otherwise the pack step would fail before the warning surfaces).

## Why these fixtures exist

The `dotnet-pack-version` action wraps `dotnet pack` + MinVer; the
non-trivial behaviors are (a) MinVer-detection, (b) `.nupkg` filename
parsing, (c) the warning path. The shim covers (a) and (b) via unit tests;
the smoke fixtures cover the runtime wiring of (c) plus the happy-path
end-to-end shape that the unit tests can't reach (dotnet CLI invocation,
output-directory contract, summary line emission).

Real consumer integration is deferred per rev-7. Future iterations of
this work item may add more sophisticated fixtures (e.g. multi-project
solutions); v1's contract is the single-project case.

## Why no per-action unit test for `nuget-push`?

The `nuget-push` action.yml is shell-only (no JS shim). Its non-trivial
behaviors are (a) the dry-run hook, (b) the `--api-key` omission for the
OIDC path, (c) the skip-duplicate signal. (a) is covered by the
`nuget-push-smoke` self-CI job using `HASHIRA_NUGET_PUSH_DRY_RUN=1`
against a synthetic fake `.nupkg` path. (b) and (c) require a real NuGet
feed to exercise end-to-end and are deferred to user-side post-v1
integration per rev-7 — the workflow-shape contract is locked by
actionlint + the trust-boundary header block.
