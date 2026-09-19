import type { PoolClient } from "pg";
import { z } from "zod";
import { createRelationWithClient } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
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
 * Looks up the `speakers` relation property on Transcripts by key. Throws rather than
 * returning `null`: every caller already assumes the catalog migration has run (same
 * assumption `enqueueTranscriptionJob`'s callers make about the job queue existing).
 */
async function getSpeakersProperty(client: PoolClient, transcriptsDatabaseId: string): Promise<{ id: string }> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM properties WHERE database_id = $1 AND key = 'speakers'`,
    [transcriptsDatabaseId],
  );
  const speakersProperty = rows[0];
  if (!speakersProperty) throw new NotFoundError(`'speakers' property not found on Transcripts`);
  return speakersProperty;
}

/**
 * Validates and writes one Transcripts <-> People `speakers` edge's `{speaker}` metadata —
 * the one sanctioned way to write this relation's edge metadata, so a malformed `speaker`
 * value (empty string, wrong type) is rejected here rather than persisted and only failing a
 * later reader. `transcriptItemId` and `personItemId` are both required to already exist in
 * their respective databases; this function performs no item creation of its own. Writes
 * through the choke-point's `createRelationWithClient` rather than `relationsStore` directly,
 * so the edge gets the same archive/writability enforcement and rollup recompute enqueue as
 * every other relation write.
 */
export async function writeTranscriptSpeakerEdge(
  client: PoolClient,
  input: { transcriptItemId: string; personItemId: string; speaker: string },
): Promise<ItemRelationRow> {
  const metadata = speakerEdgeMetadataSchema.parse({ speaker: input.speaker });

  const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  if (!transcripts) throw new NotFoundError(`Database for module '${TRANSCRIPTS_MODULE_ID}' not found`);
  const transcript = await getItemById(client, transcripts.id, input.transcriptItemId);
  if (!transcript)
    throw new NotFoundError(`Transcript item '${input.transcriptItemId}' not found`, { resource: "item" });

  const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
  if (!people) throw new NotFoundError(`Database for module '${PEOPLE_MODULE_ID}' not found`);
  const person = await getItemById(client, people.id, input.personItemId);
  if (!person) throw new NotFoundError(`People item '${input.personItemId}' not found`, { resource: "item" });

  const speakersProperty = await getSpeakersProperty(client, transcripts.id);
  return createRelationWithClient(client, {
    relationPropertyId: speakersProperty.id,
    callerItemId: input.transcriptItemId,
    targetItemId: input.personItemId,
    metadata,
  });
}
