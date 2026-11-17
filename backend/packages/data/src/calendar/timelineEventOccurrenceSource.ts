import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { expandEventOccurrences, readLiveEventSeries } from "./eventOccurrences.js";
import type { CalendarEventOccurrence, CalendarTimelineContext } from "./timelineSources.js";

/** The core Events source leaves series rows and occurrence items out, so they appear here, once. */
export async function readEventOccurrenceTimelineItems(
  client: PoolClient,
  context: CalendarTimelineContext,
): Promise<CalendarEventOccurrence[]> {
  const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  if (!events) return [];
  const series = await readLiveEventSeries(client, events.id, context.to);
  return expandEventOccurrences(client, events.id, series, context);
}
