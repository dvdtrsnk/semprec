import type { Queryable } from "../db/pool.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/** At most this many events are listed for one person. */
const EVENTS_PER_PERSON = 5;

/** One earlier event of a person: its id, its length in minutes and the day it started. */
export interface PastEventDuration {
  eventId: string;
  minutes: number;
  startDate: string;
}

interface PastEventDurationRow {
  person_id: string;
  event_id: string;
  minutes: number;
  start_date: string;
}

/**
 * Per `personIds`, the five most recent live Events linked to the person through `Events.people` whose length is
 * known (issue gh-1993), newest first by `date`, read with one statement for all people. An Event counts only when it
 * is on one day and has both times: it has no `endDate`, a `timeFrom` and a `timeTo` that are `HH:MM` (`24:00` allowed
 * for `timeTo`), and its length is positive. An Event with an `endDate`, a missing or unreadable time, an all-day Event,
 * a length of zero or less and an Event in the Trash are skipped. A person with no such Event has no entry. The read
 * writes nothing and is confined to the caller's tenant by row-level security.
 */
export async function readPastEventDurations(
  client: Queryable,
  personIds: string[],
): Promise<Record<string, PastEventDuration[]>> {
  if (personIds.length === 0) return {};
  const { rows } = await client.query<PastEventDurationRow>(
    `WITH linked AS (
       SELECT r.item_b AS person_id, e.id AS event_id, e.properties->>'date' AS start_date,
         e.properties->>'timeFrom' AS time_from,
         CASE WHEN jsonb_typeof(e.properties->'timeFrom') = 'string' AND jsonb_typeof(e.properties->'timeTo') = 'string'
              AND e.properties->>'timeFrom' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
              AND e.properties->>'timeTo' ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
           THEN (split_part(e.properties->>'timeTo', ':', 1)::int * 60 + split_part(e.properties->>'timeTo', ':', 2)::int)
              - (split_part(e.properties->>'timeFrom', ':', 1)::int * 60 + split_part(e.properties->>'timeFrom', ':', 2)::int)
         END AS minutes
       FROM databases d
       JOIN properties p ON p.database_id = d.id AND p.type = 'relation' AND p.key = 'people'
       JOIN relation_definitions rd ON rd.property_id_a = p.id
       JOIN item_relations r ON r.relation_definition_id = rd.id AND r.item_b = ANY($2::uuid[])
       JOIN items e ON e.database_id = d.id AND e.id = r.item_a AND e.deleted_at IS NULL
       WHERE d.owner_module_id = $1 AND d.archived_at IS NULL
         AND jsonb_typeof(e.properties->'date') = 'string' AND e.properties->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         AND coalesce(e.properties->>'endDate', '') = ''
     )
     SELECT person_id, event_id, minutes, start_date FROM (
       SELECT person_id, event_id, minutes, start_date,
         row_number() OVER (PARTITION BY person_id ORDER BY start_date DESC, time_from DESC, event_id) AS position
       FROM linked WHERE minutes > 0
     ) ranked
     WHERE position <= $3
     ORDER BY person_id, position`,
    [EVENTS_MODULE_ID, personIds, EVENTS_PER_PERSON],
  );
  const byPerson: Record<string, PastEventDuration[]> = {};
  for (const row of rows) {
    (byPerson[row.person_id] ??= []).push({ eventId: row.event_id, minutes: row.minutes, startDate: row.start_date });
  }
  return byPerson;
}
