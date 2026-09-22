import type { Pool } from "pg";
import {
  TRANSCRIPTS_MODULE_ID,
  FILES_MODULE_ID,
  TRANSCRIPTION_CREATE_COMPUTED_KEY,
  TRANSCRIPTION_OWNER_PROCESS,
  createItemWithClient,
  ensureItemAutomation,
  getItemById,
  getDatabaseByModuleId,
  transcriptionJobPayloadSchema,
  withTransaction,
  writeComputed,
} from "@semprec/data";
import { NotFoundError, ValidationError } from "@semprec/data";

function sourceName(properties: Record<string, unknown>): string {
  if (typeof properties.name === "string" && properties.name.length > 0) return properties.name;
  throw new ValidationError("Source file has no name", { field: "name" });
}

/**
 * Step 0 of the transcription pipeline. The source Files item's `create` checkpoint is the
 * sole durable hand-off to later steps: a repeat run observes it before opening a write
 * transaction and therefore performs no additional mutation.
 */
export function createTranscriptionTask(pool: Pool) {
  return async (payload: unknown): Promise<void> => {
    const { fileItemId } = transcriptionJobPayloadSchema.parse(payload);
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, FILES_MODULE_ID));
    if (!files) throw new NotFoundError("Files database not found");
    const source = await withTransaction(pool, (client) => getItemById(client, files.id, fileItemId));
    if (!source)
      throw new NotFoundError(`Files item '${fileItemId}' not found`, { resource: "item", itemId: fileItemId });
    if (typeof source.computed[TRANSCRIPTION_CREATE_COMPUTED_KEY] === "string") return;

    await withTransaction(pool, async (client) => {
      const currentSource = await getItemById(client, files.id, fileItemId);
      if (!currentSource)
        throw new NotFoundError(`Files item '${fileItemId}' not found`, { resource: "item", itemId: fileItemId });
      if (typeof currentSource.computed[TRANSCRIPTION_CREATE_COMPUTED_KEY] === "string") return;

      const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
      if (!transcripts) throw new NotFoundError("Transcripts database not found");
      const transcript = await createItemWithClient(
        client,
        {
          databaseId: transcripts.id,
          idempotencyKey: `transcription:${fileItemId}`,
          properties: {
            name: sourceName(currentSource.properties),
            status: "processing",
            link: `semprec://items/${fileItemId}`,
          },
        },
        { allowedSystemKeys: ["status", "link"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      await ensureItemAutomation(client, transcript.id);
      await writeComputed(client, files.id, fileItemId, TRANSCRIPTION_CREATE_COMPUTED_KEY, transcript.id);
    });
  };
}
