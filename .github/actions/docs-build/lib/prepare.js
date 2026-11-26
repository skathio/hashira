// The docs-build action's first step, run from the caller's repo root before anything is
// installed: it refuses a bad output_dir, loads and checks .github/pages.json, and builds a
// work folder under RUNNER_TEMP that holds a copy of the VitePress toolchain (vitepress/),
// these helpers (lib/), and the stage (vitepress/src/): every file under docs/ except the
// unpublished ones, plus the logo. VitePress reads the stage, never docs/, so the build
// cannot change the caller's files. Writes `work` and `stage` to GITHUB_OUTPUT.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadPagesConfig } = require('./pages-config');
const { accentCss } = require('./accent');
const { checkStagedFiles, isUnpublished, refuseFrontMatterCode } = require('./site-config');

const ACTION_DIR = path.resolve(__dirname, '..');
const INDEX = 'index.md';

const fail = (msg) => {
  throw new Error(`docs-build: ${msg}`);
};

const inside = (real, realRoot) => real === realRoot || real.startsWith(realRoot + path.sep);

// output_dir must be a new folder inside the repo: relative, no '..', not there yet, and with
// no symlinked parent that would carry the write outside the repo.
function checkOutputDir(root, out) {
  if (!out) fail('output_dir is required.');
  if (path.isAbsolute(out) || out.startsWith('/')) fail(`output_dir must be repo-relative, without a leading '/' (got: '${out}').`);
  if (out.split(/[\\/]/).includes('..')) fail(`output_dir must not contain '..' segments (got: '${out}').`);
  const full = path.join(root, out);
  let there = true;
  try {
    fs.lstatSync(full);
  } catch {
    there = false;
  }
  if (there) fail(`output_dir '${out}' already exists; docs-build never writes over it.`);
  let parent = path.dirname(full);
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  if (!inside(fs.realpathSync(parent), fs.realpathSync(root))) fail(`output_dir '${out}' resolves outside the repo.`);
  return full;
}

// The caller's repo on GitHub, for the links that open a file there.
function repoUrl() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) fail('GITHUB_REPOSITORY is not set, so links to GitHub cannot be built.');
  return `${(process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '')}/${repo}`;
}

// Every file under docs/ (paths relative to docs/), skipping dot entries and node_modules. A
// symlink is followed only when its target stays inside the repo; a directory is walked once.
function docsFiles(docs, realRoot) {
  const files = [];
  const seen = new Set();
  const walk = (dir, rel) => {
    const real = fs.realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    for (const entry of fs.readdirSync(dir).sort()) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const full = path.join(dir, entry);
      const target = fs.realpathSync(full);
      if (!inside(target, realRoot)) fail(`docs/${rel}${entry} is a symlink that leaves the repo.`);
      // Dot entries are skipped by name, so a link must not reach one either: .git holds the
      // repo's config, and a checkout that keeps its credentials writes the token there.
      const hidden = path.relative(realRoot, target).split(path.sep).find((seg) => seg.startsWith('.') || seg === 'node_modules');
      if (hidden) fail(`docs/${rel}${entry} is a symlink into ${hidden}, which is never published.`);
      if (fs.statSync(target).isDirectory()) walk(full, `${rel}${entry}/`);
      else files.push(`${rel}${entry}`);
    }
  };
  walk(docs, '');
  return files;
}

// The home page is published as the docs index, so a docs/index.md would be written to the
// same page: fail instead of letting one replace the other.
function checkIndex(config, published) {
  const home = config.home_page;
  if (home !== INDEX && !isUnpublished(home, config.unpublished) && published.includes(INDEX)) {
    fail(`docs/${INDEX} exists and would collide with docs/${home}, published as the docs index: rename docs/${INDEX} or set home_page to ${INDEX}.`);
  }
}

function copyToolchain(work) {
  fs.cpSync(path.join(ACTION_DIR, 'lib'), path.join(work, 'lib'), { recursive: true });
  const skip = new Set(['node_modules', 'src', 'dist', 'cache']);
  fs.cpSync(path.join(ACTION_DIR, 'vitepress'), path.join(work, 'vitepress'), {
    recursive: true,
    filter: (src) => !skip.has(path.relative(path.join(ACTION_DIR, 'vitepress'), src).split(path.sep)[0]),
  });
}

// Copies a repo file into the docs' public/ folder, served as it is, and returns its name there.
function publish(root, stage, { from, name, what }) {
  const dest = path.join(stage, 'public', name);
  if (fs.existsSync(dest)) fail(`docs/public/${name} would be replaced by the ${what} ${from}: rename one of them.`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, from), dest);
  return name;
}

function stageDocs(root, config, files, stage) {
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
    fs.copyFileSync(path.join(root, 'docs', rel), path.join(stage, rel));
  }
  return config.logo ? publish(root, stage, { from: config.logo, name: path.posix.basename(config.logo), what: 'logo' }) : null;
}

// theme_css is served as a file of its own, loaded after the shared theme so its rules win,
// and never passes through Vite: Vite would resolve its url() and @import paths at build
// time and publish whatever file they name, from anywhere the runner can read. The browser
// resolves them against the published site instead.
const THEME_CSS = 'site-theme.css';

// The shared theme imports accent.css, so the site's accent comes after the shared colours.
function writeTheme(root, config, vitepress, stage) {
  fs.writeFileSync(path.join(vitepress, '.vitepress', 'theme', 'accent.css'), accentCss(config.accent));
  return config.theme_css ? publish(root, stage, { from: config.theme_css, name: THEME_CSS, what: 'theme_css' }) : null;
}

function prepare(root, out) {
  checkOutputDir(root, out);
  const config = loadPagesConfig(root);
  const docs = path.join(root, 'docs');
  if (!fs.existsSync(docs) || !fs.statSync(docs).isDirectory()) fail(`docs/ not found in ${root}.`);
  const published = docsFiles(docs, fs.realpathSync(root)).filter((rel) => !isUnpublished(rel, config.unpublished));
  checkIndex(config, published);
  checkStagedFiles(published, 'docs/');
  refuseFrontMatterCode(docs, published.filter((rel) => rel.endsWith('.md')), 'docs/');
  const work = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'docs-build-'));
  copyToolchain(work);
  const vitepress = path.join(work, 'vitepress');
  const stage = path.join(vitepress, 'src');
  const logo = stageDocs(root, config, published, stage);
  const themeCss = writeTheme(root, config, vitepress, stage);
  const build = { config, logo, themeCss, repo: repoUrl(), docs, stage, dist: path.join(work, 'dist'), cache: path.join(work, 'cache') };
  fs.writeFileSync(path.join(vitepress, '.vitepress', 'build.json'), `${JSON.stringify(build, null, 2)}\n`);
  return { work, stage };
}

function main() {
  try {
    const { work, stage } = prepare(process.cwd(), process.env.DB_OUTPUT_DIR || '');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `work=${work}\nstage=${stage}\n`);
    process.stdout.write(`docs-build: staged the docs in ${stage}\n`);
  } catch (err) {
    const msg = err.message.startsWith('docs-build:') ? err.message : `docs-build: ${err.message}`;
    process.stderr.write(`::error::${msg.replace(/\r?\n/g, ' ')}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { prepare, checkOutputDir, docsFiles, isUnpublished };
