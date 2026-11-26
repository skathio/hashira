// Edges of the site-kit action's copy step beyond the rules file: a missing or empty dest, a
// _kit the site already has, a dest that is a symlink out of the workspace, the kit_path
// output, and a dest with a trailing slash or a name holding "..".
//
// Run with:
//   node --test tests/site-kit/site-kit-action-edges.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ACTION_DIR = path.join(REPO, '.github', 'actions', 'site-kit');

function copyStep() {
  const py = 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))';
  const run = spawnSync('python3', ['-c', py, path.join(ACTION_DIR, 'action.yml')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout).runs.steps.find((s) => s.id === 'copy');
}

const temps = [];
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function workspace() {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'site-kit-edges-'));
  temps.push(outer);
  const ws = path.join(outer, 'ws');
  fs.mkdirSync(ws);
  return { outer, ws };
}

function run(dest, ws, outer) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GITHUB_')));
  Object.assign(env, {
    SK_DEST: dest, SK_KIT: path.join(ACTION_DIR, 'kit'), GITHUB_WORKSPACE: ws,
    GITHUB_OUTPUT: path.join(outer, 'output'), GITHUB_STEP_SUMMARY: path.join(outer, 'summary'),
  });
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', copyStep().run], { cwd: ws, env, encoding: 'utf8' });
}

const fails = (r, pattern) => {
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /::error::site-kit:/);
  assert.match(r.stderr, pattern);
};

test('an empty dest fails and names the input', () => {
  const { ws, outer } = workspace();
  fails(run('', ws, outer), /dest is required/);
  assert.equal(fs.existsSync(path.join(ws, '_kit')), false);
});

test('a dest that does not exist fails without creating it', () => {
  const { ws, outer } = workspace();
  fails(run('dist', ws, outer), /does not exist/);
  assert.equal(fs.existsSync(path.join(ws, 'dist')), false);
});

test('a dest that already holds _kit fails and leaves the site\'s own _kit alone', () => {
  const { ws, outer } = workspace();
  fs.mkdirSync(path.join(ws, 'site', '_kit'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'site', '_kit', 'mine.css'), 'mine');
  fails(run('site', ws, outer), /site\/_kit' already exists/);
  assert.deepEqual(fs.readdirSync(path.join(ws, 'site', '_kit')), ['mine.css']);
});

test('a dest symlinked out of the workspace fails and writes nothing there', () => {
  const { ws, outer } = workspace();
  const elsewhere = path.join(outer, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(ws, 'site'));
  fails(run('site', ws, outer), /outside the workspace/);
  assert.equal(fs.existsSync(path.join(elsewhere, '_kit')), false);
});

test('kit_path names the copy, and a trailing slash on dest is accepted', () => {
  const { ws, outer } = workspace();
  fs.mkdirSync(path.join(ws, 'dist'));
  const r = run('dist/', ws, outer);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(outer, 'output'), 'utf8'), /^kit_path=dist\/_kit$/m);
  assert.deepEqual(fs.readdirSync(path.join(ws, 'dist', '_kit')).sort(), ['site-nav.js', 'theme.js', 'tokens.css']);
});

test('a folder name that only contains ".." (not a segment) is allowed', () => {
  const { ws, outer } = workspace();
  fs.mkdirSync(path.join(ws, 'a..b'));
  const r = run('a..b', ws, outer);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(ws, 'a..b', '_kit', 'tokens.css')));
});
