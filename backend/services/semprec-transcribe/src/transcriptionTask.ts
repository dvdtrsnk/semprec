import type { Pool, PoolClient } from "pg";
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
import type { ItemRow } from "@semprec/data";

function sourceName(properties: Record<string, unknown>): string {
  if (typeof properties.name === "string" && properties.name.length > 0) return properties.name;
  throw new ValidationError("Source file has no name", { field: "name" });
}

interface TranscriptionStep {
  checkpointKey: string;
  run(client: PoolClient, source: ItemRow, fileItemId: string): Promise<unknown>;
}

const transcriptionSteps: readonly TranscriptionStep[] = [
  {
    checkpointKey: TRANSCRIPTION_CREATE_COMPUTED_KEY,
    async run(client, source, fileItemId): Promise<string> {
      const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
      if (!transcripts) throw new NotFoundError("Transcripts database not found");
      const transcript = await createItemWithClient(
        client,
        {
          databaseId: transcripts.id,
          idempotencyKey: `transcription:${fileItemId}`,
          properties: {
            name: sourceName(source.properties),
            status: "processing",
            link: `semprec://items/${fileItemId}`,
          },
        },
        { allowedSystemKeys: ["status", "link"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      await ensureItemAutomation(client, transcript.id);
      return transcript.id;
    },
  },
];

/** Runs each declared transcription step in order, checkpointing each completed result. */
export function createTranscriptionTask(pool: Pool) {
  return async (payload: unknown): Promise<void> => {
    const { fileItemId } = transcriptionJobPayloadSchema.parse(payload);
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, FILES_MODULE_ID));
    if (!files) throw new NotFoundError("Files database not found");

    for (const step of transcriptionSteps) {
      await withTransaction(pool, async (client) => {
        const source = await getItemById(client, files.id, fileItemId);
        if (!source)
          throw new NotFoundError(`Files item '${fileItemId}' not found`, { resource: "item", itemId: fileItemId });
        if (Object.hasOwn(source.computed, step.checkpointKey)) return;

        const result = await step.run(client, source, fileItemId);
        await writeComputed(client, files.id, fileItemId, step.checkpointKey, result);
      });
    }
  };
}
