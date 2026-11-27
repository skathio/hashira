// What the VitePress config needs from pages.json and the stage, after pre_build_command ran:
// the docs index rewrite, the sidebar, the header items and where a folder link goes. Kept
// apart from config.mts so it runs and is tested without a build.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { h1Label } = require('./h1-label');
const { escapeHtml, isUnpublished } = require('./links');
const { GENERATED_SIDEBAR, loadGeneratedSidebar, sidebarFiles } = require('./pages-config');
const { svgProblems } = require('./html-safety');

const INDEX = 'index.md';
const posix = path.posix;

const fail = (msg) => {
  throw new Error(`docs-build: ${msg}`);
};

// The published Markdown pages in the stage, as paths relative to it, in path order. public/
// holds files served as they are, not pages.
function stagedPages(stage, unpublished) {
  const pages = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const sub = `${rel}${entry.name}`;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || sub === 'public') continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${sub}/`);
      else if (entry.name.endsWith('.md')) pages.push(sub);
    }
  };
  walk(stage, '');
  return pages.filter((rel) => !isUnpublished(rel, unpublished)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// The landing page: the folder above the docs base (/site/ for /site/docs/).
function landingOf(base) {
  const trimmed = base.replace(/\/$/, '');
  return trimmed === '' ? '/' : `${posix.dirname(trimmed).replace(/\/$/, '')}/`;
}

// A header href resolved against the landing, as <site-nav> on the landing reads it. A URL
// with a scheme stays as written (pages.json only allows http and https), and so does a
// scheme-relative //host/path, which names another host on the landing too.
function landingHref(href, landing) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return href;
  const url = new URL(href, `https://landing.invalid${landing}`);
  return `${url.pathname}${url.search}${url.hash}`;
}

// The page that /<base>/ opens: home_page, unless it is unpublished. A page already called
// index.md needs no rewrite; any other with an index.md beside it would be written over.
function indexRewrite(config, pages) {
  const home = config.home_page;
  if (home === INDEX || !pages.includes(home)) return {};
  if (pages.includes(INDEX)) fail(`${INDEX} in the docs would collide with ${home}, published as the docs index: rename ${INDEX} or set home_page to ${INDEX}.`);
  return { [home]: INDEX };
}

const pageLink = (md, rewrites) => `/${(Object.hasOwn(rewrites, md) ? rewrites[md] : md).replace(/(index)?\.md$/, '')}`;

// The sidebar entries in order, then every other published page by path under its first H1.
// config.sidebar is pages.json's, or the one pre_build_command generated. A group keeps its
// entries; a folder section lists the pages under its dir, in path order under their H1, that
// no page entry and no earlier folder section lists. Labels are HTML-escaped: VitePress
// renders sidebar text as HTML.
function sidebarItems(config, pages, stage, rewrites) {
  const { sidebar } = config;
  const named = sidebarFiles(sidebar);
  const missing = named.filter((f) => !pages.includes(f));
  if (missing.length) fail(`sidebar files missing from the docs after pre_build_command: ${missing.join(', ')}`);
  const listed = new Set(named);
  const page = (f) => ({ text: h1Label(fs.readFileSync(path.join(stage, f), 'utf8'), escapeHtml(f)), link: pageLink(f, rewrites) });
  const folder = (dir) => {
    const prefix = dir.replace(/\/?$/, '/');
    const found = pages.filter((f) => f.startsWith(prefix) && !listed.has(f));
    if (found.length === 0) fail(`sidebar folder section ${prefix} lists no page: none is published there that the sidebar does not already list.`);
    found.forEach((f) => listed.add(f));
    return found.map(page);
  };
  const render = (entry) => {
    if (entry.file) return { text: escapeHtml(entry.label), link: pageLink(entry.file, rewrites) };
    const collapsed = typeof entry.collapsed === 'boolean' ? { collapsed: entry.collapsed } : {};
    return { text: escapeHtml(entry.label), ...collapsed, items: entry.items ? entry.items.map(render) : folder(entry.dir) };
  };
  const items = sidebar.map(render);
  return [...items, ...pages.filter((f) => !listed.has(f)).map(page)];
}

// VitePress's top bar shows its links one by one and only folds them into its menu below
// 768px, so past this many nav entries they go into one dropdown labelled with the site name,
// and the bar keeps the site title, the dropdown, Docs and home_link, in <site-nav>'s order.
const NAV_IN_BAR = 2;

// The header, in <site-nav>'s order: the nav links, Docs, then home_link (the brand is
// VitePress's logo link and the theme toggle follows the menu). target _self keeps each
// landing link out of VitePress's router, and the theme's RawLink keeps its href as built.
// Docs is active on every docs page through activeMatch, which VitePress tests as a regular
// expression against the page path.
function navItems(config, landing) {
  const toLanding = (e) => ({ text: escapeHtml(e.label), link: landingHref(e.href, landing), target: '_self' });
  const docs = { text: 'Docs', link: '/', activeMatch: '^/' };
  const links = config.nav.map(toLanding);
  const home = config.home_link ? [toLanding(config.home_link)] : [];
  const bar = links.length <= NAV_IN_BAR ? links : [{ text: escapeHtml(config.name), items: links }];
  return [...bar, docs, ...home];
}

