// Writes behind an Event's participants sheet: replacing its people and inviting one linked person. Both run in
// the caller's transaction under the Event's row lock and queue the invitation jobs in that same transaction, so
// edges and jobs commit or roll back together.
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import {
  createRelationWithClient,
  deleteRelationWithClient,
  updateRelationWithClient,
} from "../chokePoint/relationOps.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { SYSTEM_WRITER, type WriterIdentity } from "../chokePoint/writerKind.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { parseAddressListProperty } from "../mail/addressListParsing.js";
import { normalizeEmailAddress } from "../mail/personEmailIndexStore.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { EVENTS_MODULE_ID, PEOPLE_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSelfPersonId } from "../selfPerson.js";
import type { ItemRow } from "../types.js";
import {
  EVENT_PEOPLE_PROPERTY_KEY,
  readEventParticipantMetadata,
  type EventParticipantInvitation,
} from "./eventParticipantEdgeHook.js";
import { enqueueEventInvitation, readEventInvitationSnapshot } from "./eventInvitationJob.js";

const ALREADY_INVITED_CODE = "conflict";

/** Invitations and the organizer edge are written as the system. */
const USER_WRITER: WriterIdentity = { writerKind: "user" };

interface LockedEvent {
  event: ItemRow;
  peopleDatabaseId: string;
  mailboxesDatabaseId: string;
  relationPropertyId: string;
  relationDefinitionId: string;
}

/** Another tenant's Event is hidden by RLS, so every not-found case answers the same `not_found`. */
async function lockLiveEvent(client: PoolClient, eventId: string): Promise<LockedEvent> {
  const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  const event = events === null ? null : await lockItemById(client, events.id, eventId);
  if (events === null || event === null || event.deletedAt !== null) throw new NotFoundError("Event not found");
  const property = await getPropertyByKey(client, events.id, EVENT_PEOPLE_PROPERTY_KEY);
  const reldef = property === null ? null : await getRelationDefinitionByPropertyId(client, property.id);
  const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
  const mailboxes = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
  if (property === null || reldef === null || people === null || mailboxes === null) {
    throw new Error("The tenant's Events, People or Mailboxes schema is incomplete");
  }
  return {
    event,
    peopleDatabaseId: people.id,
    mailboxesDatabaseId: mailboxes.id,
    relationPropertyId: property.id,
    relationDefinitionId: reldef.id,
  };
}

interface StoredParticipant {
  personId: string;
  metadata: Record<string, unknown>;
  role: "organizer" | "attendee";
  invitation: EventParticipantInvitation | null;
}

async function readStoredParticipants(client: PoolClient, locked: LockedEvent): Promise<StoredParticipant[]> {
  const edges = await listRelationsForItem(client, locked.relationDefinitionId, locked.event.id);
  return edges.map((edge) => ({
    personId: otherSide(edge, locked.event.id),
    metadata: edge.metadata,
    ...readEventParticipantMetadata(edge.metadata),
  }));
}

/** 0 for an Event that stores none. */
function eventSequence(event: ItemRow): number {
  const sequence = event.properties.icalSequence;
  return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
}

/** Lower case. */
function firstEmail(person: ItemRow): string | null {
  const first = parseAddressListProperty(person.properties.emails)[0];
  return first === undefined ? null : normalizeEmailAddress(first);
}

/**
 * Required whenever an invitation is sent. The row is locked so the mailbox is not trashed before the jobs naming
 * it commit.
 */
async function requireLiveMailbox(
  client: PoolClient,
  mailboxesDatabaseId: string,
  mailboxId: string | undefined,
): Promise<string> {
  if (mailboxId === undefined) {
    throw new ValidationError("'mailboxId' is required to send an invitation", { field: "mailboxId" });
  }
  const mailbox = await lockItemById(client, mailboxesDatabaseId, mailboxId);
  if (mailbox === null || mailbox.deletedAt !== null) {
    throw new ValidationError("'mailboxId' must name a mailbox of the tenant", { field: "mailboxId" });
  }
  return mailbox.id;
}

