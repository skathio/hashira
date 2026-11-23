# hashira-fixture-npm

A fixture consumer of [hashira](https://github.com/skathio/hashira)'s npm package flow.

Everything here is generated from hashira's `tests/consumers/npm/` and is overwritten on every integration run. Change
it in hashira, where it is reviewed. hashira's `consumer-integration` job pushes a branch `hashira/<sha>` with every
`skathio/hashira` ref set to that commit, and then runs this repo's CI and release path against it.

The release path publishes to a Verdaccio registry that runs as a service container inside the publish job, so the
package never reaches npmjs.org. The token in `.github/workflows/ci.yml` is a throwaway: it opens only that registry.
