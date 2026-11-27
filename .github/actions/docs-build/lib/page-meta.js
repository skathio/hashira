// Each docs page's link preview and canonical URL: og:title, og:description, og:url and
// <link rel="canonical">, for the VitePress config's transformHead. The URL is the page's
// GitHub Pages address, https://<owner>.github.io<base><page>, so a shared link and a search
// engine both name the page as GitHub Pages serves it.

'use strict';

const { descriptionTag } = require('./html-safety');

// A GitHub owner name: letters, digits and single hyphens, at most 39 characters.
const OWNER = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;

// The Pages origin of the repo `owner/name`. Pages serves the owner's site in lower case. null
// when the owner can't be read (a local build outside GitHub, a fork on another host): the
// pages then get no og:url or canonical link rather than a wrong one, and the build goes on.
function siteOrigin(repository) {
  const owner = String(repository ?? '').split('/')[0];
  return OWNER.test(owner) ? `https://${owner.toLowerCase()}.github.io` : null;
}

// pages.json's description, or `Guides for <name>` when it is left out or empty.
const siteDescription = (config) => config.description || `Guides for ${config.name}`;

// The served path of a page (its path in the built site, rewrites applied): an index.md is
// its folder, any other page its .html file.
function pagePath(base, relativePath) {
  const rel = relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '.html');
  return `${base}${rel.split('/').map(encodeURIComponent).join('/')}`;
}

// The head tags for one page. VitePress escapes the attributes of head tags, so the title and
// description reach the HTML as text.
function pageHead({ origin, base, relativePath, title, description }) {
  const head = [
    descriptionTag(description),
    ['meta', { property: 'og:title', content: String(title ?? '') }],
    ['meta', { property: 'og:description', content: String(description ?? '') }],
  ];
  if (!origin) return head;
  const url = `${origin}${pagePath(base, relativePath)}`;
  return [...head, ['meta', { property: 'og:url', content: url }], ['link', { rel: 'canonical', href: url }]];
}

module.exports = { siteOrigin, siteDescription, pagePath, pageHead };
