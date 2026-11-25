---
name: visual-test-site
description: Build hashira's Pages site (the site/ landing page plus the VitePress docs), serve it locally and screenshot the landing page and the docs pages at phone and desktop widths in light and dark mode. Use for every change that affects what renders, including site/**, docs-site/**, docs/**, .github/homepage.json and site/mark.svg, before you open or update the PR.
---

# Visual test for the landing page and the docs

The Pages site is `site/` (static HTML, served at `/hashira/`) plus the VitePress docs built from `docs/` (served at
`/hashira/docs/`). `docs-site/build.sh` assembles both into `artifacts/pages`, the folder `site.yml` deploys. The repo
has no browser tooling of its own, so this skill uses the Playwright CLI through `npx` with a pinned version, and adds
nothing to the repo. If the Playwright MCP tools (`mcp__playwright__*`) are available, you can use them instead. Use
the same widths and schemes.

## 1. Build and serve it

```sh
(cd docs-site && npm ci)   # once, or after docs-site/package-lock.json changes
docs-site/build.sh         # writes artifacts/pages; a dead link fails the build
```

The docs use absolute `/hashira/docs/...` URLs, so serve the folder under `/hashira/` through a link in your
scratchpad, never inside the repo:

```sh
SERVE=<scratchpad>/serve; mkdir -p "$SERVE"; ln -sfn "$PWD/artifacts/pages" "$SERVE/hashira"
python3 -m http.server 8765 --bind 127.0.0.1 --directory "$SERVE"   # run in the background
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/hashira/        # expect 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/hashira/docs/   # expect 200
```

If port 8765 is taken, pick another one and use it below.

## 2. Screenshot: phone 390x844 and desktop 1440x900, in light and dark

Take the landing page and three docs pages: `docs/` (Getting started), a flow guide (`docs/flows/npm.html`) and the
catalog (`docs/catalog.html`). Add any other page your change touches. Write the screenshots to your scratchpad, never
into the repo.

```sh
OUT=<scratchpad>/shots; mkdir -p "$OUT"
BASE=http://127.0.0.1:8765/hashira
for page in landing:/ docs:/docs/ flow-npm:/docs/flows/npm.html catalog:/docs/catalog.html; do
  name="${page%%:*}"; path="${page#*:}"
  for scheme in light dark; do
    npx -y playwright@1.61.1 screenshot --full-page --color-scheme=$scheme --viewport-size=390,844  "$BASE$path" "$OUT/$name-phone-$scheme.png"
    npx -y playwright@1.61.1 screenshot --full-page --color-scheme=$scheme --viewport-size=1440,900 "$BASE$path" "$OUT/$name-desktop-$scheme.png"
  done
done
```

If Chromium is missing, run `npx -y playwright@1.61.1 install chromium` once.

`--color-scheme` drives the default "auto" theme through `prefers-color-scheme`. The manual toggles (`theme.js` and
`data-theme` on `<html>` on the landing page, the VitePress appearance switch in the docs) share the `theme`
localStorage key. If your change touches `theme.js`, the `:root[data-theme=...]` blocks or the docs' theme bridge, also
click the toggle in the Playwright MCP browser, screenshot each state, and open the other page to check it opens in the
same theme with no flash.

## 3. Inspect: open every PNG with the Read tool and check

- At 390px, nothing scrolls sideways. Only `<pre>` and code blocks, and wide tables in the docs, may scroll inside
  themselves. Text does not overflow, cards stack in one column, and the landing page's header shows its Docs link.
- At 1440px, the landing page's hero has the text on the left and the emblem on the right, the cards are in 3 columns,
  and the stats are in 4. The docs show the sidebar on the left (Getting started first) and the outline on the right.
- Text and the accent green are readable in both schemes. In light mode, check `.t` (#0369a1) and the muted text.
- Every image loads: `mark.svg`, `users/*.svg`, and the docs logo. No raw `{{`, `undefined` or broken glyphs.
- When you changed `.github/homepage.json` or `site/mark.svg`, the mark still reads at 24px (the nav brand) and on the
  dark emblem.

## 4. Report in the PR

Attach the screenshots, or describe each one: what you checked and what you saw. Name anything you did not check.
Stop the server when you are done.
