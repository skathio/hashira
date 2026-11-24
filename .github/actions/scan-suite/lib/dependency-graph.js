// dependency-graph.js
//
// Asks GitHub whether dependency review can run on this repository, before
// actions/dependency-review-action does. The action errors with "Dependency
// review is not supported on this repository" when the repository's
// dependency graph is off, and scan-suite would record that as the scanner
// failing. A repository with the graph off is skipped with a notice instead,
// which is what every repository got before v3.1.0, when detection never let
// the scan run.
//
// The probe is the action's own call, the dependency-graph compare endpoint
// for the pull request's base and head, so it answers as the action would.
// Only GitHub's specific refusal counts as "off"; any other answer, a network
// error included, is "unknown", and the action then runs and reports its own
// result, so a real error is never turned into a skip.
//
// CLI: node dependency-graph.js   prints `graph=<on|off|unknown>` to
// $GITHUB_OUTPUT. Reads GITHUB_API_URL, GITHUB_REPOSITORY, DR_TOKEN,
// DR_BASE_SHA and DR_HEAD_SHA.

'use strict';

const fs = require('node:fs');

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NOT_SUPPORTED = /not supported on this repository|dependency graph/i;
const TIMEOUT_MS = 15000;

/** 'on' | 'off' | 'unknown' from the compare endpoint's status and message. */
function classify(status, message) {
  if (status === 200) return 'on';
  if ((status === 403 || status === 404) && NOT_SUPPORTED.test(String(message ?? ''))) return 'off';
  return 'unknown';
}

async function probe(env, fetchImpl = globalThis.fetch) {
  const api = String(env.GITHUB_API_URL || 'https://api.github.com');
  const repo = String(env.GITHUB_REPOSITORY || '');
  const base = String(env.DR_BASE_SHA || '');
  const head = String(env.DR_HEAD_SHA || '');
  if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(api) || !REPO.test(repo) || !SHA.test(base) || !SHA.test(head)) {
    return 'unknown';
  }
  try {
    const res = await fetchImpl(`${api}/repos/${repo}/dependency-graph/compare/${base}...${head}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${env.DR_TOKEN || ''}`,
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let message = '';
    if (res.status !== 200) {
      try {
        message = (await res.json())?.message ?? '';
      } catch {
        message = '';
      }
    }
    return classify(res.status, message);
  } catch {
    return 'unknown';
  }
}

async function main(env = process.env) {
  const graph = await probe(env);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `graph=${graph}\n`);
  return graph;
}

if (require.main === module) {
  main().catch(() => {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'graph=unknown\n');
  });
}

module.exports = { classify, probe, main };
