// site-kit theme: auto (follow the system), light or dark. Load it in <head>, before the
// stylesheet paints, so a stored choice applies before first paint.
//
// The choice is kept under localStorage key `theme` as `light`, `dark` or `auto`. Any other
// value, or no value, means auto. When storage is unavailable (blocked, private mode, a
// throwing getter) the page uses auto and the toggle still works for the page's lifetime.
// The VitePress docs read and write the same key, so landing and docs open in one theme.
//
// It applies the choice as data-theme="light" or "dark" on <html> (none for auto), exposes
// window.siteTheme for <site-nav>, and fires `site-theme` on document after each change.
// A plain <button id="theme"> on the page is wired up as a toggle too.
(function () {
  'use strict';
  var KEY = 'theme';
  var ORDER = ['auto', 'light', 'dark'];
  var LABEL = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };
  var root = document.documentElement;

  function valid(v) { return ORDER.indexOf(v) >= 0 ? v : 'auto'; }
  function read() {
    try { return valid(window.localStorage.getItem(KEY)); } catch (e) { return 'auto'; }
  }
  function write(v) {
    try { window.localStorage.setItem(KEY, v); } catch (e) { /* storage blocked: keep it for this page */ }
  }
  function apply(v) {
    if (v === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', v);
  }

  var current = read();
  apply(current);

  function show(v) {
    current = valid(v);
    apply(current);
    document.dispatchEvent(new CustomEvent('site-theme', { detail: { theme: current } }));
  }

  var api = {
    get: function () { return current; },
    set: function (v) { show(v); write(current); return current; },
    next: function () { return api.set(ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]); },
    label: function (v) { return LABEL[valid(v)]; },
  };
  window.siteTheme = api;

  // Another tab changed the choice.
  window.addEventListener('storage', function (e) { if (e.key === KEY) show(e.newValue); });

  function wire(button) {
    function render() {
      button.textContent = api.label(current);
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
