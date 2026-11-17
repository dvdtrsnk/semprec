// Checks that a proposal's synthetic occurrence id names a real occurrence of a live recurring Event.
import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { ValidationError } from "../errors.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { parseOccurrenceId } from "./eventOccurrenceId.js";
import { eventRecurrenceOccursOn } from "./eventRecurrenceRule.js";
import { readEventSeries } from "./eventSeries.js";

/**
 * `null` when `target` is no occurrence id, so the caller treats it as any other target; otherwise a
 * `ValidationError` unless it is a real occurrence. Takes no lock: `materializeEventOccurrence` re-checks under its
 * own locks at confirm. A cancelled date is not refused here; its trashed item refuses the link at confirm.
 */
export async function assertValidOccurrenceTarget(
  client: PoolClient,
  target: string,
): Promise<{ seriesId: string; occurrenceDate: string } | null> {
  const occurrence = parseOccurrenceId(target);
  if (occurrence === null) return null;
  const events = await databasesStore.getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  const series = events ? await itemsStore.getItemById(client, events.id, occurrence.seriesId) : null;
  const definition = series && series.deletedAt === null ? readEventSeries(series.properties) : null;
  if (!definition) {
    throw new ValidationError(`Proposal envelope target '${target}' names no recurring Event`, { field: "target" });
  }
  if (!eventRecurrenceOccursOn(definition.rule, definition.startDate, occurrence.occurrenceDate)) {
    throw new ValidationError(`Proposal envelope target '${target}' is not an occurrence of its series`, {
      field: "target",
    });
  }
  return occurrence;
}
