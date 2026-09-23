import type { PoolClient } from "pg";
import { z } from "zod";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow, PropertyRow } from "../types.js";
import { TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { TRANSCRIPT_SEGMENTS_COMPUTED_KEY } from "./transcriptionComputedKeys.js";

/** The Transcripts -> People relation property whose edges map a diarization speaker key to a person. */
export const TRANSCRIPT_SPEAKERS_PROPERTY_KEY = "speakers";

/** A `speakers` edge's metadata: exactly the diarization key (`SPEAKER_00`, ...) this person is the voice of. */
const speakerEdgeMetadataSchema = z.object({ speaker: z.string().min(1) }).strict();

/** Only the key each merged segment carries; the rest of the segment is not read here. */
const segmentSpeakersSchema = z.array(z.object({ speaker: z.string() }));

/**
 * The distinct speaker keys of a transcript's `computed.segments`, in order of first appearance —
 * none before the pipeline's merge step has written them. `segments` is written once and never
 * rewritten, so this order (and every ordinal derived from it) never changes with the mappings.
 */
export function listSegmentSpeakers(transcript: ItemRow): string[] {
  const raw = transcript.computed[TRANSCRIPT_SEGMENTS_COMPUTED_KEY];
  if (raw === undefined) return [];
  return [...new Set(segmentSpeakersSchema.parse(raw).map((segment) => segment.speaker))];
}

/** Whether `property` is the Transcripts `speakers` relation, the one relation whose edge metadata has a required shape. */
export async function isTranscriptSpeakersProperty(client: PoolClient, property: PropertyRow): Promise<boolean> {
  if (property.key !== TRANSCRIPT_SPEAKERS_PROPERTY_KEY) return false;
  const database = await databasesStore.getDatabase(client, property.databaseId);
  return database?.ownerModuleId === TRANSCRIPTS_MODULE_ID;
}

export interface SpeakerEdgeWriteInput {
  relationDefinitionId: string;
  transcriptsDatabaseId: string;
  transcriptId: string;
  personId: string;
  metadata: Record<string, unknown> | undefined;
}

/**
 * Rejects a `speakers` edge write (add, or replace of an existing edge's metadata) that would not
 * map exactly one of the transcript's own speaker keys to exactly one person: metadata other than
 * `{ speaker }`, a key that no segment of the transcript carries (including every key before the
 * merge step has run), or a key another person is already mapped to — replacing that mapping means
 * removing the other person's edge first. Row-locks the transcript, so two concurrent writes for
 * the same key serialize and the second sees the first's edge. Every rejection is
 * `validation_failed` on `metadata`.
 */
export async function assertSpeakerEdgeWritable(client: PoolClient, input: SpeakerEdgeWriteInput): Promise<void> {
  const parsed = speakerEdgeMetadataSchema.safeParse(input.metadata ?? {});
  if (!parsed.success) {
    throw new ValidationError("A speakers edge's metadata must be exactly { speaker } with a non-empty speaker", {
      field: "metadata",
    });
  }
  const { speaker } = parsed.data;

  const transcript = await itemsStore.lockItemById(client, input.transcriptsDatabaseId, input.transcriptId);
  if (!transcript || transcript.deletedAt) {
    throw new NotFoundError(`Transcripts item '${input.transcriptId}' not found`, {
      resource: "item",
      itemId: input.transcriptId,
    });
  }
  if (!listSegmentSpeakers(transcript).includes(speaker)) {
    throw new ValidationError(`Speaker '${speaker}' does not occur in transcript ${input.transcriptId}`, {
      field: "metadata",
      reason: "unknownSpeaker",
    });
  }

  const edges = await relationsStore.listRelationsForItem(client, input.relationDefinitionId, input.transcriptId);
  const holder = edges.find(
    (edge) =>
      edge.metadata.speaker === speaker && relationsStore.otherSide(edge, input.transcriptId) !== input.personId,
  );
  if (holder) {
    throw new ValidationError(`Speaker '${speaker}' is already mapped to another person`, {
      field: "metadata",
      reason: "speakerAlreadyMapped",
      personId: relationsStore.otherSide(holder, input.transcriptId),
    });
  }
}

/** One speaker key of a transcript as it is shown: its 1-based ordinal for the "Speaker N" label, and the person it is mapped to, if any. */
export interface TranscriptSpeaker {
  speaker: string;
  ordinal: number;
  person: { id: string; name: string | null } | null;
}

/**
 * Every speaker key of a transcript's segments, each with the live person its `speakers` edge maps
 * it to, or `null` when it is unmapped — a normal state, not an error. The segments themselves are
 * only read: who spoke is composed here, at read time, from the edges. An edge to a person who has
 * since been deleted leaves its key unmapped.
 */
export async function listTranscriptSpeakers(client: PoolClient, transcriptId: string): Promise<TranscriptSpeaker[]> {
  const transcripts = await databasesStore.getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  if (!transcripts) throw new NotFoundError(`Database for module '${TRANSCRIPTS_MODULE_ID}' not found`);
  const transcript = await itemsStore.getItemById(client, transcripts.id, transcriptId);
  if (!transcript || transcript.deletedAt) {
    throw new NotFoundError(`Transcripts item '${transcriptId}' not found`, { resource: "item", itemId: transcriptId });
  }

  const property = await propertiesStore.getPropertyByKey(client, transcripts.id, TRANSCRIPT_SPEAKERS_PROPERTY_KEY);
  if (!property) throw new NotFoundError(`Property '${TRANSCRIPT_SPEAKERS_PROPERTY_KEY}' not found on Transcripts`);
  const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
  if (!relationDefinition) throw new NotFoundError(`Relation definition for Transcripts 'speakers' not found`);

  const personBySpeaker = new Map<string, string>();
  for (const edge of await relationsStore.listRelationsForItem(client, relationDefinition.id, transcriptId)) {
    // Every write through the choke point carries `{ speaker }`; an edge without it maps no key.
    const metadata = speakerEdgeMetadataSchema.safeParse(edge.metadata);
    if (metadata.success) personBySpeaker.set(metadata.data.speaker, relationsStore.otherSide(edge, transcriptId));
  }
  const people = await itemsStore.getItemsByIds(client, [...personBySpeaker.values()]);
  const personById = new Map(people.map((person) => [person.id, person]));

  return listSegmentSpeakers(transcript).map((speaker, index) => {
    const personId = personBySpeaker.get(speaker);
    const person = personId === undefined ? undefined : personById.get(personId);
    const name = person?.properties.name;
    return {
      speaker,
      ordinal: index + 1,
      person: person ? { id: person.id, name: typeof name === "string" && name.length > 0 ? name : null } : null,
    };
  });
}
