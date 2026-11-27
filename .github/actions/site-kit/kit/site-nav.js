// site-kit <site-nav>: the shared header of the skathio project pages, as a framework-free
// custom element. Load theme.js in <head> first, then this file.
//
// It renders, in order: the brand (logo and name, linking to the site root), the `nav`
// links, "Docs" (only when the site has docs), a slot for per-site extras (the element's
// own children), `home_link` when set, and the theme toggle. The brand stays on the left;
// Docs, the extras, home_link and the toggle form a right group that never shrinks. When the
// nav links do not fit the element's measured width, and always on a phone-sized element,
// they collapse behind a disclosure button (aria-expanded; Escape closes it).
//
// Its items come from an inline <script type="application/json"> child holding pages.json's
// field names (name, logo, nav, home_link, accent, accent_dark) plus `root` (the brand's href, default
// "./") and `docs` (the Docs href, or true for "docs/"); from attributes of the same names
// (`nav` and `home_link` as JSON); or from the `config` property (an object), which React 19
// sets directly. Attributes win over the property, the property over the JSON child.
//
//   <site-nav role="navigation" aria-label="Site" name="hashira" logo="mark.svg" docs="docs/">
//     <script type="application/json">{"nav":[{"label":"Flows","href":"#flows"}]}</script>
//     <a href="#extra">Extra</a>
//   </site-nav>
//
// Children: a `slot="brand"` child replaces the logo and name inside the brand link; a
// `slot="fallback"` child shows only until this script defines the element and is never
// slotted after; any other child is an extra. A nav or Docs link whose href is this page gets
// aria-current="page"; with the `scrollspy` attribute, the #hash link of the section in view
// gets aria-current="location". After the first render the element sets its `ready`
// attribute and fires `site-nav:ready` (bubbling, composed) once.
//
// Every label is set as text, never as markup, and an href or logo with a scheme other than
// http(s) is dropped. The element only writes to its shadow root (and its own `ready`
// attribute), so the children React or a page generator renders into it stay theirs.
(function () {
  'use strict';
  if (window.customElements.get('site-nav')) return;

  var FIELDS = ['name', 'logo', 'root', 'docs', 'nav', 'home_link', 'accent', 'accent_dark'];
  var OBSERVED = FIELDS.concat(['scrollspy', 'role']);
  var JSON_FIELDS = { nav: true, home_link: true };
  var ACCENT = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  // Below this element width the links always sit behind the menu button.
  var PHONE_MAX = 640;
  // The method that handles each event type the element listens for (see handleEvent).
  var HANDLERS = { 'site-theme': '_theme', scroll: '_spy', resize: '_spy', keydown: '_key', click: '_click' };
  var MENU_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">'
    + '<path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  var STYLE = [
    ':host{display:block;position:sticky;top:0;z-index:2}',
    '.bar{display:flex;flex-wrap:nowrap;align-items:center;gap:var(--nav-gap,28px);padding:var(--nav-pad,12px 18px);',
    'box-sizing:border-box;min-height:var(--nav-h,3.7rem);border-bottom:1px solid var(--line);',
    'background:color-mix(in srgb,var(--canvas) 85%,transparent);',
    'backdrop-filter:blur(8px);color:var(--ink);font:.93rem/1.6 var(--sans)}',
    'a{color:inherit;text-decoration:none;white-space:nowrap}a:hover{color:var(--accent)}',
    '.brand{display:flex;gap:8px;align-items:center;font-weight:800;flex:0 1 auto;min-width:0}',
    '.brand img{width:24px;height:24px;flex:none}',
    '.brand span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.measure .brand{flex-shrink:0}',
    '.link{color:var(--muted)}.sp{flex:1 1 0;min-width:0}.home{color:var(--muted);font-size:.85rem}',
    '.docs,.home,.toggle,::slotted(*){flex-shrink:0}',
    '.docs{color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:1px 10px;font-weight:600}',
    '.docs:hover{background:var(--accent-soft)}',
    '[aria-current]{color:var(--accent);box-shadow:inset 0 -2px 0 var(--accent)}',
    '::slotted(a){color:var(--muted);text-decoration:none;white-space:nowrap}',
    '::slotted(a:hover){color:var(--accent)}',
    '::slotted(a:focus-visible){outline:2px solid var(--accent);outline-offset:2px}',
    'button{font:inherit;color:var(--ink);background:none;border:1px solid var(--line);',
    'border-radius:var(--radius-sm,8px);padding:4px 12px;cursor:pointer;white-space:nowrap}',
    '.menu{display:none;align-items:center;gap:6px;flex-shrink:0}.menu svg{display:block}',
    '.toggle{display:inline-flex;align-items:center;gap:6px}.toggle[hidden]{display:none}.ti svg{display:block}',
    '.collapsed .menu{display:inline-flex}.collapsed .link{display:none}',
    // Collapsed, the brand takes the free space from a zero basis, so the open menu's links wrap
    // onto rows of their own while the top row stays one line.
    '.collapsed .brand{flex:1 1 0;min-width:24px}.collapsed .sp{display:none}',
    '.collapsed.open{flex-wrap:wrap}',
    '.collapsed.open .link{display:block;order:1;flex:0 0 100%;padding:6px 2px;border-top:1px solid var(--line)}',
    '.collapsed.open .link[aria-current]{box-shadow:inset 3px 0 0 var(--accent);padding-left:10px}',
    '.compact .tl{display:none}.compact .menu,.compact .toggle{padding:4px 8px}',
    '.compact{column-gap:10px}',
    ':focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
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
    for (var i = 0; i < FIELDS.length; i++) {
      if (host.hasAttribute(FIELDS[i])) config[FIELDS[i]] = attrValue(host, FIELDS[i]);
    }
    return config;
  }

  function el(tag, props, text) {
    var node = document.createElement(tag);
    for (var k in props || {}) {
      if (props[k] !== null && props[k] !== undefined) node.setAttribute(k, props[k]);
    }
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  // A link whose href is this page, without a #fragment (a section link is not the page).
  function isCurrentPage(href) {
    if (!href || typeof URL !== 'function' || typeof location === 'undefined') return false;
    var url;
    try { url = new URL(href, location.href); } catch (e) { return false; }
    var index = /\/index\.html?$/;
    return !url.hash && url.origin === location.origin
      && url.pathname.replace(index, '/') === location.pathname.replace(index, '/');
  }

  function link(entry, cls) {
    var ok = isObject(entry) && typeof entry.label === 'string' && entry.label !== '';
    if (!ok) return null;
    var href = safeUrl(entry.href);
    var current = cls !== 'home' && isCurrentPage(href) ? 'page' : null;
    return el('a', { class: cls, part: cls, href: href, 'aria-current': current }, entry.label);
  }

  // A filled brand slot replaces the logo and name; the slot itself is all the kit renders.
  function brand(config, ownBrand) {
    var a = el('a', { class: 'brand', part: 'brand', href: safeUrl(config.root) || './' });
    if (ownBrand) {
      a.appendChild(el('slot', { name: 'brand' }));
      return a;
    }
    var logo = safeUrl(config.logo);
    if (logo) a.appendChild(el('img', { src: logo, alt: '' }));
    a.appendChild(el('span', {}, typeof config.name === 'string' ? config.name : ''));
    return a;
  }

  function docsLink(docs) {
    var href = docs === true || docs === '' ? 'docs/' : safeUrl(docs);
    return href ? link({ label: 'Docs', href: href }, 'docs') : null;
  }

  // The icon (theme.js's fixed SVG) stays on a phone-sized bar; the word (`.tl`) hides there.
  // Without theme.js the toggle stays hidden and empty.
  function showTheme(button) {
    var api = window.siteTheme || null;
    button.hidden = !api;
    button.textContent = '';
    if (!api) return;
    var current = api.get();
    var icon = el('span', { class: 'ti', 'aria-hidden': 'true' });
    icon.innerHTML = api.icon(current);
    button.appendChild(icon);
    button.appendChild(el('span', { class: 'tl' }, api.word(current)));
    button.setAttribute('aria-label', 'Theme: ' + current);
  }

  function menuButton() {
    var b = el('button', { type: 'button', part: 'menu', class: 'menu', 'aria-expanded': 'false', 'aria-label': 'Menu' });
    b.innerHTML = MENU_ICON;
    b.appendChild(el('span', { class: 'tl' }, 'Menu'));
    return b;
  }

  // accent is the light-mode colour and accent_dark the dark one (tokens.css falls back to
  // accent when it is unset). Anything but #rgb or #rrggbb is ignored, so no value reaches CSS.
  function setAccent(name, value) {
    if (typeof value === 'string' && ACCENT.test(value)) document.documentElement.style.setProperty(name, value);
  }
  function applyAccent(config) {
    setAccent('--site-accent', config.accent);
    setAccent('--site-accent-dark', config.accent_dark);
  }

  // The bar's children, flat: brand, menu button, links, spacer, then the right group.
  function items(config, parts) {
    var nav = Array.isArray(config.nav) ? config.nav : [];
    var out = [brand(config, parts.ownBrand), parts.menu];
    for (var i = 0; i < nav.length; i++) out.push(link(nav[i], 'link'));
    out.push(el('span', { class: 'sp' }), docsLink(config.docs), el('slot'));
    out.push(config.home_link ? link(config.home_link, 'home') : null, parts.toggle);
    return out.filter(Boolean);
  }

  // Whether the links fit inline: lay them out inline, with the brand at full width, and see
  // whether the bar overflows. Runs inside one task, so nothing paints in between.
  function linksFit(bar) {
    var was = bar.getAttribute('class');
    bar.setAttribute('class', 'bar measure');
    var fits = bar.scrollWidth <= bar.clientWidth;
    bar.setAttribute('class', was);
    return fits;
  }

  // A hash that does not decode ('#100%') names no section, rather than throwing out of render.
  function decodeHash(hash) {
    try {
      return decodeURIComponent(hash);
    } catch (e) {
      return null;
    }
  }

  // The #hash links, and of those the one whose section is in view: the last section whose
  // top has passed `below` (the bar's bottom edge).
  function sectionInView(links, below) {
    var hashLinks = [];
    var current = null;
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      var id = /^#./.test(href) ? decodeHash(href.slice(1)) : null;
      var target = id === null ? null : document.getElementById(id);
      if (!target) continue;
      hashLinks.push(links[i]);
      if (target.getBoundingClientRect().top <= below) current = links[i];
    }
    return { links: hashLinks, current: current };
  }

  class SiteNav extends HTMLElement {
    static get observedAttributes() { return OBSERVED; }

    constructor() {
      super();
      this._config = null;
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
      document.addEventListener('site-theme', this);
      document.addEventListener('click', this);
      this._render();
      this._watch();
      // A parser-made element connects before its children: read the JSON child once it is there.
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', this._render.bind(this));
    }

    disconnectedCallback() {
      document.removeEventListener('site-theme', this);
      document.removeEventListener('click', this);
      this._spyOn(false);
      if (this._observer) this._observer.disconnect();
      if (this._sizer) this._sizer.disconnect();
      this._observer = null;
      this._sizer = null;
    }

    attributeChangedCallback() { this._render(); }

    // One listener for every event the element handles: the theme changing, clicks and keys
    // in the bar, a click elsewhere on the page, and scrolling for `scrollspy`.
    handleEvent(e) { this[HANDLERS[e.type]](e); }

    _theme() {
      if (this._toggle) showTheme(this._toggle);
    }

    _click(e) {
      var path = e.composedPath();
      if (e.currentTarget === document) {
        if (path.indexOf(this) < 0) this._setOpen(false);
        return;
      }
      var hit = path[0];
      // The toggle holds an icon and a word, so a click usually lands on something inside it.
      if (path.indexOf(this._toggle) >= 0 && window.siteTheme) window.siteTheme.next();
      else if (this._menu && path.indexOf(this._menu) >= 0) this._setOpen(!this._isOpen());
      else if (hit && hit.getAttribute && hit.getAttribute('part') === 'link') this._setOpen(false);
    }

    // Enter toggles the menu on keydown, and preventDefault stops the browser's own click from
    // toggling it back; Escape closes an open menu and returns focus to its button.
    _key(e) {
      var onMenu = !!this._menu && e.composedPath()[0] === this._menu;
      if (e.key === 'Enter' && onMenu) {
        e.preventDefault();
        this._setOpen(!this._isOpen());
      } else if (e.key === 'Escape' && this._isOpen()) {
        this._setOpen(false);
        this._menu.focus();
      }
    }

    _watch() {
      if (!this._observer && typeof MutationObserver !== 'undefined') {
        this._observer = new MutationObserver(this._render.bind(this));
        this._observer.observe(this, { childList: true, subtree: true, characterData: true });
      }
      // The links collapse on the element's own width, so a header in a narrow column collapses too.
      if (!this._sizer && typeof ResizeObserver === 'function') {
        this._sizer = new ResizeObserver(this._fit.bind(this));
        this._sizer.observe(this);
      }
    }

    _render() {
      if (!this.isConnected) return;
      var config = readConfig(this);
      var root = this.shadowRoot || this.attachShadow({ mode: 'open' });
      // A host that is already a navigation landmark gets a plain bar, not a second <nav>.
      var landmark = this.getAttribute('role') !== 'navigation';
      var bar = el(landmark ? 'nav' : 'div', { class: 'bar', part: 'bar', 'aria-label': landmark ? 'Site' : null });
      var parts = {
        ownBrand: !!this.querySelector(':scope > [slot="brand"]'),
        // The menu needs a measured width; without ResizeObserver the links stay inline.
        menu: typeof ResizeObserver === 'function' ? menuButton() : null,
        toggle: el('button', { type: 'button', part: 'toggle', class: 'toggle' }),
      };
      var nodes = items(config, parts);
      for (var i = 0; i < nodes.length; i++) bar.appendChild(nodes[i]);
      bar.addEventListener('click', this);
      bar.addEventListener('keydown', this);
      root.replaceChildren(el('style', {}, STYLE), bar);
      this._bar = bar;
      this._menu = parts.menu;
      this._toggle = parts.toggle;
      showTheme(this._toggle);
      applyAccent(config);
      this._fit();
      this._spyOn(this.hasAttribute('scrollspy'));
      if (this._spying) this._spy();
      this._announce();
    }

    _announce() {
      if (this._ready || document.readyState === 'loading') return;
      this._ready = true;
      this.setAttribute('ready', '');
      if (typeof CustomEvent === 'function') {
        this.dispatchEvent(new CustomEvent('site-nav:ready', { bubbles: true, composed: true }));
      }
    }

    _links() {
      return this._bar ? Array.prototype.slice.call(this._bar.querySelectorAll('.link')) : [];
    }

    _fit() {
      if (!this._menu) return;
      var phone = this.getBoundingClientRect().width < PHONE_MAX;
      var collapse = this._links().length > 0 && (phone || !linksFit(this._bar));
      this._bar.classList.toggle('compact', phone);
      this._bar.classList.toggle('collapsed', collapse);
      if (!collapse) this._setOpen(false);
    }

    _setOpen(open) {
      if (!this._menu) return;
      this._menu.setAttribute('aria-expanded', open ? 'true' : 'false');
      this._bar.classList.toggle('open', open);
    }

    _isOpen() { return !!this._menu && this._menu.getAttribute('aria-expanded') === 'true'; }

    _spyOn(on) {
      var method = on ? 'addEventListener' : 'removeEventListener';
      if (on === !!this._spying) return;
      window[method]('scroll', this, { passive: true });
      window[method]('resize', this, { passive: true });
      this._spying = on;
    }

    _spy() {
      var found = sectionInView(this._links(), this.getBoundingClientRect().bottom + 8);
      for (var i = 0; i < found.links.length; i++) {
        if (found.links[i] === found.current) found.links[i].setAttribute('aria-current', 'location');
        else found.links[i].removeAttribute('aria-current');
      }
    }
  }

  window.customElements.define('site-nav', SiteNav);
})();
