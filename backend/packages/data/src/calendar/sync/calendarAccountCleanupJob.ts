// Trashes, in committed chunks, the calendars of an internet account that the sync no longer tracks (Calendars
// switched off, the account removed, or a calendar the provider stopped listing) together with their Events, and
// deletes the Events' remote state.
import type { Pool } from "pg";
import { z } from "zod";
import { getItemById } from "../../chokePoint/itemsStore.js";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { CALENDAR_SYNC_WRITER } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { lockCalendarAccountSync } from "./calendarAccountSyncGuard.js";
import {
  deleteEventRemoteStates,
  deleteEventRemoteStatesOfCalendar,
  listLiveCalendarEventIds,
  listUntrackedAccountCalendarIds,
  resolveCalendarSyncIds,
} from "./calendarSyncStore.js";

const CALENDAR_CLEANUP_CHUNK_SIZE = 200;

const payloadSchema = z.strictObject({ accountItemId: z.uuid() });

/**
 * Each chunk is one transaction under the account's calendar sync guard, so it never interleaves with an apply or a
 * switch. It takes the first untracked calendar, trashes up to `chunkSize` of its live Events as the calendar sync
 * and deletes their remote state; once none is left it deletes the calendar's remaining remote state and trashes the
 * calendar. The job ends when no untracked calendar is left. Calendars the sync tracks again are not touched. A failed
 * chunk rolls back alone; a rerun continues from what is still there.
 */
export async function handleCalendarAccountCleanupTask(
  pool: Pool,
  payload: unknown,
  options: { chunkSize?: number } = {},
): Promise<void> {
  const { accountItemId } = payloadSchema.parse(payload);
  const chunkSize = options.chunkSize ?? CALENDAR_CLEANUP_CHUNK_SIZE;
  const queueAffinity = createActionQueueAffinity();
  for (;;) {
    const done = await withTransaction(pool, async (client) => {
      await lockCalendarAccountSync(client, accountItemId);
      const ids = await resolveCalendarSyncIds(client);
      if (ids === null) return true;
      const [calendarItemId] = await listUntrackedAccountCalendarIds(client, ids, accountItemId);
      if (calendarItemId === undefined) return true;
      const events = await listLiveCalendarEventIds(client, ids, calendarItemId, chunkSize);
      for (const eventItemId of events) {
        await itemDeleteWithClient(client, ids.eventsDatabaseId, eventItemId, {
          queueAffinity,
          writer: CALENDAR_SYNC_WRITER,
        });
      }
      await deleteEventRemoteStates(client, events);
      if (events.length === chunkSize) return false;
      await deleteEventRemoteStatesOfCalendar(client, calendarItemId);
      const calendar = await getItemById(client, ids.calendarsDatabaseId, calendarItemId);
      if (calendar !== null && calendar.deletedAt === null) {
        await itemDeleteWithClient(client, ids.calendarsDatabaseId, calendarItemId, {
          queueAffinity,
          writer: CALENDAR_SYNC_WRITER,
        });
      }
      return false;
    });
    if (done) return;
  }
}
