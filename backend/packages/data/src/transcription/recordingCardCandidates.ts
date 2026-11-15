import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { z } from "zod";
import { compareByCodePoint } from "@semprec/shared";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { NotFoundError } from "../errors.js";
import type { RecordingCardContext } from "../inbox/recordingCardEnvelope.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

// The Events a recording card suggests (issue gh-1978) and the project an Event stands for.

/** An Event the recording card suggests: one entry of `RecordingCardContext.candidates`. */
export type RecordingCardCandidate = RecordingCardContext["candidates"][number];

/** The `type` values of the Events that are suggested; an Event with no type (one that came from a calendar) is suggested too. */
const SUGGESTED_EVENT_TYPES = ["meeting", "standup"];

const LEADING_DATE = /^\d{4}-\d{2}-\d{2}/;

const itemNameSchema = z.object({ name: z.string().nullish() });

/** The calendar date at the start of an Events `date` or `endDate` value (a value stored as a date-time keeps its own date), or `null` when it has none. */
function leadingDate(value: string | null): string | null {
  const part = value === null ? undefined : LEADING_DATE.exec(value)?.[0];
  return part !== undefined && DateTime.fromISO(part).isValid ? part : null;
}

interface EventRow {
  id: string;
  name: string | null;
  date: string | null;
  time_from: string | null;
  time_to: string | null;
  end_date: string | null;
}

/** The live project each of `eventIds` stands for: the first live item of its `project` relation, or `null`. */
export async function readEventProjects(
  client: PoolClient,
  eventsDatabaseId: string,
  eventIds: string[],
): Promise<Map<string, { id: string; name: string | null } | null>> {
  const projects = new Map<string, { id: string; name: string | null } | null>(eventIds.map((id) => [id, null]));
  if (eventIds.length === 0) return projects;
  const property = await propertiesStore.getPropertyByKey(client, eventsDatabaseId, "project");
  const definition = property ? await relationsStore.getRelationDefinitionByPropertyId(client, property.id) : null;
  if (!definition) throw new NotFoundError("Relation definition for Events 'project' not found");
  const edges = await relationsStore.listRelationsForItems(client, definition.id, eventIds);
  const eventIdSet = new Set(eventIds);
  const targets = new Map(
    (
      await itemsStore.getItemsByIds(
        client,
        edges.flatMap((edge) => [edge.itemA, edge.itemB]).filter((id) => !eventIdSet.has(id)),
      )
    ).map((item) => [item.id, item]),
  );
  for (const eventId of eventIds) {
    for (const edge of edges) {
      if (edge.itemA !== eventId && edge.itemB !== eventId) continue;
      const project = targets.get(relationsStore.otherSide(edge, eventId));
      if (project) {
        projects.set(eventId, { id: project.id, name: itemNameSchema.parse(project.properties).name ?? null });
        break;
      }
    }
  }
  return projects;
}

/**
 * The live Events whose days include `day` (`YYYY-MM-DD`, the recording's day in the tenant's time zone) and whose
 * `type` is `meeting`, `standup` or empty, with the project of each, ordered by start date, start time and id. The days
 * of an Event are its `date` to its `endDate` (its `date` alone without an `endDate`), and a value stored as a
 * date-time is read by its leading date. Those values are free input, so an Event whose `date` or `endDate` has no
 * readable date is left out and never fails the query: the statement only compares text prefixes, which narrows the
 * rows read and cannot raise, and the days are decided in code on the parsed dates.
 */
export async function listRecordingDayCandidates(client: PoolClient, day: string): Promise<RecordingCardCandidate[]> {
  const events = await databasesStore.getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  if (!events) throw new NotFoundError(`Database for module '${EVENTS_MODULE_ID}' not found`);
  const { rows } = await client.query<EventRow>(
    `SELECT id, properties ->> 'name' AS name, properties ->> 'date' AS date, properties ->> 'timeFrom' AS time_from,
            properties ->> 'timeTo' AS time_to, properties ->> 'endDate' AS end_date
       FROM items
      WHERE database_id = $1 AND deleted_at IS NULL
        AND (properties ->> 'type' IS NULL OR properties ->> 'type' = '' OR properties ->> 'type' = ANY($2::text[]))
        AND left(properties ->> 'date', 10) <= $3
        AND left(COALESCE(NULLIF(properties ->> 'endDate', ''), properties ->> 'date'), 10) >= $3`,
    [events.id, SUGGESTED_EVENT_TYPES, day],
  );
  const onDay = rows.filter((row) => {
    const start = leadingDate(row.date);
    if (start === null || start > day) return false;
    const end = row.end_date === null || row.end_date === "" ? start : leadingDate(row.end_date);
    return end !== null && end >= day;
  });
  const projects = await readEventProjects(
    client,
    events.id,
    onDay.map((row) => row.id),
  );
  return onDay
    .map((row) => ({ row, start: leadingDate(row.date) ?? "" }))
    .sort(
      (a, b) =>
        compareByCodePoint(a.start, b.start) ||
        compareByCodePoint(a.row.time_from ?? "", b.row.time_from ?? "") ||
        compareByCodePoint(a.row.id, b.row.id),
    )
    .map(({ row }) => ({
      eventId: row.id,
      name: row.name ?? "",
      date: row.date ?? "",
      timeFrom: row.time_from,
      timeTo: row.time_to,
      endDate: row.end_date === "" ? null : row.end_date,
      projectId: projects.get(row.id)?.id ?? null,
      projectName: projects.get(row.id)?.name ?? null,
    }));
}
