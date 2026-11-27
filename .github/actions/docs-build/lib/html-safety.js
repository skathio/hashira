// pages.json is data a pull request can edit, and VitePress writes some of it into each page's
// HTML without escaping it: the site data (title, description, nav and sidebar hrefs) goes into
// an inline <script> as a JSON string, where a `</script>` in any value would end the script
// and let the rest run as markup, and the page description goes into <meta content="..."> as
// written. These helpers close both holes for the config's transformHead and transformHtml.

'use strict';

// VitePress's inline metadata script: window.__VP_HASH_MAP__=JSON.parse("...") and
// window.__VP_SITE_DATA__=JSON.parse("...") (or deserializeFunctions(JSON.parse("..."))).
// Each argument is a JSON.stringify'd JS string literal, so it holds no bare `"`.
const METADATA_LITERAL = /(window\.__VP_(?:HASH_MAP|SITE_DATA)__=(?:deserializeFunctions\()?JSON\.parse\()("(?:[^"\\]|\\[\s\S])*")/g;

// Writes every `<` inside those literals as the escape <, which the JS string decodes back
// to `<`, so the HTML parser never meets a `</script>` there and the data is unchanged.
function escapeInlineMetadata(html) {
  return html.replace(METADATA_LITERAL, (_, head, literal) => head + literal.replace(/</g, '\\u003c'));
}

// The page's description as a head tag. VitePress escapes the attributes of head tags, and a
// description tag in the head makes it skip its own unescaped one.
function descriptionTag(description) {
  return ['meta', { name: 'description', content: String(description ?? '') }];
}

// ---------- the last check on each built page ----------
//
// The Markdown hooks keep a page's text as text, but VitePress and its plugins write some
// values into the HTML as they are. Whatever slips past them, a built page may hold only what
// VitePress itself writes: its scripts and stylesheets under the docs base, the config's head
// scripts, and no handler, frame, form or file reference of its own. A page that holds more
// fails the build. Vue escapes `<`, `>` and quotes in text and attributes, so a tag that is
// in the HTML was written as one.

const CHECK_MAC_OS = 'document.documentElement.classList.toggle("mac",/Mac|iPhone|iPod|iPad/i.test(navigator.platform));';
const METADATA_ONLY = /^(?:window\.__VP_(?:HASH_MAP|SITE_DATA)__=(?:deserializeFunctions\()?JSON\.parse\("(?:[^"\\<]|\\[^<])*"\)\)?;)+$/;
const SCRIPT = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;
const TAG = /<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const FORBIDDEN_TAGS = new Set(['iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'base', 'portal']);
const FORBIDDEN_ATTRS = new Set(['srcdoc', 'formaction', 'srcset']);
const MEDIA_TAGS = new Set(['img', 'source', 'video', 'audio', 'track', 'input']);
// Vite inlines an image below 4 KB as a data: URL of its MIME type, so a small .ico is
// data:image/x-icon (or vnd.microsoft.icon) and a small .bmp data:image/bmp.
const IMAGE_DATA = /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon)[;,]/;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
const ACTIVE_SCHEME = /^(?:javascript|vbscript|data):/;

const NAMED = { colon: ':', tab: '\t', newline: '\n', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', sol: '/' };

function decode(value) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) % 0x110000))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d) % 0x110000))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

// The value as a browser reads its scheme: entities decoded, whitespace and controls dropped.
const schemeOf = (value) => decode(value).replace(/[\s\u0000-\u001f]/g, '').toLowerCase();

