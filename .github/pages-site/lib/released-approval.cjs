// Whether a pages-site.yml run may take `released: true`, which skips the `gate` job's
// `production` approval. It may only when this very workflow run already holds an approved
// review for the `production` Environment: the caller's release job passed that approval before
// calling pages-site.yml. A caller that forwards a dispatch input without such a job is refused,
// so the caller needs no guard of its own.
//
// The decision is pure (decide), the read is one GET of the run's approvals
// (GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals), and a refusal is a thrown error,
// so a caller that forgets to check fails closed. Node 20 compatible: global fetch, no packages.
// A .cjs file, so a caller whose package.json says "type": "module" cannot turn it into ESM.
'use strict';

const ENVIRONMENT = 'production';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_ID = /^[1-9]\d{0,19}$/;

function refuse(message) {
  throw new Error(`pages-site: released refused: ${message}`);
}

/** The run's approvals, as the API returns them, hold an approved `production` review. */
function decide(approvals, environment = ENVIRONMENT) {
  if (!Array.isArray(approvals)) refuse('the run approvals response is not a list');
  const approved = approvals.some((a) => a !== null && typeof a === 'object'
    && a.state === 'approved'
    && Array.isArray(a.environments)
    && a.environments.some((e) => e !== null && typeof e === 'object' && e.name === environment));
  if (!approved) {
    refuse(`this run has no approved review for the '${environment}' environment. released: true `
      + `is only for a run whose release job already passed the '${environment}' approval before `
      + `calling pages-site.yml; run it with released: false to wait for the approval at gate, `
      + `or give '${environment}' required reviewers and approve it in this run.`);
  }
  return true;
}

function approvalsUrl({ apiUrl, repository, runId }) {
  if (!REPO.test(String(repository))) refuse(`'${repository}' is not an owner/repo name`);
  if (!RUN_ID.test(String(runId))) refuse(`'${runId}' is not a run id`);
  const base = String(apiUrl || 'https://api.github.com').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) refuse(`the API URL '${base}' is not https`);
  return `${base}/repos/${repository}/actions/runs/${runId}/approvals`;
}

/**
 * Reads the run's approvals: with the job's token first, then unauthenticated (released already
 * needs a public repo for deploy's tag check, and `check` holds no grant, so the token may be
 * refused). Throws when neither read gives a JSON list.
 */
async function readApprovals({ fetch, apiUrl, repository, runId, token }) {
  const url = approvalsUrl({ apiUrl, repository, runId });
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const attempts = token ? [{ ...headers, Authorization: `Bearer ${token}` }, headers] : [headers];
  const failures = [];
  for (const h of attempts) {
    try {
      const res = await fetch(url, { headers: h });
      if (res.ok) return await res.json();
      failures.push(`HTTP ${res.status}${h.Authorization ? ' with the job token' : ' unauthenticated'}`);
    } catch (err) {
      failures.push(err && err.message ? err.message : String(err));
    }
  }
  return refuse(`could not read ${url} (${failures.join('; ')}). released: true needs a public `
    + 'repo whose run approvals the API can read; run with released: false to use the gate.');
}

async function main(env = process.env, fetchImpl = globalThis.fetch) {
  const approvals = await readApprovals({
    fetch: fetchImpl,
    apiUrl: env.GITHUB_API_URL,
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    token: env.GITHUB_TOKEN,
  });
  decide(approvals);
  return `pages-site: run ${env.GITHUB_RUN_ID} holds an approved '${ENVIRONMENT}' review; released accepted.`;
}

if (require.main === module) {
  // stdout, where the runner reads workflow commands such as ::error::.
  main().then((msg) => process.stdout.write(`${msg}\n`), (err) => {
    process.stdout.write(`::error::${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { ENVIRONMENT, decide, approvalsUrl, readApprovals, main };
