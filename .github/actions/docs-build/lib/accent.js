// The docs' brand colours from pages.json's `accent`. The shared theme (custom.css) holds
// hashira's own palette, a darker green for light mode and a lighter one for dark, which is
// what the default accent means. Any other accent is used in both modes, with the hover and
// soft shades mixed from it, as site-kit's tokens.css does for the landing pages.

'use strict';

const { DEFAULT_ACCENT } = require('./pages-config');

const ACCENT_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function accentCss(accent) {
  if (typeof accent !== 'string' || !ACCENT_RE.test(accent)) throw new Error(`docs-build: accent must be #rgb or #rrggbb, got ${JSON.stringify(accent)}`);
  if (accent.toLowerCase() === DEFAULT_ACCENT) return '';
  const shades = (soft, hover) => [
    `  --vp-c-brand-1: ${accent};`,
    `  --vp-c-brand-2: color-mix(in srgb, ${accent} 85%, ${hover});`,
    `  --vp-c-brand-3: ${accent};`,
    `  --vp-c-brand-soft: color-mix(in srgb, ${accent} ${soft}%, var(--vp-c-bg));`,
  ].join('\n');
  return `/* pages.json accent */\n:root {\n${shades(15, '#000')}\n}\n\n.dark {\n${shades(18, '#fff')}\n}\n`;
}

module.exports = { accentCss };
