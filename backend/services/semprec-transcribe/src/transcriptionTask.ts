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
  lockItemById,
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
import {
  discardStoredAudio,
  downloadToTempFile,
  normalizeAudio,
  probeMedia,
  probeNormalizedDuration,
  removeTempFile,
  type MediaProbeResult,
  type NormalizedAudioResult,
} from "./mediaNormalization.js";

function sourceName(properties: Record<string, unknown>): string {
  if (typeof properties.name === "string" && properties.name.length > 0) return properties.name;
  throw new ValidationError("Source file has no name", { field: "name" });
}

interface PrepareStepResult {
  normalizedBlobId: string;
  durationSeconds: number;
  /** The recording's own `creation_time`; `null` when it had none usable and `date` fell back to the upload time. */
  creationTime: string | null;
}

/**
 * Step 1's write transaction found the source's `file` replaced while ffmpeg was normalizing the
 * previous one. Nothing is written and the normalized audio is discarded; retryable — the job's
 * next attempt normalizes the new file instead.
 */
export class TranscriptionSourceChangedError extends Error {
  constructor(fileItemId: string) {
    super(`Files item '${fileItemId}' changed its file while step 1 was normalizing it`);
    this.name = "TranscriptionSourceChangedError";
  }
}

interface TranscriptionStepContext {
  pool: Pool;
  filesDatabaseId: string;
  fileItemId: string;
}

/**
 * One checkpointed step. It opens its own transactions, so a step doing slow non-database work
 * (step 1's ffmpeg) never holds one open across it, and it is a no-op once its checkpoint exists.
 */
type TranscriptionStep = (context: TranscriptionStepContext) => Promise<void>;

function requireSource(source: ItemRow | null, fileItemId: string): ItemRow {
  if (!source)
    throw new NotFoundError(`Files item '${fileItemId}' not found`, { resource: "item", itemId: fileItemId });
  return source;
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

/**
 * `withTransaction` at `repeatable read`, the isolation both transactions of
 * `docs/adr/2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions.md` use.
 * Built on `withTransaction` rather than `createPoolClientTransactionRunner` because only the
 * former fires the `runAfterCommit` invalidations `updateItemWithClient` registers.
 */
function withRepeatableReadTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    return fn(client);
  });
}

/** Step 0: database-only, so one transaction covers the checkpoint check, the Transcripts row and the checkpoint. */
async function runCreateStep({ pool, filesDatabaseId, fileItemId }: TranscriptionStepContext): Promise<void> {
  await withTransaction(pool, async (client) => {
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    if (Object.hasOwn(source.computed, TRANSCRIPTION_CREATE_COMPUTED_KEY)) return;

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
    await writeComputed(client, filesDatabaseId, fileItemId, TRANSCRIPTION_CREATE_COMPUTED_KEY, transcript.id);
  });
}

/**
 * Step 1 (`prepare`), bracketed per
 * `docs/adr/2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions.md` so no
 * transaction stays open while ffmpeg runs: a read transaction captures the source blob, the media
 * work runs outside any transaction, and a write transaction re-checks the source before writing
 * the normalized audio's blob row, the Transcripts `date` and the checkpoint.
 */
async function runPrepareStep(
  { pool, filesDatabaseId, fileItemId }: TranscriptionStepContext,
  blobStorage: BlobStorageWriter,
): Promise<void> {
  const snapshot = await withRepeatableReadTransaction(pool, async (client) => {
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    if (Object.hasOwn(source.computed, TRANSCRIPTION_PREPARE_COMPUTED_KEY)) return null;
    const sourceBlobId = readBlobId(source.properties);
    if (!sourceBlobId) throw new ValidationError("Source file has no blob", { field: "file" });
    const sourceBlob = await getBlob(client, sourceBlobId);
    if (!sourceBlob) throw new NotFoundError(`Blob '${sourceBlobId}' not found`, { resource: "blob" });
    return { sourceBlobId, storageKey: sourceBlob.storageKey, uploadedAt: sourceBlob.createdAt };
  });
  if (!snapshot) return;

  const tempPath = await downloadToTempFile(blobStorage, snapshot.storageKey);
  let probe: MediaProbeResult;
  let normalized: NormalizedAudioResult;
  try {
    probe = await probeMedia(tempPath);
    normalized = await normalizeAudio(tempPath, blobStorage, `transcriptions/${randomUUID()}.opus`);
  } finally {
    await removeTempFile(tempPath);
  }

  // Set once the blobs row pointing at the normalized audio is written. If COMMIT then fails,
  // whether that row committed is unknown, and deleting audio a committed row references would be
  // worse than leaving an unreferenced file behind.
  let referenced = false;
  try {
    // The source container can carry no duration at all (e.g. a streamed WebM/Matroska recording);
    // the normalized Ogg Opus output always does.
    const durationSeconds =
      probe.durationSeconds ?? (await probeNormalizedDuration(blobStorage, normalized.storageKey));

    await withRepeatableReadTransaction(pool, async (client) => {
      // Locked, so the checks below still hold when this transaction's writes land.
      const source = requireSource(await lockItemById(client, filesDatabaseId, fileItemId), fileItemId);
      // A concurrent run finished step 1 first: its checkpoint stands and this run's audio is discarded.
      if (Object.hasOwn(source.computed, TRANSCRIPTION_PREPARE_COMPUTED_KEY)) return;
      if (readBlobId(source.properties) !== snapshot.sourceBlobId)
        throw new TranscriptionSourceChangedError(fileItemId);
      const transcriptId = requireTranscriptId(source, fileItemId);

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
          propertiesPatch: { date: probe.creationTime ?? snapshot.uploadedAt },
        },
        { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      const result: PrepareStepResult = {
        normalizedBlobId: normalizedBlob.id,
        durationSeconds,
        creationTime: probe.creationTime,
      };
      await writeComputed(client, filesDatabaseId, fileItemId, TRANSCRIPTION_PREPARE_COMPUTED_KEY, result);
      referenced = true;
    });
  } finally {
    if (!referenced) await discardStoredAudio(blobStorage, normalized.storageKey);
  }
}

function createTranscriptionSteps(blobStorage: BlobStorageWriter): readonly TranscriptionStep[] {
  return [runCreateStep, (context) => runPrepareStep(context, blobStorage)];
}

/** Runs each declared transcription step in order; each skips itself once its checkpoint exists. `blobStorage` defaults to the same local-filesystem backend semprec-api writes Files blobs to (issue #246), configured via `FILES_STORAGE_DIR`. */
export function createTranscriptionTask(
  pool: Pool,
  blobStorage: BlobStorageWriter = new LocalFsBlobStorageWriter(process.env.FILES_STORAGE_DIR ?? "/tmp/semprec-files"),
) {
  const transcriptionSteps = createTranscriptionSteps(blobStorage);
  return async (payload: unknown): Promise<void> => {
    const { fileItemId } = transcriptionJobPayloadSchema.parse(payload);
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, FILES_MODULE_ID));
    if (!files) throw new NotFoundError("Files database not found");

    for (const step of transcriptionSteps) await step({ pool, filesDatabaseId: files.id, fileItemId });
  };
}
