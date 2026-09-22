import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  TRANSCRIPTS_MODULE_ID,
  FILES_MODULE_ID,
  TRANSCRIPTION_CREATE_COMPUTED_KEY,
  TRANSCRIPTION_PREPARE_COMPUTED_KEY,
  TRANSCRIPTION_OWNER_PROCESS,
  createItemWithClient,
  createBlob,
  getBlob,
  ensureItemAutomation,
  getItemById,
  getDatabaseByModuleId,
  readBlobId,
  transcriptionJobPayloadSchema,
  updateItemWithClient,
  withTransaction,
  writeComputed,
  LocalFsBlobStorageWriter,
} from "@semprec/data";
import type { BlobStorageWriter } from "@semprec/data";
import { NotFoundError, ValidationError } from "@semprec/data";
import type { ItemRow } from "@semprec/data";
import { downloadToTempFile, normalizeAudio, probeMedia, removeTempFile } from "./mediaNormalization.js";

function sourceName(properties: Record<string, unknown>): string {
  if (typeof properties.name === "string" && properties.name.length > 0) return properties.name;
  throw new ValidationError("Source file has no name", { field: "name" });
}

interface PrepareStepResult {
  normalizedBlobId: string;
  durationSeconds: number;
}

interface TranscriptionStep {
  checkpointKey: string;
  run(client: PoolClient, source: ItemRow, fileItemId: string): Promise<unknown>;
}

/** Reads the transcript item id step 0 checkpointed for this source, the row step 1 patches `date` onto. */
function requireTranscriptId(source: ItemRow, fileItemId: string): string {
  const transcriptId = source.computed[TRANSCRIPTION_CREATE_COMPUTED_KEY];
  if (typeof transcriptId !== "string")
    throw new NotFoundError(`Files item '${fileItemId}' has no '${TRANSCRIPTION_CREATE_COMPUTED_KEY}' checkpoint yet`, {
      resource: "item",
      itemId: fileItemId,
    });
  return transcriptId;
}

function createTranscriptionSteps(blobStorage: BlobStorageWriter): readonly TranscriptionStep[] {
  return [
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
    {
      checkpointKey: TRANSCRIPTION_PREPARE_COMPUTED_KEY,
      async run(client, source, fileItemId): Promise<PrepareStepResult> {
        const sourceBlobId = readBlobId(source.properties);
        if (!sourceBlobId) throw new ValidationError("Source file has no blob", { field: "file" });
        const sourceBlob = await getBlob(client, sourceBlobId);
        if (!sourceBlob) throw new NotFoundError(`Blob '${sourceBlobId}' not found`, { resource: "blob" });
        const transcriptId = requireTranscriptId(source, fileItemId);

        const tempPath = await downloadToTempFile(blobStorage, sourceBlob.storageKey);
        try {
          const probe = await probeMedia(tempPath);
          const normalized = await normalizeAudio(tempPath, blobStorage, `transcriptions/${randomUUID()}.opus`);
          const normalizedBlob = await createBlob(client, {
            mimeType: "audio/ogg",
            byteSize: normalized.byteSize,
            storageKey: normalized.storageKey,
            contentHash: normalized.contentHash,
          });

          const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
          if (!transcripts) throw new NotFoundError("Transcripts database not found");
          await updateItemWithClient(
            client,
            {
              databaseId: transcripts.id,
              itemId: transcriptId,
              propertiesPatch: { date: probe.creationTime ?? sourceBlob.createdAt },
            },
            { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
          );

          return { normalizedBlobId: normalizedBlob.id, durationSeconds: probe.durationSeconds };
        } finally {
          await removeTempFile(tempPath);
        }
      },
    },
  ];
}

/** Runs each declared transcription step in order, checkpointing each completed result. `blobStorage` defaults to the same local-filesystem backend semprec-api writes Files blobs to (issue #246), configured via `FILES_STORAGE_DIR`. */
export function createTranscriptionTask(
  pool: Pool,
  blobStorage: BlobStorageWriter = new LocalFsBlobStorageWriter(process.env.FILES_STORAGE_DIR ?? "/tmp/semprec-files"),
) {
  const transcriptionSteps = createTranscriptionSteps(blobStorage);
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
