// docs-build's last check on each built page (lib/html-safety.js checkBuiltPage): whatever a
// docs page or pages.json slipped past the Markdown hooks, the page holds no script, handler,
// frame or file reference of its own. It allows exactly what VitePress itself writes.
//
// Run with: node --test tests/docs-build/built-html.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', '.github', 'actions', 'docs-build', 'lib');
const { checkBuiltPage } = require(path.join(LIB, 'html-safety.js'));
const { themeFromLanding } = require(path.join(LIB, 'theme-bridge.js'));

const BASE = '/site/docs/';
const opts = { base: BASE, inlineScripts: [themeFromLanding] };

// The shape of a page VitePress 1.6 builds, with this config's head scripts.
const page = (body = '<p>Hi</p>') => [
  '<!DOCTYPE html><html lang="en-US" dir="ltr"><head>',
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  `<link rel="preload stylesheet" href="${BASE}assets/style.x.css" as="style">`,
  `<link rel="icon" href="${BASE}mark.svg" type="image/svg+xml">`,
  `<script type="module" src="${BASE}assets/app.x.js"></script>`,
  `<link rel="modulepreload" href="${BASE}assets/chunks/theme.x.js">`,
  `<script>${themeFromLanding}</script>`,
  '<script id="check-mac-os">document.documentElement.classList.toggle("mac",/Mac|iPhone|iPod|iPad/i.test(navigator.platform));</script>',
  '</head><body><div id="app">',
  `<img class="VPImage logo" src="${BASE}mark.svg" alt data-v-1>`,
  body,
  '</div><script>window.__VP_HASH_MAP__=JSON.parse("{\\"a.md\\":\\"x\\"}");window.__VP_SITE_DATA__=JSON.parse("{}");</script></body></html>',
].join('');

test('a page as VitePress builds it passes', () => {
  assert.deepEqual(checkBuiltPage(page(), opts), []);
});

test('images under the base, on the web or inlined as images pass', () => {
  const body = `<img src="${BASE}assets/a.png" alt="a"><img src="https://x.example/a.png" alt="b"><img src="data:image/svg+xml,%3Csvg%3E" alt="c">`;
  assert.deepEqual(checkBuiltPage(page(body), opts), []);
});

const bad = {
  'an event handler': '<span class="lang">x<img src="https://x.invalid/a" onerror="alert(1)"></span>',
  'an upper-case handler': '<div ONMOUSEOVER="x()">a</div>',
  'a script of its own': '<script>alert(1)</script>',
  'a script from elsewhere': '<script src="https://evil.example/a.js"></script>',
  'a module script outside the base': '<script type="module" src="/other/a.js"></script>',
  'an iframe': '<iframe src="https://evil.example/"></iframe>',
  'an object': '<object data="x.swf"></object>',
  'an embed': '<embed src="x.swf">',
  'a form': '<form action="https://evil.example/"><input></form>',
  'a base tag': '<base href="https://evil.example/">',
  'a meta refresh': '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
  'a javascript: link': '<a href="javascript:alert(1)">a</a>',
  'an entity-encoded javascript: link': '<a href="jav&#x61;script:alert(1)">a</a>',
  'a data: page link': '<a href="data:text/html,<b>x</b>">a</a>',
  'an image inlined as text': '<img src="data:text/plain;base64,T1VUU0lERQo=" alt="x">',
  'an image above the base': '<img src="/site/secret.png" alt="x">',
  'an image with .. under the base': `<img src="${BASE}../secret.png" alt="x">`,
  'a relative image': '<img src="../../outside.png" alt="x">',
  'a poster that is not an image': `<video poster="${BASE}assets/outside.BlLibLaX.txt"></video>`,
  'an image src that is not an image': `<img src="${BASE}assets/outside.BlLibLaX.txt" alt="x">`,
  'a stylesheet from elsewhere': '<link rel="stylesheet" href="https://evil.example/a.css">',
  'a srcdoc': '<div srcdoc="<script>x()</script>">a</div>',
  'a formaction': '<button formaction="https://evil.example/">a</button>',
};

