// The user's rules for the site-kit action (brief requirements 14-16, landing half, and the
// catalog line of 24): the copy into <dest>/_kit/, tokens.css, theme.js's storage rules and
// <site-nav>'s order and escaping. Each test goes through the action's own files: action.yml
// (its run steps executed with bash, the way a runner does), and kit/tokens.css, kit/theme.js
// and kit/site-nav.js loaded into a small fake browser built below (no packages to install).
//
// Run with:
//   node --test tests/site-kit/site-kit-rules.test.js
//
// Left to the builder, so not tested here: how "works in React 19" is shown, how the site's
// accent reaches --accent and --accent-soft, what marks the folder's version, which attribute
// or JSON key says the site has docs, the brand's exact href, the toggle's cycle order, and
// how auto shows on <html> (anything but data-theme="light" or "dark" reads as auto here).
// The inline JSON child is read as <script type="application/json"> holding pages.json's own
// field names (name, logo, nav, home_link), the shape requirement 17 says both headers share.
//
// The fake browser keeps to SoMi's complexity limits for a test file, so it picks from lookup
// tables where a browser would branch.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ACTION_DIR = path.join(REPO, '.github', 'actions', 'site-kit');
const KIT_DIR = path.join(ACTION_DIR, 'kit');
const KIT_FILES = ['tokens.css', 'theme.js', 'site-nav.js'];

const temps = [];
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const readKit = (name) => fs.readFileSync(path.join(KIT_DIR, name), 'utf8');

// ---------- action.yml, read through PyYAML (the shape lints' own parser) ----------

function loadYaml(file) {
  const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))';
  const run = spawnSync('python3', ['-c', py, file], { encoding: 'utf8' });
  assert.equal(run.status, 0, `could not read ${file}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

const actionSpec = () => loadYaml(path.join(ACTION_DIR, 'action.yml'));
const runSteps = (spec) => spec.runs.steps.filter((s) => s.run);

// ---------- running the composite action's steps the way a runner does ----------

const FAKE_SHA = 'a'.repeat(40);

function expressionValue(expr, ctx) {
  const [scope, key] = expr.trim().split('.');
  const github = {
    action_path: ctx.actionDir, workspace: ctx.workspace, sha: FAKE_SHA, workflow_sha: FAKE_SHA,
    action_ref: 'v3', action_repository: 'skathio/hashira', repository: 'octo/site', ref: 'refs/heads/main',
  };
  return { inputs: ctx.inputs, github, runner: { temp: ctx.outer } }[scope]?.[key] ?? '';
}

const substitute = (text, ctx) => String(text ?? '')
  .replace(/\$\{\{([^}]*)\}\}/g, (_, expr) => expressionValue(expr, ctx));

const inputsWithDefaults = (spec, given) => ({
  ...Object.fromEntries(Object.entries(spec.inputs ?? {}).map(([name, def]) => [name, def.default ?? ''])),
  ...given,
});

function runnerEnv(ctx) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GITHUB_')));
  return {
    ...env, GITHUB_WORKSPACE: ctx.workspace, GITHUB_ACTION_PATH: ctx.actionDir,
    GITHUB_OUTPUT: path.join(ctx.outer, 'output'), GITHUB_ENV: path.join(ctx.outer, 'env'),
    GITHUB_STEP_SUMMARY: path.join(ctx.outer, 'summary'), GITHUB_SHA: FAKE_SHA, RUNNER_TEMP: ctx.outer,
  };
}

function runStep(step, ctx) {
  const stepEnv = Object.entries(step.env ?? {}).map(([k, v]) => [k, substitute(v, ctx)]);
  const env = { ...runnerEnv(ctx), ...Object.fromEntries(stepEnv) };
  const cwd = path.resolve(ctx.workspace, substitute(step['working-directory'], ctx));
  const script = substitute(step.run, ctx);
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd, env, encoding: 'utf8' });
}

// Runs every `run:` step in order and stops at the first that fails, as a runner does.
function runAction(given, actionDir = ACTION_DIR) {
  const outer = tempDir('site-kit-run-');
  const workspace = path.join(outer, 'ws');
  fs.mkdirSync(path.join(workspace, 'site', 'dist'), { recursive: true });
  const spec = loadYaml(path.join(actionDir, 'action.yml'));
  const ctx = { outer, workspace, actionDir, inputs: inputsWithDefaults(spec, given) };
  const result = { status: 0, stderr: '', outer, workspace };
  runSteps(spec).find((step) => {
    const run = runStep(step, ctx);
    result.stderr += run.stderr;
    result.status = run.status;
    return run.status !== 0;
  });
  return result;
}

// ---------- (14) the copy ----------

test('(14) site-kit is a composite action with a `dest` input', () => {
  const spec = actionSpec();
  assert.equal(spec.runs.using, 'composite');
  assert.ok('dest' in (spec.inputs ?? {}), 'action.yml has no `dest` input');
});

test('(14) the kit folder holds tokens.css, theme.js and site-nav.js', () => {
  KIT_FILES.forEach((name) => assert.ok(fs.statSync(path.join(KIT_DIR, name)).isFile(), name));
});

['site', 'site/dist'].forEach((dest) => {
  test(`(14) dest "${dest}": the kit is copied to ${dest}/_kit/ unchanged`, () => {
    const run = runAction({ dest });
    assert.equal(run.status, 0, run.stderr);
    KIT_FILES.forEach((name) => {
      const copied = fs.readFileSync(path.join(run.workspace, dest, '_kit', name), 'utf8');
      assert.equal(copied, readKit(name), `${dest}/_kit/${name} differs from kit/${name}`);
    });
  });
});

test('(14) the copy comes from the action folder the caller ran, not from anywhere else', () => {
  const pinned = path.join(tempDir('site-kit-pinned-'), 'site-kit');
  fs.cpSync(ACTION_DIR, pinned, { recursive: true });
  fs.appendFileSync(path.join(pinned, 'kit', 'tokens.css'), '\n/* pinned-copy-marker */\n');
  const run = runAction({ dest: 'site' }, pinned);
  assert.equal(run.status, 0, run.stderr);
  const copied = fs.readFileSync(path.join(run.workspace, 'site', '_kit', 'tokens.css'), 'utf8');
  assert.ok(copied.includes('pinned-copy-marker'), 'tokens.css did not come from the running action folder');
});

// Convention: paths are rejected for traversal and absolute form, with a `::error::<name>:`
// annotation on stderr and exit 1.
test('(convention) dest with a ".." segment fails with a site-kit error and writes nothing outside', () => {
  const run = runAction({ dest: '../escape' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /::error::site-kit:/);
  assert.equal(fs.existsSync(path.join(run.outer, 'escape')), false);
});

test('(convention) an absolute dest fails with a site-kit error and writes nothing there', () => {
  const abs = path.join(tempDir('site-kit-abs-'), 'out');
  const run = runAction({ dest: abs });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /::error::site-kit:/);
  assert.equal(fs.existsSync(path.join(abs, '_kit')), false);
});

test('(convention) no run: step interpolates an input with ${{ }}; inputs go through env:', () => {
  runSteps(actionSpec()).forEach((step) => {
    assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./, `step "${step.name}" puts an input into run:`);
  });
});

test('(convention) every third-party action in site-kit is pinned to a full commit SHA', () => {
  const remote = actionSpec().runs.steps.filter((s) => /^[^./][^@]*@/.test(s.uses ?? ''));
  remote.forEach((step) => assert.match(step.uses, /@[0-9a-f]{40}$/, `unpinned: ${step.uses}`));
});

// ---------- (24) the catalog ----------

test('(24) docs/catalog.md has a site-kit section with a uses: snippet not pinned to main', () => {
  const catalog = fs.readFileSync(path.join(REPO, 'docs', 'catalog.md'), 'utf8');
  const body = catalog.split(/^(?=#{1,3}\s)/m).find((s) => /^### site-kit[ \t]*\n/.test(s));
  assert.ok(body, 'no `### site-kit` section in docs/catalog.md');
  const ref = body.match(/uses:\s*skathio\/hashira\/\.github\/actions\/site-kit@(\S+)/);
  assert.ok(ref, 'no `uses: skathio/hashira/.github/actions/site-kit@<ref>` snippet');
  assert.notEqual(ref[1], 'main');
});

