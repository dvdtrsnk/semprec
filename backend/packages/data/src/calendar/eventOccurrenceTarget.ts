// The synthetic occurrence id as the target of a proposal (issue gh-1850): the check that it names a real
// occurrence of a live recurring Event, which a proposal envelope runs before it is stored or confirmed.
// Constrained by: docs/adr/2026-11-13-an-event-occurrence-is-an-events-item-named-by-its-series-event-and-date.md
import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { ValidationError } from "../errors.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { parseOccurrenceId } from "./eventOccurrenceId.js";
import { eventRecurrenceOccursOn } from "./eventRecurrenceRule.js";
import { readEventSeries } from "./eventSeries.js";

/**
 * Reads `target` as the synthetic id `<seriesId>@<date>` of an occurrence (`parseOccurrenceId`): `null` when it is
 * not one, so the caller treats it as any other target. When it is one, the series Event must exist, be live, be a
 * recurring series (`readEventSeries`) and have an occurrence on that date (`eventRecurrenceOccursOn`), otherwise this
 * throws a `ValidationError` on `target`; it returns the parsed occurrence when all of that holds. The read takes no
 * lock: it validates a proposal, and `materializeEventOccurrence` re-checks under its own locks when the proposal is
 * confirmed. A date whose occurrence was cancelled is not refused here; its trashed item refuses the link at confirm.
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
