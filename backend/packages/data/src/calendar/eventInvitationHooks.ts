// An update moving an Event's time or place queues an updated invitation for people who were sent one; trashing
// an Event queues a cancellation for every invitation. Both queue in the write's transaction. Restoring sends
// nothing.
import type { PoolClient } from "pg";
import type { ItemDeleteHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  EVENT_PEOPLE_PROPERTY_KEY,
  readEventParticipantMetadata,
  type EventParticipantInvitation,
} from "./eventParticipantEdgeHook.js";
import { enqueueEventInvitation, readEventInvitationSnapshot } from "./eventInvitationJob.js";

function isEventsDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === EVENTS_MODULE_ID;
}

async function listEventInvitations(
  client: PoolClient,
  database: DatabaseRow,
  event: ItemRow,
): Promise<Array<{ personId: string; invitation: EventParticipantInvitation }>> {
  const property = await getPropertyByKey(client, database.id, EVENT_PEOPLE_PROPERTY_KEY);
  const reldef = property === null ? null : await getRelationDefinitionByPropertyId(client, property.id);
  if (reldef === null) return [];
  const invitations: Array<{ personId: string; invitation: EventParticipantInvitation }> = [];
  for (const edge of await listRelationsForItem(client, reldef.id, event.id)) {
    const { invitation } = readEventParticipantMetadata(edge.metadata);
    if (invitation !== null) invitations.push({ personId: otherSide(edge, event.id), invitation });
  }
  return invitations;
}

/**
 * `icalSequence` changes exactly when date, times or place changed. Queues a `REQUEST` for every sent, not
 * declined invitation; recorded reply statuses are not touched.
 */
export const eventInvitationItemUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  if (!isEventsDatabase(database) || !Object.hasOwn(propertiesPatch, "icalSequence")) return;
  const sequence = item.properties.icalSequence;
  if (typeof sequence !== "number") return;
  for (const { personId, invitation } of await listEventInvitations(client, database, item)) {
    if (invitation.sentAt === undefined || invitation.status === "declined") continue;
    await enqueueEventInvitation(client, {
      method: "REQUEST",
      eventId: item.id,
      personId,
      mailboxId: invitation.mailboxId,
      attendeeEmail: invitation.email,
      sequence,
    });
  }
};

/**
 * Carries an Event snapshot because the Event and its edges may be gone when the job runs. The invitation need
 * not have been sent.
 */
export const eventInvitationItemDeleteHook: ItemDeleteHook = async ({ client, database, item }) => {
  if (!isEventsDatabase(database)) return;
  const invitations = await listEventInvitations(client, database, item);
  if (invitations.length === 0) return;
  const snapshot = await readEventInvitationSnapshot(client, item);
  for (const { personId, invitation } of invitations) {
    await enqueueEventInvitation(client, {
      method: "CANCEL",
      eventId: item.id,
      personId,
      mailboxId: invitation.mailboxId,
      attendeeEmail: invitation.email,
      snapshot,
    });
  }
};
