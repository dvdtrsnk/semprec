/**
 * The review follow-ups harvest's selection rules: which harvest may run, which merged
 * pull requests it looks at, which of their findings it takes, and where it stops
 * (decision: docs/adr/2026-09-26-merged-review-findings-become-proposed-follow-up-issues.md).
 *
 * Every rule is pure given its data, so this module performs no I/O and has no
 * dependencies; the harvest script fetches the data, calls these functions and writes
 * the result.
 *
 *   - Backpressure: a harvest writes nothing while any open issue carries
 *     `followups:harvest`, or carries both `followups:issue` and `spec:proposed`.
 *   - Candidates: pull requests merged into `develop` with number >= the fixed floor,
 *     without `followups:harvested`, in ascending number.
 *   - Findings: only `status: open`, and never one whose `(pr, key)` is already in the
 *     ledger's `harvested` set.
 *   - Threads: the bot opens an inline thread for medium and above, and its
 *     `discussion_id` is then the numeric id of the thread's root comment. The only
 *     deterministic skip is a resolved thread with a reply from a trusted bot whose
 *     body, trimmed, is exactly `Fixed.` — the bot's sole wording for a confirmed fix.
 *     Every other finding is harvested with `threadResolved` and up to the last three
 *     replies as excerpts.
 *   - Missing path: never a skip; recorded as `pathExists: false`.
 *   - Cap: at most HARVEST_CAP harvested findings per harvest issue. A pull request is
 *     never split, pull requests are taken in order, the first one with harvested
 *     findings is always taken whatever its count, and taking stops before the one that
 *     would exceed the cap.
 *   - Crash safety: a pull request already listed in a harvest issue's harvest marker
 *     (the ledger's `harvestedPrs`) is only labelled, never harvested again.
 */

import { LABELS, findingId } from "./markers.mjs";
import { TRUSTED_REVIEW_BOT_LOGINS } from "./memory.mjs";

export const HARVEST_CAP = 30;

const FIXED_REPLY = "Fixed.";
const MAX_REPLIES = 3;
const MAX_EXCERPT = 200;
const DIGITS = /^[0-9]+$/;

function ascending(a, b) {
  return a - b;
}

/**
 * The ascending numbers of the open issues (`{ number, labels: string[] }[]`) that hold
 * back a harvest; an empty array means the harvest may run.
 */
export function pendingWork(openIssues) {
  return openIssues
    .filter(
      ({ labels }) =>
        labels.includes(LABELS.harvest) || (labels.includes(LABELS.issue) && labels.includes(LABELS.proposed)),
    )
    .map(({ number }) => number)
    .sort(ascending);
}

/**
 * The pull requests (`{ number, mergedAt, labels }[]`) with `number >= minPr` and
 * without `followups:harvested`, ascending by number.
 */
export function candidatePullRequests(pullRequests, { minPr }) {
  return pullRequests
    .filter(({ number, labels }) => number >= minPr && !labels.includes(LABELS.harvested))
    .sort((a, b) => a.number - b.number);
}

/** The first `MAX_EXCERPT` code points of `text`, the unit finding records are measured in. */
function excerpt(text) {
  return Array.from(text).slice(0, MAX_EXCERPT).join("");
}

function isConfirmedFix(thread) {
  return (
    thread.isResolved &&
    thread.comments
      .slice(1)
      .some((reply) => TRUSTED_REVIEW_BOT_LOGINS.includes(reply.author) && reply.body.trim() === FIXED_REPLY)
  );
}

/**
 * Splits a merged pull request's open, not yet harvested findings into `harvest`
 * (finding records without the hint fields `touchedAfterLastSeen` and
 * `laterPrsTouchingPath`) and `skipped` (`{ pr, key, path, line, category, description }`),
 * both in the memory's order.
 *
 * `memoryFindings` is `parseMemory(...).findings`, or `null` when the pull request has
 * no memory; `threads` is `[{ isResolved, comments: [{ databaseId, author, body }] }]`;
 * `treePaths` is the `Set` of paths on `develop`; `ledger` is `computeLedger`'s result.
 */
export function classifyPullRequest({ pr, memoryFindings, threads, treePaths, ledger }) {
  const harvest = [];
  const skipped = [];
  if (memoryFindings === null) return { harvest, skipped };

  for (const finding of memoryFindings) {
    if (finding.status !== "open" || ledger.harvested.has(findingId({ pr, key: finding.key }))) continue;

    const { key, path, line, category, description } = finding;
    const numericId = DIGITS.test(finding.discussionId);
    const thread = numericId
      ? threads.find((candidate) => String(candidate.comments[0]?.databaseId) === finding.discussionId)
      : undefined;

    if (thread !== undefined && isConfirmedFix(thread)) {
      skipped.push({ pr, key, path, line, category, description });
      continue;
    }

    harvest.push({
      pr,
      key,
      severity: finding.severity,
      category,
      path,
      line,
      anchor: finding.anchor,
      description,
      descriptionTruncated: description.endsWith("…"),
      discussionId: numericId ? finding.discussionId : "",
      threadResolved: thread === undefined ? false : thread.isResolved,
      replies:
        thread === undefined
          ? []
          : thread.comments
              .slice(1)
              .slice(-MAX_REPLIES)
              .map((reply) => ({ author: reply.author, excerpt: excerpt(reply.body) })),
      pathExists: treePaths.has(path),
      firstSeenSha: finding.firstSeenSha,
      lastSeenSha: finding.lastSeenSha,
    });
  }
  return { harvest, skipped };
}

/**
 * Collects classified pull requests, offered in ascending order, into one harvest under
 * the cap. `offer({ pr, alreadyRecorded, harvest, skipped })` returns `"take"` or
 * `"stop"`; once it has returned `"stop"`, every later offer returns `"stop"` and
 * changes nothing. `plan()` returns `{ prs, labelOnly, harvest, skipped, stoppedAt }`.
 */
export function createHarvestPlan({ cap = HARVEST_CAP } = {}) {
  const prs = [];
  const labelOnly = [];
  const harvest = [];
  const skipped = [];
  let stoppedAt = null;

  function offer(result) {
    if (stoppedAt !== null) return "stop";
    if (result.alreadyRecorded) {
      labelOnly.push(result.pr);
      return "take";
    }
    if (harvest.length > 0 && result.harvest.length > 0 && harvest.length + result.harvest.length > cap) {
      stoppedAt = result.pr;
      return "stop";
    }
    prs.push(result.pr);
    harvest.push(...result.harvest);
    skipped.push(...result.skipped);
    return "take";
  }

  function plan() {
    return {
      prs: [...prs].sort(ascending),
      labelOnly: [...labelOnly].sort(ascending),
      harvest: [...harvest],
      skipped: [...skipped],
      stoppedAt,
    };
  }

  return { offer, plan };
}
