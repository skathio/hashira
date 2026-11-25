---
name: release
description: Cut a hashira release by dispatching release.yml with a bump (tag vX.Y.Z on main, create the GitHub Release, roll the v3 major tag, deploy the site), with the manual commands as the fallback. Use only when the maintainer asks for a release.
---

# Release hashira

Releases go through `.github/workflows/release.yml`. Tags and the GitHub Release are public, and consumers pinned to
`@v3` pick up the result at once. Dispatch a release, or push anything by hand, only when the maintainer has asked for
this release in this session.

## The release workflow

1. Pick the bump against the additive-only rule in `docs/usage.md`: `patch` for fixes, `minor` for inputs or outputs
   added with defaults, `major` for anything that removes, renames, changes a default or widens permissions. A major
   is the maintainer's decision, and the templates, docs and lints must already name the new major (a normal PR before
   the release), or the workflow refuses. Look at what is new with `git log --oneline <last-tag>..origin/main`.
2. Dispatch it on main:
   ```sh
   gh workflow run release.yml --ref main -f bump=patch
   gh run list --workflow release.yml --limit 1
   ```
   One release runs at a time, and GitHub keeps at most one run waiting behind it: a later dispatch replaces a
   waiting run, which is cancelled before any job starts and changed nothing. Dispatch a cancelled release again.
   `check` refuses, before any approval, a ref other than main, a commit main has moved past, a `_self-ci.yml` run for main's HEAD that is not
   green (it waits up to 45 minutes for one still running, so dispatch right after the merge is fine), a v1 or v2 version, a template that pins another major, and a `vX.Y.Z` tag on another commit. `docs` builds
   the docs, and a failure stops the release before any tag.
3. The `publish` job waits for the `production` environment's approval (the hashira-owners team). After it, the job
   pushes `vX.Y.Z`, creates the Release with generated notes and points the major tag at the commit, with the release
   App's token. Then `site` deploys the landing page and docs and `homepage` pings the org homepage (a failed ping
   only warns).
4. If a run fails partway, re-run it (`gh run rerun <id> --failed`): a tag already on the commit, an existing Release
   and a major tag already on the commit count as done. If only the site deploy failed, run `site.yml` by hand on main
   (`gh workflow run site.yml --ref main`) and approve it in `production`.
5. Check as in step 5 of the fallback below.

`v1` and `v2` are frozen: the workflow never names them, and a major release leaves the previous major's tag where it
was.

## Fallback: the manual commands

Use these only when `release.yml` is down (for example the release App is missing or its key has expired) and the
maintainer asks for a release anyway. They do the same steps by hand.

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
6. Deploy the site and ping the homepage, which the workflow would have done: `gh workflow run site.yml --ref main`
   (it waits for the `production` approval), then `gh workflow run homepage.yml --ref main`.
