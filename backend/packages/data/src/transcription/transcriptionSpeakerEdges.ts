import type { PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { createItemRelation, getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import type { ItemRelationRow } from "../types.js";
import { NotFoundError } from "../errors.js";
import { PEOPLE_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * The `{speaker: 'SPEAKER_00'}` shape issue #180's Task requires the Transcripts -> People
 * `speakers` relation's edges to carry (`seedTenDatabases.ts`'s "edges carry `{ speaker }`
 * metadata" comment, `transcriptsCatalogCutoverMigration.ts`'s catalog backfill). Only the
 * shape is enforced here; the transcription pipeline that actually diarizes a recording and
 * calls `writeTranscriptSpeakerEdge` with real speaker labels is a later issue (`#181` builds
 * on this one) — issue #180's own scope is the catalog contract, not the pipeline.
 */
export const speakerEdgeMetadataSchema = z.object({ speaker: z.string().min(1) });
export type SpeakerEdgeMetadata = z.infer<typeof speakerEdgeMetadataSchema>;

/**
 * Looks up the `speakers` relation definition id by walking Transcripts' `speakers` property,
 * mirroring `transcriptsCatalogCutoverMigration.ts`'s own property-then-relation lookup shape.
 * Throws rather than returning `null`: every caller of this function already assumes the
 * catalog migration has run (same assumption `enqueueTranscriptionJob`'s callers make about
 * the job queue existing).
 */
export async function getSpeakersRelationDefinitionId(client: PoolClient): Promise<string> {
  const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  if (!transcripts) throw new NotFoundError(`Database for module '${TRANSCRIPTS_MODULE_ID}' not found`);

  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM properties WHERE database_id = $1 AND key = 'speakers'`,
    [transcripts.id],
  );
  const speakersProperty = rows[0];
  if (!speakersProperty) throw new NotFoundError(`'speakers' property not found on Transcripts`);

  const definition = await getRelationDefinitionByPropertyId(client, speakersProperty.id);
  if (!definition) throw new NotFoundError(`Relation definition for 'speakers' property not found`);
  return definition.id;
}

/**
 * Validates and writes one Transcripts <-> People `speakers` edge's `{speaker}` metadata —
 * the one sanctioned way to write this relation's edge metadata, so a malformed `speaker`
 * value (empty string, wrong type) is rejected here rather than persisted and only failing a
 * later reader. `personItemId` is required to already exist in People; this function performs
 * no item creation of its own.
 */
export async function writeTranscriptSpeakerEdge(
  client: PoolClient,
  input: { transcriptItemId: string; personItemId: string; speaker: string },
): Promise<ItemRelationRow> {
  const metadata = speakerEdgeMetadataSchema.parse({ speaker: input.speaker });

  const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
  if (!people) throw new NotFoundError(`Database for module '${PEOPLE_MODULE_ID}' not found`);
  const person = await getItemById(client, people.id, input.personItemId);
  if (!person) throw new NotFoundError(`People item '${input.personItemId}' not found`, { resource: "item" });

  const relationDefinitionId = await getSpeakersRelationDefinitionId(client);
  return createItemRelation(client, {
    relationDefinitionId,
    itemA: input.transcriptItemId,
    itemB: input.personItemId,
    metadata,
  });
}
