// Owns the metadata of an Event participant edge: its shape, write rules, and how a stored edge is read. A
// participant edge is an edge of `Events.people` / `People.events`, whichever side a write names.
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { RelationEdgeWriteHook } from "../chokePoint/hooks.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import type { RelationEdgeContext } from "../chokePoint/relationEdgeContext.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { runValueLinkAdmissionLock } from "../chokePoint/valueLinkRelationAdmission.js";
import type { WriterKind } from "../chokePoint/writerKind.js";
import { ValidationError } from "../errors.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSelfPersonId } from "../selfPerson.js";

export const EVENT_PEOPLE_PROPERTY_KEY = "people";

const participantRoleSchema = z.enum(["organizer", "attendee"]);

/** `sentAt` and `respondedAt` are UTC instants. */
const participantInvitationSchema = z
  .object({
    status: z.enum(["pending", "accepted", "tentative", "declined"]),
    email: z.string().min(1),
    mailboxId: z.uuid(),
    sentAt: z.iso.datetime().optional(),
    respondedAt: z.iso.datetime().optional(),
  })
  .strict();

const participantMetadataSchema = z
  .object({ role: participantRoleSchema.optional(), invitation: participantInvitationSchema.optional() })
  .strict();

export type EventParticipantRole = z.infer<typeof participantRoleSchema>;
export type EventParticipantInvitation = z.infer<typeof participantInvitationSchema>;
export type EventParticipantMetadata = z.infer<typeof participantMetadataSchema>;

/**
 * Refused (`invalidParticipantMetadata`): keys other than `role`/`invitation`, an unknown role, a malformed
 * `invitation`, or an `invitation` on an organizer edge. Absent metadata is an attendee without an invitation.
 */
export function parseEventParticipantMetadata(metadata: Record<string, unknown> | undefined): EventParticipantMetadata {
  const parsed = participantMetadataSchema.safeParse(metadata ?? {});
  if (!parsed.success) {
    throw new ValidationError("A participant edge's metadata must be { role?, invitation? } in their defined shapes", {
      field: "metadata",
      reason: "invalidParticipantMetadata",
    });
  }
  if (parsed.data.role === "organizer" && parsed.data.invitation !== undefined) {
    throw new ValidationError("An organizer edge carries no invitation", {
      field: "metadata",
      reason: "invalidParticipantMetadata",
    });
  }
  return parsed.data;
}

/**
 * Lenient: an unknown role reads as `attendee` and a malformed invitation as none, since stored edges may predate
 * the write rule or hold other metadata.
 */
export function readEventParticipantMetadata(metadata: Record<string, unknown>): {
  role: EventParticipantRole;
  invitation: EventParticipantInvitation | null;
} {
  const role = participantRoleSchema.safeParse(metadata.role);
  const invitation = participantInvitationSchema.safeParse(metadata.invitation);
  return { role: role.success ? role.data : "attendee", invitation: invitation.success ? invitation.data : null };
}

interface ParticipantEdgeEnds {
  eventsDatabaseId: string;
  eventId: string;
  personId: string;
}

const UUID_TEXT_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Postgres accepts more uuid text forms than it returns (braces, moved or missing hyphens). Such an id names the
 * same row to the edge write but would match no stored edge here, so the write would be judged as a first write.
 * It is refused (`nonCanonicalItemId`).
 */
function storedTextOfItemId(itemId: string, field: "callerItemId" | "targetItemId"): string {
  if (!UUID_TEXT_FORM.test(itemId)) {
    throw new ValidationError("A participant edge names its Event and its person by UUIDs in the 8-4-4-4-12 form", {
      field,
      reason: "nonCanonicalItemId",
    });
  }
  return itemId.toLowerCase();
}

