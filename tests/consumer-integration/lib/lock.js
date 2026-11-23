// One lock per fixture repo, so integration runs against it never overlap:
// they share its tags, Releases and Pages site. GitHub's job concurrency
// cannot do this, because a concurrency group keeps only one pending job
// and cancels the older one when a third run queues.
//
// The lock is the branch `integration-lock` in the fixture repo, pointing at
// an empty commit whose message names the holder (hashira commit, run id and
// attempt). Every write is a compare-and-swap push (--force-with-lease), so
// two runs can never both take it, and a run releases it only while it still
// points at the commit that run pushed. Waiting reads it anonymously: the
// fixture repos are public, so no App token is held for the whole wait.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOCK_REF = 'refs/heads/integration-lock';
const SEEN_REF = 'refs/seen/integration-lock';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MARK = 'hashira-integration-lock';
// How long a run waits for another run's lock, and how long it then tries
// to take it with one App token (which lasts an hour).
const WAIT_MS = 120 * 60 * 1000;
const TAKE_MS = 40 * 60 * 1000;
// Older than any consumer-integration job can run (its timeout-minutes),
// so a lock this old was left by a job that died before its cleanup.
const STALE_MS = 330 * 60 * 1000;
const POLL_MS = 30 * 1000;
const DIGITS = /^[0-9]+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const LEASE_LOST = /\(stale info\)|\(fetch first\)|\[rejected\]/;

function lockMessage(holder) {
  return `${MARK}\n\nsha=${holder.sha}\nrun=${holder.run}\nattempt=${holder.attempt}\n`;
}

/** The holder named in a lock commit's message, or null if it is not one of ours. */
function parseHolder(message) {
  const text = String(message || '');
  if (!text.startsWith(MARK)) return null;
  const field = (name) => (text.match(new RegExp(`^${name}=(\\S+)$`, 'm')) || [])[1];
  const holder = { sha: field('sha'), run: field('run'), attempt: field('attempt') };
  const valid = COMMIT.test(holder.sha || '') && DIGITS.test(holder.run || '') && DIGITS.test(holder.attempt || '');
  return valid ? holder : null;
}

/**
 * What a run should do about the lock it sees.
 * lock: null | { commit, time (ms), holder | null }; ours: { run, attempt };
 * holderRun: the holder's hashira run as the API returns it, or null.
 */
function verdict({ lock, ours, now, holderRun }) {
  if (!lock) return { state: 'free' };
  const own = ownRunVerdict(lock.holder, ours);
  if (own) return own;
  if (now - lock.time > STALE_MS) return { state: 'stale', reason: 'it is older than any run can last' };
  if (holderEnded(lock.holder, holderRun)) {
    return { state: 'stale', reason: `hashira run ${lock.holder.run} attempt ${lock.holder.attempt} has ended` };
  }
  return { state: 'busy' };
}

// A lock this run holds: ours on the same attempt, stale from an earlier one.
// A later attempt of this run holding it is someone else's (null).
function ownRunVerdict(holder, ours) {
  if (!holder || holder.run !== ours.run) return null;
  if (Number(holder.attempt) < Number(ours.attempt)) return { state: 'stale', reason: 'an earlier attempt of this run holds it' };
  return holder.attempt === ours.attempt ? { state: 'ours' } : null;
}

function holderEnded(holder, holderRun) {
  if (!holder || !holderRun) return false;
  return holderRun.status === 'completed' || Number(holderRun.run_attempt) > Number(holder.attempt);
}

function describe(lock) {
  const since = new Date(lock.time).toISOString();
  if (!lock.holder) return `a lock commit ${lock.commit} that names no hashira run, since ${since}`;
  return `hashira run ${lock.holder.run} attempt ${lock.holder.attempt} (commit ${lock.holder.sha}) since ${since}`;
}

// --- I/O through deps -------------------------------------------------------

function scratch(ctx, deps) {
  const dir = path.join(ctx.workdir, 'integration-lock');
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true });
    deps.git(dir, ['init', '-q']);
  }
  return dir;
}