for (const [name, body] of Object.entries(bad)) {
  test(`a page with ${name} fails`, () => {
    const problems = checkBuiltPage(page(body), opts);
    assert.ok(problems.length > 0, `${name}: ${body}`);
    assert.ok(problems.every((p) => typeof p === 'string' && !p.includes('\n')));
  });
}

test('an inline script differing from the allowed ones by one character fails', () => {
  const html = page().replace(themeFromLanding, `${themeFromLanding};x()`);
  assert.ok(checkBuiltPage(html, opts).length > 0);
});

test('site data that ends its script early fails', () => {
  const html = page().replace('JSON.parse("{}")', 'JSON.parse("{}");alert(1)//")');
  assert.ok(checkBuiltPage(html, opts).length > 0);
});

test('the VitePress config runs the check on every page, with the head scripts as VitePress writes them', () => {
  const fs = require('node:fs');
  const config = fs.readFileSync(path.join(LIB, '..', 'vitepress', '.vitepress', 'config.mts'), 'utf8');
  const transform = config.slice(config.indexOf('transformHtml:'), config.indexOf('transformPageData:'));
  assert.match(transform, /checkBuiltPage\(out, \{ base: config\.base, inlineScripts: builtHeadScripts \}\)/);
  assert.match(transform, /if \(problems\.length > 0\) failBuild\(/);
  assert.match(transform, /return out/);
  assert.match(config, /transformWithEsbuild\(code, 'inline-script\.js', \{ minify: true \}\)/);
});

// ---------- the rendered Markdown, before Vue ----------

const { checkRenderedHtml } = require(path.join(LIB, 'html-safety.js'));

test('Markdown as markdown-it and VitePress render it passes', () => {
  const html = [
    '<div v-pre><h1 id="a" tabindex="-1">A <a class="header-anchor" href="#a" aria-label="Permalink to &quot;A&quot;">​</a></h1>',
    '<p>Text <strong>b</strong> <em>i</em> <code>c</code> <a href="https://x.example/" target="_blank" rel="noreferrer">l</a><br></p>',
    '<div class="language-js vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">js</span>',
    '<pre class="shiki" tabindex="0"><code><span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">x</span></span></code></pre></div>',
    '<table tabindex="0"><thead><tr><th style="text-align:right">h</th></tr></thead><tbody><tr><td>d</td></tr></tbody></table>',
    '<div class="vp-code-group"><div class="tabs"><input type="radio" name="group-1" id="tab-1" checked><label data-title="a" for="tab-1">a</label></div></div>',
    '<ul><li><input type="checkbox" disabled> t</li></ul><img src="./a.png" alt="a"><hr></div>',
  ].join('');
  assert.deepEqual(checkRenderedHtml(html), []);
});

const renderedBad = {
  'a wrapper closed early': '<div v-pre><p>x</p></div></div><div><p>{{ 1 }}</p></div>',
  'a tag left open': '<div v-pre><p>x</div>',
  'a video': '<div v-pre><video poster="../x.txt?url"></video></div>',
  'a script': '<div v-pre><script>x()</script></div>',
  'an iframe': '<div v-pre><iframe src="x"></iframe></div>',
  'a handler': '<div v-pre><img src="a.png" onerror="x()"></div>',
  'an unknown attribute': '<div v-pre><span data-x="1">a</span></div>',
  'a style with url()': '<div v-pre><span style="background:url(x)">a</span></div>',
  'a bare <': '<div v-pre><p>a < b</p></div>',
};

for (const [name, html] of Object.entries(renderedBad)) {
  test(`rendered Markdown with ${name} fails`, () => {
    const problems = checkRenderedHtml(html);
    assert.ok(problems.length > 0, name);
    assert.ok(problems.every((p) => !p.includes('\n')));
  });
}
