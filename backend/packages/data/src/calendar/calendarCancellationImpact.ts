import type { PoolClient } from "pg";
import { z } from "zod";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { EVENT_PEOPLE_PROPERTY_KEY, readEventParticipantMetadata } from "./eventParticipantEdgeHook.js";

const CALENDAR_EVENTS_PROPERTY_KEY = "events";

/**
 * `cancellationCount` counts participant edges carrying an invitation (one cancellation each); `recipientCount`
 * the distinct invitation emails, compared in lower case.
 */
export interface CalendarCancellationImpact {
  eventCount: number;
  recipientCount: number;
  cancellationCount: number;
}

const LIVE_CALENDAR_SQL = `
SELECT i.id
FROM items i
JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
WHERE i.tenant_id = app_tenant_default() AND d.system AND d.owner_module_id = $1
  AND i.id = $2 AND i.deleted_at IS NULL
`;

/** Trashed Events are left out: deleting the calendar does not trash them again. */
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

/** Every edge counts whatever state its person is in, because cancellations are enqueued per edge. */
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
 * `null` for no live calendar of the tenant (unknown, wrong database, trashed, or hidden by RLS). Three statements
 * regardless of size; the route runs them in a repeatable-read transaction so they read one snapshot.
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
