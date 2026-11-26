// site-kit <site-nav>: the shared header of the skathio project pages, as a framework-free
// custom element. Load theme.js in <head> first, then this file.
//
// It renders, in order: the brand (logo and name, linking to the site root), the `nav`
// links, "Docs" (only when the site has docs), a slot for per-site extras (the element's
// own children), `home_link` when set, and the theme toggle.
//
// Its items come from an inline <script type="application/json"> child holding pages.json's
// field names (name, logo, nav, home_link, accent) plus `root` (the brand's href, default
// "./") and `docs` (the Docs href, or true for "docs/"); from attributes of the same names
// (`nav` and `home_link` as JSON); or from the `config` property (an object), which React 19
// sets directly. Attributes win over the property, the property over the JSON child.
//
//   <site-nav name="hashira" logo="mark.svg" docs="docs/">
//     <script type="application/json">{"nav":[{"label":"Flows","href":"#flows"}]}</script>
//     <a href="#extra">Extra</a>
//   </site-nav>
//
// Every label is set as text, never as markup, and an href or logo with a scheme other than
// http(s) is dropped. The element only writes to its shadow root, so the children React or a
// page generator renders into it stay theirs.
(function () {
  'use strict';
  if (window.customElements.get('site-nav')) return;

  var FIELDS = ['name', 'logo', 'root', 'docs', 'nav', 'home_link', 'accent'];
  var JSON_FIELDS = { nav: true, home_link: true };
  var ACCENT = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  var STYLE = [
    ':host{display:block;position:sticky;top:0;z-index:2}',
    'nav{display:flex;align-items:center;gap:var(--nav-gap,28px);padding:var(--nav-pad,12px 18px);',
    'border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--canvas) 85%,transparent);',
    'backdrop-filter:blur(8px);color:var(--ink);font:.93rem/1.6 var(--sans);overflow-x:auto}',
    'a{color:inherit;text-decoration:none;white-space:nowrap}a:hover{color:var(--accent)}',
    '.brand{display:flex;gap:8px;align-items:center;font-weight:800}.brand img{width:24px;height:24px}',
    '.link{color:var(--muted)}.sp{flex:1}.home{color:var(--muted);font-size:.85rem}',
    'button{font:inherit;color:var(--ink);background:none;border:1px solid var(--line);',
    'border-radius:var(--radius-sm,8px);padding:4px 12px;cursor:pointer;white-space:nowrap}',
    ':focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '@media (max-width:760px){.link{display:none}}',
  ].join('');

  function safeUrl(url) {
    if (typeof url !== 'string' || url === '') return null;
    var bare = url.replace(/[\u0000- \u007f]/g, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(bare) && !/^https?:/i.test(bare)) return null;
    return url;
  }

  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function inlineConfig(host) {
    var script = host.querySelector(':scope > script[type="application/json"]');
    var parsed = script ? parseJson(script.textContent) : null;
    return isObject(parsed) ? parsed : {};
  }

  function attrValue(host, field) {
    var raw = host.getAttribute(field);
    return JSON_FIELDS[field] ? parseJson(raw) : raw;
  }

  function readConfig(host) {
    var config = Object.assign({}, inlineConfig(host), isObject(host._config) ? host._config : {});
    FIELDS.forEach(function (field) {
      if (host.hasAttribute(field)) config[field] = attrValue(host, field);
    });
    return config;
  }

  function el(tag, props, text) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (props[k] !== null && props[k] !== undefined) node.setAttribute(k, props[k]);
    });
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function link(entry, cls) {
    var ok = isObject(entry) && typeof entry.label === 'string' && entry.label !== '';
    return ok ? el('a', { class: cls, part: cls, href: safeUrl(entry.href) }, entry.label) : null;
  }

  function brand(config) {
    var a = el('a', { class: 'brand', part: 'brand', href: safeUrl(config.root) || './' });
    var logo = safeUrl(config.logo);
    if (logo) a.appendChild(el('img', { src: logo, alt: '' }));
    a.appendChild(el('span', {}, typeof config.name === 'string' ? config.name : ''));
    return a;
  }

  function docsLink(docs) {
    var href = docs === true || docs === '' ? 'docs/' : safeUrl(docs);
    return href ? el('a', { class: 'docs', part: 'docs', href: href }, 'Docs') : null;
  }

  function theme() { return window.siteTheme || null; }

  function toggle() {
    var b = el('button', { type: 'button', part: 'toggle', class: 'toggle' });
    b.addEventListener('click', function () {
      if (theme()) theme().next();
    });
    return b;
  }

  function showTheme(button) {
    var api = theme();
    var current = api ? api.get() : 'auto';
    button.hidden = !api;
    button.textContent = api ? api.label(current) : 'Theme';
    button.setAttribute('aria-label', 'Theme: ' + current);
  }

  function applyAccent(accent) {
    if (typeof accent === 'string' && ACCENT.test(accent)) {
      document.documentElement.style.setProperty('--site-accent', accent);
    }
  }

  function items(config) {
    var nav = Array.isArray(config.nav) ? config.nav : [];
    return [brand(config)]
      .concat(nav.map(function (entry) { return link(entry, 'link'); }))
      .concat([docsLink(config.docs), el('slot'), el('span', { class: 'sp' })])
      .concat([config.home_link ? link(config.home_link, 'home') : null])
      .filter(Boolean);
  }

  class SiteNav extends HTMLElement {
    static get observedAttributes() { return FIELDS; }

    constructor() {
      super();
      this._config = null;
      this._onTheme = this._showTheme.bind(this);
    }

    get config() { return this._config; }
    set config(value) {
      this._config = value;
      this._render();
    }

    connectedCallback() {
      // `config` set on the element before this script defined it (a page script or a framework
      // that rendered first) is an own property hiding the setter: move it to the setter.
      if (Object.prototype.hasOwnProperty.call(this, 'config')) {
        var early = this.config;
        delete this.config;
        this._config = early;
      }
      document.addEventListener('site-theme', this._onTheme);
      this._render();
      this._watch();
      // A parser-made element connects before its children: read the JSON child once it is there.
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', this._render.bind(this));
    }

    disconnectedCallback() {
      document.removeEventListener('site-theme', this._onTheme);
      if (this._observer) this._observer.disconnect();
      this._observer = null;
    }

    attributeChangedCallback() { this._render(); }

    _watch() {
      if (this._observer || typeof MutationObserver === 'undefined') return;
      this._observer = new MutationObserver(this._render.bind(this));
      this._observer.observe(this, { childList: true, subtree: true, characterData: true });
    }

    _showTheme() {
      if (this._toggle) showTheme(this._toggle);
    }

    _render() {
      if (!this.isConnected) return;
      var config = readConfig(this);
      var root = this.shadowRoot || this.attachShadow({ mode: 'open' });
      var bar = el('nav', { part: 'bar', 'aria-label': 'Site' });
      items(config).forEach(function (node) { bar.appendChild(node); });
      this._toggle = toggle();
      bar.appendChild(this._toggle);
      root.replaceChildren(el('style', {}, STYLE), bar);
      this._showTheme();
      applyAccent(config.accent);
    }
  }

  window.customElements.define('site-nav', SiteNav);
})();