test('(24) catalog shape-validate passes, and so does its --self-test', () => {
  [[], ['--self-test']].forEach((args) => {
    const run = spawnSync('python3', ['tests/catalog/shape-validate.py', ...args], { cwd: REPO, encoding: 'utf8' });
    assert.equal(run.status, 0, `shape-validate ${args.join(' ')}: ${run.stdout}${run.stderr}`);
  });
});

// ---------- (14) tokens.css ----------

const declarations = (body) => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)]
  .map((m) => [m[1], m[2].trim().replace(/\s+/g, ' ')]));
const merged = (bodies) => Object.assign({}, ...bodies.map(declarations));

const LIGHT_RULE = /(?:^|\})\s*:root\s*\{([^{}]*)\}/g;
const FORCED_DARK_RULE = /(?:^|\})\s*[^{}@]*\[\s*data-theme\s*=\s*["']?dark["']?\s*\][^{}]*\{([^{}]*)\}/g;
const DARK_MEDIA = /@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{([\s\S]*?\})\s*\}/g;
const NOT_LIGHT_RULE = /[^{}]*:not\(\s*\[\s*data-theme\s*=\s*["']?light["']?\s*\]\s*\)[^{}]*\{([^{}]*)\}/g;

function tokenSets() {
  const css = readKit('tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const media = [...css.matchAll(DARK_MEDIA)].map((m) => m[1]);
  return {
    light: merged([...css.matchAll(LIGHT_RULE)].map((m) => m[1])),
    mediaDark: merged(media.flatMap((body) => [...body.matchAll(NOT_LIGHT_RULE)].map((m) => m[1]))),
    forcedDark: merged([...css.matchAll(FORCED_DARK_RULE)].map((m) => m[1])),
  };
}

const hex6 = (v) => String(v ?? '').replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, '#$1$1$2$2$3$3').toLowerCase();

// Today's landing values, the same in hashira's and rogue's site/index.html.
const LIGHT = { '--canvas': '#f7f6f2', '--surface': '#ffffff', '--line': '#dedbd2', '--ink': '#1b1d22', '--muted': '#5b606b', '--code': '#efece4' };
const DARK = { '--canvas': '#101216', '--surface': '#171a20', '--line': '#2b3039', '--ink': '#e8e9ec', '--muted': '#a0a6b1', '--code': '#1f232b' };
const TYPE = {
  '--sans': 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
  '--mono': 'ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace',
};

test("(14) tokens.css keeps today's light colours under :root", () => {
  const { light } = tokenSets();
  Object.entries(LIGHT).forEach(([name, value]) => assert.equal(hex6(light[name]), value, name));
});

[['mediaDark', 'system dark'], ['forcedDark', 'data-theme=dark']].forEach(([block, label]) => {
  test(`(14) tokens.css keeps today's dark colours (${label})`, () => {
    const set = tokenSets()[block];
    Object.entries(DARK).forEach(([name, value]) => assert.equal(hex6(set[name]), value, name));
  });
});

test("(14) tokens.css keeps today's type variables", () => {
  const { light } = tokenSets();
  Object.entries(TYPE).forEach(([name, value]) => assert.equal(String(light[name]).replace(/,\s+/g, ','), value, name));
});

test('(14) tokens.css defines --accent and --accent-soft in light and in both dark blocks', () => {
  Object.entries(tokenSets()).forEach(([block, set]) => {
    ['--accent', '--accent-soft'].forEach((name) => assert.ok(set[name], `${name} missing in ${block}`));
  });
});

// ---------- a small fake browser for theme.js and <site-nav> ----------

const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'wbr']);
const RAW = new Set(['script', 'style']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&(\w+);/g, (m, e) => ENTITIES[e.toLowerCase()] ?? m);
const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

const parseAttrs = (text) => [...text.matchAll(/([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)]
  .map((m) => [m[1].toLowerCase(), decode((m[2] ?? '').replace(/^(["'])([\s\S]*)\1$/, '$2'))]);

// [start, next(start), next(next(start)), ...] up to the first null.
function chain(start, next) {
  const out = [];
  for (let n = start; n; n = next(n)) out.push(n);
  return out;
}

function walk(node, visit) {
  node.childNodes.forEach((child) => {
    visit(child);
    walk(child.content ?? child, visit);
  });
}

function descendants(root) {
  const all = [];
  walk(root, (n) => all.push(n));
  return all.filter((n) => n.nodeType === 1);
}

const SERIALIZE = {
  1: (el) => `<${el.localName}${[...el.attrs].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')}>`
    + [`${el.innerHTML}</${el.localName}>`, ''][+VOID.has(el.localName)],
  3: (t) => [escapeText, (s) => s][+RAW.has(t.parentNode?.localName)](t.data),
  8: () => '',
  11: (f) => f.innerHTML,
};
const serialize = (node) => SERIALIZE[node.nodeType](node);

// ---------- selectors: compound parts and descendant combinators (">" is read as descendant) ----------

const ATTR_OPS = {
  has: (v) => v !== null,
  '=': (v, w) => v === w,
  '~=': (v, w) => (v ?? '').split(/\s+/).includes(w),
  '^=': (v, w) => (v ?? '\0').startsWith(w),
  '$=': (v, w) => (v ?? '\0').endsWith(w),
  '*=': (v, w) => (v ?? '\0').includes(w),
  '|=': (v, w) => v === w || (v ?? '').startsWith(`${w}-`),
};

function attrMatches(el, part) {
  const m = part.match(/^\[([\w-]+)(?:([~^$*|]?=)(.*))?\]$/);
  return ATTR_OPS[m[2] ?? 'has'](el.getAttribute(m[1]), (m[3] ?? '').replace(/^["']|["']$/g, ''));
}

const PART = {
  ':': (el, part, scope) => el === scope,
  '*': () => true,
  '#': (el, part) => el.id === part.slice(1),
  '.': (el, part) => el.classList.contains(part.slice(1)),
  '[': attrMatches,
};
const COMPOUND = /^(\*|[a-zA-Z][\w-]*)|#[\w-]+|\.[\w-]+|\[[\w-]+(?:[~^$*|]?=(?:"[^"]*"|'[^']*'|[^\]]*))?\]|:scope/g;
const tagMatches = (el, part) => el.localName === part.toLowerCase();

function matchesCompound(el, compound, scope) {
  const parts = compound.match(COMPOUND) ?? [];
  return parts.length > 0 && parts.every((part) => (PART[part[0]] ?? tagMatches)(el, part, scope));
}

function matchesComplex(el, tokens, scope) {
  const rest = tokens.slice(0, -1);
  const ancestors = chain(el.parentElement, (n) => n.parentElement);
  return matchesCompound(el, tokens[tokens.length - 1], scope)
    && (rest.length === 0 || ancestors.some((p) => matchesComplex(p, rest, scope)));
}

const matches = (el, selector, scope) => selector.split(',')
  .some((sel) => matchesComplex(el, sel.trim().split(/[\s>]+/), scope));

// ---------- the fake browser ----------

function storageFor(mode, store, writes) {
  const ok = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, String(v)); writes.push(String(v)); },
    removeItem: (k) => store.delete(k),
  };
  const fail = () => { throw new Error('SecurityError: storage is disabled'); };
  const throwing = { getItem: fail, setItem: fail, removeItem: fail };
  const getters = { ok: () => ok, 'methods-throw': () => throwing, 'getter-throws': fail };
  return getters[mode];
}

function eventClasses() {
  class Event {
    constructor(type, init = {}) {
      Object.assign(this, { type, bubbles: !!init.bubbles, composed: !!init.composed, detail: init.detail });
      this.defaultPrevented = false;
      this.stopped = false;
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
    stopImmediatePropagation() { this.stopped = true; }
    composedPath() { return chain(this.target, (n) => n.eventParent()); }
  }
  class CustomEvent extends Event {}
  class EventTarget {
    constructor() { this.listeners = {}; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
    fire(event) {
      event.currentTarget = this;
      [...(this.listeners[event.type] ?? [])].forEach((fn) => (fn.handleEvent?.bind(fn) ?? fn).call(this, event));
    }
    dispatchEvent(event) {
      event.target ??= this;
      const route = chain(this, (n) => n.eventParent());
      route.slice(0, [1, route.length][+event.bubbles]).every((node) => {
        node.fire(event);
        return !event.stopped;
      });
      return !event.defaultPrevented;
    }
    eventParent() { return null; }
  }
  return { Event, CustomEvent, EventTarget };
}

function makeBrowser({ stored = null, storage = 'ok' } = {}) {
  const pending = [];
  const registry = new Map();
  const store = new Map([['theme', stored]].filter(([, v]) => v !== null));
  const writes = [];
  const { Event, CustomEvent, EventTarget } = eventClasses();
  const win = new EventTarget();
  const asNode = (n) => ({ string: (s) => new Text(s) })[typeof n]?.(n) ?? n;
  const connect = (node) => {
    node.connectedCallback?.();
    [...node.childNodes, node.shadowRoot].filter(Boolean).forEach(connect);
  };

  class Node extends EventTarget {
    constructor() {
      super();
      this.childNodes = [];
      this.parentNode = null;
    }
    get ownerDocument() { return doc; }
    get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
    get firstChild() { return this.childNodes[0] ?? null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
    get firstElementChild() { return this.children[0] ?? null; }
    get parentElement() { return [this.parentNode].find((p) => p?.nodeType === 1) ?? null; }
    get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
    get isConnected() { return this.getRootNode({ composed: true }) === doc; }
    getRootNode(opts = {}) { return chain(this, (n) => [n.parentNode, n.parentNode ?? n.host][+!!opts.composed]).pop(); }
    eventParent() { return this.parentNode ?? this.host ?? this.defaultView ?? null; }
    contains(other) { return chain(other, (n) => n.parentNode).includes(this); }
    ownNodes() { return [this]; }
    insertBefore(node, ref) {
      node.ownNodes().forEach((n) => {
        n.parentNode?.removeChild(n);
        const len = this.childNodes.length;
        this.childNodes.splice((this.childNodes.indexOf(ref) + len + 1) % (len + 1), 0, n);
        n.parentNode = this;
        [n].filter((x) => x.isConnected).forEach(connect);
      });
      return node;
    }
    appendChild(node) { return this.insertBefore(node, null); }
    removeChild(node) {
      this.childNodes.splice(this.childNodes.indexOf(node), 1);
      node.parentNode = null;
      return node;
    }
    remove() { this.parentNode?.removeChild(this); }
    append(...nodes) { nodes.forEach((n) => this.appendChild(asNode(n))); }
    prepend(...nodes) {
      const first = this.firstChild;
      nodes.forEach((n) => this.insertBefore(asNode(n), first));
    }
    before(...nodes) { nodes.forEach((n) => this.parentNode.insertBefore(asNode(n), this)); }
    after(...nodes) { [...nodes].reverse().forEach((n) => this.parentNode.insertBefore(asNode(n), this.nextSibling)); }
    replaceWith(...nodes) {
      this.before(...nodes);
      this.remove();
    }
    replaceChildren(...nodes) {
      [...this.childNodes].forEach((n) => this.removeChild(n));
      this.append(...nodes);
    }
    get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
    set textContent(value) { this.replaceChildren(new Text(String(value ?? ''))); }
    get innerHTML() { return (this.content ?? this).childNodes.map(serialize).join(''); }
    set innerHTML(html) { (this.content ?? this).replaceChildren(...parseHtml(String(html))); }
    querySelectorAll(selector) { return descendants(this).filter((el) => matches(el, selector, this)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    getElementById(id) { return descendants(this).find((el) => el.id === id) ?? null; }
    cloneNode() { return parseHtml(serialize(this))[0]; }
  }

  class Text extends Node {
    constructor(data = '') {
      super();
      this.data = String(data);
    }
    get nodeType() { return 3; }
    get nodeName() { return '#text'; }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
    get nodeValue() { return this.data; }
  }
  class Comment extends Text {
    get nodeType() { return 8; }
    get textContent() { return ''; }
  }
  class DocumentFragment extends Node {
    get nodeType() { return 11; }
    ownNodes() { return [...this.childNodes]; }
    cloneNode() {
      const copy = new DocumentFragment();
      copy.append(...parseHtml(this.innerHTML));
      return copy;
    }
  }
  class ShadowRoot extends DocumentFragment {}

  class HTMLElement extends Node {
    constructor(tag) {
      super();
      this.localName = String(tag ?? pending[pending.length - 1]).toLowerCase();
      this.attrs = new Map();
      this.style = { setProperty() {}, removeProperty() {} };
      this.content = { template: new DocumentFragment() }[this.localName];
    }
    get nodeType() { return 1; }
    get tagName() { return this.localName.toUpperCase(); }
    get nodeName() { return this.tagName; }
    getAttribute(name) { return this.attrs.get(name.toLowerCase()) ?? null; }
    hasAttribute(name) { return this.attrs.has(name.toLowerCase()); }
    getAttributeNames() { return [...this.attrs.keys()]; }
    get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
    setAttribute(name, value) { this.changeAttribute(name.toLowerCase(), String(value)); }
    removeAttribute(name) { this.changeAttribute(name.toLowerCase(), null); }
    changeAttribute(key, value) {
      const old = this.getAttribute(key);
      [() => this.attrs.delete(key), () => this.attrs.set(key, value)][+(value !== null)]();
      const observed = this.constructor.observedAttributes ?? [];
      [this.attributeChangedCallback].filter(() => observed.includes(key)).forEach((cb) => cb?.call(this, key, old, value));
    }
    toggleAttribute(name, force) {
      const on = force ?? !this.hasAttribute(name);
      [() => this.removeAttribute(name), () => this.setAttribute(name, '')][+!!on]();
      return !!on;
    }
    get classList() {
      const list = () => (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
      const set = (items) => this.setAttribute('class', [...new Set(items)].join(' '));
      return {
        contains: (c) => list().includes(c),
        add: (...cs) => set([...list(), ...cs]),
        remove: (...cs) => set(list().filter((c) => !cs.includes(c))),
        toggle: (c, force) => {
          const on = force ?? !list().includes(c);
          set(list().filter((x) => x !== c).concat([c].filter(() => on)));
          return !!on;
        },
      };
    }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(v) { this.toggleAttribute('hidden', !!v); }
    attachShadow() {
      this.shadowRoot = new ShadowRoot();
      this.shadowRoot.host = this;
      return this.shadowRoot;
    }
    matches(selector) { return matches(this, selector, null); }
    closest(selector) { return chain(this, (n) => n.parentElement).find((n) => n.matches(selector)) ?? null; }
    click() { this.dispatchEvent(new Event('click', { bubbles: true, composed: true })); }
    focus() {}
    blur() {}
    assignedNodes() { return slotted(this); }
    assignedElements() { return slotted(this).filter((n) => n.nodeType === 1); }
  }
  const reflect = (prop, attr) => Object.defineProperty(HTMLElement.prototype, prop, {
    get() { return this.getAttribute(attr) ?? ''; },
    set(v) { this.setAttribute(attr, v); },
  });
  ['id', 'href', 'src', 'alt', 'type', 'title', 'slot', 'rel', 'target', 'lang', 'role', 'part', 'name']
    .forEach((name) => reflect(name, name));
  [['className', 'class'], ['ariaLabel', 'aria-label'], ['ariaPressed', 'aria-pressed'], ['ariaCurrent', 'aria-current']]
    .forEach(([prop, attr]) => reflect(prop, attr));

  function createElement(tag) {
    const name = String(tag).toLowerCase();
    pending.push(name);
    try {
      return new (registry.get(name) ?? HTMLElement)(name);
    } finally {
      pending.pop();
    }
  }

  // A slot takes the host's children whose slot attribute names it; a lone slot takes them all.
  function slotted(slot) {
    const root = slot.getRootNode();
    const lone = descendants(root).filter((n) => n.localName === 'slot').length === 1;
    const name = slot.getAttribute('name') ?? '';
    return (root.host?.childNodes ?? []).filter((n) => lone || (n.getAttribute?.('slot') ?? '') === name);
  }

  const TOKEN = /(?<comment><!--[\s\S]*?-->)|<(?<raw>script|style)\b(?<rawAttrs>(?:[^>"']|"[^"]*"|'[^']*')*)>(?<rawText>[\s\S]*?)<\/\k<raw>\s*>|<\/(?<close>[a-zA-Z][\w-]*)\s*>|<(?<open>[a-zA-Z][\w-]*)(?<attrs>(?:[^>"']|"[^"]*"|'[^']*')*)>|(?<text>[^<]+|<)/gi;
  const KINDS = ['comment', 'raw', 'close', 'open', 'text'];

  function element(tag, attrs) {
    const el = createElement(tag);
    parseAttrs(attrs.replace(/\/\s*$/, '')).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  }

  const PARSE = {
    comment: () => {},
    text: (g, top) => top().appendChild(new Text(decode(g.text))),
    raw: (g, top) => top().appendChild(element(g.raw, g.rawAttrs)).appendChild(new Text(g.rawText)),
    open: (g, top, stack) => {
      const el = top().appendChild(element(g.open, g.attrs));
      stack.push(el);
      stack.length -= Math.sign(VOID.has(el.localName) + /\/\s*$/.test(g.attrs));
    },
    close: (g, top, stack) => {
      const at = stack.map((n) => n.localName).lastIndexOf(g.close.toLowerCase());
      stack.length = [stack.length, at].filter((x) => x > 0).pop();
    },
  };

  function parseHtml(html) {
    const stack = [new DocumentFragment()];
    const top = () => stack[stack.length - 1].content ?? stack[stack.length - 1];
    [...html.matchAll(TOKEN)].forEach((m) => PARSE[KINDS.find((k) => m.groups[k] !== undefined)](m.groups, top, stack));
    return [...stack[0].childNodes];
  }

  const doc = new Node();
  Object.assign(doc, { nodeType: 9, readyState: 'loading', defaultView: win, createElement });
  doc.createTextNode = (t) => new Text(t);
  doc.createComment = (t) => new Comment(t);
  doc.createDocumentFragment = () => new DocumentFragment();
  doc.documentElement = doc.appendChild(createElement('html'));
  doc.head = doc.documentElement.appendChild(createElement('head'));
  doc.body = doc.documentElement.appendChild(createElement('body'));

  const media = { matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  Object.assign(win, {
    document: doc, Node, Text, HTMLElement, Element: HTMLElement, Event, CustomEvent, DocumentFragment, ShadowRoot,
    customElements: {
      define: (name, cls) => registry.set(name, cls),
      get: (name) => registry.get(name),
      whenDefined: () => Promise.resolve(),
    },
    matchMedia: () => media,
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    CSSStyleSheet: class { replaceSync() {} replace() { return Promise.resolve(this); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    location: { href: 'https://example.test/site/', pathname: '/site/', origin: 'https://example.test' },
    navigator: { userAgent: 'site-kit-test' },
    setTimeout, clearTimeout, queueMicrotask, console,
  });
  Object.defineProperty(win, 'localStorage', { get: storageFor(storage, store, writes) });
  Object.assign(win, { window: win, self: win, globalThis: win });
  return { win, doc, context: vm.createContext(win), store, writes };
}

// ---------- loading the kit into the fake browser ----------

// A classic <script>: an ES-module build of the same file is accepted by dropping `export`.
const asClassic = (code) => code.replace(/^\s*export\s+(default\s+)?/gm, '');

function loadScript(browser, name) {
  vm.runInContext(asClassic(readKit(name)), browser.context, { filename: name });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function finishLoading({ doc, win }) {
  doc.readyState = 'interactive';
  doc.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  doc.readyState = 'complete';
  win.dispatchEvent(new win.Event('load'));
  await settle();
  await settle();
  await settle();
}

function jsonChild(doc, config) {
  const json = doc.createElement('script');
  json.setAttribute('type', 'application/json');
  json.textContent = JSON.stringify(config);
  return json;
}

function extraChild(doc) {
  const x = doc.createElement('a');
  x.setAttribute('href', '/extra/');
  x.setAttribute('data-extra', '');
  x.textContent = 'Extra';
  return x;
}

// A page with theme.js in <head> (as today's landing loads it) and one <site-nav> in <body>
// holding an inline JSON child and, optionally, one per-site extra.
async function page({ config, attrs = {}, extra = true, stored = null, storage = 'ok' } = {}) {
  const browser = makeBrowser({ stored, storage });
  loadScript(browser, 'theme.js');
  loadScript(browser, 'site-nav.js');
  const nav = browser.doc.createElement('site-nav');
  Object.entries(attrs).forEach(([k, v]) => nav.setAttribute(k, v));
  [config].filter(Boolean).forEach((c) => nav.appendChild(jsonChild(browser.doc, c)));
  [extra].filter(Boolean).forEach(() => nav.appendChild(extraChild(browser.doc)));
  browser.doc.body.appendChild(nav);
  await finishLoading(browser);
  return { ...browser, nav };
}

// The rendered nav in visual order: its shadow tree with slots filled, or its own children,
// skipping script, style and template. Each anchor and button is one item.
function flatten(node, out = []) {
  (node.shadowRoot ?? node).childNodes.forEach((child) => collect(child, out));
  return out;
}

const skip = () => {};
const keep = (node, out) => out.push(node);
const COLLECT = {
  script: skip,
  style: skip,
  template: skip,
  a: keep,
  button: keep,
  slot: (node, out) => [node.assignedNodes(), node.childNodes].find((list) => list.length)?.forEach((n) => collect(n, out)),
};
const collect = (node, out) => (COLLECT[node.localName] ?? flatten)(node, out);

const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const items = (nav) => flatten(nav).filter((el) => text(el) !== 'Docs');
const renderTree = (nav) => [...descendants(nav.shadowRoot ?? nav), ...descendants(nav)];

const CONFIG = {
  name: 'demo',
  logo: 'mark.svg',
  nav: [{ label: 'Flows', href: '#flows' }, { label: 'Use it', href: '#use' }],
  home_link: { label: '← skathio', href: 'https://skathio.github.io/' },
};

// ---------- (15) <site-nav> order ----------

test('(14) site-nav.js defines the custom element <site-nav>', () => {
  const browser = makeBrowser();
  loadScript(browser, 'site-nav.js');
  assert.ok(browser.win.customElements.get('site-nav'), 'customElements has no site-nav');
});

test('(15) order: brand, nav links, extras slot, home_link, theme toggle', async () => {
  const { nav } = await page({ config: CONFIG });
  const got = items(nav);
  assert.equal(got.length, 6, `items: ${got.map((el) => `${el.localName}:${text(el)}`).join(' | ')}`);
  const [brand, first, second, extra, home, toggle] = got;
  assert.ok(text(brand).includes('demo'), `brand: ${text(brand)}`);
  assert.equal(brand.localName, 'a');
  assert.deepEqual([text(first), first.getAttribute('href')], ['Flows', '#flows']);
  assert.deepEqual([text(second), second.getAttribute('href')], ['Use it', '#use']);
  assert.ok(extra.hasAttribute('data-extra'), `4th item is not the extra: ${text(extra)}`);
  assert.deepEqual([text(home), home.getAttribute('href')], ['← skathio', 'https://skathio.github.io/']);
  assert.equal(toggle.localName, 'button');
});

test('(15) the brand shows the logo and the name, and is a link', async () => {
  const { nav } = await page({ config: CONFIG });
  const brand = items(nav)[0];
  const img = descendants(brand).find((el) => el.localName === 'img');
  assert.ok(img, 'brand has no <img>');
  assert.equal(img.getAttribute('src'), 'mark.svg');
  assert.ok(brand.hasAttribute('href'), 'brand has no href');
});

test('(15) Docs, when shown, sits after the nav links and before the extras', async () => {
  const { nav } = await page({ config: CONFIG });
  const all = flatten(nav);
  const docs = all.findIndex((el) => text(el) === 'Docs');
  const lastNav = all.findIndex((el) => text(el) === 'Use it');
  const extra = all.findIndex((el) => el.hasAttribute('data-extra'));
  assert.ok(docs < 0 || (docs > lastNav && docs < extra), `Docs at ${docs}, last nav link at ${lastNav}, extra at ${extra}`);
});

test('(15) no nav links: brand, extras, home_link, toggle', async () => {
  const { nav } = await page({ config: { ...CONFIG, nav: [] } });
  const got = items(nav);
  assert.equal(got.length, 4, got.map(text).join(' | '));
  assert.ok(got[1].hasAttribute('data-extra'));
  assert.equal(text(got[2]), '← skathio');
  assert.equal(got[3].localName, 'button');
});

test('(15) one nav link renders as one link in place', async () => {
  const { nav } = await page({ config: { ...CONFIG, nav: [{ label: 'Only', href: '/only/' }] } });
  const got = items(nav);
  assert.deepEqual([text(got[1]), got[1].getAttribute('href')], ['Only', '/only/']);
  assert.ok(got[2].hasAttribute('data-extra'));
});

test('(15) eight nav links (the pages.json limit) all render, in order', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ label: `N${i}`, href: `/n${i}/` }));
  const { nav } = await page({ config: { ...CONFIG, nav: many } });
  assert.deepEqual(items(nav).slice(1, 9).map(text), many.map((l) => l.label));
  assert.ok(items(nav)[9].hasAttribute('data-extra'));
});

test('(15) no home_link: nothing between the extras and the toggle', async () => {
  const { home_link: _, ...noHome } = CONFIG;
  const { nav } = await page({ config: noHome });
  const got = items(nav);
  const extra = got.findIndex((el) => el.hasAttribute('data-extra'));
  assert.equal(got[extra + 1].localName, 'button');
  assert.equal(got.length, extra + 2);
  assert.ok(!got.some((el) => text(el) === '← skathio'));
});

test('(15) no extras given: the toggle still comes last', async () => {
  const { nav } = await page({ config: CONFIG, extra: false });
  const got = items(nav);
  assert.equal(got.length, 5, got.map(text).join(' | '));
  assert.equal(got[3].getAttribute('href'), 'https://skathio.github.io/');
  assert.equal(got[4].localName, 'button');
});

test('(15) items can come from attributes: name', async () => {
  const { nav } = await page({ attrs: { name: 'attr-site' } });
  assert.ok(text(items(nav)[0]).includes('attr-site'), `brand: ${text(items(nav)[0])}`);
});

// ---------- (15) escaping ----------

const HOSTILE = {
  name: '<img src=x onerror=alert(1)>',
  nav: [{ label: '<b>bold</b> & co', href: '/a/' }, { label: '&lt;already&gt;', href: '/b/' }],
  home_link: { label: '</a><script>alert(2)</script>', href: '/home/' },
};

test('(15) every label renders as text, exactly as given', async () => {
  const { nav } = await page({ config: HOSTILE, extra: false });
  const texts = items(nav).map(text);
  assert.ok(texts[0].includes(HOSTILE.name), `brand: ${texts[0]}`);
  assert.equal(texts[1], '<b>bold</b> & co');
  assert.equal(texts[2], '&lt;already&gt;');
  assert.equal(texts[3], '</a><script>alert(2)</script>');
});

test('(15) a label never becomes markup: no injected elements or on* attributes', async () => {
  const { nav } = await page({ config: HOSTILE, extra: false });
  const tree = renderTree(nav);
  assert.ok(!tree.some((el) => el.localName === 'b'), 'a <b> from a label');
  assert.ok(!tree.some((el) => el.getAttributeNames().some((a) => a.startsWith('on'))), 'an on* attribute');
  assert.ok(!tree.some((el) => el.localName === 'img' && el.getAttribute('src') === 'x'), 'an <img> from the name');
  const scripts = tree.filter((el) => el.localName === 'script' && el.getAttribute('type') !== 'application/json');
  assert.equal(scripts.length, 0, 'a <script> from a label');
});

// ---------- (16) theme.js storage rules ----------

const shownTheme = (browser) => ({ light: 'light', dark: 'dark' })[browser.doc.documentElement.getAttribute('data-theme')] ?? 'auto';

['light', 'dark'].forEach((value) => {
  test(`(16) a stored "${value}" applies ${value}`, async () => {
    assert.equal(shownTheme(await page({ config: CONFIG, stored: value })), value);
  });
});

['auto', null, '', 'purple', 'LIGHT', 'Dark', ' light'].forEach((value) => {
  test(`(16) a stored ${JSON.stringify(value)} means auto`, async () => {
    assert.equal(shownTheme(await page({ config: CONFIG, stored: value })), 'auto');
  });
});

const toggleOf = (nav) => items(nav).filter((el) => el.localName === 'button').pop();

test('(16) the toggle stores only light, dark or auto under "theme", and reaches all three', async () => {
  const browser = await page({ config: CONFIG, stored: 'auto' });
  const seen = [0, 1, 2].map(() => {
    toggleOf(browser.nav).click();
    const stored = browser.store.get('theme');
    assert.equal(shownTheme(browser), stored, `stored ${stored}, shown ${shownTheme(browser)}`);
    return stored;
  });
  assert.deepEqual([...new Set(seen)].sort(), ['auto', 'dark', 'light']);
  assert.deepEqual(browser.writes.filter((v) => !['light', 'dark', 'auto'].includes(v)), []);
});

// A pointer lands on the glyph or the word inside the button far more often than on its padding.
test('(16) a click on the text inside the toggle presses it', async () => {
  const browser = await page({ config: CONFIG, stored: 'auto' });
  // The toggle renders its spans again after each press, so they are looked up each time.
  const spans = () => toggleOf(browser.nav).childNodes.filter((n) => n.localName === 'span');
  assert.ok(spans().length > 0, 'the toggle holds no span to click');
  for (let i = 0; i < spans().length; i++) {
    const before = browser.store.get('theme') ?? 'auto';
    const span = spans()[i];
    span.click();
    assert.notEqual(browser.store.get('theme') ?? 'auto', before, `a click on <span class="${span.getAttribute('class') ?? ''}"> did nothing`);
  }
});

test('(16) from an unknown stored value, the toggle writes a valid choice', async () => {
  const browser = await page({ config: CONFIG, stored: 'purple' });
  toggleOf(browser.nav).click();
  assert.ok(['light', 'dark', 'auto'].includes(browser.store.get('theme')), browser.store.get('theme'));
});

['getter-throws', 'methods-throw'].forEach((storage) => {
  test(`(16) storage unavailable (${storage}): auto, and loading raises no error`, async () => {
    assert.equal(shownTheme(await page({ config: CONFIG, storage })), 'auto');
  });

  test(`(16) storage unavailable (${storage}): the toggle still works with no error`, async () => {
    const browser = await page({ config: CONFIG, storage });
    const toggle = toggleOf(browser.nav);
    assert.ok(toggle, 'no toggle rendered');
    assert.doesNotThrow(() => [0, 1, 2].forEach(() => toggle.click()));
  });
});
