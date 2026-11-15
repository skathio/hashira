---
name: visual-test-site
description: Serve hashira's project site (site/) locally and screenshot it at phone and desktop widths in light and dark mode. Use for every change that affects what renders, including site/**, .github/homepage.json and site/mark.svg, before you open or update the PR.
---

# Visual test for site/

`site/` is static HTML with no build. The repo has no browser tooling of its own, so this skill uses the Playwright
CLI through `npx` with a pinned version, and adds nothing to the repo. If the Playwright MCP tools
(`mcp__playwright__*`) are available, you can use them instead. Use the same widths and schemes.

## 1. Serve it

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory site   # run in the background
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/  # expect 200
```

The URL is http://127.0.0.1:8765/. If port 8765 is taken, pick another one and use it below.

## 2. Screenshot: phone 390x844 and desktop 1440x900, in light and dark

Write the screenshots to your scratchpad, never into the repo.

```sh
OUT=<scratchpad>/shots; mkdir -p "$OUT"
for scheme in light dark; do
  npx -y playwright@1.61.1 screenshot --full-page --color-scheme=$scheme --viewport-size=390,844  http://127.0.0.1:8765/ "$OUT/phone-$scheme.png"
  npx -y playwright@1.61.1 screenshot --full-page --color-scheme=$scheme --viewport-size=1440,900 http://127.0.0.1:8765/ "$OUT/desktop-$scheme.png"
done
```

If Chromium is missing, run `npx -y playwright@1.61.1 install chromium` once.

`--color-scheme` drives the default "auto" theme through `prefers-color-scheme`. The manual toggle (`theme.js`,
`data-theme` on `<html>`) uses the same CSS tokens. If your change touches `theme.js` or the `:root[data-theme=...]`
blocks, also click the toggle (Auto → Light → Dark) in the Playwright MCP browser and screenshot each state.

## 3. Inspect: open every PNG with the Read tool and check

- At 390px, nothing scrolls sideways. Only the `<pre>` block may scroll inside itself. Text does not overflow and cards
  stack in one column.
- At 1440px, the hero has the text on the left and the emblem on the right, the cards are in 3 columns, and the stats
  are in 4.
- Text and the accent green are readable in both schemes. In light mode, check `.t` (#0369a1) and the muted text.
- Every image loads: `mark.svg` and `users/*.svg`. No raw `{{`, `undefined` or broken glyphs.
- When you changed `.github/homepage.json` or `site/mark.svg`, the mark still reads at 24px (the nav brand) and on the
  dark emblem.

## 4. Report in the PR

Attach the four screenshots, or describe each one: what you checked and what you saw. Name anything you did not check.
Stop the server when you are done.
