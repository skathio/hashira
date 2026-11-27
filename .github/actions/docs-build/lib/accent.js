// The docs' brand colours from pages.json's `accent` (light mode) and `accent_dark` (dark mode).
// The shared theme (custom.css) holds hashira's own palette, a darker green for light mode and a
// lighter one for dark, which is what the default accent with no accent_dark means. A custom
// accent with no accent_dark is used in both modes, as before accent_dark existed. Each mode's
// hover and soft shades are mixed from that mode's accent, as site-kit's tokens.css does for
// the landing pages.

'use strict';

const { DEFAULT_ACCENT } = require('./pages-config');

const ACCENT_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// The shared theme's link colour in dark mode when no accent changes it (custom.css).
const DEFAULT_ACCENT_DARK = '#4fd1b5';
// The canvas (--vp-c-bg) in each mode, as custom.css sets it; a test keeps the two in step.
const CANVAS = { light: '#f7f6f2', dark: '#101216' };
// WCAG AA for normal-size text: links are body text.
const MIN_CONTRAST = 4.5;

function checkHex(field, value) {
  if (typeof value !== 'string' || !ACCENT_RE.test(value)) throw new Error(`docs-build: ${field} must be #rgb or #rrggbb, got ${JSON.stringify(value)}`);
}

const shades = (accent, soft, hover) => [
  `  --vp-c-brand-1: ${accent};`,
  `  --vp-c-brand-2: color-mix(in srgb, ${accent} 85%, ${hover});`,
  `  --vp-c-brand-3: ${accent};`,
  `  --vp-c-brand-soft: color-mix(in srgb, ${accent} ${soft}%, var(--vp-c-bg));`,
].join('\n');

const isDefault = (accent) => accent.toLowerCase() === DEFAULT_ACCENT;

function accentCss(accent, accentDark = null) {
  checkHex('accent', accent);
  if (accentDark !== null) checkHex('accent_dark', accentDark);
  const blocks = [];
  if (!isDefault(accent)) blocks.push(`:root {\n${shades(accent, 15, '#000')}\n}\n`);
  const dark = accentDark ?? (isDefault(accent) ? null : accent);
  if (dark !== null) blocks.push(`.dark {\n${shades(dark, 18, '#fff')}\n}\n`);
  return blocks.length ? `/* pages.json accent */\n${blocks.join('\n')}` : '';
}

// ---------- contrast ----------

function channels(hex) {
  const h = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

// Relative luminance, as WCAG 2 defines it for sRGB.
function luminance(hex) {
  const [r, g, b] = channels(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// The link colour each mode shows, with the pages.json field it comes from.
function linkColours(accent, accentDark) {
  let dark = { field: 'accent_dark', value: accentDark };
  if (accentDark === null) {
    dark = isDefault(accent) ? { field: null, value: DEFAULT_ACCENT_DARK } : { field: 'accent (no accent_dark is set)', value: accent };
  }
  return { light: { field: 'accent', value: accent }, dark };
}

// One message for each mode whose links fall below 4.5:1 against that mode's canvas. Advisory
// only: the build goes on, since a brand colour is the site's call.
function contrastWarnings(accent, accentDark = null) {
  const warnings = [];
  for (const [mode, { field, value }] of Object.entries(linkColours(accent, accentDark))) {
    const ratio = contrast(value, CANVAS[mode]);
    if (field === null || ratio >= MIN_CONTRAST) continue;
    warnings.push(`docs-build: pages.json ${field} ${value} has a contrast of ${ratio.toFixed(2)}:1 against the ${mode} canvas ${CANVAS[mode]}, below the ${MIN_CONTRAST}:1 that link text needs; pick a ${mode === 'light' ? 'darker' : 'lighter'} colour${mode === 'dark' ? ' for accent_dark' : ''}.`);
  }
  return warnings;
}

module.exports = { accentCss, contrast, contrastWarnings, CANVAS, MIN_CONTRAST };
