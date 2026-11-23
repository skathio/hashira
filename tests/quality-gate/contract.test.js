// Contract tests for the quality-gate composite action: its files, its
// pinned SoMi install, its Dependabot entry and the CI job that runs its
// unit tests. Behaviour of the lib/ helpers is covered by their own tests
// in this folder; this file checks the parts the request fixes by name.
//
// Run locally with:  node --test tests/quality-gate/contract.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const ACTION_DIR = path.join(ROOT, '.github', 'actions', 'quality-gate');
const ACTION_YML = path.join(ACTION_DIR, 'action.yml');
const LIB_DIR = path.join(ACTION_DIR, 'lib');
const TEST_DIR = __dirname;
const SELF_CI = path.join(ROOT, '.github', 'workflows', '_self-ci.yml');
const DEPENDABOT = path.join(ROOT, '.github', 'dependabot.yml');

// "About 80 lines": the existing building blocks run up to the high 90s,
// so 100 is the tolerance this test allows.
const ACTION_LINE_LIMIT = 100;
const SKIP_MESSAGE = 'skipped: quality gate runs on pull requests';
const EXACT_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SHA_PIN = /@[0-9a-f]{40}\b/;

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function readJson(file) {
  return JSON.parse(read(file));
}

function libFiles() {
  return fs.readdirSync(LIB_DIR).filter((f) => /\.(c?js|mjs)$/.test(f));
}

function gateTestFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js'));
}

// Every text the action can write: action.yml plus its lib/ sources.
function actionSources() {
  const libs = libFiles().map((f) => read(path.join(LIB_DIR, f)));
  return [read(ACTION_YML), ...libs].join('\n');
}

// Top-level job blocks of a workflow, keyed by job id, from the text under
// `jobs:`. Job ids sit at two-space indent in this repo's workflows.
function jobBlocks(text) {
  const body = text.slice(text.search(/^jobs:\s*$/m));
  const blocks = {};
  let current = null;
  for (const line of body.split('\n').slice(1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      current = m[1];
      blocks[current] = [];
    } else if (current) {
      blocks[current].push(line);
    }
  }
  return Object.fromEntries(Object.entries(blocks).map(([k, v]) => [k, v.join('\n')]));
}

// Dependabot `updates:` entries as text, one per `- package-ecosystem:` item.
function dependabotEntries(text) {
  return text.split(/^\s*-\s+package-ecosystem:/m).slice(1).map((e) => `package-ecosystem:${e}`);
}

test('the action directory has action.yml, lib/, package.json and package-lock.json', () => {
  for (const rel of ['action.yml', 'lib', 'package.json', 'package-lock.json']) {
    assert.ok(fs.existsSync(path.join(ACTION_DIR, rel)), `missing .github/actions/quality-gate/${rel}`);
  }
  assert.ok(libFiles().length >= 1, 'lib/ holds no JavaScript: the logic belongs in lib/');
});