/** `null` when an organizer edge exists. A tenant user linked to no person cannot send (`noSelfPerson`). */
function organizerPersonToCreate(stored: readonly StoredParticipant[], selfPersonId: string | null): string | null {
  if (stored.some((participant) => participant.role === "organizer")) return null;
  if (selfPersonId === null) {
    throw new ValidationError("The tenant's user is linked to no person, so an invitation has no organizer", {
      field: "sendInvites",
      reason: "noSelfPerson",
    });
  }
  return selfPersonId;
}

/** Written as the system; replaces an attendee edge of that person. */
async function writeOrganizerEdge(client: PoolClient, locked: LockedEvent, personId: string): Promise<void> {
  await createRelationWithClient(
    client,
    {
      relationPropertyId: locked.relationPropertyId,
      callerItemId: locked.event.id,
      targetItemId: personId,
      metadata: { role: "organizer" },
    },
    undefined,
    SYSTEM_WRITER,
  );
}

function pendingInvitation(email: string, mailboxId: string): EventParticipantInvitation {
  return { status: "pending", email, mailboxId };
}

async function enqueueRequest(
  client: PoolClient,
  event: ItemRow,
  personId: string,
  invitation: EventParticipantInvitation,
): Promise<void> {
  await enqueueEventInvitation(client, {
    method: "REQUEST",
    eventId: event.id,
    personId,
    mailboxId: invitation.mailboxId,
    attendeeEmail: invitation.email,
    sequence: eventSequence(event),
  });
}

export interface ReplaceEventPeopleInput {
  eventId: string;
  /** 8-4-4-4-12 form, lower case. */
  personIds: readonly string[];
  sendInvites: boolean;
  mailboxId?: string;
  actingUserId: string;
}

export interface ReplaceEventPeopleResult {
  invited: number;
  linkedOnly: number;
}

interface PlannedAddition {
  personId: string;
  email: string | null;
}

/**
 * - Listed and linked people keep their edge and are not invited again.
 * - Linked non-organizers not listed are unlinked; one with an invitation also gets a `CANCEL`.
 * - Listed unlinked people are linked; with `sendInvites` and an address the edge carries a pending invitation
 *   (system writer) and a `REQUEST` is queued.
 * - When sending and the Event has no organizer edge, it is created first.
 *
 * All refusals happen before the first write. A later failure throws and the caller's transaction rolls back every
 * edge and job.
 */
export async function replaceEventPeople(
  client: PoolClient,
  input: ReplaceEventPeopleInput,
): Promise<ReplaceEventPeopleResult> {
  const locked = await lockLiveEvent(client, input.eventId);
  const stored = await readStoredParticipants(client, locked);
  const selfPersonId = await getSelfPersonId(client);
  const storedIds = new Set(stored.map((participant) => participant.personId));
  const organizerIds = new Set(
    stored.filter((participant) => participant.role === "organizer").map((participant) => participant.personId),
  );

  const wanted = [...new Set(input.personIds)];
  // The tenant's own person is never newly linked as a plain participant, but a stored attendee edge to it is
  // listed like any other, so naming it again keeps it and leaving it out unlinks it.
  if (
    wanted.some((personId) => organizerIds.has(personId) || (personId === selfPersonId && !storedIds.has(personId)))
  ) {
    throw new ValidationError("The organizer and the tenant's own person are not added to the list of people", {
      field: "people",
      reason: "organizerInPeople",
    });
  }
  // Locked in id order, so two replacements naming the same people take rows in the same order.
  const emailOf = new Map<string, string | null>();
  for (const personId of [...wanted].sort()) {
    const person = await lockItemById(client, locked.peopleDatabaseId, personId);
    if (person === null || person.deletedAt !== null) {
      throw new ValidationError("A person in the list does not exist", { field: "people", reason: "unknownPerson" });
    }
    emailOf.set(personId, firstEmail(person));
  }
  const added: PlannedAddition[] = wanted
    .filter((personId) => !storedIds.has(personId))
    .map((personId) => ({ personId, email: input.sendInvites ? (emailOf.get(personId) ?? null) : null }));
  const removed = stored.filter(
    (participant) => participant.role !== "organizer" && !wanted.includes(participant.personId),
  );

  const sending = added.filter((addition) => addition.email !== null);
  const mailboxId =
    sending.length > 0 ? await requireLiveMailbox(client, locked.mailboxesDatabaseId, input.mailboxId) : null;

  // Checked before the first write: the organizer edge is created only when an invitation is sent.
  const organizerPersonId = sending.length > 0 ? organizerPersonToCreate(stored, selfPersonId) : null;

  for (const participant of removed) {
    const edge = await deleteRelationWithClient(
      client,
      {
        relationPropertyId: locked.relationPropertyId,
        callerItemId: locked.event.id,
        targetItemId: participant.personId,
        actingUserId: input.actingUserId,
      },
      undefined,
      USER_WRITER,
    );
    if (edge === null) {
      throw new ConflictError("A participant changed while the list was being saved", { field: "people" });
    }
    if (participant.invitation !== null) {
      await enqueueEventInvitation(client, {
        method: "CANCEL",
        eventId: locked.event.id,
        personId: participant.personId,
        mailboxId: participant.invitation.mailboxId,
        attendeeEmail: participant.invitation.email,
        snapshot: await readEventInvitationSnapshot(client, locked.event),
      });
    }
  }

  if (organizerPersonId !== null) await writeOrganizerEdge(client, locked, organizerPersonId);
  for (const addition of added) {
    const invitation =
      addition.email !== null && mailboxId !== null ? pendingInvitation(addition.email, mailboxId) : null;
    await createRelationWithClient(
      client,
      {
        relationPropertyId: locked.relationPropertyId,
        callerItemId: locked.event.id,
        targetItemId: addition.personId,
        metadata: invitation === null ? undefined : { invitation },
        actingUserId: input.actingUserId,
      },
      undefined,
      invitation === null ? USER_WRITER : SYSTEM_WRITER,
    );
    if (invitation !== null) await enqueueRequest(client, locked.event, addition.personId, invitation);
  }
  return { invited: sending.length, linkedOnly: added.length - sending.length };
}

