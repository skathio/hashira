// The docs' half of the shared theme key. The landing pages (site-kit's theme.js) keep the
// visitor's choice in localStorage under `theme`: light, dark or auto, anything else auto.
// VitePress keeps its own under vitepress-theme-appearance. These inline <head> scripts run
// before first paint and bridge the two, so the landing and the docs open in the same theme.

'use strict';

// Reads `theme`, sets the dark class itself (light or dark as stored, else the system's), and
// copies the choice to VitePress's key for its toggle. Every storage access is guarded, so with
// storage blocked the docs follow the system and nothing throws. It replaces VitePress's own
// check-dark-mode script, which reads storage unguarded (config.mts removes it).
const themeFromLanding = [
  ';(function(){var r=document.documentElement,t=null;',
  "try{t=localStorage.getItem('theme')}catch(e){}",
  "var m=t==='light'||t==='dark'?t:'auto';",
  "try{localStorage.setItem('vitepress-theme-appearance',m)}catch(e){}",
  "var d=m==='auto'?window.matchMedia('(prefers-color-scheme: dark)').matches:m==='dark';",
  "r.classList.toggle('dark',d)})()",
].join('');

// When the visitor flips the docs toggle, store light or dark under the landing key. The
// observer starts after load, so the initial class does not count as a choice.
const themeToLanding = [
  "document.addEventListener('DOMContentLoaded',function(){var r=document.documentElement,d=r.classList.contains('dark');",
  "new MutationObserver(function(){var n=r.classList.contains('dark');if(n===d){return}d=n;",
  "try{localStorage.setItem('theme',n?'dark':'light')}catch(e){}}).observe(r,{attributes:true,attributeFilter:['class']})})",
].join('');

// VitePress's own appearance script, which the build drops from every page.
const CHECK_DARK_MODE = /<script id="check-dark-mode">[\s\S]*?<\/script>/;

function dropCheckDarkMode(html) {
  return html.replace(CHECK_DARK_MODE, '');
}

module.exports = { themeFromLanding, themeToLanding, dropCheckDarkMode };
