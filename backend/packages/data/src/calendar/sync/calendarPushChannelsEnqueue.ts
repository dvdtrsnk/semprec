import { CORE_TASK_NAMES, enqueueJob } from "@alldots/queue";
import type { Queryable } from "../../db/pool.js";

export function calendarPushChannelsJobKey(accountItemId: string): string {
  return `calendar-push-channels:${accountItemId}`;
}

/** The maintenance of one account's push channels (`calendarPushChannelsJob.ts`). */
export async function enqueueCalendarPushChannels(client: Queryable, accountItemId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.CALENDAR_PUSH_CHANNELS,
    { accountItemId },
    { jobKey: calendarPushChannelsJobKey(accountItemId), maxAttempts: 3 },
  );
}
