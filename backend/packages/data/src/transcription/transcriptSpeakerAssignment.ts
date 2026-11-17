// A user assigns, replaces or clears the person of one speaker key of a transcript in one
// transaction, settling the Inbox card that asks who the speaker is; and the people a client can
// offer for a speaker.
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

const USER_WRITER: WriterIdentity = { writerKind: "user" };

/** One error for unknown, other-tenant and trashed transcripts and unknown or foreign people, so none is distinguishable. */
function speakerNotFound(): NotFoundError {
  return new NotFoundError("Transcript or person not found", { resource: "transcriptSpeaker" });
}

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

/** `null` for an edge whose metadata names none. */
function edgeSpeaker(metadata: Record<string, unknown>): string | null {
  return typeof metadata.speaker === "string" ? metadata.speaker : null;
}

/** `personId: null` clears the key. */
export interface AssignTranscriptSpeakerInput {
  transcriptId: string;
  speaker: string;
  personId: string | null;
  userId: string;
}

/**
 * Runs in the caller's transaction; returns the transcript's speakers afterwards.
 *
 * Lock order is the speaker-card confirm's: the key's open card, then the transcript row. The Event
 * participant write is insert-only with no invitation, so it takes no Event lock. A card that
 * `proposeSpeakerMappings` created while this call waited for the transcript lock is found again
 * afterwards and locked without waiting (there the card follows the transcript, so waiting could
 * deadlock with its confirm; a busy card answers a retryable `409 version_conflict`).
 *
 * Refuses a key no segment carries (`unknownSpeaker`), a non-live person, and a person another key
 * already maps (`personAlreadyMapped`). For a person it also adds them to the live linked Event's
 * `people` if absent and settles the key's open card; clearing leaves the card. The person is read
 * without a lock: one trashed before the edge write fails it and rolls the assignment back.
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
      // `proposeSpeakerMappings` locks the transcript before creating cards, so a card it created while
      // this call waited was invisible to the first lookup.
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
 * Found only after the transcript lock, the reverse of the confirm's order: waiting could deadlock,
 * so a busy card is a retryable conflict and the whole assignment rolls back.
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

async function requireLivePerson(client: PoolClient, personId: string): Promise<void> {
  const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
  const person = people && (await itemsStore.getItemById(client, people.id, personId));
  if (!person || person.deletedAt) throw speakerNotFound();
}

/** As an attendee without an invitation; an existing edge is kept as it is. */
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

export interface SpeakerCandidateParticipant {
  personId: string;
  name: string | null;
  /** People has no job title property yet. */
  title: null;
  relationship: string | null;
  /** `null` for a person linked without an invitation. */
  invitationStatus: "pending" | "accepted" | "tentative" | "declined" | null;
  mappedSpeaker: string | null;
}

export interface SpeakerCandidates {
  participants: SpeakerCandidateParticipant[];
  /** `null` when System settings `selfPerson` names none. */
  self: { personId: string; name: string | null; mappedSpeaker: string | null } | null;
}

/** `null` when missing or empty. */
function textProperty(person: ItemRow, key: string): string | null {
  const value = person.properties[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `participants`: the live people on the live linked Event's `people` edges, in edge order, without
 * the tenant's own person. No filter on mapping or invitation: `mappedSpeaker` lets a client hide
 * mapped ones. Throws the assignment's not-found error for an unknown, other-tenant or trashed
 * transcript.
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
