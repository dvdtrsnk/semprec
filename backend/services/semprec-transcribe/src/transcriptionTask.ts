import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  TRANSCRIPTS_MODULE_ID,
  FILES_MODULE_ID,
  TRANSCRIPTION_CREATE_COMPUTED_KEY,
  TRANSCRIPTION_PREPARE_COMPUTED_KEY,
  TRANSCRIPTION_DIARIZE_COMPUTED_KEY,
  TRANSCRIPTION_ASR_COMPUTED_KEY,
  TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
  TRANSCRIPT_LANGUAGE_COMPUTED_KEY,
  TRANSCRIPT_SUMMARY_BY_INSTRUCTION_COMPUTED_KEY,
  TRANSCRIPTION_OWNER_PROCESS,
  createItemWithClient,
  createBlob,
  getBlob,
  ensureItemAutomation,
  getItemById,
  getDatabaseByModuleId,
  lockItemById,
  markItemAutomationDone,
  notifyInvalidation,
  readBlobId,
  runAfterCommit,
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
  extractAudioChunkBytes,
  normalizeAudio,
  probeMedia,
  probeNormalizedDuration,
  removeTempFile,
  type MediaProbeResult,
  type NormalizedAudioResult,
} from "./mediaNormalization.js";
import { createHttpAiGatewayClient } from "@semprec/ai-gateway-client";
import type { AiGatewayClientPort } from "@semprec/shared";
import { computeAsrChunkBoundaries } from "./asrChunking.js";
import { createHttpAudioGatewayClient, type AudioGatewayClient } from "./audioGatewayClient.js";
import { mergeTranscriptSegments, type TranscriptSegment } from "./segmentMerge.js";
import {
  buildSummaryRequest,
  DEFAULT_SUMMARY_INSTRUCTION,
  parseSummaryContent,
  type SummaryInstruction,
} from "./transcriptSummary.js";

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

const prepareCheckpointSchema = z.object({
  normalizedBlobId: z.string(),
  durationSeconds: z.number(),
  creationTime: z.string().nullable(),
});

/** Reads step 1's checkpoint, the input steps 2 and 3 both consume. */
function requirePrepareCheckpoint(source: ItemRow, fileItemId: string): PrepareStepResult {
  const parsed = prepareCheckpointSchema.safeParse(source.computed[TRANSCRIPTION_PREPARE_COMPUTED_KEY]);
  if (!parsed.success)
    throw new NotFoundError(
      `Files item '${fileItemId}' has no '${TRANSCRIPTION_PREPARE_COMPUTED_KEY}' checkpoint yet`,
      {
        resource: "item",
        itemId: fileItemId,
      },
    );
  return parsed.data;
}

const asrChunkResultSchema = z.object({
  text: z.string(),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
});

const asrCheckpointSchema = z.object({
  language: z.string().nullable(),
  chunks: z.record(z.string(), asrChunkResultSchema),
});
type AsrCheckpoint = z.infer<typeof asrCheckpointSchema>;