function readLock(ctx, deps) {
  const dir = scratch(ctx, deps);
  const listed = deps.git(dir, ['ls-remote', ctx.remote, LOCK_REF]).trim();
  if (!listed) return null;
  deps.git(dir, ['fetch', '-q', '--no-tags', ctx.remote, `+${LOCK_REF}:${SEEN_REF}`]);
  const [time, ...message] = deps.git(dir, ['log', '-1', '--format=%ct%n%B', SEEN_REF]).split('\n');
  const commit = deps.git(dir, ['rev-parse', SEEN_REF]).trim();
  return { commit, time: Number(time) * 1000, holder: parseHolder(message.join('\n')) };
}

function holderRun(deps, holder) {
  if (!holder) return null;
  try {
    return JSON.parse(deps.hashiraGh(['api', `repos/skathio/hashira/actions/runs/${holder.run}`]));
  } catch {
    return null;
  }
}

function look(ctx, deps) {
  const lock = readLock(ctx, deps);
  const ours = { run: ctx.run, attempt: ctx.attempt };
  return { lock, ...verdict({ lock, ours, now: deps.now(), holderRun: holderRun(deps, lock && lock.holder) }) };
}

/** Polls until the lock is free, stale or ours; throws naming the holder after `limitMs`. */
function waitUntilAvailable(ctx, deps, limitMs) {
  const deadline = deps.now() + limitMs;
  for (;;) {
    const seen = look(ctx, deps);
    if (seen.state !== 'busy') return seen;
    if (deps.now() >= deadline) {
      throw new Error(`${ctx.repo} is busy: its integration lock is held by ${describe(seen.lock)}; gave up after ${limitMs / 60000} minutes`);
    }
    deps.sleep(POLL_MS);
  }
}

/** Pushes our lock commit if the lock still points at `expected` ('' for none). */
function swap(ctx, deps, expected, commit) {
  const dir = scratch(ctx, deps);
  try {
    deps.git(dir, ['push', '-q', `--force-with-lease=${LOCK_REF}:${expected}`, ctx.remote, `${commit}:${LOCK_REF}`]);
    return true;
  } catch (err) {
    if (LEASE_LOST.test(String(err.stderr || err.message))) return false;
    throw err;
  }
}

function newLockCommit(ctx, deps) {
  const holder = { sha: ctx.sha, run: ctx.run, attempt: ctx.attempt };
  return deps.git(scratch(ctx, deps), ['-c', 'user.name=hashira consumer-integration', '-c', 'user.email=noreply@github.com',
    'commit-tree', EMPTY_TREE, '-m', lockMessage(holder)]).trim();
}

/** Waits for the lock without writing anything. */
function wait(ctx, deps) {
  const seen = waitUntilAvailable(ctx, deps, WAIT_MS);
  return seen.state;
}

/** Takes the lock, or throws; returns { commit to release it with, replaced: the stale holder or null }. */
function take(ctx, deps) {
  const deadline = deps.now() + TAKE_MS;
  for (;;) {
    const taken = tryTake(ctx, deps, waitUntilAvailable(ctx, deps, Math.max(0, deadline - deps.now())));
    if (taken) return taken;
    if (deps.now() >= deadline) throw new Error(`${ctx.repo}: another run took the integration lock first; gave up after ${TAKE_MS / 60000} minutes`);
    deps.sleep(POLL_MS);
  }
}

/** One attempt on a lock seen free, stale or ours; null when another run won the swap. */
function tryTake(ctx, deps, seen) {
  if (seen.state === 'ours') return { commit: seen.lock.commit, replaced: null };
  const stale = seen.state === 'stale';
  const commit = newLockCommit(ctx, deps);
  if (!swap(ctx, deps, stale ? seen.lock.commit : '', commit)) return null;
  return { commit, replaced: stale ? `${describe(seen.lock)}: ${seen.reason}` : null };
}

/** Deletes the lock only while it is still `commit`; false when another run had replaced it. */
function release(ctx, deps, commit) {
  const dir = scratch(ctx, deps);
  try {
    deps.git(dir, ['push', '-q', `--force-with-lease=${LOCK_REF}:${commit}`, ctx.remote, `:${LOCK_REF}`]);
    return true;
  } catch (err) {
    if (LEASE_LOST.test(String(err.stderr || err.message))) return false;
    throw err;
  }
}

module.exports = { LOCK_REF, WAIT_MS, TAKE_MS, STALE_MS, lockMessage, parseHolder, verdict, wait, take, release };
