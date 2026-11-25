// Defences added on top of the request: a stale re-run never moves the major tag back or
// redeploys an older site, a full re-run of an old run is refused once main has moved on, only
// main's own push runs count as CI, a hand run of site.yml deploys main only, a link named like
// an Object member is not a rewrite, the release concurrency comment says what GitHub does, the
// App-token pin carries its real version, and a listed guide that is gone fails the docs build.
// The release logic is CommonJS under tests/release/lib, loaded here so the cases sit in one file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rewriteLink } from './links.mjs'

const repoFile = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const read = (p) => readFileSync(repoFile(p), 'utf8')
const { planPublish, latestCiConclusion, assertCurrentMain, assertLatestRelease } =
  createRequire(import.meta.url)(repoFile('tests/release/lib/release.js'))

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const OLDER = 'c'.repeat(40)
const APP_ACTION_COMMIT = 'f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc'

// The jobs of a workflow as name to its block of text, read by indentation.
function jobBlocks(text) {
  const body = text.split(/^jobs:\n/m)[1]
  const blocks = {}
  let name = null
  for (const line of body.split('\n')) {
    const head = /^ {2}([\w-]+):\s*$/.exec(line)
    if (head) {
      name = head[1]
      blocks[name] = ''
    } else if (name) {
      blocks[name] += `${line}\n`
    }
  }
  return blocks
}

const needsOf = (block) => {
  const m = /^ {4}needs:\s*(.+)$/m.exec(block)
  return m ? m[1].replace(/[[\]\s]/g, '').split(',').filter(Boolean) : []
}

function ancestors(jobs, name) {
  const seen = new Set()
  const todo = needsOf(jobs[name])
  while (todo.length) {
    const job = todo.pop()
    if (!seen.has(job) && jobs[job]) {
      seen.add(job)
      todo.push(...needsOf(jobs[job]))
    }
  }
  return seen
}

// --- The major tag never moves back ---

test('a stale re-run leaves the major tag alone once a later release of that major is out', () => {
  const tags = { 'v3.1.0': HEAD, 'v3.2.0': OTHER, v3: OTHER, 'v3.0.0': OLDER }
  assert.equal(planPublish({ version: '3.1.0', sha: HEAD, tags, releaseExists: true }).majorTag, 'done')
})

test('an older release of the same major on another commit still moves the major tag forward', () => {
  const tags = { 'v3.0.0': OLDER, v3: OLDER, 'v3.1.0': HEAD }
  assert.equal(planPublish({ version: '3.1.0', sha: HEAD, tags, releaseExists: false }).majorTag, 'move')
})

test('the major-tag sink force-pushes only when the current major tag is in the released history', () => {
  const sink = jobBlocks(read('.github/workflows/release.yml')).publish
  const guard = sink.indexOf('git merge-base --is-ancestor')
  assert.ok(guard > 0, 'the sink checks ancestry')
  assert.ok(guard < sink.indexOf('push --force'), 'before the force push')
})

// --- A stale site deploy ---

test('the site deploys only while the released commit holds the highest release tag', () => {
  assert.doesNotThrow(() => assertLatestRelease({ tags: { 'v3.0.0': OLDER, 'v3.1.0': HEAD, v3: HEAD }, sha: HEAD }))
  assert.throws(() => assertLatestRelease({ tags: { 'v3.1.0': HEAD, 'v3.10.0': OTHER }, sha: HEAD }), /stale/,
    'v3.10.0 is newer than v3.1.0, so the versions are compared as numbers')
  assert.throws(() => assertLatestRelease({ tags: { v3: HEAD }, sha: HEAD }), /release refused/)
  for (const tags of [undefined, null, [], 'v3.1.0']) {
    assert.throws(() => assertLatestRelease({ tags, sha: HEAD }), /release refused/, JSON.stringify(tags))
  }
  assert.throws(() => assertLatestRelease({ tags: { 'v3.1.0': HEAD }, sha: 'main' }), /release refused/)
})