export interface InviteEventPersonInput {
  eventId: string;
  personId: string;
  mailboxId: string;
  actingUserId: string;
}

/**
 * The edge gets a pending invitation to the person's first address (other metadata kept, system writer) and a
 * `REQUEST` is queued; a missing organizer edge is created first. All refusals happen before the first write. The
 * tenant's own person is the organizer of every invited Event and is never invited. An existing invitation is a
 * 409 `conflict`.
 */
export async function inviteEventPerson(client: PoolClient, input: InviteEventPersonInput): Promise<void> {
  const locked = await lockLiveEvent(client, input.eventId);
  const person = await lockItemById(client, locked.peopleDatabaseId, input.personId);
  if (person === null || person.deletedAt !== null) throw new NotFoundError("Person not found");
  const stored = await readStoredParticipants(client, locked);
  const participant = stored.find((candidate) => candidate.personId === person.id);
  if (participant === undefined) throw new NotFoundError("The person is not linked to the Event");
  // Read once: refused here before any write, and names the organizer edge below.
  const selfPersonId = await getSelfPersonId(client);
  if (participant.role === "organizer" || person.id === selfPersonId) {
    throw new ValidationError("The organizer of an Event and the tenant's own person are not invited", {
      field: "personId",
      reason: "organizerInvite",
    });
  }
  if (participant.invitation !== null) {
    throw new ConflictError(
      "The person already has an invitation to the Event",
      { personId: person.id },
      ALREADY_INVITED_CODE,
    );
  }
  const email = firstEmail(person);
  if (email === null) {
    throw new ValidationError("The person has no email address", { field: "personId", reason: "noEmailAddress" });
  }
  const mailboxId = await requireLiveMailbox(client, locked.mailboxesDatabaseId, input.mailboxId);

  const organizerPersonId = organizerPersonToCreate(stored, selfPersonId);
  if (organizerPersonId !== null) await writeOrganizerEdge(client, locked, organizerPersonId);
  const invitation = pendingInvitation(email, mailboxId);
  await updateRelationWithClient(
    client,
    {
      relationPropertyId: locked.relationPropertyId,
      callerItemId: locked.event.id,
      targetItemId: person.id,
      metadata: { ...participant.metadata, invitation },
      actingUserId: input.actingUserId,
    },
    undefined,
    SYSTEM_WRITER,
  );
  await enqueueRequest(client, locked.event, person.id, invitation);
}
