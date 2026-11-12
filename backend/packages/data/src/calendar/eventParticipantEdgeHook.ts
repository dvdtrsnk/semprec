// Owns the metadata of an Event participant edge (issue #1757): its shape, the rules a write of it must
// meet, and how a stored edge is read. A participant edge is an edge of the relation between `Events.people`
// and its inverse `People.events`, whichever of the two properties a write names.
// Constrained by: docs/adr/2026-11-11-event-participant-invitations-are-written-by-system-writers.md,
// docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md
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

/** The Events -> People relation property whose edges are an Event's participants. */
export const EVENT_PEOPLE_PROPERTY_KEY = "people";

const participantRoleSchema = z.enum(["organizer", "attendee"]);

/** The state of the invitation a participant was sent by email. `sentAt` and `respondedAt` are UTC instants. */
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
 * The metadata a participant edge write carries, or `validation_failed` on `metadata` with reason
 * `invalidParticipantMetadata`: a key other than `role` and `invitation`, a role that is neither
 * `organizer` nor `attendee`, an `invitation` of another shape, or an `invitation` on an organizer edge.
 * Absent metadata is `{}`: an attendee without an invitation.
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
 * What a stored participant edge says. A stored role that is not one of the two roles reads as `attendee`,
 * and a stored invitation that is not of the defined shape reads as none: `{}` is every edge written before
 * the write rule existed, and such an edge may also hold other metadata.
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

/** A UUID in its 8-4-4-4-12 text form, in either letter case. */
const UUID_TEXT_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `itemId` as Postgres returns a uuid, so that it compares equal to the ids of stored edges: the 8-4-4-4-12
 * form in lower case. Postgres reads more text forms of one uuid than it returns: in braces, and with
 * hyphens left out or placed after any group of four digits. An id in such a form names the same row to the
 * edge write, but it would match no stored edge here, and the write would then be judged as the first write
 * of an edge that is stored. It is refused with `validation_failed` on `field`, reason `nonCanonicalItemId`.
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

/**
 * The Event and the person of an edge write on the participant relation, or `null` when the write is on
 * another relation. Both ids are returned as `storedTextOfItemId` gives them, which refuses the write when
 * one of them is in another text form.
 */
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
 * Rejects a participant edge write, each time with `validation_failed` on `metadata`:
 * - metadata `parseEventParticipantMetadata` refuses (`invalidParticipantMetadata`);
 * - an organizer edge to a person other than the one linked to the tenant's user, including when no person
 *   is linked (`organizerNotSelf`);
 * - an organizer edge while another edge of the Event is an organizer edge (`organizerAlreadySet`);
 * - from a writer whose kind is not `system`, an `invitation` that is not exactly the stored one, which
 *   includes leaving out a stored one and giving one where none is stored (`invitationReadOnly`). An
 *   insert-only write may leave it out, because such a write stores nothing over an existing edge.
 *
 * Row-locks the Event before it reads the Event's edges, so two participant edge writes of one Event that
 * take the lock run one after the other and the second reads what the first stored. The lock comes before
 * the edge row is written, and so before the People `lastContact` job key that the write's changed-edge
 * hook takes: the order of an Event update. An Event that does not exist (the placeholder caller of a
 * proposed item) has no row to lock and no edges.
 *
 * An insert-only write that carries no invitation and is not an organizer edge takes no lock and reads no
 * edges: it returns after the metadata check. Nothing about it is decided from the Event's edges, and it
 * stores nothing over a stored edge. The speaker confirmation makes that write after its speakers edge took
 * a person's `lastContact` job key, so a lock there would be taken in the opposite order to an Event update
 * and the two could deadlock.
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

/**
 * The choke point's relation-edge-write hook for an Event's participant edges (registered by
 * `../domainWriteHooks.ts`). It runs on an edge add and on a metadata replace, from the Event's side and
 * from the person's side. It refuses a write that names the Event or the person by an id in another text
 * form than 8-4-4-4-12 (`storedTextOfItemId`) and then applies `assertParticipantEdgeWritable`. An edge
 * removal carries no metadata and does not run it.
 */
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
