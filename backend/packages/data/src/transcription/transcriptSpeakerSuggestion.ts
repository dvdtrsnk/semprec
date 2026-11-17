import { isDeepStrictEqual } from "node:util";
import { DatabaseError, type PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { tenantLane } from "../tenancy/tenantLane.js";
import type { RelationEdgeChangedHook } from "../chokePoint/hooks.js";
import { appendHistoryEntry } from "../inbox/proposalHistory.js";
import { readTranscriptionSourceFileItemId } from "./transcriptionJob.js";
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
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { aiProposalPatch, assertValidProposalEnvelope, type ProposalEnvelope } from "../inbox/inboxTickAction.js";
import { publishInboxCardChange } from "../inbox/inboxCardsRealtime.js";
import { referencedItemIdsOf } from "../inbox/proposalReferences.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { EVENTS_MODULE_ID, FILES_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { NotFoundError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { PROCESSING_PROPOSALS_RELATION_CONTEXT } from "./transcriptEventMatch.js";
import { listTranscriptSpeakers, TRANSCRIPT_SPEAKERS_PROPERTY_KEY } from "./transcriptionSpeakerEdges.js";

export interface SpeakerSuggestionCandidate {
  id: string;
  name: string;
  title: string | null;
  invitationStatus: TranscriptSpeakerCardContext["alternatives"][number]["invitationStatus"];
}

export interface SpeakerSuggestionContext {
  /** `null` without a live Event; with `candidates` it is what a suggestion is asked for (`speakerSuggestionBinding`). */
  eventId: string | null;
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

/** A re-run never proposes the same key twice. */
export function speakerSuggestionIdempotencyKey(transcriptId: string, speaker: string): string {
  return `transcript-speaker-suggestion:${transcriptId}:${speaker}`;
}

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
    eventId,
    unmappedSpeakers: unmapped.map((entry) => entry.speaker),
    candidates,
    details,
    source: { transcriptName: properties.name ?? null, date: properties.date ?? null },
    locale: (await getTenantUserLocale(client)) ?? "cs",
  };
}

/** An unreadable history counts as touched too. */
function historyHasUserEntry(history: unknown): boolean {
  if (history === undefined || history === null) return false;
  const parsed = z.array(z.looseObject({ author: z.string() })).safeParse(history);
  return !parsed.success || parsed.data.some((entry) => entry.author === "user");
}

/**
 * Refreshes an untouched `needsClarification` speaker card with what the Event offers now (context,
 * and on a confident answer the proposal, `aiVersion` + 1 and status `proposed`), with one `recompute`
 * history entry; nothing is written when nothing changed. The card is taken with `NOWAIT` after the
 * transcript the caller holds: a confirm locks card then transcript, so waiting could deadlock. A busy,
 * gone, trashed, settled or user-touched card is left as it is. Returns whether it wrote.
 */
async function refreshClarificationCard(
  client: PoolClient,
  card: ItemRow,
  cardContext: TranscriptSpeakerCardContext,
  envelope: ProposalEnvelope | null,
): Promise<boolean> {
  await client.query("SAVEPOINT speaker_card_refresh");
  let locked: ItemRow | null;
  try {
    locked = await itemsStore.lockItemByIdNowait(client, card.databaseId, card.id);
    await client.query("RELEASE SAVEPOINT speaker_card_refresh");
  } catch (error) {
    if (!(error instanceof DatabaseError) || error.code !== "55P03") throw error;
    await client.query("ROLLBACK TO SAVEPOINT speaker_card_refresh");
    await client.query("RELEASE SAVEPOINT speaker_card_refresh");
    return false;
  }
  if (
    !locked ||
    locked.deletedAt !== null ||
    locked.properties.status !== "needsClarification" ||
    historyHasUserEntry(locked.properties.history) ||
    (envelope === null && isDeepStrictEqual(locked.properties.context, cardContext))
  )
    return false;
  await updateItemWithClient(
    client,
    {
      databaseId: locked.databaseId,
      itemId: locked.id,
      propertiesPatch: {
        context: cardContext,
        ...(envelope
          ? {
              proposal: envelope,
              ...aiProposalPatch(locked.properties, envelope),
              referencedItemIds: referencedItemIdsOf(envelope),
              status: "proposed",
            }
          : {}),
        history: appendHistoryEntry(
          locked.properties.history,
          "Refreshed with the Event's current participants.",
          "ai",
          { kind: "recompute" },
        ),
      },
    },
    { allowedSystemKeys: ["context", "proposal", "aiProposal", "aiVersion", "referencedItemIds", "status", "history"] },
  );
  publishInboxCardChange(client, locked.id, "updated");
  return true;
}

