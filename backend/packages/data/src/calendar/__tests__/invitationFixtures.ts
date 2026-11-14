import type { Pool } from "pg";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { INVITATIONS_MODULE_ID } from "../../seed/invitationsKeys.js";
import { CALENDAR_MODULE_ID } from "../calendarModuleId.js";

/** The invitation properties the calendar module writes; the ingest of an iMIP message writes the same keys. */
const INVITATION_KEYS = [
  "title",
  "startsAt",
  "endsAt",
  "allDay",
  "place",
  "status",
  "kind",
  "uid",
  "sequence",
  "respondedAt",
] as const;

/** "Sprint review", Thursday 22 Oct 2026, 13:00-14:00 in Europe/Prague (UTC+2 until 25 Oct). */
export const SPRINT_REVIEW = {
  title: "Sprint review",
  place: "Room 4",
  startsAt: "2026-10-22T11:00:00.000Z",
  endsAt: "2026-10-22T12:00:00.000Z",
  allDay: false,
  status: "pending",
  kind: "invite",
  uid: "sprint-review@example.test",
  sequence: 0,
};

/**
 * An invitation as the ingest of a message writes it (the calendar module's system keys), in the tenant in scope on
 * `pool`, linked to `suggestedCalendar` when one is named. The ingest is the only production writer of such a row; a
 * property whose override is `undefined` is left out. Returns the invitation's id.
 */
export async function createInvitation(
  pool: Pool,
  overrides: Record<string, unknown>,
  suggestedCalendar: string | null,
): Promise<string> {
  return withTransaction(pool, async (client) => {
    const invitations = await databasesStore.getDatabaseByModuleId(client, INVITATIONS_MODULE_ID);
    if (!invitations) throw new Error("Missing the Invitations database");
    const properties = Object.fromEntries(
      Object.entries({ ...SPRINT_REVIEW, ...overrides }).filter(([, value]) => value !== undefined),
    );
    const created = await createItemWithClient(
      client,
      { databaseId: invitations.id, properties },
      { allowedSystemKeys: INVITATION_KEYS, systemOwnerProcess: CALENDAR_MODULE_ID },
    );
    if (suggestedCalendar !== null) {
      const property = await propertiesStore.getPropertyByKey(client, invitations.id, "suggestedCalendar");
      if (!property) throw new Error("Missing Invitations.suggestedCalendar");
      await createRelationWithClient(
        client,
        { relationPropertyId: property.id, callerItemId: created.id, targetItemId: suggestedCalendar },
        { ownerProcess: CALENDAR_MODULE_ID },
      );
    }
    return created.id;
  });
}
