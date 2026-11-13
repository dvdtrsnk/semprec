import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import type { Queryable } from "../db/pool.js";

/**
 * How long a badge refresh waits before it runs (issue #1891). Every enqueue for the same user moves the run
 * time to this long after itself, so changes that follow one another within it send one push.
 */
export const BADGE_REFRESH_DELAY_MS = 5_000;

/** The tries the queue gives a refresh; a refresh is recomputed from the stored counts on every try, so it does not keep retrying. */
export const BADGE_REFRESH_MAX_ATTEMPTS = 3;

/** The queue key of the pending badge refresh of `userId`: at most one job per user waits under it. */
export function badgeRefreshJobKey(userId: string): string {
  return `badge-refresh:${userId}`;
}

/**
 * Enqueues the `pushBadgeRefresh` job that sends the current badge of `userId` to their iOS devices in
 * `BADGE_REFRESH_DELAY_MS` (issue #1891). It runs on the caller's client, so the job commits or rolls back with
 * the write that changed a count or a badge switch. The job key `badge-refresh:<userId>` with `replace` moves the
 * run time of a job still waiting, so several changes within the delay leave one job. The job carries no badge:
 * the handler computes it when it runs, from what is stored by then. While a job with the key is running,
 * graphile-worker adds a new one instead of replacing it, so a change during a send is sent by a second job.
 * The caller names the user whose count changed; it is not taken from a request.
 */
export async function enqueueBadgeRefresh(client: Queryable, userId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.PUSH_BADGE_REFRESH,
    { userId },
    {
      jobKey: badgeRefreshJobKey(userId),
      jobKeyMode: "replace",
      maxAttempts: BADGE_REFRESH_MAX_ATTEMPTS,
      runAt: new Date(Date.now() + BADGE_REFRESH_DELAY_MS),
    },
  );
}