/**
 * Creates a card for every still-unmapped speaker: eligible matches become relation proposals, the
 * rest clarification cards. Locks the source transcript and re-reads eligibility in the transaction.
 * Existing idempotency keys suppress duplicates whatever their status; an untouched
 * `needsClarification` card is refreshed instead. Returns the keys that got a new card. No speaker
 * mapping is written until a user confirms.
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
    const existing = await itemsStore.findIdempotentReplay(client, processingProposalsDatabaseId, idempotencyKey);
    if (existing && (existing.deletedAt !== null || existing.properties.status !== "needsClarification")) continue;
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
    if (existing) {
      await refreshClarificationCard(client, existing, cardContext, envelope);
      continue;
    }
    const card = await createItemWithClient(
      client,
      {
        databaseId: processingProposalsDatabaseId,
        idempotencyKey,
        properties: {
          kind: "transcript",
          proposal: envelope,
          ...aiProposalPatch({}, envelope),
          referencedItemIds: referencedItemIdsOf(envelope),
          context: cardContext,
          status: envelope ? "proposed" : "needsClarification",
        },
      },
      {
        allowedSystemKeys: ["kind", "proposal", "aiProposal", "aiVersion", "referencedItemIds", "context", "status"],
      },
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

/**
 * The `suggestSpeakers` checkpoint on the source Files item: keys that got a card and the binding the
 * suggestion was asked for. A checkpoint written before the binding existed has neither field.
 */
export const speakerSuggestionCheckpointSchema = z.object({
  proposedSpeakers: z.array(z.string()),
  eventId: z.string().nullable().optional(),
  candidateIds: z.array(z.string()).optional(),
});

/** The transcript's live Event and the sorted ids of the people it may map to. */
export function speakerSuggestionBinding(context: Pick<SpeakerSuggestionContext, "eventId" | "candidates">) {
  return { eventId: context.eventId, candidateIds: context.candidates.map((candidate) => candidate.id).sort() };
}

/** A missing, binding-less or unreadable checkpoint counts as different, so the model is asked again. */
export function isSpeakerSuggestionCurrent(
  checkpoint: unknown,
  context: Pick<SpeakerSuggestionContext, "eventId" | "candidates">,
): boolean {
  const parsed = speakerSuggestionCheckpointSchema.safeParse(checkpoint);
  if (!parsed.success || parsed.data.eventId === undefined || parsed.data.candidateIds === undefined) return false;
  const binding = speakerSuggestionBinding(context);
  return parsed.data.eventId === binding.eventId && isDeepStrictEqual(parsed.data.candidateIds, binding.candidateIds);
}

/** Keys accumulate across runs: this run's and the earlier checkpoint's. */
export function buildSpeakerSuggestionCheckpoint(
  context: Pick<SpeakerSuggestionContext, "eventId" | "candidates">,
  previous: unknown,
  created: readonly string[],
): z.infer<typeof speakerSuggestionCheckpointSchema> {
  const earlier = speakerSuggestionCheckpointSchema.safeParse(previous);
  const proposedSpeakers = [...new Set([...(earlier.success ? earlier.data.proposedSpeakers : []), ...created])];
  return { proposedSpeakers, ...speakerSuggestionBinding(context) };
}

export const transcriptSpeakerSuggestionPayloadSchema = z.object({ transcriptId: z.uuid() });
export type TranscriptSpeakerSuggestionPayload = z.infer<typeof transcriptSpeakerSuggestionPayloadSchema>;

/** One job per transcript: many edge writes in a short time converge onto one run. */
export function transcriptSpeakerSuggestionJobKey(transcriptId: string): string {
  return `transcript-speaker-suggestion:${transcriptId}`;
}

