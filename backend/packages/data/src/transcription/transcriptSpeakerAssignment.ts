// Issue #1770: a user assigns, replaces or clears the person of one speaker key of a transcript in one
// transaction, which also settles the Inbox card that asks who the speaker is, and the people a client
// can offer for a speaker.
// Constrained by: docs/adr/2026-10-03-tenant-isolation-through-row-level-security.md,
// docs/adr/2026-09-10-choke-point-api-for-state-writes.md
import { DatabaseError, type PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import {
  createRelationIfAbsentWithClient,
  createRelationWithClient,
  deleteRelationWithClient,
} from "../chokePoint/relationOps.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { EVENT_PEOPLE_PROPERTY_KEY, readEventParticipantMetadata } from "../calendar/eventParticipantEdgeHook.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { settleSpeakerCardWithClient } from "../inbox/proposalActions.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { EVENTS_MODULE_ID, PEOPLE_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSelfPersonId } from "../selfPerson.js";
import type { ItemRow, PropertyRow, RelationDefinitionRow } from "../types.js";
import { readLiveTranscriptEventId } from "./transcriptEventEdges.js";
import { speakerSuggestionIdempotencyKey } from "./transcriptSpeakerSuggestion.js";
import {
  listSegmentSpeakers,
  listTranscriptSpeakers,
  TRANSCRIPT_SPEAKERS_PROPERTY_KEY,
  type TranscriptSpeaker,
} from "./transcriptionSpeakerEdges.js";

/** Every write of the assignment is the signed-in user's. */
const USER_WRITER: WriterIdentity = { writerKind: "user" };

/** The same error for an unknown transcript, another tenant's, one in the Trash and an unknown or foreign person. */
function speakerNotFound(): NotFoundError {
  return new NotFoundError("Transcript or person not found", { resource: "transcriptSpeaker" });
}

/** The Transcripts database, the Transcripts `speakers` property and its relation definition. */
async function requireSpeakersRelation(
  client: PoolClient,
): Promise<{ transcriptsDatabaseId: string; property: PropertyRow; definition: RelationDefinitionRow }> {
  const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  if (!transcripts) throw speakerNotFound();
  const property = await getPropertyByKey(client, transcripts.id, TRANSCRIPT_SPEAKERS_PROPERTY_KEY);
  const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
  if (!property || !definition) {
    throw new NotFoundError(`Relation '${TRANSCRIPT_SPEAKERS_PROPERTY_KEY}' not found on Transcripts`);
  }
  return { transcriptsDatabaseId: transcripts.id, property, definition };
}

/** The speaker key a `speakers` edge maps, or `null` for an edge whose metadata names none. */
function edgeSpeaker(metadata: Record<string, unknown>): string | null {
  return typeof metadata.speaker === "string" ? metadata.speaker : null;
}

/** The input of {@link assignTranscriptSpeaker}: the signed-in user assigns `speaker` of the transcript to a person, or clears it with `personId: null`. */
export interface AssignTranscriptSpeakerInput {
  transcriptId: string;
  speaker: string;
  personId: string | null;
  userId: string;
}

/**
 * Assigns, replaces or clears the person of one speaker key of a transcript (issue #1770) and returns
 * the transcript's speakers as they read afterwards. Runs in the caller's transaction.
 *
 * Lock order is the one the confirm of a speaker card uses: the open card of the key (found by its
 * idempotency key `transcript-speaker-suggestion:<transcriptId>:<speaker>`), then the transcript's item
 * row. The Event participant write takes no Event lock: it is insert-only and carries no invitation, so
 * the participant hook locks nothing (see `assertParticipantEdgeWritable`), and no lock order with the
 * Event exists to follow. A card that a concurrent `proposeSpeakerMappings` created while this call
 * waited for the transcript lock is looked up again once the transcript is locked, and is locked
 * without waiting, because the card comes after the transcript there and waiting could deadlock with a
 * confirm of that card (a busy card answers `409 version_conflict`, retryable). See
 * [[2026-11-12-a-manual-speaker-assignment-settles-the-key-card-in-the-confirm-lock-order]]. With the transcript locked it
 *
 * 1. refuses a key that no segment of the transcript carries (`validation_failed`, reason
 *    `unknownSpeaker`, field `speaker`) and a person who is not a live People item (the not-found error
 *    that an unknown transcript gets);
 * 2. refuses a person who another key of this transcript already maps (`validation_failed`, field
 *    `personId`, reason `personAlreadyMapped`, `speaker` naming the key they hold) and changes nothing;
 * 3. deletes the key's `speakers` edge when it points to another person, or when `personId` is `null`,
 *    and writes the edge to `personId` with the metadata `{ speaker }` through the choke point, so the
 *    edge validation of `transcriptionSpeakerEdges.ts` runs. An edge that already maps the key to
 *    this person is not written again;
 * 4. for a person, adds them to the `people` of the transcript's live linked Event unless they are
 *    on it, whatever the edge stores (`createRelationIfAbsentWithClient`, as the confirm of a speaker card
 *    does). No path of this function removes an Event participant;
 * 5. for a person, settles the open card of the key with `settleSpeakerCardWithClient`. Clearing a key
 *    leaves its card as it is.
 *
 * The person is read without a lock. A person moved to the Trash between that read and the edge write
 * fails the write with `validation_failed`, and nothing of the assignment is kept; an assignment that
 * writes no edge (the key already maps this person) does not check again. Every write is the user's and
 * carries their id, so the edge writes publish their relation invalidations to that user's sockets
 * after the commit.
 */
export async function assignTranscriptSpeaker(
  client: PoolClient,
  input: AssignTranscriptSpeakerInput,
): Promise<TranscriptSpeaker[]> {
  const { transcriptId, speaker, personId, userId } = input;
  const { transcriptsDatabaseId, property, definition } = await requireSpeakersRelation(client);

  const proposals = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
  const findCard = async (): Promise<ItemRow | null> =>
    proposals
      ? itemsStore.findIdempotentReplay(client, proposals.id, speakerSuggestionIdempotencyKey(transcriptId, speaker), {
          requireLive: true,
        })
      : null;
  let card = await findCard();
  if (proposals && card) await itemsStore.lockItemById(client, proposals.id, card.id);

  const transcript = await itemsStore.lockItemById(client, transcriptsDatabaseId, transcriptId);
  if (!transcript || transcript.deletedAt) throw speakerNotFound();
  if (!listSegmentSpeakers(transcript).includes(speaker)) {
    throw new ValidationError(`Speaker '${speaker}' does not occur in transcript ${transcriptId}`, {
      field: "speaker",
      reason: "unknownSpeaker",
    });
  }
  if (personId !== null) await requireLivePerson(client, personId);

  const edges = await listRelationsForItem(client, definition.id, transcriptId);
  const holder = edges.find((edge) => edgeSpeaker(edge.metadata) === speaker);
  const holderPersonId = holder ? otherSide(holder, transcriptId) : null;
  const personEdge = personId === null ? undefined : edges.find((edge) => otherSide(edge, transcriptId) === personId);
  if (personEdge && edgeSpeaker(personEdge.metadata) !== speaker) {
    throw new ValidationError(`Person ${personId} is already mapped to another speaker`, {
      field: "personId",
      reason: "personAlreadyMapped",
      speaker: edgeSpeaker(personEdge.metadata),
    });
  }

  if (holderPersonId !== null && holderPersonId !== personId) {
    await deleteRelationWithClient(
      client,
      { relationPropertyId: property.id, callerItemId: transcriptId, targetItemId: holderPersonId },
      undefined,
      USER_WRITER,
      userId,
    );
  }
  if (personId !== null && holderPersonId !== personId) {
    await createRelationWithClient(
      client,
      { relationPropertyId: property.id, callerItemId: transcriptId, targetItemId: personId, metadata: { speaker } },
      undefined,
      USER_WRITER,
      userId,
    );
  }

  if (personId !== null) {
    await addToEventParticipants(client, transcript, personId, userId);
    if (proposals && !card) {
      // `proposeSpeakerMappings` locks the transcript before it creates the cards, so a card it created while
      // this call waited for the transcript lock was invisible to the first lookup and is visible now.
      card = await findCard();
      if (card) await lockCreatedCard(client, proposals.id, card.id);
    }
    if (proposals && card) {
      await settleSpeakerCardWithClient(
        client,
        { processingProposalsDatabaseId: proposals.id },
        card.id,
        { transcriptId, speaker, personId },
        userId,
      );
    }
  }
  return listTranscriptSpeakers(client, transcriptId);
}

/**
 * Locks a card that was found only after the transcript was locked, which is the reverse of the order a
 * confirm of the card takes. Waiting could deadlock with that confirm, so a card that is busy is answered with a
 * retryable conflict and the whole assignment rolls back.
 */
async function lockCreatedCard(client: PoolClient, proposalsDatabaseId: string, cardId: string): Promise<void> {
  try {
    await itemsStore.lockItemByIdNowait(client, proposalsDatabaseId, cardId);
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "55P03") {
      throw new ConflictError("The speaker's card is busy", { field: "speaker" });
    }
    throw error;
  }
}

