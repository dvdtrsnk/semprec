// The writes behind the participants sheet of an Event (issue #1790): replacing the list of people on an Event and
// inviting one linked person by email. Both run in the caller's open transaction under the Event's row lock, write the
// edges of the `Events.people` relation through the choke point's relation functions and queue the invitation jobs of
// issue #1774 in that same transaction, so the edges and the jobs commit or roll back together.
// Constrained by: docs/adr/2026-11-11-event-participant-invitations-are-written-by-system-writers.md,
// docs/adr/2026-09-10-side-effects-follow-the-commit.md
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

/** The `code` of the 409 that the invite refuses an already invited person with. */
const ALREADY_INVITED_CODE = "conflict";

/** The user's own writes: linking and unlinking people. An invitation and the organizer edge are written as the system. */
const USER_WRITER: WriterIdentity = { writerKind: "user" };

/** The Event, locked, and the relation its participants are the edges of. */
interface LockedEvent {
  event: ItemRow;
  peopleDatabaseId: string;
  mailboxesDatabaseId: string;
  relationPropertyId: string;
  relationDefinitionId: string;
}

/**
 * Locks the live Event `eventId` of the tenant in scope and reads the ids of the relation and databases the writes
 * need. Another tenant's Event is hidden by row-level security, so it, an unknown id, a trashed Event, an item of
 * another database and a tenant without an Events database all answer the same `not_found`.
 */
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

/** One participant edge of the Event, as stored. */
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

/** The `icalSequence` a `REQUEST` is keyed by: the Event's, or 0 for an Event that stores none. */
function eventSequence(event: ItemRow): number {
  const sequence = event.properties.icalSequence;
  return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
}

/** The first address of a person's `emails`, in lower case, or `null` when the person has none. */
function firstEmail(person: ItemRow): string | null {
  const first = parseAddressListProperty(person.properties.emails)[0];
  return first === undefined ? null : normalizeEmailAddress(first);
}

/**
 * The mailbox an invitation is sent from. `mailboxId` is required whenever an invitation is to be sent
 * (`validation_failed` on `mailboxId`) and must be a live item of the tenant's Mailboxes database (the same answer for
 * a trashed one, another tenant's and an unknown id). The mailbox row is locked, so it is not trashed between this
 * check and the commit of the jobs that name it.
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

/**
 * The person the Event's organizer edge is to be created for, or `null` when the Event has an organizer edge already.
 * The organizer is the person the tenant's user is linked to; a tenant whose user is linked to no person has nobody to
 * name, and the invitation cannot be sent (`validation_failed` on `sendInvites`, reason `noSelfPerson`).
 */
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

/** Creates the organizer edge (role `organizer`) to `personId`, written as the system; an attendee edge of that person is replaced by it. */
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

/** The pending invitation metadata a new edge or a re-written edge carries. */
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
  /** The full list of non-organizer participants wanted, as person ids in the 8-4-4-4-12 form, in lower case. */
  personIds: readonly string[];
  sendInvites: boolean;
  mailboxId?: string;
  actingUserId: string;
}

export interface ReplaceEventPeopleResult {
  /** New people linked with a pending invitation. */
  invited: number;
  /** New people linked without one. */
  linkedOnly: number;
}

/** A person to link, with the address they are invited at, or `null` when they are only linked. */
interface PlannedAddition {
  personId: string;
  email: string | null;
}

/**
 * Makes the non-organizer participants of the Event the people in `personIds`, in the caller's transaction, under the
 * Event's row lock:
 * - a person who is in the list and linked keeps their edge and its metadata and is not invited again;
 * - a linked non-organizer person who is not in the list is unlinked, and one whose edge carries an invitation also
 *   gets a `CANCEL` job built from the Event as it is now;
 * - a person in the list who is not linked is linked. With `sendInvites` and an address (the first of `emails`) the edge
 *   carries a pending invitation, written as the system, and a `REQUEST` job is queued; otherwise it is a plain edge.
 * - when an invitation is sent and the Event has no organizer edge yet, the organizer edge is created first.
 *
 * Refusals, all before the first write: the Event is not found (`not_found`); a person who is not a live item of
 * People, or who is the Event's organizer or the tenant's own person without being linked already as an attendee, is
 * `validation_failed` on `people`; invitations are to be sent and the mailbox is missing or not a mailbox of the tenant (`validation_failed` on `mailboxId`), or the
 * organizer edge is to be created and the tenant's user is linked to no person (`validation_failed` on `sendInvites`).
 * A later failure (a refused edge write, a participant removed by another transaction meanwhile, an Event that cannot
 * be described in a `CANCEL`) throws and the caller's transaction rolls back every edge and every job.
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
  // The tenant's own person is never newly linked as a plain participant, but an attendee edge to it can be stored (the
  // generic edge write allows one). Such an edge is listed by the read endpoint like any other, so a list that names it
  // again is a list that stays, and one that leaves it out unlinks it.
  if (
    wanted.some((personId) => organizerIds.has(personId) || (personId === selfPersonId && !storedIds.has(personId)))
  ) {
    throw new ValidationError("The organizer and the tenant's own person are not added to the list of people", {
      field: "people",
      reason: "organizerInPeople",
    });
  }
  // Locked in id order, so two replacements that name the same people take the rows in the same order.
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
 * Invites one person who is already linked to the Event, in the caller's transaction, under the Event's row lock: the
 * person's edge gets a pending invitation to the first address of their `emails`, written as the system with the
 * edge's other metadata kept, and a `REQUEST` job is queued. When the Event has no organizer edge yet it is created
 * first.
 *
 * Refusals, all before the first write: the Event is not found, the person is not a live item of People or is not
 * linked to the Event (`not_found`); the person is the Event's organizer or the tenant's own person (who is the organizer
 * of every Event the tenant invites to, so is never invited, whatever role a stored edge to them has), has no address,
 * the mailbox is not a mailbox of the tenant or the organizer edge is to be created and the tenant's user is linked to
 * no person (`validation_failed`); the person already has an invitation (409, code `conflict`).
 */
export async function inviteEventPerson(client: PoolClient, input: InviteEventPersonInput): Promise<void> {
  const locked = await lockLiveEvent(client, input.eventId);
  const person = await lockItemById(client, locked.peopleDatabaseId, input.personId);
  if (person === null || person.deletedAt !== null) throw new NotFoundError("Person not found");
  const stored = await readStoredParticipants(client, locked);
  const participant = stored.find((candidate) => candidate.personId === person.id);
  if (participant === undefined) throw new NotFoundError("The person is not linked to the Event");
  // Read once: the tenant's own person is refused here, before any write, and names the organizer edge below.
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
