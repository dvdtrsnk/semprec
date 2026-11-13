import type { PoolClient } from "pg";
import { z } from "zod";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import {
  transcriptSpeakerCardContextSchema,
  type TranscriptSpeakerCardContext,
} from "./transcriptSpeakerCardContext.js";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { getSelfPersonId } from "../selfPerson.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { aiProposalPatch, assertValidProposalEnvelope, type ProposalEnvelope } from "../inbox/inboxTickAction.js";
import { publishInboxCardChange } from "../inbox/inboxCardsRealtime.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { EVENTS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { NotFoundError } from "../errors.js";
import { PROCESSING_PROPOSALS_RELATION_CONTEXT } from "./transcriptEventMatch.js";
import { listTranscriptSpeakers, TRANSCRIPT_SPEAKERS_PROPERTY_KEY } from "./transcriptionSpeakerEdges.js";

/** A participant of the transcript's Event a speaker key may be proposed for. */
export interface SpeakerSuggestionCandidate {
  id: string;
  name: string;
  title: string | null;
  invitationStatus: TranscriptSpeakerCardContext["alternatives"][number]["invitationStatus"];
}

/** What the speaker-suggestion step asks the model about: the still-unmapped keys and the not-yet-mapped participants. */
export interface SpeakerSuggestionContext {
  unmappedSpeakers: string[];
  locale: string;
  candidates: SpeakerSuggestionCandidate[];
  details: Array<{
    speaker: string;
    ordinal: number;
    quotes: TranscriptSpeakerCardContext["quotes"];
    firstStartsAt: number;
  }>;
  source: TranscriptSpeakerCardContext["source"];
}

