// Writes the one hashira summary comment on a pull request and keeps it to
// one. Runs inside actions/github-script, which passes `github`, `context`
// and `core`.
//
// The comment is the one that starts with MARKER and is written by
// github-actions[bot]. Anyone can paste the marker into a comment, so a
// comment by any other author is never edited or deleted.
//
// The comment is a report, not a check: no outcome here may change the job's
// conclusion. writeComment never throws, never calls core.setFailed, and on
// any API error falls back to the job summary with a warning.
'use strict';

const { MARKER, renderBody } = require('./body');

const BOT = 'github-actions[bot]';
const DEPENDABOT = 'dependabot[bot]';

async function toSummary(core, text) {
  try {
    await core.summary.addRaw(`${text}\n`, true).write();
  } catch (err) {
    core.warning(`ci-summary: could not write the job summary: ${err.message}`);
  }
}

function apiError(core, what, err) {
  core.warning(`ci-summary: ${what} failed (${err.status ?? 'no status'}: ${err.message}); the summary is in the job summary instead.`);
}

// A fork PR's token, and a Dependabot PR's, cannot write comments, so the
// writer does not try: the call would only fail.
function readOnlyReason(pr, actor) {
  const head = pr.head?.repo?.full_name;
  if (!head || head !== pr.base?.repo?.full_name) return 'the pull request comes from a fork';
  if (pr.user?.login === DEPENDABOT || actor === DEPENDABOT) return 'the pull request is by Dependabot';
  return '';
}

const isOurs = (c) => c.user?.login === BOT && typeof c.body === 'string' && c.body.startsWith(MARKER);
const byAge = (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id;

async function removeDuplicates({ github, core, where, extra }) {
  for (const dup of extra) {
    try {
      await github.rest.issues.deleteComment({ ...where, comment_id: dup.id });
    } catch (err) {
      core.warning(`ci-summary: deleting duplicate comment ${dup.id} failed (${err.status ?? 'no status'}: ${err.message}).`);
    }
  }
}

// Each step names what failed, so the warning says which call was refused.
async function step(what, call) {
  try {
    return await call();
  } catch (err) {
    err.step = what;
    throw err;
  }
}

async function upsert({ github, core, context, body }) {
  const pr = context.payload.pull_request;
  const where = { owner: context.repo.owner, repo: context.repo.repo };
  const { data: live } = await step('reading the pull request', () => github.rest.pulls.get({ ...where, pull_number: pr.number }));
  if (live.head?.sha !== pr.head.sha) {
    await toSummary(core, `ci-summary: the PR comment was not written: this run is for ${pr.head.sha}, but the pull request head is now ${live.head?.sha} (a newer push exists).`);
    return;
  }
  const all = await step('listing comments', () => github.paginate(github.rest.issues.listComments, { ...where, issue_number: pr.number, per_page: 100 }));
  const [oldest, ...extra] = all.filter(isOurs).sort(byAge);
  if (!oldest) {
    await step('creating the comment', () => github.rest.issues.createComment({ ...where, issue_number: pr.number, body }));
    return;
  }
  await step('updating the comment', () => github.rest.issues.updateComment({ ...where, comment_id: oldest.id, body }));
  await removeDuplicates({ github, core, where, extra });
}

async function writeComment({ github, context, core, body }) {
  try {
    const pr = context.payload?.pull_request;
    if (context.eventName !== 'pull_request' || !pr) return;
    const reason = readOnlyReason(pr, context.actor);
    if (reason) {
      core.info(`ci-summary: no PR comment because ${reason}; the summary is in the job summary.`);
      await toSummary(core, body);
      return;
    }
    await upsert({ github, core, context, body });
  } catch (err) {
    apiError(core, err.step ?? 'writing the comment', err);
    await toSummary(core, body);
  }
}

module.exports = { MARKER, renderBody, writeComment };
