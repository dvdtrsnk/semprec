import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import type { Queryable } from "../../db/pool.js";

export function calendarAccountSyncJobKey(accountItemId: string): string {
  return `calendar-account-sync:${accountItemId}`;
}

export function calendarAccountCleanupJobKey(accountItemId: string): string {
  return `calendar-account-cleanup:${accountItemId}`;
}

/**
 * One waiting pass per account: a pass queued now replaces the waiting one's time; one queued for a later `runAt`
 * keeps the time of a pass already waiting, which then serves it too.
 */
export async function enqueueCalendarAccountSync(
  client: Queryable,
  accountItemId: string,
  runAt?: Date,
): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.CALENDAR_ACCOUNT_SYNC,
    { accountItemId },
    {
      jobKey: calendarAccountSyncJobKey(accountItemId),
      maxAttempts: 3,
      ...(runAt === undefined ? {} : { runAt, jobKeyMode: "preserve_run_at" as const }),
    },
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

export function calendarEventPushJobKey(eventItemId: string): string {
  return `calendar-event-push:${eventItemId}`;
}

/**
 * Called in the transaction that recorded the Event's desired state; a newer change replaces the queued job. The push
 * counts its own attempts and gives up before the queue would (`MAX_EVENT_PUSH_ATTEMPTS` in `eventPushJob.ts`). A
 * job queued while another runs waits for that one's lease (`claimEventPush`); `runAt` is when it runs again then.
 */
export async function enqueueCalendarEventPush(client: Queryable, eventItemId: string, runAt?: Date): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.CALENDAR_EVENT_PUSH,
    { eventItemId },
    { jobKey: calendarEventPushJobKey(eventItemId), maxAttempts: 10, ...(runAt === undefined ? {} : { runAt }) },
  );
}
