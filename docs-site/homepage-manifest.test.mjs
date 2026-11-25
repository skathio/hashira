// Rules for .github/homepage.json, the manifest the org homepage (skathio.github.io) reads for
// hashira's tile: its Docs link opens the published docs site, and its links stay within the
// homepage's limits (at most 4, each https), since the homepage drops a field it refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsSite = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(docsSite, '..', '.github', 'homepage.json'), 'utf8'));
const config = readFileSync(join(docsSite, '.vitepress', 'config.mts'), 'utf8');

test('the tile links to the docs site at the base the docs are built for', () => {
  const base = config.match(/^\s*base:\s*'([^']+)'/m);
  assert.ok(base, 'no base in docs-site/.vitepress/config.mts');
  assert.equal(manifest.links?.Docs, `https://skathio.github.io${base[1]}`);
});

test('the tile has at most 4 links, each an https URL', () => {
  const links = Object.entries(manifest.links ?? {});
  assert.ok(links.length <= 4, `${links.length} links`);
  for (const [label, url] of links) {
    assert.equal(new URL(url).protocol, 'https:', `${label}: ${url}`);
  }
});
