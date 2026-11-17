import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import type { Queryable } from "../db/pool.js";

/** Debounce: each enqueue pushes the run time out, so changes within the window send one push. */
export const BADGE_REFRESH_DELAY_MS = 5_000;

export const BADGE_REFRESH_MAX_ATTEMPTS = 3;

export function badgeRefreshJobKey(userId: string): string {
  return `badge-refresh:${userId}`;
}

/**
 * Commits with the caller's write. The job carries no badge; it is computed when the job runs.
 * While a keyed job is running, graphile-worker adds a second one, so a change during a send is
 * still sent.
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