/** `null` for a write on another relation. */
async function resolveParticipantEdgeEnds(
  client: PoolClient,
  edgeContext: RelationEdgeContext,
  callerItemId: string,
  targetItemId: string,
): Promise<ParticipantEdgeEnds | null> {
  const { rows } = await client.query<{ id: string; database_id: string }>(
    `SELECT p.id, p.database_id FROM properties p
     JOIN databases d ON d.id = p.database_id AND d.tenant_id = p.tenant_id
     WHERE p.id = ANY($1::uuid[]) AND p.key = $2 AND d.owner_module_id = $3 AND d.system`,
    [[edgeContext.reldef.propertyIdA, edgeContext.reldef.propertyIdB], EVENT_PEOPLE_PROPERTY_KEY, EVENTS_MODULE_ID],
  );
  const eventsSide = rows[0];
  if (!eventsSide) return null;
  const callerIsEvent = eventsSide.id === edgeContext.property.id;
  const caller = storedTextOfItemId(callerItemId, "callerItemId");
  const target = storedTextOfItemId(targetItemId, "targetItemId");
  return {
    eventsDatabaseId: eventsSide.database_id,
    eventId: callerIsEvent ? caller : target,
    personId: callerIsEvent ? target : caller,
  };
}

interface ParticipantEdgeWrite extends ParticipantEdgeEnds {
  relationDefinitionId: string;
  metadata: Record<string, unknown> | undefined;
  writerKind: WriterKind;
  insertOnly: boolean;
  lockMode?: "nowait";
}

/**
 * Refusals (`validation_failed` on `metadata`):
 * - metadata `parseEventParticipantMetadata` refuses;
 * - an organizer edge to anyone but the tenant user's person (`organizerNotSelf`);
 * - a second organizer edge (`organizerAlreadySet`);
 * - from a non-`system` writer, an `invitation` not exactly the stored one (`invitationReadOnly`). An insert-only
 *   write may omit it, since it stores nothing over an existing edge.
 *
 * Row-locks the Event before reading its edges, so concurrent writes on one Event serialize. The lock comes before
 * the edge row and so before the People `lastContact` job key the changed-edge hook takes: an Event update's order.
 *
 * An insert-only, invitation-less attendee write takes no lock: the speaker confirmation makes it after taking a
 * person's `lastContact` key, so locking there would invert the order and could deadlock.
 */
async function assertParticipantEdgeWritable(client: PoolClient, write: ParticipantEdgeWrite): Promise<void> {
  const { role } = parseEventParticipantMetadata(write.metadata);
  const invitation = write.metadata?.invitation;
  const leavesStoredEdge = write.insertOnly && invitation === undefined;
  if (leavesStoredEdge && role !== "organizer") return;

  if (write.lockMode === "nowait") {
    await runValueLinkAdmissionLock(() => itemsStore.lockItemByIdNowait(client, write.eventsDatabaseId, write.eventId));
  } else {
    await itemsStore.lockItemById(client, write.eventsDatabaseId, write.eventId);
  }
  const edges = await relationsStore.listRelationsForItem(client, write.relationDefinitionId, write.eventId);
  const stored = edges.find((edge) => relationsStore.otherSide(edge, write.eventId) === write.personId);

  if (role === "organizer") {
    if ((await getSelfPersonId(client)) !== write.personId) {
      throw new ValidationError("Only the person linked to the tenant's user can be an Event's organizer", {
        field: "metadata",
        reason: "organizerNotSelf",
      });
    }
    const otherOrganizer = edges.some(
      (edge) => edge !== stored && readEventParticipantMetadata(edge.metadata).role === "organizer",
    );
    if (otherOrganizer) {
      throw new ValidationError("The Event already has an organizer", {
        field: "metadata",
        reason: "organizerAlreadySet",
      });
    }
  }

  if (write.writerKind === "system" || leavesStoredEdge) return;
  if (!isDeepStrictEqual(invitation, stored?.metadata.invitation)) {
    throw new ValidationError("A participant's invitation is written by the server only", {
      field: "metadata",
      reason: "invitationReadOnly",
    });
  }
}

/** Runs on edge add and metadata replace from either side; an edge removal carries no metadata and skips it. */
export const eventParticipantEdgeWriteHook: RelationEdgeWriteHook = async ({
  client,
  edgeContext,
  callerItemId,
  targetItemId,
  metadata,
  writer,
  lockMode,
  insertOnly,
}) => {
  const ends = await resolveParticipantEdgeEnds(client, edgeContext, callerItemId, targetItemId);
  if (!ends) return;
  await assertParticipantEdgeWritable(client, {
    ...ends,
    relationDefinitionId: edgeContext.reldef.id,
    metadata,
    writerKind: writer.writerKind,
    insertOnly: insertOnly === true,
    lockMode,
  });
};
