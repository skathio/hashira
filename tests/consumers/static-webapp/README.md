# hashira-fixture-static

A fixture consumer of [hashira](https://github.com/skathio/hashira)'s static webapp flow.

Everything here is generated from hashira's `tests/consumers/static-webapp/` and is overwritten on every integration
run. Change it in hashira, where it is reviewed. hashira's `consumer-integration` job pushes a branch `hashira/<sha>`
with every `skathio/hashira` ref set to that commit, and then runs this repo's CI and deploy against it.

The site deploys to this repo's own GitHub Pages. `npm run build` writes `dist/marker.txt` with the hashira ref the
caller pins, and the deploy job checks that the live site serves the commit hashira resolved.
