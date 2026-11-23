# hashira-fixture-nuget

A fixture consumer of [hashira](https://github.com/skathio/hashira)'s NuGet package flow.

Everything here is generated from hashira's `tests/consumers/nuget/` and is overwritten on every integration run. Change
it in hashira, where it is reviewed. hashira's `consumer-integration` job pushes a branch `hashira/<sha>` with every
`skathio/hashira` ref set to that commit, and then runs this repo's CI and release path against it.

The release path pushes to a BaGetter feed that runs as a service container inside the publish job, so the package
never reaches nuget.org. The API key in `.github/workflows/ci.yml` is a throwaway: it opens only that feed.

The repo holds one project, which is both the package and its tests, because `nuget-package-ci.yml` with no
`project_path` tests and packs the single `.csproj` that is not named like a test project.