/** The ASR checkpoint written so far, or the empty shape before step 3's first chunk lands. */
function readAsrCheckpoint(source: ItemRow): AsrCheckpoint {
  const raw = source.computed[TRANSCRIPTION_ASR_COMPUTED_KEY];
  if (raw === undefined) return { language: null, chunks: {} };
  return asrCheckpointSchema.parse(raw);
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

/**
 * Step 2 (`diarize`): calls `gateway.diarize()` exactly once over the entire normalized recording
 * — diarization is never chunked — and checkpoints its speaker turns before step 3 starts, per
 * issue #182. No transaction stays open across the gateway call, mirroring step 1's bracket.
 */
async function runDiarizeStep(
  { pool, filesDatabaseId, fileItemId }: TranscriptionStepContext,
  blobStorage: BlobStorageWriter,
  gatewayClient: AudioGatewayClient,
): Promise<void> {
  const prepare = await withTransaction(pool, async (client) => {
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    if (Object.hasOwn(source.computed, TRANSCRIPTION_DIARIZE_COMPUTED_KEY)) return null;
    return requirePrepareCheckpoint(source, fileItemId);
  });
  if (!prepare) return;

  const blob = await withTransaction(pool, (client) => getBlob(client, prepare.normalizedBlobId));
  if (!blob) throw new NotFoundError(`Blob '${prepare.normalizedBlobId}' not found`, { resource: "blob" });

  const tempPath = await downloadToTempFile(blobStorage, blob.storageKey);
  let turns;
  try {
    const audio = await readFile(tempPath);
    turns = await gatewayClient.diarize({
      audio,
      filename: "recording.opus",
      mimeType: blob.mimeType,
      audioSeconds: prepare.durationSeconds,
    });
  } finally {
    await removeTempFile(tempPath);
  }

  await withTransaction(pool, async (client) => {
    // Locked, so a concurrent run that checkpointed first is not overwritten.
    const source = requireSource(await lockItemById(client, filesDatabaseId, fileItemId), fileItemId);
    if (Object.hasOwn(source.computed, TRANSCRIPTION_DIARIZE_COMPUTED_KEY)) return;
    await writeComputed(client, filesDatabaseId, fileItemId, TRANSCRIPTION_DIARIZE_COMPUTED_KEY, turns);
  });
}

/**
 * Step 3 (`ASR`): calls `gateway.transcribe()` once per 20-minute, 30-second-overlap chunk of the
 * normalized recording (`computeAsrChunkBoundaries`), checkpointing each chunk's raw result right
 * after it completes so a crash mid-stage repeats only the unfinished chunks. The language detected
 * on chunk 0 is passed explicitly to every later chunk, including across a resume.
 */
async function runAsrStep(
  { pool, filesDatabaseId, fileItemId }: TranscriptionStepContext,
  blobStorage: BlobStorageWriter,
  gatewayClient: AudioGatewayClient,
): Promise<void> {
  const prepare = await withTransaction(pool, async (client) => {
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    return requirePrepareCheckpoint(source, fileItemId);
  });
  const boundaries = computeAsrChunkBoundaries(prepare.durationSeconds);
  if (boundaries.length === 0) return;

  const alreadyDone = await withTransaction(pool, async (client) => {
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    const checkpoint = readAsrCheckpoint(source);
    return boundaries.every((_boundary, index) => Object.hasOwn(checkpoint.chunks, String(index)));
  });
  if (alreadyDone) return;

  const blob = await withTransaction(pool, (client) => getBlob(client, prepare.normalizedBlobId));
  if (!blob) throw new NotFoundError(`Blob '${prepare.normalizedBlobId}' not found`, { resource: "blob" });

  const tempPath = await downloadToTempFile(blobStorage, blob.storageKey);
  try {
    let language: string | null = null;
    for (let index = 0; index < boundaries.length; index += 1) {
      const boundary = boundaries[index]!;
      const current = await withTransaction(pool, async (client) => {
        const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
        return readAsrCheckpoint(source);
      });
      const existingChunk = current.chunks[String(index)];
      if (existingChunk) {
        language = current.language;
        continue;
      }

      const chunkAudio = await extractAudioChunkBytes(tempPath, boundary.start, boundary.end - boundary.start);
      const result = await gatewayClient.transcribe({
        audio: chunkAudio,
        filename: `chunk-${index}.opus`,
        mimeType: "audio/ogg",
        audioSeconds: boundary.end - boundary.start,
        language: index === 0 ? undefined : (language ?? undefined),
      });
      if (index === 0) language = result.language;

      await withTransaction(pool, async (client) => {
        // Locked, so a concurrent run that checkpointed this chunk first is not overwritten.
        const source = requireSource(await lockItemById(client, filesDatabaseId, fileItemId), fileItemId);
        const base = readAsrCheckpoint(source);
        if (Object.hasOwn(base.chunks, String(index))) return;
        const merged: AsrCheckpoint = {
          language: index === 0 ? result.language : base.language,
          chunks: { ...base.chunks, [String(index)]: { text: result.text, segments: result.segments } },
        };
        await writeComputed(client, filesDatabaseId, fileItemId, TRANSCRIPTION_ASR_COMPUTED_KEY, merged);
      });
    }
  } finally {
    await removeTempFile(tempPath);
  }
}

const diarizeCheckpointSchema = z.array(z.object({ speaker: z.string(), start: z.number(), end: z.number() }));

const segmentsSchema = z.array(
  z.object({ speaker: z.string(), text: z.string(), startsAt: z.number(), endsAt: z.number() }),
);

const summaryByInstructionSchema = z.record(z.string(), z.string());

async function requireTranscriptsDatabaseId(client: PoolClient): Promise<string> {
  const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  if (!transcripts) throw new NotFoundError("Transcripts database not found");
  return transcripts.id;
}

function requireTranscript(transcript: ItemRow | null, transcriptId: string): ItemRow {
  if (!transcript)
    throw new NotFoundError(`Transcripts item '${transcriptId}' not found`, { resource: "item", itemId: transcriptId });
  return transcript;
}

/** Step 4's output, the input steps 5 and 6 both require. */
function requireSegments(transcript: ItemRow): TranscriptSegment[] {
  const parsed = segmentsSchema.safeParse(transcript.computed[TRANSCRIPT_SEGMENTS_COMPUTED_KEY]);
  if (!parsed.success)
    throw new NotFoundError(`Transcripts item '${transcript.id}' has no '${TRANSCRIPT_SEGMENTS_COMPUTED_KEY}' yet`, {
      resource: "item",
      itemId: transcript.id,
    });
  return parsed.data;
}

/** The summaries cached so far, or none before step 5 first writes one. */
function readSummaries(transcript: ItemRow): Record<string, string> {
  const raw = transcript.computed[TRANSCRIPT_SUMMARY_BY_INSTRUCTION_COMPUTED_KEY];
  if (raw === undefined) return {};
  return summaryByInstructionSchema.parse(raw);
}

/**
 * Announces a computed write on the Transcripts row over the generic realtime channel, after the
 * commit. `writeComputed` fires no invalidation itself (unlike `updateItemWithClient`), so without
 * this the UI would not see steps 4 and 5 land until `done`.
 */
function announceTranscriptUpdate(client: PoolClient, transcriptsDatabaseId: string, transcript: ItemRow): void {
  runAfterCommit(client, () =>
    notifyInvalidation({
      scope: "item",
      databaseId: transcriptsDatabaseId,
      itemId: transcript.id,
      op: "update",
      updatedAt: transcript.updatedAt,
    }),
  );
}

/**
 * Step 4 (`merge`): database-only, so one transaction reads steps 1–3's checkpoints, runs the pure
 * `mergeTranscriptSegments` over them, and writes `segments` and `language` onto the Transcripts
 * row together. Written once: a transcript that already has `segments` is left untouched, so its
 * speaker keys are never rewritten.
 */
async function runMergeStep({ pool, filesDatabaseId, fileItemId }: TranscriptionStepContext): Promise<void> {
  await withTransaction(pool, async (client) => {
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    const transcriptId = requireTranscriptId(source, fileItemId);
    const transcriptsDatabaseId = await requireTranscriptsDatabaseId(client);
    // Locked, so a concurrent run that merged first is not overwritten.
    const transcript = requireTranscript(
      await lockItemById(client, transcriptsDatabaseId, transcriptId),
      transcriptId,
    );
    if (Object.hasOwn(transcript.computed, TRANSCRIPT_SEGMENTS_COMPUTED_KEY)) return;

    const prepare = requirePrepareCheckpoint(source, fileItemId);
    const turns = diarizeCheckpointSchema.parse(source.computed[TRANSCRIPTION_DIARIZE_COMPUTED_KEY]);
    const asr = readAsrCheckpoint(source);
    const chunks = computeAsrChunkBoundaries(prepare.durationSeconds).map((boundary, index) => {
      const chunk = asr.chunks[String(index)];
      if (!chunk)
        throw new NotFoundError(`Files item '${fileItemId}' has no ASR checkpoint for chunk ${index} yet`, {
          resource: "item",
          itemId: fileItemId,
        });
      return { boundary, segments: chunk.segments };
    });

    const segments = mergeTranscriptSegments(turns, chunks);
    await writeComputed(client, transcriptsDatabaseId, transcriptId, TRANSCRIPT_SEGMENTS_COMPUTED_KEY, segments);
    await writeComputed(client, transcriptsDatabaseId, transcriptId, TRANSCRIPT_LANGUAGE_COMPUTED_KEY, asr.language);
    announceTranscriptUpdate(client, transcriptsDatabaseId, transcript);
  });
}

/**
 * Step 5 (`summarize`): calls `gateway.complete()` over the merged transcript for `instruction`
 * and caches the result under the instruction's key in `summaryByInstruction`, next to any other
 * instruction's summary. Bracketed like steps 2 and 3, so no transaction stays open across the
 * gateway call; `segments` is written once by step 4, so the write transaction only has to
 * re-check that no concurrent run cached this instruction first. A transcript with no segments
 * (no speech) gets an empty summary without a paid call.
 */
async function runSummarizeStep(
  { pool, filesDatabaseId, fileItemId }: TranscriptionStepContext,
  summaryClient: AiGatewayClientPort,
  instruction: SummaryInstruction,
): Promise<void> {
  const snapshot = await withRepeatableReadTransaction(pool, async (client) => {
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    const transcriptId = requireTranscriptId(source, fileItemId);
    const transcriptsDatabaseId = await requireTranscriptsDatabaseId(client);
    const transcript = requireTranscript(await getItemById(client, transcriptsDatabaseId, transcriptId), transcriptId);
    if (Object.hasOwn(readSummaries(transcript), instruction.key)) return null;
    const language = z.string().nullable().parse(transcript.computed[TRANSCRIPT_LANGUAGE_COMPUTED_KEY]);
    return { transcriptsDatabaseId, transcriptId, segments: requireSegments(transcript), language };
  });
  if (!snapshot) return;

  let summary = "";
  if (snapshot.segments.length > 0) {
    const result = await summaryClient.complete(buildSummaryRequest(snapshot.segments, snapshot.language, instruction));
    summary = parseSummaryContent(result.content);
  }

  await withTransaction(pool, async (client) => {
    // Locked, so a concurrent run's summary for another instruction is kept, and one for this instruction wins.
    const transcript = requireTranscript(
      await lockItemById(client, snapshot.transcriptsDatabaseId, snapshot.transcriptId),
      snapshot.transcriptId,
    );
    const summaries = readSummaries(transcript);
    if (Object.hasOwn(summaries, instruction.key)) return;
    await writeComputed(
      client,
      snapshot.transcriptsDatabaseId,
      snapshot.transcriptId,
      TRANSCRIPT_SUMMARY_BY_INSTRUCTION_COMPUTED_KEY,
      { ...summaries, [instruction.key]: summary },
    );
    announceTranscriptUpdate(client, snapshot.transcriptsDatabaseId, transcript);
  });
}

/**
 * Step 6 (`finalize`): sets `status = done` and `item_automation` to `done` in one transaction,
 * and only once that transaction itself sees the committed `segments` and this instruction's
 * summary — a run that failed before either landed leaves the row `processing`. `status` goes
 * through `updateItemWithClient`, which announces it over the generic realtime channel.
 */
async function runFinalizeStep(
  { pool, filesDatabaseId, fileItemId }: TranscriptionStepContext,
  instruction: SummaryInstruction,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    const transcriptId = requireTranscriptId(source, fileItemId);
    const transcriptsDatabaseId = await requireTranscriptsDatabaseId(client);
    const transcript = requireTranscript(
      await lockItemById(client, transcriptsDatabaseId, transcriptId),
      transcriptId,
    );
    if (transcript.properties.status === "done") return;
    requireSegments(transcript);
    if (!Object.hasOwn(readSummaries(transcript), instruction.key))
      throw new NotFoundError(`Transcripts item '${transcriptId}' has no '${instruction.key}' summary yet`, {
        resource: "item",
        itemId: transcriptId,
      });

    await updateItemWithClient(
      client,
      { databaseId: transcriptsDatabaseId, itemId: transcriptId, propertiesPatch: { status: "done" } },
      { allowedSystemKeys: ["status"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
    );
    await markItemAutomationDone(client, transcriptId);
  });
}

function createTranscriptionSteps(
  blobStorage: BlobStorageWriter,
  gatewayClient: AudioGatewayClient,
  summaryClient: AiGatewayClientPort,
  summaryInstruction: SummaryInstruction,
): readonly TranscriptionStep[] {
  return [
    runCreateStep,
    (context) => runPrepareStep(context, blobStorage),
    (context) => runDiarizeStep(context, blobStorage, gatewayClient),
    (context) => runAsrStep(context, blobStorage, gatewayClient),
    runMergeStep,
    (context) => runSummarizeStep(context, summaryClient, summaryInstruction),
    (context) => runFinalizeStep(context, summaryInstruction),
  ];
}

function requireGatewayInternalToken(): string {
  const token = process.env.AI_GATEWAY_INTERNAL_TOKEN;
  if (!token) throw new Error("AI_GATEWAY_INTERNAL_TOKEN is not set");
  return token;
}

/**
 * Runs each declared transcription step in order; each skips itself once its checkpoint exists.
 * `blobStorage` defaults to the same local-filesystem backend semprec-api writes Files blobs to
 * (issue #246), configured via `FILES_STORAGE_DIR`. `gatewayClient` defaults to a loopback HTTP
 * client for `semprec-ai-gateway`'s `/internal/diarize` and `/internal/transcribe` routes
 * (issue #182), and `summaryClient` to `@semprec/ai-gateway-client`'s client for its
 * `/internal/complete` route (issue #183), both configured via
 * `AI_GATEWAY_PORT`/`AI_GATEWAY_INTERNAL_TOKEN` — the only path from this service to an AI
 * provider, per `docs/adr/2026-09-10-ai-gateway-monopoly-on-provider-calls.md`.
 * `summaryInstruction` selects the instruction step 5 summarizes with and step 6 requires.
 */
export function createTranscriptionTask(
  pool: Pool,
  blobStorage: BlobStorageWriter = new LocalFsBlobStorageWriter(process.env.FILES_STORAGE_DIR ?? "/tmp/semprec-files"),
  gatewayClient?: AudioGatewayClient,
  summaryClient?: AiGatewayClientPort,
  summaryInstruction: SummaryInstruction = DEFAULT_SUMMARY_INSTRUCTION,
) {
  // Constructed lazily (only when a run actually reaches step 2), not as an eagerly-evaluated
  // default parameter: callers who omit `gatewayClient` and never run a job that reaches
  // diarize/ASR (e.g. queue-runtime handler-registration checks) must not fail just because
  // AI_GATEWAY_INTERNAL_TOKEN happens to be unset in their environment.
  const resolveGatewayClient = (): AudioGatewayClient =>
    gatewayClient ??
    createHttpAudioGatewayClient({
      port: Number(process.env.AI_GATEWAY_PORT ?? "3002"),
      token: requireGatewayInternalToken(),
    });
  const resolveSummaryClient = (): AiGatewayClientPort =>
    summaryClient ??
    createHttpAiGatewayClient({
      port: Number(process.env.AI_GATEWAY_PORT ?? "3002"),
      token: requireGatewayInternalToken(),
    });

  return async (payload: unknown): Promise<void> => {
    const { fileItemId } = transcriptionJobPayloadSchema.parse(payload);
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, FILES_MODULE_ID));
    if (!files) throw new NotFoundError("Files database not found");

    const transcriptionSteps = createTranscriptionSteps(
      blobStorage,
      resolveGatewayClient(),
      resolveSummaryClient(),
      summaryInstruction,
    );
    for (const step of transcriptionSteps) await step({ pool, filesDatabaseId: files.id, fileItemId });
  };
}
