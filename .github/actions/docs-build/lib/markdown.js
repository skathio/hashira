// The Markdown renderer hooks that make the docs read the same on the site as on GitHub,
// for VitePress's `markdown.config`: braces render as text, relative links go where
// `rewrite` says, and each permalink's aria-label is its heading's plain text.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { escapeBraces, escapeHtml, missingAnchors } = require('./links');
const { checkRenderedHtml } = require('./html-safety');

// VitePress compiles each page as a Vue template: see escapeBraces.
function textAsText(md) {
  for (const rule of ['text', 'code_inline']) {
    const render = md.renderer.rules[rule];
    md.renderer.rules[rule] = (...args) => escapeBraces(render(...args));
  }
}

// `rewrite(page, href)` returns a link's new href or null to keep it. `page` is the source
// page's path relative to srcDir, before any rewrite moved it.
function rewrittenLinks(md, srcDir, rewrite) {
  md.core.ruler.push('outbound-and-rewritten-links', (state) => {
    // VitePress also renders bits of front matter (a title) with no page in env: they hold
    // no links to rewrite.
    if (!state.env.path) return;
    const page = path.relative(srcDir, state.env.realPath ?? state.env.path).split('\\').join('/');
    for (const block of state.tokens) {
      for (const token of block.children ?? []) {
        const href = token.type === 'link_open' ? token.attrGet('href') ?? '' : '';
        const url = href && rewrite(page, href);
        if (url) token.attrSet('href', url);
      }
    }
  });
}

// VitePress labels a heading's permalink with the heading's Markdown source, backslash
// escapes and code marks included. A screen reader should hear the heading as it reads.
function permalinkLabels(md) {
  md.core.ruler.push('permalink-labels', (state) => {
    for (const block of state.tokens) {
      const permalink = block.children?.find((t) => t.type === 'link_open' && t.attrGet('class') === 'header-anchor');
      if (permalink) {
        const heading = block.children.filter((t) => t.type === 'text' || t.type === 'code_inline').map((t) => t.content).join('').trim();
        permalink.attrSet('aria-label', `Permalink to "${heading}"`);
      }
    }
  });
}

// VitePress's `<<< path` snippet line reads any file the runner can, with no bound to the
// docs. GitHub shows the line as text, so it does here too.
function noSnippets(md) {
  md.block.ruler.disable('snippet', true);
}

// VitePress compiles each page as a Vue template, so `{{ }}` in a `-vue` fence or a code-group
// title would run as code at build time and in the browser. One v-pre around the page stops
// Vue compiling anything in it, whatever markdown-it rule produced it.
// The page must then hold only Markdown's own tags (lib/html-safety.js checkRenderedHtml).
function pageAsText(md, srcDir) {
  const render = md.render.bind(md);
  md.render = (src, env = {}) => {
    const html = `<div v-pre>${render(src, env)}</div>`;
    const problems = checkRenderedHtml(html);
    if (problems.length > 0) {
      const page = env.path ? path.relative(srcDir, env.realPath ?? env.path).split('\\').join('/') : 'a page';
      fail(`docs-build: ${page}: ${problems.slice(0, 3).join('; ')}`);
    }
    return html;
  };
}

// An in-page #anchor that matches no heading id on its page is most often a heading renamed,
// or an id from another renderer's slug rule: it warns, naming the page and the anchor, and
// the build goes on. VitePress renders a page more than once (the page, its search entry), so
// each warning is written once.
function anchorWarnings(md, srcDir) {
  const render = md.render.bind(md);
  const warned = new Set();
  md.render = (src, env = {}) => {
    const html = render(src, env);
    if (!env.path) return html;
    const page = path.relative(srcDir, env.realPath ?? env.path).split('\\').join('/');
    for (const anchor of missingAnchors(html)) {
      const line = `::warning::docs-build: ${page}: the link #${anchor} matches no heading id on the page (ids follow GitHub's slug rule)`.replace(/\r?\n/g, ' ');
      if (!warned.has(line)) console.warn(line);
      warned.add(line);
    }
    return html;
  };
}