export interface SpeakerMappingSuggestion {
  speaker: string;
  personId: string | null;
  reason: string;
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
export function speakerSuggestionIdempotencyKey(transcriptId: string, speaker: string): string {
  return `transcript-speaker-suggestion:${transcriptId}:${speaker}`;
}

/** Reads unmapped speakers, eligible participants and the tenant's own person. */
export async function readSpeakerSuggestionContext(
  client: PoolClient,
  transcriptId: string,
): Promise<SpeakerSuggestionContext | null> {
  const transcriptsDatabaseId = await requireDatabaseId(client, TRANSCRIPTS_MODULE_ID);
  const transcript = await itemsStore.getItemById(client, transcriptsDatabaseId, transcriptId);
  if (!transcript || transcript.deletedAt) throw new NotFoundError("Transcript not found");
  const segments = z
    .array(z.object({ speaker: z.string(), text: z.string(), startsAt: z.number(), endsAt: z.number() }))
    .parse(transcript.computed.segments ?? []);
  const properties = z.object({ name: z.string().nullish(), date: z.string().nullish() }).parse(transcript.properties);
  const speakers = await listTranscriptSpeakers(client, transcriptId, transcript);
  const unmapped = speakers.filter((entry) => entry.person === null);
  if (unmapped.length === 0) return null;
  const mappedPersonIds = new Set(speakers.flatMap((entry) => (entry.person ? [entry.person.id] : [])));
  const eventRelationId = await requireRelationDefinitionId(client, transcriptsDatabaseId, "event");
  const [eventEdge] = await relationsStore.listRelationsForItem(client, eventRelationId, transcriptId);
  const linkedEventId = eventEdge ? relationsStore.otherSide(eventEdge, transcriptId) : null;
  const event = linkedEventId
    ? await itemsStore.getItemById(client, await requireDatabaseId(client, EVENTS_MODULE_ID), linkedEventId)
    : null;
  const eventId = event && !event.deletedAt ? event.id : null;
  const participantEdges =
    eventId === null
      ? []
      : await relationsStore.listRelationsForItem(
          client,
          await requireRelationDefinitionId(client, await requireDatabaseId(client, EVENTS_MODULE_ID), "people"),
          eventId,
        );
  const invitation = z.object({
    invitation: z.object({ status: z.enum(["pending", "accepted", "tentative", "declined"]) }),
  });
  const statuses = new Map<string, SpeakerSuggestionCandidate["invitationStatus"]>();
  if (eventId !== null)
    for (const edge of participantEdges) {
      const parsed = invitation.safeParse(edge.metadata);
      statuses.set(relationsStore.otherSide(edge, eventId), parsed.success ? parsed.data.invitation.status : null);
    }
  const ownPersonId = await getSelfPersonId(client);
  const ids = new Set(statuses.keys());
  if (ownPersonId) ids.add(ownPersonId);
  const participants = await itemsStore.getItemsByIds(client, [...ids]);
  const candidates = participants.flatMap((person) => {
    const rawName = person.properties.name;
    const name = typeof rawName === "string" ? rawName : "";
    if (mappedPersonIds.has(person.id) || (person.id !== ownPersonId && name.length === 0)) return [];
    return [
      {
        id: person.id,
        name,
        title: null,
        invitationStatus: statuses.get(person.id) ?? null,
      },
    ];
  });
  const details = unmapped.map(({ speaker, ordinal }) => {
    const utterances = segments.flatMap((segment, segmentIndex) =>
      segment.speaker === speaker ? [{ ...segment, segmentIndex }] : [],
    );
    const first = utterances[0];
    if (!first) throw new Error("Speaker has no segment");
    const quotes = utterances
      .filter((segment) => segment.text.trim().split(/\s+/).filter(Boolean).length >= 6)
      .sort((a, b) => b.text.length - a.text.length || a.segmentIndex - b.segmentIndex)
      .slice(0, 3)
      .sort((a, b) => a.segmentIndex - b.segmentIndex)
      .map(({ segmentIndex, text }) => ({ segmentIndex, text: text.slice(0, 140) }));
    return { speaker, ordinal, firstStartsAt: first.startsAt, quotes };
  });
  return {
    unmappedSpeakers: unmapped.map((entry) => entry.speaker),
    candidates,
    details,
    source: { transcriptName: properties.name ?? null, date: properties.date ?? null },
    locale: (await getTenantUserLocale(client)) ?? "cs",
  };
}

/**
 * Creates a card for every still-unmapped speaker. Eligible model matches become relation
 * proposals; missing, repeated or no-longer-eligible matches become clarification cards.
 * The source transcript is locked and eligibility is re-read in the supplied transaction.
 * Existing idempotency keys suppress duplicate cards, regardless of their status. No speaker
 * mapping is written until a user confirms a proposal.
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
  const catalogs = await loadModuleCatalogs(import.meta.url);
  const fallback = (key: string) =>
    resolveCatalogLabel(null, catalogs[toManifestLocale(context.locale)], catalogs.en, key);
  const proposed: string[] = [];
  for (const detail of context.details) {
    const idempotencyKey = speakerSuggestionIdempotencyKey(input.transcriptId, detail.speaker);
    if (await itemsStore.findIdempotentReplay(client, processingProposalsDatabaseId, idempotencyKey)) continue;
    const suggestion = input.suggestions.find((entry) => entry.speaker === detail.speaker);
    const personId = suggestion?.personId && candidateIds.has(suggestion.personId) ? suggestion.personId : null;
    const reason =
      personId && suggestion?.reason.trim()
        ? suggestion.reason
        : fallback(
            context.candidates.length === 0
              ? "transcript.speaker.noCandidatesReason"
              : "transcript.speaker.uncertainReason",
          );
    if (personId) candidateIds.delete(personId);
    const envelope: ProposalEnvelope | null = personId
      ? {
          entityKind: "relation",
          target: personId,
          properties: { propertyKey: TRANSCRIPT_SPEAKERS_PROPERTY_KEY, metadata: { speaker: detail.speaker } },
        }
      : null;
    if (envelope) await assertValidProposalEnvelope(client, envelope);
    const cardContext = transcriptSpeakerCardContextSchema.parse({
      role: "speaker",
      ...detail,
      source: context.source,
      reason,
      alternatives: context.candidates.map((candidate) => ({
        personId: candidate.id,
        name: candidate.name,
        title: candidate.title,
        invitationStatus: candidate.invitationStatus,
      })),
    });
    const card = await createItemWithClient(
      client,
      {
        databaseId: processingProposalsDatabaseId,
        idempotencyKey,
        properties: {
          kind: "transcript",
          proposal: envelope,
          ...aiProposalPatch({}, envelope),
          context: cardContext,
          status: envelope ? "proposed" : "needsClarification",
        },
      },
      { allowedSystemKeys: ["kind", "proposal", "aiProposal", "aiVersion", "context", "status"] },
    );
    await createRelationWithClient(
      client,
      { relationPropertyId: sourceTranscriptProperty.id, callerItemId: card.id, targetItemId: input.transcriptId },
      PROCESSING_PROPOSALS_RELATION_CONTEXT,
    );
    publishInboxCardChange(client, card.id, "created");
    proposed.push(detail.speaker);
  }
  return proposed;
}
