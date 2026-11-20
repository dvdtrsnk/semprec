import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import type { Queryable } from "../../db/pool.js";

export function calendarAccountSyncJobKey(accountItemId: string): string {
  return `calendar-account-sync:${accountItemId}`;
}

export function calendarAccountCleanupJobKey(accountItemId: string): string {
  return `calendar-account-cleanup:${accountItemId}`;
}

export async function enqueueCalendarAccountSync(client: Queryable, accountItemId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.CALENDAR_ACCOUNT_SYNC,
    { accountItemId },
    { jobKey: calendarAccountSyncJobKey(accountItemId), maxAttempts: 3 },
  );
}

/** Called in the transaction that ended the tracking of calendars, so the job exists only when that commits. */
export async function enqueueCalendarAccountCleanup(client: Queryable, accountItemId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.CALENDAR_ACCOUNT_CLEANUP,
    { accountItemId },
    { jobKey: calendarAccountCleanupJobKey(accountItemId), maxAttempts: 3 },
  );
}