/** Throws the not-found error of an assignment unless `personId` is a live People item of the tenant in scope. */
async function requireLivePerson(client: PoolClient, personId: string): Promise<void> {
  const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
  const person = people && (await itemsStore.getItemById(client, people.id, personId));
  if (!person || person.deletedAt) throw speakerNotFound();
}

/** Adds the person to the `people` of the transcript's live linked Event as an attendee without an invitation; a person already on it keeps their edge as it is. */
async function addToEventParticipants(
  client: PoolClient,
  transcript: ItemRow,
  personId: string,
  userId: string,
): Promise<void> {
  const eventId = await readLiveTranscriptEventId(client, transcript.databaseId, transcript.id);
  if (eventId === null) return;
  const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  const people = events && (await getPropertyByKey(client, events.id, EVENT_PEOPLE_PROPERTY_KEY));
  if (!people) throw new NotFoundError(`Relation '${EVENT_PEOPLE_PROPERTY_KEY}' not found on Events`);
  await createRelationIfAbsentWithClient(
    client,
    { relationPropertyId: people.id, callerItemId: eventId, targetItemId: personId },
    undefined,
    USER_WRITER,
    userId,
  );
}

/** One person a client can offer for a speaker of a transcript. */
export interface SpeakerCandidateParticipant {
  personId: string;
  name: string | null;
  /** Always `null`: People has no job title property in v1. */
  title: null;
  relationship: string | null;
  /** The status of the invitation stored on the participant edge, or `null` for a person linked without an invitation. */
  invitationStatus: "pending" | "accepted" | "tentative" | "declined" | null;
  /** The speaker key of this transcript the person is mapped to, or `null`. */
  mappedSpeaker: string | null;
}

