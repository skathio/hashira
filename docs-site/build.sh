#!/usr/bin/env bash
# Builds the VitePress docs site from the repo's docs/*.md and docs/flows/*.md, which it reads
# and never edits. Run from the repo root after `npm ci` in docs-site/. It then assembles the
# one GitHub Pages folder, artifacts/pages: the site/ files at its root (served at /hashira/)
# and the VitePress output under docs/ (served at /hashira/docs/). _self-ci.yml runs this same
# script on every pull request. Nothing generated is committed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
stage="$root/artifacts/docs-site"
pages="$root/artifacts/pages"

if [[ ! -d "$here/node_modules/vitepress" ]]; then
  echo "docs-site/node_modules is missing: run 'npm ci' in docs-site/ first." >&2
  exit 1
fi

# The docs live under the landing page's docs/ route, so site/ must not hold a docs entry of
# its own: copying over it would mix the two, so fail instead.
if [[ -e "$root/site/docs" ]]; then
  echo "site/docs exists and would collide with the docs route: rename or remove it." >&2
  exit 1
fi

# getting-started.md is published as the docs site's index page (`rewrites` in config.mts), so a
# docs/index.md would be written to the same file: fail instead of letting one replace the other.
if [[ -e "$root/docs/index.md" ]]; then
  echo "docs/index.md exists and would collide with getting-started.md, the docs home page: rename it." >&2
  exit 1
fi

# VitePress reads one source folder and resolves node modules from the sources, so the
# pages and the logo are staged together next to a link to docs-site's node_modules. The
# flows/ subfolder is kept, so the pages' relative links resolve as they do on GitHub.
# The Pages folder of an earlier run goes first, so a build that fails leaves no stale site
# behind for site.yml or the visual test to pick up.
rm -rf "$stage" "$pages"
mkdir -p "$stage/src/public" "$stage/src/flows"
cp "$root"/docs/*.md "$stage/src/"
cp "$root"/docs/flows/*.md "$stage/src/flows/"
cp "$root/site/mark.svg" "$stage/src/public/mark.svg"
ln -s "$here/node_modules" "$stage/node_modules"

node "$here/node_modules/vitepress/bin/vitepress.js" build "$here"

# Assemble the Pages folder.
mkdir -p "$pages"
cp -R "$root/site/." "$pages/"
cp -R "$stage/dist" "$pages/docs"