test('release.yml checks for the latest release in a job that the site deploy needs', () => {
  const jobs = jobBlocks(read('.github/workflows/release.yml'))
  const site = Object.keys(jobs).find((n) => /^ {4}uses: \.\/\.github\/workflows\/site\.yml\s*$/m.test(jobs[n]))
  const guards = Object.keys(jobs).filter((n) => jobs[n].includes('assertLatestRelease'))
  assert.ok(site && guards.length, 'a site job and a guard job')
  assert.ok(guards.some((g) => ancestors(jobs, site).has(g)), 'the site job needs the guard')
  for (const g of guards) {
    assert.ok(ancestors(jobs, g).has('publish'), 'the guard reads the tags after they are pushed')
    assert.doesNotMatch(jobs[g], /secrets\.|environment:|write/, 'the guard is read only')
  }
})

// --- A full re-run of an old run ---

test('a commit main has moved past is refused unless it already carries its release tag', () => {
  assert.throws(() => assertCurrentMain({ version: '3.1.0', sha: HEAD, mainHead: OTHER, tags: { 'v3.0.0': OLDER } }),
    /not main's HEAD/)
  assert.throws(() => assertCurrentMain({ version: '3.1.0', sha: HEAD, mainHead: OTHER, tags: { 'v3.1.0': OTHER } }),
    /not main's HEAD/)
  assert.doesNotThrow(() => assertCurrentMain({ version: '3.1.0', sha: HEAD, mainHead: HEAD, tags: {} }))
  assert.doesNotThrow(() => assertCurrentMain({ version: '3.1.0', sha: HEAD, mainHead: OTHER, tags: { 'v3.1.0': HEAD } }),
    'a re-run that finishes a partial release')
  for (const mainHead of [undefined, null, '']) {
    assert.throws(() => assertCurrentMain({ version: '3.1.0', sha: HEAD, mainHead, tags: {} }), /release refused/)
  }
  assert.throws(() => assertCurrentMain({ version: '3.1.0', sha: HEAD, mainHead: OTHER, tags: null }), /release refused/)
  assert.throws(() => assertCurrentMain({ version: '3.1.0', sha: 'main', mainHead: 'main', tags: {} }), /release refused/)
})

test("release.yml's check job compares the commit with origin's main", () => {
  const check = jobBlocks(read('.github/workflows/release.yml')).check
  assert.match(check, /assertCurrentMain\(/)
  assert.match(check, /refs\/remotes\/origin\/main/)
})

// --- Only main's own push runs count ---

test("a pull_request run at main's HEAD does not stand in for main's push run", () => {
  const push = { head_sha: HEAD, status: 'completed', event: 'push', head_branch: 'main' }
  const runs = [
    { ...push, conclusion: 'success', created_at: '2026-11-01T10:00:00Z' },
    { ...push, event: 'pull_request', head_branch: 'feat/x', conclusion: 'failure', created_at: '2026-11-01T11:00:00Z' },
  ]
  assert.equal(latestCiConclusion(runs, HEAD), 'success')
  assert.equal(latestCiConclusion([{ ...runs[1], conclusion: 'success' }], HEAD), null)
  assert.equal(latestCiConclusion([{ ...runs[0], head_branch: 'feat/x' }], HEAD), null)
  assert.match(jobBlocks(read('.github/workflows/release.yml')).check, /_self-ci\.yml\/runs\?[^"]*event=push/)
})

// --- Rewrites are looked up by own key only ---

test('a link named like an Object member is not taken for a rewrite', () => {
  const opts = { unpublished: ['contributing.md'], rewrites: { 'getting-started.md': 'index.md' } }
  for (const href of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(rewriteLink('usage.md', href, opts), null, href)
  }
  assert.equal(rewriteLink('usage.md', './getting-started.md#a', opts), 'index.md#a', 'a real rewrite still applies')
  assert.match(read('docs-site/.vitepress/config.mts'), /Object\.hasOwn\(rewrites, md\)/)
})

// --- A hand run of site.yml deploys main only ---

test('site.yml refuses a ref other than main before the approval and before npm ci', () => {
  const jobs = jobBlocks(read('.github/workflows/site.yml'))
  const refuse = /if \[ "\$\{REF\}" != "refs\/heads\/main" \]; then[\s\S]*?exit 1/
  for (const [name, before] of [['gate', 'Owner approval'], ['build', 'npm ci']]) {
    const m = refuse.exec(jobs[name])
    assert.ok(m, `${name} checks the ref`)
    assert.ok(m.index < jobs[name].indexOf(before), `${name} checks before ${before}`)
    assert.match(jobs[name], /REF: \$\{\{ github\.ref \}\}/, `${name} reads the ref through env`)
  }
})

// --- What the concurrency group does ---

test('the release concurrency comment and the skill say a later dispatch replaces a waiting one', () => {
  const lines = read('.github/workflows/release.yml').split('\n')
  const at = lines.findIndex((l) => l.startsWith('concurrency:'))
  let start = at
  while (start > 0 && lines[start - 1].startsWith('#')) start -= 1
  const comment = lines.slice(start, at).join(' ')
  assert.doesNotMatch(comment, /waits rather/)
  assert.match(comment, /replaces/)
  assert.match(comment, /cancelled/)
  assert.match(comment, /again/)
  const skill = read('.claude/skills/release/SKILL.md')
  assert.match(skill, /later dispatch replaces a\s+waiting run/)
  assert.match(skill, /Dispatch a cancelled release again/)
})

// --- The App-token pin's version comment ---

test('every create-github-app-token pin at f418cff says v3.4.0, the tag that SHA is', () => {
  const dir = repoFile('.github/workflows')
  let seen = 0
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!line.includes(`actions/create-github-app-token@${APP_ACTION_COMMIT}`)) return
      seen += 1
      let j = i
      const comment = [line]
      while (j > 0 && lines[j - 1].trim().startsWith('#')) comment.unshift(lines[(j -= 1)])
      const named = comment.join('\n').match(/create-github-app-token (v\d+\.\d+\.\d+)|# (v\d+\.\d+\.\d+)/)
      assert.ok(named, `${file}:${i + 1} has a version comment`)
      assert.equal(named[1] ?? named[2], 'v3.4.0', `${file}:${i + 1}`)
    })
  }
  assert.ok(seen >= 2, 'release.yml and _self-ci.yml pin it')
})

// --- A listed guide that is gone ---

const vitepress = repoFile('docs-site/node_modules/vitepress')

test('the docs build fails when a listed guide is missing', { skip: !existsSync(vitepress) && 'needs npm ci in docs-site/' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'docs-guides-'))
  try {
    mkdirSync(join(tmp, 'docs-site'))
    for (const f of ['build.sh', 'h1-label.mjs', 'links.mjs', '.vitepress']) {
      cpSync(repoFile(`docs-site/${f}`), join(tmp, 'docs-site', f), { recursive: true })
    }
    symlinkSync(repoFile('docs-site/node_modules'), join(tmp, 'docs-site/node_modules'))
    mkdirSync(join(tmp, 'docs/flows'), { recursive: true })
    writeFileSync(join(tmp, 'docs/usage.md'), '# Usage\n')
    writeFileSync(join(tmp, 'docs/flows/npm.md'), '# npm\n')
    cpSync(repoFile('site'), join(tmp, 'site'), { recursive: true })
    const run = spawnSync('bash', [join(tmp, 'docs-site/build.sh')], { cwd: tmp, encoding: 'utf8', timeout: 300_000 })
    assert.notEqual(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout + run.stderr, /listed guides missing from docs\/: getting-started\.md/)
    assert.equal(existsSync(join(tmp, 'artifacts/pages')), false, 'no Pages folder is left behind')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