export async function enqueueTranscriptSpeakerSuggestion(
  client: PoolClient,
  input: TranscriptSpeakerSuggestionPayload,
): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.TRANSCRIPT_SPEAKER_SUGGESTION,
    { transcriptId: input.transcriptId },
    {
      jobKey: transcriptSpeakerSuggestionJobKey(input.transcriptId),
      maxAttempts: 3,
      queueName: tenantLane("transcript-speaker-suggestion"),
    },
  );
}

const edgeKindRowSchema = z.object({
  transcripts_database_id: z.string().nullable(),
  events_database_id: z.string().nullable(),
});

/**
 * Re-asks the speakers when the suggestion's binding may have changed: a created or deleted Transcripts
 * `event` edge (that transcript) or Events `people` edge (every live transcript of that Event). Enqueues
 * in the writing transaction; ignores updates, other relations and trashed transcripts. This hook
 * never runs for the dry-run validation, so revising an unconfirmed card enqueues nothing.
 */
export const transcriptSpeakerSuggestionEdgeChangedHook: RelationEdgeChangedHook = async (context) => {
  if (context.op === "update") return;
  const { client } = context;
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT
       (array_agg(d.id) FILTER (WHERE p.key = 'event' AND d.owner_module_id = $2))[1] AS transcripts_database_id,
       (array_agg(d.id) FILTER (WHERE p.key = 'people' AND d.owner_module_id = $3))[1] AS events_database_id
     FROM relation_definitions rd
     JOIN properties p ON p.id IN (rd.property_id_a, rd.property_id_b)
     JOIN databases d ON d.id = p.database_id AND d.system
     WHERE rd.id = $1`,
    [context.relationDefinitionId, TRANSCRIPTS_MODULE_ID, EVENTS_MODULE_ID],
  );
  const kind = edgeKindRowSchema.parse(rows[0]);
  const sides = [context.itemA, context.itemB];
  let transcriptIds: string[] = [];
  if (kind.transcripts_database_id !== null) {
    const transcripts = await itemsStore.getItemsByIdsInDatabaseIncludingDeleted(
      client,
      kind.transcripts_database_id,
      sides,
    );
    transcriptIds = transcripts
      .filter((transcript) => transcript.deletedAt === null)
      .map((transcript) => transcript.id);
  } else if (kind.events_database_id !== null) {
    const transcriptsDatabase = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
    const property =
      transcriptsDatabase && (await propertiesStore.getPropertyByKey(client, transcriptsDatabase.id, "event"));
    const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
    if (!definition) return;
    const events = await itemsStore.getItemsByIdsInDatabaseIncludingDeleted(client, kind.events_database_id, sides);
    for (const event of events.filter((candidate) => candidate.deletedAt === null)) {
      const edges = await relationsStore.listRelationsForItem(client, definition.id, event.id);
      const linked = await itemsStore.getItemsByIds(
        client,
        edges.map((edge) => relationsStore.otherSide(edge, event.id)),
      );
      transcriptIds.push(...linked.map((transcript) => transcript.id));
    }
  }
  for (const transcriptId of [...new Set(transcriptIds)].sort())
    await enqueueTranscriptSpeakerSuggestion(client, { transcriptId });
};

/** `null` for a transcript that is gone, trashed or has no source link; the task then has nothing to ask. */
export async function readSpeakerSuggestionSource(
  client: PoolClient,
  transcriptId: string,
): Promise<{ transcriptsDatabaseId: string; filesDatabaseId: string; fileItemId: string } | null> {
  const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  const files = await getDatabaseByModuleId(client, FILES_MODULE_ID);
  if (!transcripts || !files) throw new NotFoundError("Transcripts or Files database not found");
  const transcript = await itemsStore.getItemById(client, transcripts.id, transcriptId);
  if (!transcript || transcript.deletedAt) return null;
  const fileItemId = readTranscriptionSourceFileItemId(transcript.properties.link);
  return fileItemId === null ? null : { transcriptsDatabaseId: transcripts.id, filesDatabaseId: files.id, fileItemId };
}
