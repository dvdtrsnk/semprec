// Issue gh-2003: how many Events, cancellations and invited people the deletion of one calendar affects. The
// numbers are read from the edges of `Calendars.events` and `Events.people`; the deletion that trashes the
// Events is `calendarTrashHooks.ts` (issue gh-1803); the Event delete reaction of the invitation sending work
// (issue #1774) will enqueue one cancellation per invited participant edge of a trashed Event. The route
// `GET /api/calendar/calendars/:id/cancellation-impact` is in `cancellationImpactRouteHandler.ts`.
import type { PoolClient } from "pg";
import { z } from "zod";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { EVENT_PEOPLE_PROPERTY_KEY, readEventParticipantMetadata } from "./eventParticipantEdgeHook.js";

/** The `Calendars.events` property: the Events of a calendar are the items on its edges. */
const CALENDAR_EVENTS_PROPERTY_KEY = "events";

/**
 * What deleting a calendar would send. `eventCount` is the live Events on the calendar's edges, `cancellationCount`
 * the participant edges of those Events that carry an invitation (one cancellation each) and `recipientCount` the
 * distinct invitation emails among those edges, compared in lower case.
 */
export interface CalendarCancellationImpact {
  eventCount: number;
  recipientCount: number;
  cancellationCount: number;
}

/** The calendar `$2` when it is a live item of the Calendars system database. `$1` is the Calendars module id. */
const LIVE_CALENDAR_SQL = `
SELECT i.id
FROM items i
JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
WHERE i.tenant_id = app_tenant_default() AND d.system AND d.owner_module_id = $1
  AND i.id = $2 AND i.deleted_at IS NULL
`;

/**
 * The live Events on the edges of the calendar `$3`. `$1` is the Calendars module id and `$2` the key of its
 * Events property. An edge whose other end is not an item of that property's target database is left out, and so
 * is an Event in the trash, which a deletion of the calendar does not trash again.
 */
const CALENDAR_EVENTS_SQL = `
SELECT ev.id
FROM properties p
JOIN databases d ON d.id = p.database_id AND d.tenant_id = p.tenant_id
JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
JOIN item_relations r ON r.tenant_id = p.tenant_id AND r.relation_definition_id = rd.id
  AND $3::uuid = CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END
JOIN items ev ON ev.tenant_id = p.tenant_id
  AND ev.database_id = (p.config->>'targetDatabaseId')::uuid
  AND ev.id = CASE WHEN rd.property_id_a = p.id THEN r.item_b ELSE r.item_a END
  AND ev.deleted_at IS NULL
WHERE p.tenant_id = app_tenant_default() AND d.system AND d.owner_module_id = $1 AND p.key = $2
`;

/**
 * The metadata of every edge of the Events `people` relation that one of the Events `$3` holds, one row per edge.
 * `$1` is the Events module id and `$2` the key of its People property. The person is not read: an edge counts
 * whatever state its person is in, because the cancellations are enqueued per edge.
 */
const EVENT_PARTICIPANT_EDGES_SQL = `
SELECT r.metadata AS metadata
FROM properties p
JOIN databases d ON d.id = p.database_id AND d.tenant_id = p.tenant_id
JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
JOIN item_relations r ON r.tenant_id = p.tenant_id AND r.relation_definition_id = rd.id
  AND (CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END) = ANY($3::uuid[])
WHERE p.tenant_id = app_tenant_default() AND d.system AND d.owner_module_id = $1 AND p.key = $2
`;

const idRow = z.object({ id: z.string() });
const edgeRow = z.object({ metadata: z.record(z.string(), z.unknown()) });

/**
 * The cancellation impact of deleting the calendar `calendarId` of the tenant in scope, or `null` when it names no
 * live calendar: an unknown id, an item of another database, a calendar in the trash and another tenant's calendar
 * (row-level security hides it) all answer the same way. A system or subscription calendar, which cannot be deleted,
 * is read like any other.
 *
 * Three statements however many Events and edges there are: the calendar, its live Events, and the participant
 * edges of those Events. An edge carries an invitation when `readEventParticipantMetadata` reads one from it, so a
 * stored invitation of an unknown shape counts as none. Nothing is written. The statements read what the caller's
 * transaction sees; the route runs it in a repeatable-read transaction, so they read one snapshot.
 */
export async function readCalendarCancellationImpact(
  client: PoolClient,
  calendarId: string,
): Promise<CalendarCancellationImpact | null> {
  const calendar = await client.query<Record<string, unknown>>(LIVE_CALENDAR_SQL, [CALENDARS_MODULE_ID, calendarId]);
  if (calendar.rows.length === 0) return null;
  const events = await client.query<Record<string, unknown>>(CALENDAR_EVENTS_SQL, [
    CALENDARS_MODULE_ID,
    CALENDAR_EVENTS_PROPERTY_KEY,
    calendarId,
  ]);
  const eventIds = events.rows.map((row) => idRow.parse(row).id);
  const edges = await client.query<Record<string, unknown>>(EVENT_PARTICIPANT_EDGES_SQL, [
    EVENTS_MODULE_ID,
    EVENT_PEOPLE_PROPERTY_KEY,
    eventIds,
  ]);
  const emails = new Set<string>();
  let cancellationCount = 0;
  for (const row of edges.rows) {
    const { invitation } = readEventParticipantMetadata(edgeRow.parse(row).metadata);
    if (invitation === null) continue;
    cancellationCount += 1;
    emails.add(invitation.email.toLowerCase());
  }
  return { eventCount: eventIds.length, recipientCount: emails.size, cancellationCount };
}
