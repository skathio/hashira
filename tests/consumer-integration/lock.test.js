// Unit tests for tests/consumer-integration/lib/lock.js: the stale rules on
// their own, and taking, waiting for and releasing the lock against a local
// bare git repo standing in for the fixture repo, with a fake clock and a
// fake reader of hashira's runs.
//
// Run locally with:  node --test tests/consumer-integration/lock.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lock = require('./lib/lock.js');

const S = 'c'.repeat(40);
const OTHER = 'a'.repeat(40);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-lock-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function context(name, run = '100', attempt = '1') {
  const remote = path.join(tmp, `${name}.git`);
  git(tmp, ['init', '-q', '--bare', remote]);
  const workdir = path.join(tmp, `${name}-${run}-${attempt}`);
  fs.mkdirSync(workdir, { recursive: true });
  return { repo: `skathio/${name}`, sha: S, run, attempt, remote, workdir };
}

// runs: hashira run id -> the API's answer for it (absent: the call fails).
function deps(runs = {}, hooks = {}) {
  let clock = Date.now();
  const writes = [];
  return {
    writes,
    git: (cwd, args) => {
      if (args[0] === 'push') {
        writes.push(args.join(' '));
        if (hooks.beforePush) hooks.beforePush(writes.length);
      }
      return git(cwd, args);
    },
    hashiraGh: (args) => {
      const id = args[1].split('/').pop();
      if (!runs[id]) throw new Error('gh: Not Found (HTTP 404)');
      return JSON.stringify(runs[id]);
    },
    sleep: (ms) => { clock += ms; },
    now: () => clock,
    advance: (ms) => { clock += ms; },
  };
}

const lockRef = (ctx) => git(tmp, ['--git-dir', ctx.remote, 'for-each-ref', '--format=%(objectname)', lock.LOCK_REF]).trim();
const lockText = (ctx) => git(tmp, ['--git-dir', ctx.remote, 'log', '-1', '--format=%B', lock.LOCK_REF]);

// --- the rules --------------------------------------------------------------

const NOW = 1_000_000_000_000;
const held = (holder, ageMs = 0) => ({ commit: OTHER, time: NOW - ageMs, holder });
const ours = { run: '100', attempt: '2' };
const v = (lockSeen, holderRun = null) => lock.verdict({ lock: lockSeen, ours, now: NOW, holderRun }).state;

test('no lock is free', () => {
  assert.equal(v(null), 'free');
});

test('a lock from this run and attempt is ours; an earlier attempt of this run is stale', () => {
  assert.equal(v(held({ sha: S, run: '100', attempt: '2' })), 'ours');
  assert.equal(v(held({ sha: S, run: '100', attempt: '1' })), 'stale');
});

test('a later attempt of this run holding it is busy, not ours', () => {
  assert.equal(v(held({ sha: S, run: '100', attempt: '3' }), { status: 'in_progress', run_attempt: 3 }), 'busy');
});

test('another live run holds it: busy', () => {
  assert.equal(v(held({ sha: OTHER, run: '7', attempt: '1' }), { status: 'in_progress', run_attempt: 1 }), 'busy');
});

test('the holder run has completed, or moved on to a later attempt: stale', () => {
  assert.equal(v(held({ sha: OTHER, run: '7', attempt: '1' }), { status: 'completed', run_attempt: 1 }), 'stale');
  assert.equal(v(held({ sha: OTHER, run: '7', attempt: '1' }), { status: 'in_progress', run_attempt: 2 }), 'stale');
});

test('the holder run cannot be read: busy until the lock is older than any run', () => {
  const holder = { sha: OTHER, run: '7', attempt: '1' };
  assert.equal(v(held(holder, lock.STALE_MS)), 'busy');
  assert.equal(v(held(holder, lock.STALE_MS + 1)), 'stale');
});

test('a lock commit that names no run is busy until it is older than any run', () => {
  assert.equal(v(held(null, lock.STALE_MS)), 'busy');
  assert.equal(v(held(null, lock.STALE_MS + 1)), 'stale');
});

