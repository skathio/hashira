// Checks that a built site's HTML loads only site-kit files that exist. A page that names
// `_kit/<file>` (or `../_kit/<file>` from a sub-page) gets that file from site-kit at build time;
// a typo, or a kit file a later hashira version renamed, would otherwise ship as a page with no
// header or theme and a 404 in the console. pages-site.yml's build runs it after site-kit and
// docs-build, before the upload, so a broken reference stops the deploy.
//
// Only relative src and href values with a `_kit` path segment are checked: an absolute path
// (`/repo/_kit/...`) or a URL depends on where the site is served, which the build cannot know.
// Node 20 compatible, no packages. A .cjs file, so a caller's "type": "module" cannot change it.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A tag and its attribute text, quoted values respected (the way docs-build's html-safety.js
// reads SVG tags), so escaped text such as `&lt;script src="_kit/x.js"&gt;` is never read.
const TAG = /<([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
// One attribute of a tag's text, name and optional quoted or bare value, read in order so a
// value that holds ` src=` is never taken for an attribute.
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const REFERENCE = new Set(['src', 'href']);
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

/** The relative `_kit` references in one page's HTML, without query or fragment. */
function kitReferences(html) {
  const found = [];
  for (const [, , attrs] of html.matchAll(TAG)) {
    for (const [, name, ...values] of attrs.matchAll(ATTRIBUTE)) {
      if (!REFERENCE.has(name.toLowerCase())) continue;
      const value = (values.find((v) => v !== undefined) ?? '').trim().split(/[?#]/)[0];
      if (value && !NOT_RELATIVE.test(value) && value.split('/').includes('_kit')) found.push(value);
    }
  }
  return found;
}

/** Every .html file under `dir`, not following symlinked folders. */
function htmlFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...htmlFiles(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) files.push(full);
  }
  return files;
}

/** One problem per reference that does not name a file inside the site. */
function referenceProblem(root, page, ref) {
  const target = path.resolve(path.dirname(page), ref);
  const where = `${path.relative(root, page)}: ${ref}`;
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return `${where} resolves outside the site`;
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  return stat && stat.isFile() ? null : `${where} names no kit file (site-kit copies ${kitFileList(root)})`;
}

function kitFileList(root) {
  const kit = path.join(root, '_kit');
  return fs.existsSync(kit) ? fs.readdirSync(kit).sort().join(', ') : 'nothing: there is no _kit folder';
}

/** Every broken kit reference in the site at `root`. */
function check(root) {
  const full = path.resolve(root);
  const problems = [];
  for (const page of htmlFiles(full)) {
    for (const ref of kitReferences(fs.readFileSync(page, 'utf8'))) {
      const problem = referenceProblem(full, page, ref);
      if (problem) problems.push(problem);
    }
  }
  return problems;
}

function main(argv) {
  const [root] = argv;
  if (!root || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write(`::error::pages-site: kit check: '${root ?? ''}' is not a folder.\n`);
    return 1;
  }
  const problems = check(root);
  for (const p of problems) process.stderr.write(`::error::pages-site: ${p}.\n`);
  if (problems.length === 0) process.stdout.write(`pages-site: every _kit reference in '${root}' names a kit file.\n`);
  return problems.length === 0 ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { kitReferences, check, main };
