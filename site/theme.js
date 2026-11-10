// Theme toggle: auto (follow the system), light, dark. The choice is a per-visitor
// convenience kept in localStorage; the page renders correctly without it.
(function () {
  var KEY = 'theme';
  var order = ['auto', 'light', 'dark'];
  var label = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };
  function read() { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } }
  function write(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* storage blocked: keep it for this page only */ } }
  function apply(v) {
    if (v === 'light' || v === 'dark') document.documentElement.setAttribute('data-theme', v);
    else document.documentElement.removeAttribute('data-theme');
  }
  var current = read();
  if (order.indexOf(current) < 0) current = 'auto';
  apply(current);
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('theme');
    if (!b) return;
    b.hidden = false;
    b.textContent = label[current];
    b.setAttribute('aria-label', 'Theme: ' + current);
    b.addEventListener('click', function () {
      current = order[(order.indexOf(current) + 1) % order.length];
      apply(current); write(current);
      b.textContent = label[current];
      b.setAttribute('aria-label', 'Theme: ' + current);
    });
  });
})();
