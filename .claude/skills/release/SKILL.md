---
name: release
description: Cut a hashira release. Tag vX.Y.Z on main, create the GitHub Release, and roll the v3 major tag forward. Use only when the maintainer asks for a release.
---

# Release hashira

Releases are manual. No workflow tags this repo. Tags and the GitHub Release are public, and consumers pinned to `@v3`
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
4. Roll the major tag. This is the only allowed force-push in this repo, and it applies to `v3` only. `v1` and `v2`
   are frozen and are never moved: `v2` callers still pass `library_ref`, which v3's workflows no longer accept, so
   moving `v2` onto a v3 commit would break every one of them. The first v3 release creates `v3`, and each later one
   moves it:
   ```sh
   git tag -f v3 'vX.Y.Z^{commit}' && git push -f origin v3
   ```
   `v3` is a lightweight tag on the commit. Without `^{commit}` it would point at the annotated tag object instead.
   Refuse to release a `v1.*` or `v2.*` version, and refuse any command that moves `v1` or `v2`.
5. Check: `git ls-remote --tags origin 'vX.Y.Z^{}' v3` shows the same commit SHA on both lines, `git ls-remote --tags
   origin v2` still shows the commit it showed before this release, and the README and docs are not
   pinned to `@main` anywhere (`grep -rn '@main' README.md docs/` finds no `uses:` line).
6. Optional: run `homepage.yml` by hand on main (`gh workflow run homepage.yml --ref main`) so the org homepage tile
   shows the release now and not at its next scheduled build.