test('the holder is read back from the lock message, and anything else is not a holder', () => {
  const holder = { sha: S, run: '42', attempt: '3' };
  assert.deepEqual(lock.parseHolder(lock.lockMessage(holder)), holder);
  assert.equal(lock.parseHolder(''), null);
  assert.equal(lock.parseHolder('someone else\nsha=' + S + '\nrun=1\nattempt=1'), null);
  assert.equal(lock.parseHolder(lock.lockMessage({ ...holder, run: '42;x' })), null);
  assert.equal(lock.parseHolder(lock.lockMessage({ ...holder, sha: 'main' })), null);
});

// --- against a repo -----------------------------------------------------------

test('take on a free repo creates the lock naming this run; release removes it', () => {
  const ctx = context('free');
  const d = deps();
  const taken = lock.take(ctx, d);
  assert.equal(lockRef(ctx), taken.commit);
  assert.equal(taken.replaced, null);
  assert.deepEqual(lock.parseHolder(lockText(ctx)), { sha: S, run: '100', attempt: '1' });
  assert.equal(lock.release(ctx, d, taken.commit), true);
  assert.equal(lockRef(ctx), '');
});

test('take while a live run holds the lock waits, then fails naming the holder, and writes nothing', () => {
  const ctx = context('busy', '200');
  const holder = context('busy-holder-unused', '7');
  lock.take({ ...holder, remote: ctx.remote, sha: OTHER }, deps());
  const before = lockRef(ctx);
  const d = deps({ 7: { status: 'in_progress', run_attempt: 1 } });
  assert.throws(() => lock.take(ctx, d), /busy: its integration lock is held by hashira run 7 attempt 1 \(commit a{40}\)/);
  assert.equal(d.writes.length, 0);
  assert.equal(lockRef(ctx), before);
});

test('take replaces a lock whose run has completed, and says so', () => {
  const ctx = context('stale', '300');
  lock.take({ ...ctx, run: '7', sha: OTHER, workdir: path.join(tmp, 'stale-holder') }, deps());
  const d = deps({ 7: { status: 'completed', run_attempt: 1 } });
  const taken = lock.take(ctx, d);
  assert.equal(lockRef(ctx), taken.commit);
  assert.match(taken.replaced, /hashira run 7 attempt 1 .* has ended/);
});

test('take that loses the race to another run leaves that run\'s lock alone', () => {
  const ctx = context('race', '400');
  const rival = { ...ctx, run: '8', sha: OTHER, workdir: path.join(tmp, 'race-rival') };
  fs.mkdirSync(rival.workdir, { recursive: true });
  let rivalCommit = null;
  const d = deps({ 8: { status: 'in_progress', run_attempt: 1 } }, {
    beforePush: (n) => { if (n === 1) rivalCommit = lock.take(rival, deps()).commit; },
  });
  assert.throws(() => lock.take(ctx, d), /busy|took the integration lock first/);
  assert.equal(lockRef(ctx), rivalCommit);
});

test('take when this run and attempt already hold it returns that lock without a push', () => {
  const ctx = context('again', '500');
  const first = lock.take(ctx, deps());
  const d = deps();
  assert.equal(lock.take(ctx, d).commit, first.commit);
  assert.equal(d.writes.length, 0);
});

test('release leaves a lock another run has since taken', () => {
  const ctx = context('replaced', '600');
  const mine = lock.take(ctx, deps());
  lock.take({ ...ctx, run: '9', sha: OTHER, workdir: path.join(tmp, 'replaced-next') }, deps({ 600: { status: 'completed', run_attempt: 1 } }));
  const theirs = lockRef(ctx);
  assert.equal(lock.release(ctx, deps(), mine.commit), false);
  assert.equal(lockRef(ctx), theirs);
});

test('wait returns at once on a free repo and writes nothing', () => {
  const ctx = context('wait-free');
  const d = deps();
  assert.equal(lock.wait(ctx, d), 'free');
  assert.equal(d.writes.length, 0);
});

test('wait gives up after two hours on a lock a live run holds', () => {
  const ctx = context('wait-busy', '700');
  lock.take({ ...ctx, run: '7', sha: OTHER, workdir: path.join(tmp, 'wait-busy-holder') }, deps());
  const d = deps({ 7: { status: 'in_progress', run_attempt: 1 } });
  const start = d.now();
  assert.throws(() => lock.wait(ctx, d), /gave up after 120 minutes/);
  assert.ok(d.now() - start >= lock.WAIT_MS);
});
