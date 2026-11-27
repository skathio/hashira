// The docs' half of the shared theme key. The landing pages (site-kit's theme.js) keep the
// visitor's choice in localStorage under `theme`: light, dark or auto, anything else auto.
// VitePress keeps its own under vitepress-theme-appearance. This inline <head> script runs
// before first paint and bridges the two, so the landing and the docs open in the same theme.
// The docs' theme control (vitepress/.vitepress/theme/ThemeSwitch.vue) writes both keys when
// the visitor picks a theme, so a system theme change in auto is never stored as a choice.

'use strict';

// Reads `theme`, sets the dark class itself (light or dark as stored, else the system's), and
// copies the choice to VitePress's key, which VitePress applies from then on. Every storage
// access is guarded, so with storage blocked the docs follow the system and nothing throws. It replaces VitePress's own
// check-dark-mode script, which reads storage unguarded (config.mts removes it).
const themeFromLanding = [
  ';(function(){var r=document.documentElement,t=null;',
  "try{t=localStorage.getItem('theme')}catch(e){}",
  "var m=t==='light'||t==='dark'?t:'auto';",
  "try{localStorage.setItem('vitepress-theme-appearance',m)}catch(e){}",
  "var d=m==='auto'?window.matchMedia('(prefers-color-scheme: dark)').matches:m==='dark';",
  "r.classList.toggle('dark',d)})()",
].join('');

// VitePress's own appearance script, which the build drops from every page.
const CHECK_DARK_MODE = /<script id="check-dark-mode">[\s\S]*?<\/script>/;

function dropCheckDarkMode(html) {
  return html.replace(CHECK_DARK_MODE, '');
}

module.exports = { themeFromLanding, dropCheckDarkMode };
