// docs-build's Markdown renderer hooks (lib/markdown.js), run against a small stand-in for
// markdown-it: braces render as text, links go where `rewrite` says, and a permalink's
// aria-label is its heading's plain text.
//
// Run with: node --test tests/docs-build/markdown.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { configureMarkdown } = require(path.join(__dirname, '..', '..', '.github', 'actions', 'docs-build', 'lib', 'markdown.js'));

function token(type, attrs = {}, content = '') {
  const map = new Map(Object.entries(attrs));
  return { type, content, attrGet: (k) => (map.has(k) ? map.get(k) : null), attrSet: (k, v) => map.set(k, v), attrs: map };
}

function fakeMd() {
  const rules = [];
  const disabled = [];
  return {
    renderer: { rules: { text: (tokens, i) => tokens[i].content, code_inline: (tokens, i) => `<code>${tokens[i].content}</code>`, image: (tokens, i) => `<img ${tokens[i].attrGet('src')}>` } },
    core: { ruler: { push: (name, fn) => rules.push([name, fn]) } },
    block: { ruler: { disable: (name, ignoreInvalid) => disabled.push([name, ignoreInvalid]) } },
    render: (src) => `<p>${src}</p>`,
    run(state) {
      rules.forEach(([, fn]) => fn(state));
    },
    rules,
    disabled,
  };
}

test('text and inline code render their braces as entities', () => {
  const md = fakeMd();
  configureMarkdown(md, { srcDir: '/src', rewrite: () => null });
  const tokens = [token('text', {}, '${{ github.token }}')];
  assert.equal(md.renderer.rules.text(tokens, 0), '$&#123;&#123; github.token &#125;&#125;');
  assert.equal(md.renderer.rules.code_inline(tokens, 0), '<code>$&#123;&#123; github.token &#125;&#125;</code>');
});

test('a link gets the href rewrite returns, from the page path relative to srcDir', () => {
  const md = fakeMd();
  const seen = [];
  const rewrite = (page, href) => {
    seen.push([page, href]);
    return href === 'x.md' ? 'https://example.test/x.md' : null;
  };
  configureMarkdown(md, { srcDir: '/src', rewrite });
  const moved = token('link_open', { href: 'x.md' });
  const kept = token('link_open', { href: 'y.md' });
  md.run({ env: { path: '/src/flows/a.md' }, tokens: [{ children: [moved, kept] }] });
  assert.deepEqual(seen, [['flows/a.md', 'x.md'], ['flows/a.md', 'y.md']]);
  assert.equal(moved.attrGet('href'), 'https://example.test/x.md');
  assert.equal(kept.attrGet('href'), 'y.md');
});

test('the page path comes from realPath when VitePress moved the page', () => {
  const md = fakeMd();
  let page;
  configureMarkdown(md, { srcDir: '/src', rewrite: (p) => { page = p; return null; } });
  md.run({ env: { path: '/src/index.md', realPath: '/src/getting-started.md' }, tokens: [{ children: [token('link_open', { href: 'a.md' })] }] });
  assert.equal(page, 'getting-started.md');
});

test('a permalink is labelled with its heading as plain text', () => {
  const md = fakeMd();
  configureMarkdown(md, { srcDir: '/src', rewrite: () => null });
  const permalink = token('link_open', { class: 'header-anchor', 'aria-label': 'Permalink to "The `ci` \\*job"' });
  const heading = { children: [token('text', {}, 'The '), token('code_inline', {}, 'ci'), token('text', {}, ' *job '), permalink] };
  md.run({ env: { path: '/src/a.md' }, tokens: [heading] });
  assert.equal(permalink.attrGet('aria-label'), 'Permalink to "The ci *job"');
});

test('the <<< snippet rule is turned off, so a snippet line reads no file', () => {
  const md = fakeMd();
  configureMarkdown(md, { srcDir: '/src', rewrite: () => null });
  assert.deepEqual(md.disabled, [['snippet', true]]);
});

test('a render with no page in env, such as a front matter title, rewrites nothing and does not throw', () => {
  const md = fakeMd();
  const seen = [];
  configureMarkdown(md, { srcDir: '/src', rewrite: (page, href) => seen.push([page, href]) && '/x' });
  const link = token('link_open', { href: 'a.md' });
  md.run({ env: {}, tokens: [{ children: [link] }] });
  assert.deepEqual(seen, []);
  assert.equal(link.attrGet('href'), 'a.md');
});

test('a rendered page is wrapped in one v-pre, so Vue compiles nothing in it', () => {
  const md = fakeMd();
  configureMarkdown(md, { srcDir: '/src', rewrite: () => null });
  assert.equal(md.render('{{ 1 }}', {}), '<div v-pre><p>{{ 1 }}</p></div>');
});

function withErrors(fn) {
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(line);
  try {
    fn();
  } finally {
    console.error = original;
  }
  assert.ok(errors.every((line) => /^::error::docs-build: /.test(line) && !line.includes('\n')));
}

// A real stage, so an absolute path can be checked against its public/ folder.
function stageWithPublic() {
  const fs = require('node:fs');
  const os = require('node:os');
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-images-'));
  fs.mkdirSync(path.join(srcDir, 'public'));
  fs.writeFileSync(path.join(srcDir, 'public', 'pub.png'), 'png');
  fs.mkdirSync(path.join(srcDir, 'public', 'dir'));
  fs.symlinkSync(os.tmpdir(), path.join(srcDir, 'public', 'out'));
  test.after(() => fs.rmSync(srcDir, { recursive: true, force: true }));
  return srcDir;
}

test('an image outside the docs or with a query fails; a URL or a path in the docs passes', () => {
  const srcDir = stageWithPublic();
  const md = fakeMd();
  configureMarkdown(md, { srcDir, rewrite: () => null });
  const render = (src, env) => md.renderer.rules.image([token('image', { src })], 0, {}, env, {});
  const env = { path: path.join(srcDir, 'guide', 'a.md') };
  withErrors(() => {
    for (const src of ['../../x.txt', '../b.png?url', 'c.png?raw', '/@fs/etc/hostname', '//evil.example/a.png', 'a\\b.png', '%E0%A4%A',
      '/etc/hostname', '/missing.png', '/dir', '/out/x.png', 'x%2F..%2F..%2F..%2Fy.svg']) {
      assert.throws(() => render(src, env), /guide\/a\.md: image .* must be a URL or a path to a file in the docs/, src);
    }
    for (const src of ['b.png', '../top.png', '/pub.png', 'img/c%20d.png#x', 'https://x.example/a.png', 'http://x.example/a.png', 'data:image/png;base64,AA==']) {
      assert.doesNotThrow(() => render(src, env), src);
    }
  });
});

test('an image rendered with no page, such as in a container title, passes only as a URL', () => {
  const srcDir = stageWithPublic();
  const md = fakeMd();
  configureMarkdown(md, { srcDir, rewrite: () => null });
  const render = (src, env) => md.renderer.rules.image([token('image', { src })], 0, {}, env, {});
  withErrors(() => {
    for (const env of [{}, undefined, { references: {} }]) {
      for (const src of ['b.png', '../../creds?raw', 'img/a.svg']) {
        assert.throws(() => render(src, env), /docs-build: a title: image .* must be a URL/, src);
      }
      for (const src of ['https://x.example/a.png', 'data:image/png;base64,AA==', '/pub.png']) {
        assert.equal(render(src, env), `<img ${src}>`, src);
      }
    }
  });
});
