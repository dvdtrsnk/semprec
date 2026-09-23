import type { PoolClient } from "pg";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient, createRelationWithClient } from "../chokePoint/chokePoint.js";
import { appendHistoryEntry, assertValidProposalEnvelope, type ProposalEnvelope } from "../inbox/inboxTickAction.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { EVENTS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { NotFoundError } from "../errors.js";
import { PROCESSING_PROPOSALS_RELATION_CONTEXT } from "./transcriptEventMatch.js";
import { listTranscriptSpeakers, TRANSCRIPT_SPEAKERS_PROPERTY_KEY } from "./transcriptionSpeakerEdges.js";

/** A participant of the transcript's Event a speaker key may be proposed for. */
export interface SpeakerSuggestionCandidate {
  id: string;
  name: string;
}

/** What the speaker-suggestion step asks the model about: the still-unmapped keys and the not-yet-mapped participants. */
export interface SpeakerSuggestionContext {
  unmappedSpeakers: string[];
  candidates: SpeakerSuggestionCandidate[];
}

export interface SpeakerMappingSuggestion {
  speaker: string;
  personId: string;
}

async function requireDatabaseId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await getDatabaseByModuleId(client, moduleId);
  if (!database) throw new NotFoundError(`Database for module '${moduleId}' not found`);
  return database.id;
}

async function requireRelationDefinitionId(client: PoolClient, databaseId: string, key: string): Promise<string> {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
  if (!property) throw new NotFoundError(`Property '${key}' not found on database ${databaseId}`);
  const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
  if (!relationDefinition) throw new NotFoundError(`Relation definition for property '${key}' not found`);
  return relationDefinition.id;
}

/** The idempotency key of the one card proposing a mapping for `speaker`: a re-run never proposes the same key twice. */
function speakerSuggestionIdempotencyKey(transcriptId: string, speaker: string): string {
  return `transcript-speaker-suggestion:${transcriptId}:${speaker}`;
}

/**
 * What a speaker-mapping suggestion for this transcript could be about (issue #185), or `null`
 * when there is nothing to ask: the transcript has no linked Event, the Event has no named
 * participant who is not already mapped, or every speaker key is already mapped. Candidates are
 * the Event's `people` only — never anyone else in People — and a participant without a name is
 * left out, since nothing in the transcript can address them.
 */
export async function readSpeakerSuggestionContext(
  client: PoolClient,
  transcriptId: string,
): Promise<SpeakerSuggestionContext | null> {
  const speakers = await listTranscriptSpeakers(client, transcriptId);
  const unmappedSpeakers = speakers.filter((entry) => entry.person === null).map((entry) => entry.speaker);
  if (unmappedSpeakers.length === 0) return null;
  const mappedPersonIds = new Set(speakers.flatMap((entry) => (entry.person ? [entry.person.id] : [])));

  const transcriptsDatabaseId = await requireDatabaseId(client, TRANSCRIPTS_MODULE_ID);
  const eventRelationId = await requireRelationDefinitionId(client, transcriptsDatabaseId, "event");
  const [eventEdge] = await relationsStore.listRelationsForItem(client, eventRelationId, transcriptId);
  if (!eventEdge) return null;
  const eventId = relationsStore.otherSide(eventEdge, transcriptId);

  const eventsDatabaseId = await requireDatabaseId(client, EVENTS_MODULE_ID);
  const peopleRelationId = await requireRelationDefinitionId(client, eventsDatabaseId, "people");
  const participantEdges = await relationsStore.listRelationsForItem(client, peopleRelationId, eventId);
  const participants = await itemsStore.getItemsByIds(
    client,
    participantEdges.map((edge) => relationsStore.otherSide(edge, eventId)),
  );
  const candidates = participants.flatMap((person) => {
    const name = person.properties.name;
    return typeof name === "string" && name.length > 0 && !mappedPersonIds.has(person.id)
      ? [{ id: person.id, name }]
      : [];
  });
  if (candidates.length === 0) return null;
  return { unmappedSpeakers, candidates };
}

/**
 * Creates one `kind = 'transcript'` Processing proposal card per suggested mapping (issue #185):
 * a `'relation'` envelope linking the transcript to the person through `speakers` with
 * `{ speaker }` as the edge metadata, plus the card's `sourceTranscript` edge. No mapping is
 * written — it exists only once a human confirms the card. Row-locks the transcript and re-reads
 * the suggestion context inside the caller's transaction, so a suggestion is dropped when its key
 * or person was mapped, or its person stopped being a participant, since the model was asked; a
 * key or person suggested twice keeps its first suggestion. A key that already has a card (from an
 * earlier run, whatever that card's status) gets no second one. Returns the keys that got a card.
 */
export async function proposeSpeakerMappings(
  client: PoolClient,
  input: { transcriptId: string; suggestions: readonly SpeakerMappingSuggestion[] },
): Promise<string[]> {
  const transcriptsDatabaseId = await requireDatabaseId(client, TRANSCRIPTS_MODULE_ID);
  const transcript = await itemsStore.lockItemById(client, transcriptsDatabaseId, input.transcriptId);
  if (!transcript || transcript.deletedAt) {
    throw new NotFoundError(`Transcripts item '${input.transcriptId}' not found`, {
      resource: "item",
      itemId: input.transcriptId,
    });
  }
  const context = await readSpeakerSuggestionContext(client, input.transcriptId);
  if (!context) return [];

  const processingProposalsDatabaseId = await requireDatabaseId(client, PROCESSING_PROPOSALS_MODULE_ID);
  const sourceTranscriptProperty = await propertiesStore.getPropertyByKey(
    client,
    processingProposalsDatabaseId,
    "sourceTranscript",
  );
  if (!sourceTranscriptProperty)
    throw new NotFoundError(`Property 'sourceTranscript' not found on Processing proposals`);

  const candidateIds = new Set(context.candidates.map((candidate) => candidate.id));
  const openSpeakers = new Set(context.unmappedSpeakers);
  const proposed: string[] = [];
  for (const suggestion of input.suggestions) {
    if (!openSpeakers.has(suggestion.speaker) || !candidateIds.has(suggestion.personId)) continue;
    openSpeakers.delete(suggestion.speaker);
    candidateIds.delete(suggestion.personId);

    const idempotencyKey = speakerSuggestionIdempotencyKey(input.transcriptId, suggestion.speaker);
    if (await itemsStore.findIdempotentReplay(client, processingProposalsDatabaseId, idempotencyKey)) continue;

    const envelope: ProposalEnvelope = {
      entityKind: "relation",
      target: suggestion.personId,
      properties: { propertyKey: TRANSCRIPT_SPEAKERS_PROPERTY_KEY, metadata: { speaker: suggestion.speaker } },
    };
    await assertValidProposalEnvelope(client, envelope);
    const card = await createItemWithClient(
      client,
      {
        databaseId: processingProposalsDatabaseId,
        idempotencyKey,
        properties: {
          kind: "transcript",
          proposal: envelope,
          history: appendHistoryEntry(
            [],
            `Suggested from the linked Event's participants and how they are addressed in the transcript.`,
          ),
          status: "proposed",
        },
      },
      { allowedSystemKeys: ["kind", "proposal", "history", "status"] },
    );
    await createRelationWithClient(
      client,
      { relationPropertyId: sourceTranscriptProperty.id, callerItemId: card.id, targetItemId: input.transcriptId },
      PROCESSING_PROPOSALS_RELATION_CONTEXT,
    );
    proposed.push(suggestion.speaker);
  }
  return proposed;
}