// A link to a folder of docs/ with no index page of its own opens that folder on GitHub.
function folderCheck(docs, stage) {
  const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();
  return (repoPath) => {
    const sub = repoPath.slice('docs/'.length);
    return (isDir(path.join(docs, sub)) || isDir(path.join(stage, sub))) && !fs.existsSync(path.join(stage, sub, INDEX));
  };
}

// A link that leaves docs/ (or reaches an unpublished page) opens on GitHub as a folder when
// the repo path it names is a folder of the checkout, whether or not it ends in '/'. Only a
// path whose real location stays inside the checkout counts.
function repoDirCheck(docs) {
  const root = path.dirname(docs);
  const realRoot = fs.realpathSync(root);
  return (repoPath) => {
    try {
      const real = fs.realpathSync(path.join(root, repoPath));
      return (real === realRoot || real.startsWith(realRoot + path.sep)) && fs.statSync(real).isDirectory();
    } catch {
      return false;
    }
  };
}

// docs/ holds Markdown pages and static files. VitePress runs code it finds beside the pages
// (a `[id].paths.js` for a `[id].md` dynamic route, and whatever such code imports), so any
// other kind of file, and any name with a bracket, fails the build before VitePress sees it.
const STATIC_FILE = /\.(?:md|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|pdf|txt|csv)$/i;

function checkStagedFiles(files, prefix) {
  for (const rel of files) {
    if (/[[\]]/.test(rel)) fail(`${prefix}${rel}: a [ or ] in a name makes a VitePress dynamic route, which runs code at build time.`);
    // VitePress builds a .md under public/ as a page, outside the page checks here.
    if (/^public\//.test(rel) && /\.md$/i.test(rel)) fail(`${prefix}${rel}: a Markdown file under public/ would be built as a page; public/ is for files served as they are.`);
    if (!STATIC_FILE.test(rel)) fail(`${prefix}${rel}: only Markdown pages and static files (images, fonts, PDF, text, CSV) are published.`);
  }
}

// Every file in the stage, as paths relative to it.
function allFiles(stage) {
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${rel}${entry.name}/`);
      else files.push(`${rel}${entry.name}`);
    }
  };
  walk(stage, '');
  return files;
}

// VitePress replaces `<!--@include: path-->` with any file the runner can read, outside the
// docs too, before markdown-it sees the page. GitHub hides the comment, so no page may hold one.
const INCLUDE = /<!--\s*@include:/;

function refuseIncludes(stage, pages) {
  for (const rel of pages) {
    if (INCLUDE.test(fs.readFileSync(path.join(stage, rel), 'utf8'))) {
      fail(`${rel}: <!--@include--> is not supported; it would publish a file from outside the docs.`);
    }
  }
}

// gray-matter runs front matter that opens with `---js` (or `---javascript`) as code, and
// reads other languages with engines of their own. Only YAML is read: a page whose opening
// `---` line names another language fails, before VitePress parses it. The config's engines
// throw too, so a page this check missed still fails.
const FRONT_MATTER_LANG = /^\uFEFF?---[ \t]*([^\s-][^\r\n]*?)[ \t]*(?:\r?\n|$)/;

function refuseFrontMatterCode(dir, pages, prefix) {
  for (const rel of pages) {
    const lang = fs.readFileSync(path.join(dir, rel), 'utf8').match(FRONT_MATTER_LANG)?.[1];
    if (lang && lang.toLowerCase() !== 'yaml') {
      fail(`${prefix}${rel}: front matter in ${lang.slice(0, 20)} is not supported; only YAML front matter is read.`);
    }
  }
}

// An SVG is published as a file a browser may open on its own, with the docs' origin: one
// that could run a script fails the build, naming the file (lib/html-safety.js svgProblems).
function refuseUnsafeSvgs(dir, files, prefix) {
  for (const rel of files.filter((f) => /\.svg$/i.test(f))) {
    const problems = svgProblems(fs.readFileSync(path.join(dir, rel), 'utf8'));
    if (problems.length > 0) fail(`${prefix}${rel}: an SVG that could run a script is not published: ${problems.slice(0, 3).join('; ')}.`);
  }
}

function siteConfig(build) {
  const { config, stage } = build;
  // pre_build_command may have added files since prepare.js checked the stage.
  // prepare.js stages theme_css itself, the one CSS file served as it is.
  // The generated sidebar is read here, never published.
  const own = new Set([build.themeCss ? `public/${build.themeCss}` : null, GENERATED_SIDEBAR]);
  const staged = allFiles(stage).filter((rel) => !own.has(rel) && !isUnpublished(rel, config.unpublished));
  checkStagedFiles(staged, '');
  refuseUnsafeSvgs(stage, staged, '');
  const pages = stagedPages(stage, config.unpublished);
  refuseFrontMatterCode(stage, pages, '');
  refuseIncludes(stage, pages);
  const rewrites = indexRewrite(config, pages);
  const landing = landingOf(config.base);
  return {
    rewrites,
    landing,
    sidebar: sidebarItems({ ...config, sidebar: loadGeneratedSidebar(stage) ?? config.sidebar }, pages, stage, rewrites),
    nav: navItems(config, landing),
    isFolder: folderCheck(build.docs, stage),
    isRepoDir: repoDirCheck(build.docs),
  };
}

module.exports = { checkStagedFiles, refuseFrontMatterCode, refuseUnsafeSvgs, siteConfig, isUnpublished, stagedPages, landingOf, landingHref, indexRewrite, sidebarItems, navItems, pageLink };