test('action.yml is a composite action of about 80 lines', () => {
  const text = read(ACTION_YML);
  assert.match(text, /^runs:\s*\n\s+using:\s*["']?composite["']?\s*$/m);
  const lines = text.replace(/\n$/, '').split('\n').length;
  assert.ok(lines <= ACTION_LINE_LIMIT, `action.yml has ${lines} lines, over ${ACTION_LINE_LIMIT}`);
});

test('the action runs SoMi on the pull request change set', () => {
  assert.match(actionSources(), /quality['",\s]+--scope['",\s]+pr\b/);
});

test('SoMi is installed with npm ci --ignore-scripts and never with npm install', () => {
  const text = read(ACTION_YML);
  assert.match(text, /npm ci\b[^\n]*--ignore-scripts/);
  assert.doesNotMatch(text, /npm (install|i)\b/);
});

test('package.json pins @skathio/somi to one exact version', () => {
  const pkg = readJson(path.join(ACTION_DIR, 'package.json'));
  const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  assert.ok('@skathio/somi' in all, 'package.json does not depend on @skathio/somi');
  assert.match(all['@skathio/somi'], EXACT_SEMVER, 'the SoMi version must be exact, not a range');
});

test('package-lock.json resolves @skathio/somi to the pinned version', () => {
  const pkg = readJson(path.join(ACTION_DIR, 'package.json'));
  const pinned = { ...pkg.dependencies, ...pkg.devDependencies }['@skathio/somi'];
  const lock = readJson(path.join(ACTION_DIR, 'package-lock.json'));
  assert.ok(lock.lockfileVersion >= 2, 'npm ci needs a lockfile with a packages map');
  const entry = lock.packages && lock.packages['node_modules/@skathio/somi'];
  assert.ok(entry, 'the lockfile has no node_modules/@skathio/somi entry');
  assert.equal(entry.version, pinned);
});

test('every installed package in the lockfile carries an integrity hash', () => {
  const lock = readJson(path.join(ACTION_DIR, 'package-lock.json'));
  const installed = Object.entries(lock.packages).filter(([k, v]) => k !== '' && !v.link);
  assert.ok(installed.length >= 1, 'the lockfile installs nothing');
  for (const [name, entry] of installed) {
    assert.match(String(entry.integrity), /^sha(256|384|512)-/, `${name} has no integrity hash`);
  }
});

test('Dependabot watches the quality-gate npm lockfile', () => {
  const entries = dependabotEntries(read(DEPENDABOT));
  const npm = entries.filter((e) => /^package-ecosystem:\s*["']?npm["']?\s*$/m.test(e));
  const dir = /^\s*directory:\s*["']?\/\.github\/actions\/quality-gate\/?["']?\s*$/m;
  assert.ok(npm.some((e) => dir.test(e)), 'no npm entry for /.github/actions/quality-gate');
});

test('the gate runs SoMi only on pull_request events', () => {
  assert.match(actionSources(), /pull_request/);
});

test('a non-pull-request run writes the skip message to the job summary', () => {
  const sources = actionSources();
  assert.ok(sources.includes(SKIP_MESSAGE), `the action never writes "${SKIP_MESSAGE}"`);
  assert.match(sources, /GITHUB_STEP_SUMMARY/);
});

test('no step can swallow a failure: the gate fails closed', () => {
  const text = read(ACTION_YML);
  assert.doesNotMatch(text, /continue-on-error:\s*["']?true/);
  assert.doesNotMatch(text, /\|\|\s*true\b/);
});

test('third-party actions in action.yml are pinned to a full commit SHA', () => {
  const uses = read(ACTION_YML).split('\n').filter((l) => /^\s*(-\s+)?uses:/.test(l));
  for (const line of uses.filter((l) => !/uses:\s*["']?\.\//.test(l))) {
    assert.match(line, SHA_PIN, `not SHA-pinned: ${line.trim()}`);
  }
});

test('every lib/ file has a node:test unit test in tests/quality-gate/', () => {
  const sources = gateTestFiles().map((f) => read(path.join(TEST_DIR, f)));
  for (const lib of libFiles()) {
    const stem = lib.replace(/\.(c?js|mjs)$/, '');
    const requires = (s) => s.includes(`lib/${stem}`) || s.includes(`'lib', '${stem}`);
    const covered = sources.some((s) => s.includes('node:test') && requires(s));
    assert.ok(covered, `lib/${lib} has no node:test unit test requiring it`);
  }
});

test('_self-ci.yml runs every tests/quality-gate test file on Node 20', () => {
  const jobs = Object.values(jobBlocks(read(SELF_CI)));
  const node20 = jobs.filter((j) => /node-version:\s*["']?20["']?\s*$/m.test(j));
  for (const file of gateTestFiles()) {
    const rel = `tests/quality-gate/${file}`;
    const runs = node20.some((j) => j.includes('node --test') && (j.includes(rel) || /tests\/quality-gate\/(\*|\s|$)/m.test(j)));
    assert.ok(runs, `${rel} is not run by a Node 20 job in _self-ci.yml`);
  }
});
