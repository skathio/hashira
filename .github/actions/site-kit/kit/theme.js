// site-kit theme: auto (follow the system), light or dark. Load it in <head>, before the
// stylesheet paints, so a stored choice applies before first paint.
//
// The choice is kept under localStorage key `theme` as `light`, `dark` or `auto`. Any other
// value, or no value, means auto. When storage is unavailable (blocked, private mode, a
// throwing getter) the page uses auto and the toggle still works for the page's lifetime.
// The VitePress docs read and write the same key, so landing and docs open in one theme.
//
// It applies the choice as data-theme="light" or "dark" on <html> (none for auto), and the theme
// the page shows as data-theme-resolved="light" or "dark", which follows the system's
// prefers-color-scheme while in auto. It exposes window.siteTheme for <site-nav>, and fires
// `site-theme` on document after each change. A plain <button id="theme"> on the page is wired
// up as a toggle too.
//
// Each press goes auto -> the opposite of the system theme -> the system theme -> auto, so the
// first press from auto always changes what the page shows. The docs' control (docs-build's
// ThemeSwitch.vue) steps through the same cycle.
(function () {
  'use strict';
  var KEY = 'theme';
  var VALUES = ['auto', 'light', 'dark'];
  var LABEL = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };
  // The toggles show these icons and the label's word: the label's glyphs render at different
  // sizes from font to font (◐ comes out half-size in some system fonts).
  var SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" style="vertical-align:-.15em">';
  var ICON = {
    auto: SVG + '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/>'
      + '<path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg>',
    light: SVG + '<circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4'
      + 'M11.55 11.55l1.4 1.4M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    dark: SVG + '<path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z" fill="currentColor"/></svg>',
  };
  var root = document.documentElement;

  function valid(v) { return VALUES.indexOf(v) >= 0 ? v : 'auto'; }
  function read() {
    try { return valid(window.localStorage.getItem(KEY)); } catch (e) { return 'auto'; }
  }
  function write(v) {
    try { window.localStorage.setItem(KEY, v); } catch (e) { /* storage blocked: keep it for this page */ }
  }
  var media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function system() { return media && media.matches ? 'dark' : 'light'; }
  function apply(v) {
    if (v === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', v);
    root.setAttribute('data-theme-resolved', v === 'auto' ? system() : v);
  }
  // The step after v: from auto the theme the system does not show, then the system's own,
  // then back to auto.
  function following(v) {
    var sys = system();
    if (v === 'auto') return sys === 'dark' ? 'light' : 'dark';
    return v === sys ? 'auto' : sys;
  }

  var current = read();
  apply(current);
  // In auto the resolved theme follows the system; an explicit choice ignores it.
  function onSystem() { apply(current); }
  if (media && media.addEventListener) media.addEventListener('change', onSystem);
  else if (media && media.addListener) media.addListener(onSystem);

  function show(v) {
    current = valid(v);
    apply(current);
    document.dispatchEvent(new CustomEvent('site-theme', { detail: { theme: current } }));
  }

  var api = {
    get: function () { return current; },
    set: function (v) { show(v); write(current); return current; },
    next: function () { return api.set(following(current)); },
    label: function (v) { return LABEL[valid(v)]; },
    // A fixed SVG string from this file, never built from page input.
    icon: function (v) { return ICON[valid(v)]; },
    word: function (v) { var l = LABEL[valid(v)]; return l.slice(l.indexOf(' ') + 1); },
  };
  window.siteTheme = api;

  // Another tab changed the choice.
  window.addEventListener('storage', function (e) { if (e.key === KEY) show(e.newValue); });

  function wire(button) {
    function render() {
      button.innerHTML = api.icon(current);
      var word = document.createElement('span');
      word.textContent = ' ' + api.word(current);
      button.appendChild(word);
      button.setAttribute('aria-label', 'Theme: ' + current);
    }
    button.hidden = false;
    render();
    button.addEventListener('click', function () { api.next(); });
    document.addEventListener('site-theme', render);
  }
  function wirePageButton() {
    var b = document.getElementById('theme');
    if (b) wire(b);
  }
  api.wire = wire;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wirePageButton);
  else wirePageButton();
})();