export interface SpeakerCandidates {
  participants: SpeakerCandidateParticipant[];
  /** The tenant's own person, or `null` when System settings `selfPerson` names none. */
  self: { personId: string; name: string | null; mappedSpeaker: string | null } | null;
}

/** The text property `key` of a person, or `null` when it is missing or empty. */
function textProperty(person: ItemRow, key: string): string | null {
  const value = person.properties[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The people a client can offer for the speakers of a transcript (issue #1770). `participants` are
 * the live people on the `people` edges of the transcript's live linked Event, in the order
 * `listRelationsForItem` returns the edges (the edges carry no position), without the tenant's own
 * person; a transcript without such an Event has none. Every participant is returned, whether or not they
 * are mapped to a speaker already and whatever their invitation: the server applies no filter, `mappedSpeaker` lets a
 * client hide the mapped ones. `self` is the tenant's own person, mapped or not, or `null`.
 * Throws the not-found error of an assignment for a transcript that is unknown, another tenant's or in the
 * Trash.
 */
export async function listSpeakerCandidates(client: PoolClient, transcriptId: string): Promise<SpeakerCandidates> {
  const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  const transcript = transcripts && (await itemsStore.getItemById(client, transcripts.id, transcriptId));
  if (!transcript || transcript.deletedAt) throw speakerNotFound();

  const speakers = await listTranscriptSpeakers(client, transcript.id, transcript);
  const mappedSpeakerOf = new Map(
    speakers.flatMap((entry) => (entry.person ? [[entry.person.id, entry.speaker]] : [])),
  );
  const ownPersonId = await getSelfPersonId(client);

  const participants: SpeakerCandidateParticipant[] = [];
  const eventId = await readLiveTranscriptEventId(client, transcript.databaseId, transcript.id);
  const events = eventId === null ? null : await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  const peopleProperty = events && (await getPropertyByKey(client, events.id, EVENT_PEOPLE_PROPERTY_KEY));
  const peopleDefinition = peopleProperty && (await getRelationDefinitionByPropertyId(client, peopleProperty.id));
  if (eventId !== null && peopleDefinition) {
    const edges = await listRelationsForItem(client, peopleDefinition.id, eventId);
    const persons = new Map(
      (
        await itemsStore.getItemsByIds(
          client,
          edges.map((edge) => otherSide(edge, eventId)),
        )
      ).map((person) => [person.id, person]),
    );
    for (const edge of edges) {
      const person = persons.get(otherSide(edge, eventId));
      if (!person || person.id === ownPersonId) continue;
      participants.push({
        personId: person.id,
        name: textProperty(person, "name"),
        title: null,
        relationship: textProperty(person, "relationship"),
        invitationStatus: readEventParticipantMetadata(edge.metadata).invitation?.status ?? null,
        mappedSpeaker: mappedSpeakerOf.get(person.id) ?? null,
      });
    }
  }

  const [self] = ownPersonId === null ? [] : await itemsStore.getItemsByIds(client, [ownPersonId]);
  return {
    participants,
    self: self
      ? { personId: self.id, name: textProperty(self, "name"), mappedSpeaker: mappedSpeakerOf.get(self.id) ?? null }
      : null,
  };
}