function attributes(text) {
  return [...text.matchAll(ATTR)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']);
}

const underBase = (value, base) => {
  const url = decode(value);
  return url.startsWith(base) && !url.split(/[?#]/)[0].split('/').some((seg) => seg === '..' || seg === '.');
};

function scriptProblem(attrs, body, { base, inlineScripts }) {
  const map = Object.fromEntries(attributes(attrs));
  if ('src' in map) {
    const ok = map.type === 'module' && underBase(map.src, `${base}assets/`) && body === '';
    return ok ? null : `script ${JSON.stringify(map.src)} is not one of the docs' own`;
  }
  if (map.id === 'check-mac-os' ? body === CHECK_MAC_OS : inlineScripts.includes(body) || METADATA_ONLY.test(body)) return null;
  return `the inline script ${JSON.stringify(body.slice(0, 60))} is not one VitePress or the config writes`;
}

function attributeProblem(tag, name, value, base) {
  if (name.startsWith('on')) return `<${tag}> has the handler ${name}`;
  if (FORBIDDEN_ATTRS.has(name)) return `<${tag}> has ${name}`;
  const scheme = schemeOf(value);
  if ((name === 'src' || name === 'poster') && MEDIA_TAGS.has(tag)) {
    const local = underBase(value, base) && IMAGE_FILE.test(decode(value).split(/[?#]/)[0]);
    const ok = /^https?:\/\//.test(scheme) || IMAGE_DATA.test(scheme) || local;
    return ok ? null : `<${tag}> src ${JSON.stringify(value.slice(0, 80))} is not an image under ${base}, a web URL or an inline image`;
  }
  if (name === 'href' && tag === 'link') return underBase(value, base) ? null : `<link> href ${JSON.stringify(value.slice(0, 80))} is not under ${base}`;
  if (ACTIVE_SCHEME.test(scheme)) return `<${tag}> ${name} uses ${scheme.split(':')[0]}:`;
  return null;
}

function tagProblems(html, base) {
  const problems = [];
  for (const [, rawTag, attrs] of html.matchAll(TAG)) {
    const tag = rawTag.toLowerCase();
    if (FORBIDDEN_TAGS.has(tag)) problems.push(`<${tag}> is not allowed`);
    const list = attributes(attrs);
    if (tag === 'meta' && list.some(([name]) => name === 'http-equiv')) problems.push('<meta http-equiv> is not allowed');
    if (tag !== 'script') problems.push(...attributeProblems(tag, list, base));
  }
  return problems;
}

// The page's canonical URL is the one <link> that names a full https URL (lib/page-meta.js).
const canonicalProblem = (value) => (/^https:\/\//.test(schemeOf(value)) ? null : `<link rel="canonical"> href ${JSON.stringify(value.slice(0, 80))} is not an https URL`);

function attributeProblems(tag, list, base) {
  const canonical = tag === 'link' && list.some(([name, value]) => name === 'rel' && value.trim().toLowerCase() === 'canonical');
  return list.map(([name, value]) => (canonical && name === 'href' ? canonicalProblem(value) : attributeProblem(tag, name, value, base))).filter(Boolean);
}

// Returns the page's problems, one line each; an empty list means the page is VitePress's own.
function checkBuiltPage(html, { base, inlineScripts }) {
  const problems = [];
  const scripts = [...html.matchAll(SCRIPT)];
  if (scripts.length !== (html.match(/<script\b/gi) ?? []).length) problems.push('a <script> is not closed');
  for (const [, attrs, body] of scripts) {
    const problem = scriptProblem(attrs, body, { base, inlineScripts });
    if (problem) problems.push(problem);
  }
  problems.push(...tagProblems(html.replace(SCRIPT, '<script>'), base));
  return [...new Set(problems)].map((p) => p.replace(/[\r\n]+/g, ' '));
}

// ---------- what markdown-it renders, before Vue compiles it ----------
//
// The Markdown hooks wrap each rendered page in one v-pre so Vue compiles nothing in it. A
// plugin that writes a value into the HTML as it is (a fence's language, an alert's title)
// could close that wrapper, or add a tag Vite then resolves. So the rendered page must be
// balanced and may hold only the tags and attributes Markdown and VitePress's plugins write.

const RENDER_TAGS = new Set([
  'div', 'p', 'span', 'a', 'strong', 'em', 's', 'del', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br', 'img', 'button',
  'input', 'label', 'sup', 'sub', 'section', 'nav', 'details', 'summary',
]);
const VOID_TAGS = new Set(['hr', 'br', 'img', 'input']);
const RENDER_ATTRS = new Set([
  'class', 'id', 'href', 'src', 'alt', 'title', 'tabindex', 'target', 'rel', 'style', 'start', 'type', 'name',
  'checked', 'for', 'data-title', 'v-pre', 'aria-label', 'aria-hidden', 'disabled',
]);
const ANY_TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

function renderedTagProblem(closing, tag, attrs, stack) {
  if (!RENDER_TAGS.has(tag)) return `<${tag}> is not written by Markdown`;
  if (closing) {
    if (stack.pop() !== tag) return `</${tag}> does not close the open tag`;
    return null;
  }
  const bad = attributes(attrs).find(([name, value]) => !RENDER_ATTRS.has(name) || (name === 'style' && /url\(|expression|[<>]/i.test(value)));
  if (bad) return `<${tag}> has the attribute ${bad[0]}`;
  if (!VOID_TAGS.has(tag)) stack.push(tag);
  return null;
}

// Returns the rendered page's problems, one line each; empty means it is Markdown's own.
function checkRenderedHtml(html) {
  const stack = [];
  const problems = [];
  for (const [, slash, rawTag, attrs] of html.matchAll(ANY_TAG)) {
    const problem = renderedTagProblem(slash === '/', rawTag.toLowerCase(), attrs, stack);
    if (problem) problems.push(problem);
  }
  if (stack.length > 0) problems.push(`<${stack[stack.length - 1]}> is not closed`);
  if (/<(?![a-zA-Z/!])/.test(html.replace(/<!--[\s\S]*?-->/g, ''))) problems.push('a < is not escaped');
  return [...new Set(problems)];
}

// ---------- SVG files under docs/ ----------
//
// An SVG under docs/ is published as a file of its own, and a browser that opens it runs its
// scripts with the docs' origin. So an SVG may hold no <script> element (any namespace prefix,
// a comment or CDATA included: the check reads the raw text and fails closed), no on* handler,
// and no attribute value that names a javascript: URL once entities and whitespace are gone.
// An ENTITY declaration (or a DOCTYPE with an internal subset) could spell any of that through an entity the check never
// expands, and <iframe>, <embed>, <object> or a srcdoc attribute carry a
// document of their own, so those are refused too. A NUL byte means the file is not UTF-8 text
// the check can read, so it fails too.
const SVG_SCRIPT = /<\s*(?:[\w.-]+:)?script\b/i;
// A DOCTYPE with an internal subset ([...]) can declare entities; a plain one, as Illustrator and
// draw.io write, cannot, and stays allowed.
const SVG_DECLARATION = /<!\s*(doctype)\b[^>[]*\[|<!\s*(entity)\b/i;
// An xml-stylesheet processing instruction can point the browser at an XSLT stylesheet (in the
// file or beside it) that writes any element, a <script> included, so neither is allowed.
const SVG_STYLESHEET = /<\?\s*xml-stylesheet\b/i;
const SVG_XSLT = /http:\/\/www\.w3\.org\/1999\/XSL\/Transform/i;
// <foreignObject> stays allowed: what it holds is scanned like the rest (script, handlers, URLs).
const SVG_EMBEDS = new Set(['iframe', 'embed', 'object']);
// The tag scan reads the text in the order an XML parser does: a comment, a CDATA section or a
// processing instruction is one token, so a quote inside one can never open an attribute value
// that swallows the real tag after it. One left open is not a token, so the scan reads into it.
// A bare `<` ends a tag attempt (it is not well-formed XML there, and the scan picks the tag up
// from that `<`), so a run of unclosed `<x ` openers costs linear time, not quadratic.
const SVG_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<([a-zA-Z][\w:.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;

// The problems a whole-text pattern finds: a script element, a declaration, a stylesheet or XSLT.
function svgTextProblems(text) {
  const problems = [];
  if (SVG_SCRIPT.test(text)) problems.push('it holds a <script> element');
  const declaration = text.match(SVG_DECLARATION);
  if (declaration) problems.push(`it holds a <!${(declaration[1] || declaration[2]).toUpperCase()}> declaration with entities`);
  if (SVG_STYLESHEET.test(text)) problems.push('it holds an <?xml-stylesheet?> instruction');
  if (SVG_XSLT.test(text)) problems.push('it holds XSLT');
  return problems;
}

// The problems of one tag: an embedded document, a handler, srcdoc or a javascript: URL.
function svgTagProblems(tag, attrs) {
  const problems = [];
  if (SVG_EMBEDS.has(tag.toLowerCase().replace(/^[\w.-]+:/, ''))) problems.push(`it holds a <${tag}> element`);
  for (const [name, value] of attributes(attrs)) {
    if (/^(?:[\w.-]+:)?on/.test(name)) problems.push(`<${tag}> has the handler ${name}`);
    else if (/^(?:[\w.-]+:)?srcdoc$/.test(name)) problems.push(`<${tag}> has a srcdoc attribute`);
    else if (schemeOf(value).includes('javascript:')) problems.push(`<${tag}> ${name} names a javascript: URL`);
  }
  return problems;
}

// Returns the SVG text's problems, one line each; empty means it holds no script.
function svgProblems(text) {
  if (text.includes('\0')) return ['it is not UTF-8 text'];
  const problems = svgTextProblems(text);
  for (const [, tag, attrs] of text.matchAll(SVG_TOKEN)) {
    if (tag) problems.push(...svgTagProblems(tag, attrs));
  }
  return [...new Set(problems)];
}

module.exports = { escapeInlineMetadata, descriptionTag, checkBuiltPage, checkRenderedHtml, svgProblems };
