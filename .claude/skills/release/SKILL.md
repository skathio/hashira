---
name: release
description: Cut a hashira release. Tag vX.Y.Z on main, create the GitHub Release, and roll the v2 major tag forward. Use only when the maintainer asks for a release.
---

# Release hashira

Releases are manual. No workflow tags this repo. Tags and the GitHub Release are public, and consumers pinned to `@v2`
pick up the result at once. Do each push step only when the maintainer has asked for this release in this session.

1. Confirm that main is green and you are releasing it:
   `git fetch origin --tags && git checkout main && git pull --ff-only`, then
   `gh run list --branch main --workflow _self-ci.yml --limit 1 --json headSha,status,conclusion` must show
   `completed` and `success` for a `headSha` equal to `git rev-parse origin/main`. A run for an older commit does not
   count.
2. Pick the version against the additive-only rule in `docs/usage.md`. A patch is for fixes, a minor adds inputs or
   outputs with defaults, and anything that removes, renames, changes a default or widens permissions is a major. A
   major is the maintainer's decision. `x_` inputs are outside the contract. Get the last release with
   `gh release list --limit 3`, and look at what is new with `git log --oneline <last-tag>..main`.
3. Tag and publish:
   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z" origin/main
   git push origin vX.Y.Z
   gh release create vX.Y.Z --verify-tag --title vX.Y.Z --generate-notes
   ```
4. Roll the major tag. This is the only allowed force-push in this repo, and it applies only to `v1` and `v2`. `v1` is
   frozen:
   ```sh
   git tag -f v2 'vX.Y.Z^{commit}' && git push -f origin v2
   ```
   `v2` is a lightweight tag on the commit. Without `^{commit}` it would point at the annotated tag object instead.
5. Check: `git ls-remote --tags origin 'vX.Y.Z^{}' v2` shows the same commit SHA on both lines, and the README and docs are not
   pinned to `@main` anywhere (`tests/dual-pin/lint.py` passes).
6. Optional: run `homepage.yml` by hand on main (`gh workflow run homepage.yml --ref main`) so the org homepage tile
   shows the release now and not at its next scheduled build.
