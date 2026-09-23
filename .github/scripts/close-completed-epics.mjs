#!/usr/bin/env node
/**
 * Closes a parent issue once every one of its sub-issues is closed.
 *
 * GitHub does not do this itself: its only documented auto-close is "merging a linked
 * pull request closes the issue it names", which is a different mechanism with its own
 * repository setting. A parent whose children are all done stays open until someone
 * notices, which is how this repository accumulated five stale epics.
 *
 * Completion is GitHub's own count, not a reading of the issue body. Every issue in the
 * REST listing carries `sub_issues_summary` (`total`, `completed`), so one page of
 * issues answers the question for every epic on it — the script never fetches an epic's
 * children, never parses a task list, and costs one request per hundred open issues.
 * The markdown task lists still in these bodies are not consulted and may be stale: the
 * checkboxes are not ticked when a child closes.
 *
 * ## Announce first, close on a later run
 *
 * A brand-new epic must not be closed in the window between creating it and adding its
 * children. Two things prevent that:
 *
 *   - `total > 0` — an epic with no sub-issues yet is never a candidate at all.
 *   - The announcement below — the first run that finds an epic complete only says so,
 *     in a comment. A later run closes it, and only once that comment is older than
 *     GRACE_HOURS. Adding a child in between makes the epic stop qualifying, the
 *     announcement is withdrawn, and the clock starts again from zero.
 *
 * The announcement is deliberately a comment rather than a label or a timestamp file:
 * it notifies the humans watching the epic, it says what will happen and when, and it
 * is the audit trail for the close that follows. `epic:wip` on the epic opts out of all
 * of this for as long as it is there.
 *
 * Inputs, all from the Actions runner environment:
 *   GITHUB_REPOSITORY, GITHUB_API_URL — where to look
 *   GITHUB_TOKEN                      — needs `issues: write`
 *   GRACE_HOURS                       — how old an announcement must be (default 20)
 *   DRY_RUN                           — "true" reports what it would do and writes nothing
 */

const MARKER = "<!-- epic-sweeper:pending -->";
const OPT_OUT_LABEL = "epic:wip";
const DEFAULT_GRACE_HOURS = 20;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** One authenticated API call. A non-2xx is a throw: a half-read repository must not look like an empty one. */
async function api({ apiUrl, token }, path, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  return response.status === 204 ? null : response.json();
}

/** Every open issue, pull requests dropped — they share the issues endpoint and carry no sub-issues. */
async function openIssues(ctx, repo) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(ctx, `/repos/${repo}/issues?state=open&per_page=100&page=${page}`);
    out.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) return out;
  }
}

/**
 * An epic is ready when GitHub says every sub-issue it has is closed. `total > 0` is
 * what keeps a new, still-empty epic out: it is the guard against closing one before
 * its children have been added, not merely an optimisation.
 */
function isComplete(issue) {
  const summary = issue.sub_issues_summary;
  if (!summary || summary.total === 0) return false;
  if ((issue.labels ?? []).some((l) => (typeof l === "string" ? l : l.name) === OPT_OUT_LABEL)) return false;
  return summary.completed === summary.total;
}

async function findAnnouncement(ctx, repo, number) {
  for (let page = 1; ; page += 1) {
    const batch = await api(ctx, `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    const hit = batch.find((c) => c.body?.includes(MARKER));
    if (hit) return hit;
    if (batch.length < 100) return null;
  }
}

function hoursSince(iso) {
  return (Date.now() - Date.parse(iso)) / 3_600_000;
}

function announcementBody(summary, graceHours) {
  return [
    MARKER,
    `All ${summary.total} sub-issues of this epic are closed, so it looks finished.`,
    "",
    `Unless that changes, a run at least ${graceHours} hours from now will close this epic as completed.`,
    "Adding a sub-issue, reopening one, or labelling this epic `" + OPT_OUT_LABEL + "` withdraws this notice.",
  ].join("\n");
}

function closingBody(summary) {
  return [
    `Closing as completed: all ${summary.total} sub-issues are closed.`,
    "",
    "Announced on an earlier run and unchanged since. Counted from GitHub's own",
    "`sub_issues_summary`, not from the task list in the body.",
  ].join("\n");
}

async function main() {
  const ctx = {
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    token: requireEnv("GITHUB_TOKEN"),
  };
  const repo = requireEnv("GITHUB_REPOSITORY");
  const graceHours = Number(process.env.GRACE_HOURS) || DEFAULT_GRACE_HOURS;
  const dryRun = process.env.DRY_RUN === "true";

  const issues = await openIssues(ctx, repo);
  const epics = issues.filter((i) => i.sub_issues_summary?.total > 0);
  const announced = [];
  const closed = [];
  const waiting = [];
  const withdrawn = [];

  for (const issue of epics) {
    const existing = await findAnnouncement(ctx, repo, issue.number);

    if (!isComplete(issue)) {
      // Withdrawn rather than left standing: a notice that says "this will be closed"
      // about an epic that has open work again is worse than no notice at all.
      if (existing) {
        if (!dryRun) await api(ctx, `/repos/${repo}/issues/comments/${existing.id}`, { method: "DELETE" });
        withdrawn.push(issue.number);
      }
      continue;
    }

    if (!existing) {
      if (!dryRun) {
        await api(ctx, `/repos/${repo}/issues/${issue.number}/comments`, {
          method: "POST",
          body: JSON.stringify({ body: announcementBody(issue.sub_issues_summary, graceHours) }),
        });
      }
      announced.push(issue.number);
      continue;
    }

    const age = hoursSince(existing.created_at);
    if (age < graceHours) {
      waiting.push(`#${issue.number} (${age.toFixed(1)}h of ${graceHours}h)`);
      continue;
    }

    if (!dryRun) {
      await api(ctx, `/repos/${repo}/issues/${issue.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: closingBody(issue.sub_issues_summary) }),
      });
      await api(ctx, `/repos/${repo}/issues/${issue.number}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      });
    }
    closed.push(issue.number);
  }

  const say = (label, items) => console.log(`${label}: ${items.length ? items.join(", ") : "none"}`);
  console.log(`${dryRun ? "[dry run] " : ""}${epics.length} open epic(s) of ${issues.length} open issue(s)`);
  say("closed", closed.map((n) => `#${n}`));
  say("announced", announced.map((n) => `#${n}`));
  say("waiting out the grace period", waiting);
  say("announcement withdrawn", withdrawn.map((n) => `#${n}`));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