// VitePress's GitHub alert plugin writes the text after `> [!NOTE]` into the page as HTML.
// GitHub shows it as text, so it is escaped here, after the plugin has read it.
function alertTitleAsText(md) {
  md.core.ruler.push('alert-title-as-text', (state) => {
    for (const token of state.tokens) {
      if (token.type === 'github_alert_open' && token.meta?.title) token.meta.title = escapeHtml(token.meta.title);
    }
  });
}

const fail = (message) => {
  const line = message.replace(/\r?\n/g, ' ');
  console.error(`::error::${line}`);
  throw new Error(line);
};

// Vite resolves an image's path at build time and can inline the file it names, with a
// `?url` or `?raw` query, from anywhere the runner can read. An image is either a URL or a
// plain path that stays in the docs; anything else fails the build naming the page.
const IMAGE_URL = /^(https?:\/\/|data:image\/)/i;

// VitePress decodes an image path with decodeURIComponent before Vite sees it, so `%2F` and
// `%3F` are a '/' and a '?' there. The check decodes the same way, and refuses a '%' left
// after it, which a second decoding could turn into another character.
function decodedPath(src) {
  try {
    const decoded = decodeURIComponent(src.split('#')[0]);
    return decoded.includes('%') ? null : decoded;
  } catch {
    return null;
  }
}

// An absolute path is a file in the stage's public/: Vite would otherwise fall back to the
// runner's filesystem root.
function inPublic(decoded, srcDir) {
  const publicDir = path.join(srcDir, 'public');
  try {
    const real = fs.realpathSync(path.join(publicDir, decoded));
    return real.startsWith(fs.realpathSync(publicDir) + path.sep) && fs.statSync(real).isFile();
  } catch {
    return false;
  }
}

// `file` is the page the image is on, or null where VitePress renders it with no page, such
// as a container's title: there only a URL can be checked, so only a URL passes.
function imageStaysInDocs(src, file, srcDir) {
  if (IMAGE_URL.test(src)) return true;
  const decoded = decodedPath(src);
  if (decoded === null || /[?\\\0]/.test(decoded) || decoded.startsWith('//') || decoded.startsWith('/@')) return false;
  if (decoded.startsWith('/')) return inPublic(decoded, srcDir);
  if (file === null) return false;
  const rel = path.relative(srcDir, path.resolve(path.dirname(file), decoded));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The check is in the image render rule, which every image passes through, whatever renders
// it: a page, a heading, or a container title rendered on its own.
function imagesInDocs(md, srcDir) {
  const render = md.renderer.rules.image;
  // markdown-it calls a render rule with (tokens, idx, options, env, self).
  md.renderer.rules.image = (...args) => {
    const [tokens, idx, , env] = args;
    const src = tokens[idx].attrGet('src') ?? '';
    const file = env?.path ? env.realPath ?? env.path : null;
    if (!imageStaysInDocs(src, file, srcDir)) {
      const where = file ? path.relative(srcDir, file).split('\\').join('/') : 'a title';
      fail(`docs-build: ${where}: image ${JSON.stringify(src)} must be a URL or a path to a file in the docs, with no query; it would read a file from outside the docs.`);
    }
    return render(...args);
  };
}

// VitePress writes a fence's language, and a code-group tab's title, into the page as HTML
// without escaping them. GitHub shows neither as markup, so the characters that could open a
// tag, an attribute or an entity are dropped from the fence's info string before it renders.
const INFO_UNSAFE = /[<>"'`&\\\u0000-\u0008\u000a-\u001f\u007f]/g;

function fenceInfoAsText(md) {
  md.core.ruler.push('fence-info-as-text', (state) => {
    for (const token of state.tokens) {
      if (token.type === 'fence') token.info = token.info.replace(INFO_UNSAFE, '').replace(/\t/g, ' ');
    }
  });
}

function configureMarkdown(md, { srcDir, rewrite }) {
  noSnippets(md);
  fenceInfoAsText(md);
  pageAsText(md, srcDir);
  anchorWarnings(md, srcDir);
  alertTitleAsText(md);
  imagesInDocs(md, srcDir);
  textAsText(md);
  rewrittenLinks(md, srcDir, rewrite);
  permalinkLabels(md);
}

module.exports = { configureMarkdown };
