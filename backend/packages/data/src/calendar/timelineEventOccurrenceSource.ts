import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { expandEventOccurrences, readLiveEventSeries } from "./eventOccurrences.js";
import type { CalendarEventOccurrence, CalendarTimelineContext } from "./timelineSources.js";

/**
 * The timeline source of the recurring Events (issue gh-1877): every occurrence of every live recurring series
 * whose days overlap the requested range, virtual and real ones, cancelled dates left out
 * (`expandEventOccurrences` describes each). The core Events source leaves the series rows and the occurrence items
 * out, so this source is where they appear, once. A tenant without an Events database has none.
 */
export async function readEventOccurrenceTimelineItems(
  client: PoolClient,
  context: CalendarTimelineContext,
): Promise<CalendarEventOccurrence[]> {
  const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  if (!events) return [];
  const series = await readLiveEventSeries(client, events.id, context.to);
  return expandEventOccurrences(client, events.id, series, context);
}
