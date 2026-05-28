# pages-fixture

Tiny static-site fixture (one HTML file + one CSS file) used by
`_self-ci.yml`'s `pages-upload-shape-smoke` job to exercise the
`actions/pages-upload/` composite action with a real two-file directory.

## Why it's tiny

The fixture exists solely to give `pages-upload` something realistic to
package — enough to prove that the action's autodetect + summary logic
runs end-to-end against a real directory, but small enough that nobody
mistakes it for an example template. Consumers should NOT copy this
fixture as a starting point for a real site; see
`docs/flows/static-webapp.md` (iter 4.3) for the consumer-facing
adoption walk-through.

## Why it's not under `dist/`

The fixture is committed at `tests/pages-fixture/` rather than at one of
the autodetected directory names (`dist/`, `build/`, `out/`, `public/`).
That way, an explicit-path smoke (`pages-upload-shape-smoke`) and an
autodetect smoke (`pages-upload-autodetect-smoke`) can both run from the
same fixture: the explicit smoke passes `path: tests/pages-fixture`
directly, and the autodetect smoke first copies the fixture into a
temporary `dist/` directory before invoking the action with no `path:`
input.

## Files

- `index.html` — minimal landing page.
- `styles.css` — a few rules so the directory has more than one file
  (proves the action packages the whole directory, not just one file).
