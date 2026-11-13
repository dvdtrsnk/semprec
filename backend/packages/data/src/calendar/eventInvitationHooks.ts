// The Events item hooks of issue #1774, registered by `../domainWriteHooks.ts`: an update that moves an Event's time
// or place queues an updated invitation for the people who were sent one, and trashing an Event queues a
// cancellation for every person who has an invitation. Both queue inside the write's transaction. No restore hook
// exists: restoring an Event from the trash sends nothing.
// Constrained by: docs/adr/2026-11-07-item-delete-and-restore-domain-hooks.md,
// docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md
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

/** The participant edges of the Event that store an invitation, with the person each one names. */
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
 * When an Events update changed `icalSequence` (the pre-write transform of issue #1599 writes it exactly when the date,
 * the times or the place changed), queues a `REQUEST` with the new sequence for every participant whose invitation was
 * sent (`sentAt` set) and is not declined. A rename or any other change leaves the sequence alone and queues nothing.
 * The recorded reply statuses are not touched.
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
 * When an Event is trashed, queues a `CANCEL` for every participant edge that carries an invitation, with a snapshot of
 * the Event because the Event and its edges may be gone when the job runs. The invitation need not have been sent.
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
