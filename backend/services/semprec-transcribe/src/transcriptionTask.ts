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
  TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY,
  TRANSCRIPTION_OWNER_PROCESS,
  createItemWithClient,
  createBlob,
  getBlob,
  ensureItemAutomation,
  getEarliestUserId,
  getItemById,
  getDatabaseByModuleId,
  lockItemAutomation,
  lockItemById,
  markItemAutomationDone,
  matchTranscriptToEvent,
  proposeSpeakerMappings,
  readSpeakerSuggestionContext,
  readBlobId,
  recordItemAutomationFailure,
  startItemAutomationAttempt,
  transcriptionJobPayloadSchema,
  updateItemWithClient,
  withTransaction,
  writeComputed,
  writeComputedAndAnnounce,
  writeNotification,
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
import { AiGatewayFailedError, type AiGatewayClientPort } from "@semprec/shared";
import { computeAsrChunkBoundaries } from "./asrChunking.js";
import {
  AudioGatewayBudgetExceededError,
  createHttpAudioGatewayClient,
  type AudioGatewayClient,
} from "./audioGatewayClient.js";
import { logger } from "./logger.js";
import { mergeTranscriptSegments, type TranscriptSegment } from "./segmentMerge.js";
import {
  buildSummaryRequest,
  DEFAULT_SUMMARY_INSTRUCTION,
  parseSummaryContent,
  type SummaryInstruction,
} from "./transcriptSummary.js";
import { buildSpeakerSuggestionRequest, parseSpeakerSuggestionContent } from "./speakerSuggestion.js";

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

/**
 * A step's transaction found the Transcriptions row `locked` by a user. Thrown before the
 * transaction writes anything, so nothing of that step lands; the pipeline stops without
 * recording a failure, since `locked` is the user's to keep.
 */
export class TranscriptionLockedError extends Error {
  constructor(transcriptId: string) {
    super(`Transcriptions item '${transcriptId}' was locked by a user`);
    this.name = "TranscriptionLockedError";
  }
}

/** Identifies the source file a run transcribes; all step 0 and the attempt start need. */
interface TranscriptionSourceContext {
  pool: Pool;
  filesDatabaseId: string;
  fileItemId: string;
}

/** Steps 1–8 also know the Transcriptions row step 0 created, whose lock every one of their transactions checks. */
interface TranscriptionStepContext extends TranscriptionSourceContext {
  transcriptId: string;
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

/** Reads the transcript item id step 0 checkpointed for this source, the row steps 1–8 write to. */
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

/**
 * Row-locks the Transcriptions row's `item_automation` inside the caller's transaction and throws
 * `TranscriptionLockedError` when a user locked it. Held until that transaction ends, so a user's
 * lock cannot land between this check and the writes after it — it waits for them to commit.
 * Every transaction of steps 1–8 calls it first, including the read transaction ahead of a paid
 * call, so a lock set while a step runs stops the pipeline before its next write or paid call.
 * Taken before any `items` row lock, the same order `recordTranscriptionFailure` takes them in.
 */
async function requireTranscriptionUnlocked(client: PoolClient, transcriptId: string): Promise<void> {
  const automation = await lockItemAutomation(client, transcriptId);
  if (!automation)
    throw new NotFoundError(`item_automation row for item '${transcriptId}' not found`, {
      resource: "item",
      itemId: transcriptId,
    });
  if (automation.status === "locked") throw new TranscriptionLockedError(transcriptId);
}

/** Step 0: database-only, so one transaction covers the checkpoint check, the Transcripts row and the checkpoint. */
async function runCreateStep({ pool, filesDatabaseId, fileItemId }: TranscriptionSourceContext): Promise<void> {
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
  { pool, filesDatabaseId, fileItemId, transcriptId }: TranscriptionStepContext,
  blobStorage: BlobStorageWriter,
): Promise<void> {
  const snapshot = await withRepeatableReadTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, transcriptId);
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
      await requireTranscriptionUnlocked(client, transcriptId);
      // Locked, so the checks below still hold when this transaction's writes land.
      const source = requireSource(await lockItemById(client, filesDatabaseId, fileItemId), fileItemId);
      // A concurrent run finished step 1 first: its checkpoint stands and this run's audio is discarded.
      if (Object.hasOwn(source.computed, TRANSCRIPTION_PREPARE_COMPUTED_KEY)) return;
      if (readBlobId(source.properties) !== snapshot.sourceBlobId)
        throw new TranscriptionSourceChangedError(fileItemId);

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
  { pool, filesDatabaseId, fileItemId, transcriptId }: TranscriptionStepContext,
  blobStorage: BlobStorageWriter,
  gatewayClient: AudioGatewayClient,
): Promise<void> {
  const prepare = await withTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, transcriptId);
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
    await requireTranscriptionUnlocked(client, transcriptId);
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
  { pool, filesDatabaseId, fileItemId, transcriptId }: TranscriptionStepContext,
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
        await requireTranscriptionUnlocked(client, transcriptId);
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
        await requireTranscriptionUnlocked(client, transcriptId);
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

/** Step 4's output, the input steps 5 and 7 both require. */
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
 * Step 4 (`merge`): database-only, so one transaction reads steps 1–3's checkpoints, runs the pure
 * `mergeTranscriptSegments` over them, and writes `segments` and `language` onto the Transcripts
 * row together. Written once: a transcript that already has `segments` is left untouched, so its
 * speaker keys are never rewritten.
 */
async function runMergeStep({
  pool,
  filesDatabaseId,
  fileItemId,
  transcriptId,
}: TranscriptionStepContext): Promise<void> {
  await withTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, transcriptId);
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    const transcriptsDatabaseId = await requireTranscriptsDatabaseId(client);
    // Locked, so a concurrent run that merged first is not overwritten.
    const transcript = requireTranscript(await lockItemById(client, transcriptsDatabaseId, transcriptId), transcriptId);
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
    await writeComputedAndAnnounce(
      client,
      transcriptsDatabaseId,
      transcriptId,
      TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
      segments,
    );
    await writeComputedAndAnnounce(
      client,
      transcriptsDatabaseId,
      transcriptId,
      TRANSCRIPT_LANGUAGE_COMPUTED_KEY,
      asr.language,
    );
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
  { pool, transcriptId }: TranscriptionStepContext,
  summaryClient: AiGatewayClientPort,
  instruction: SummaryInstruction,
): Promise<void> {
  const snapshot = await withRepeatableReadTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, transcriptId);
    const transcriptsDatabaseId = await requireTranscriptsDatabaseId(client);
    const transcript = requireTranscript(await getItemById(client, transcriptsDatabaseId, transcriptId), transcriptId);
    if (Object.hasOwn(readSummaries(transcript), instruction.key)) return null;
    const language = z.string().nullable().parse(transcript.computed[TRANSCRIPT_LANGUAGE_COMPUTED_KEY]);
    return { transcriptsDatabaseId, segments: requireSegments(transcript), language };
  });
  if (!snapshot) return;

  let summary = "";
  if (snapshot.segments.length > 0) {
    const result = await summaryClient.complete(buildSummaryRequest(snapshot.segments, snapshot.language, instruction));
    summary = parseSummaryContent(result.content);
  }

  await withTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, transcriptId);
    // Locked, so a concurrent run's summary for another instruction is kept, and one for this instruction wins.
    const transcript = requireTranscript(
      await lockItemById(client, snapshot.transcriptsDatabaseId, transcriptId),
      transcriptId,
    );
    const summaries = readSummaries(transcript);
    if (Object.hasOwn(summaries, instruction.key)) return;
    await writeComputedAndAnnounce(
      client,
      snapshot.transcriptsDatabaseId,
      transcriptId,
      TRANSCRIPT_SUMMARY_BY_INSTRUCTION_COMPUTED_KEY,
      { ...summaries, [instruction.key]: summary },
    );
  });
}

/**
 * Step 6 (`match`): `matchTranscriptToEvent` in one transaction — links the one Event whose
 * `date` falls inside the recording's window, or otherwise creates the transcript's single
 * suggestion card. Re-running it converges: an existing edge or card is left as it is.
 */
async function runMatchStep({
  pool,
  filesDatabaseId,
  fileItemId,
  transcriptId,
}: TranscriptionStepContext): Promise<void> {
  await withTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, transcriptId);
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    const { durationSeconds } = requirePrepareCheckpoint(source, fileItemId);
    await matchTranscriptToEvent(client, { transcriptId, durationSeconds });
  });
}

/**
 * Step 7 (`suggestSpeakers`, issue #185): when the transcript is linked to an Event with named
 * participants and has unmapped speaker keys, calls `gateway.complete()` once to suggest which
 * participant each key is, and turns the suggestions into `kind = 'transcript'` cards
 * (`proposeSpeakerMappings`) — it never writes a mapping; only a human's `confirm` does.
 * Bracketed like step 5, so no transaction stays open across the gateway call, and checkpointed
 * with the cards in one transaction, so a retried run never pays for the call twice. When there is
 * nothing to ask (no Event yet, no participants) nothing is paid for and nothing is checkpointed,
 * so a later run of the pipeline for the same file can still ask.
 */
async function runSuggestSpeakersStep(
  { pool, filesDatabaseId, fileItemId, transcriptId }: TranscriptionStepContext,
  completionClient: AiGatewayClientPort,
): Promise<void> {
  const snapshot = await withRepeatableReadTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, transcriptId);
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    if (Object.hasOwn(source.computed, TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY)) return null;
    const transcriptsDatabaseId = await requireTranscriptsDatabaseId(client);
    const transcript = requireTranscript(await getItemById(client, transcriptsDatabaseId, transcriptId), transcriptId);
    const segments = requireSegments(transcript);
    const context = await readSpeakerSuggestionContext(client, transcriptId);
    return context ? { segments, context } : null;
  });
  if (!snapshot) return;

  const result = await completionClient.complete(buildSpeakerSuggestionRequest(snapshot.segments, snapshot.context));
  const suggestions = parseSpeakerSuggestionContent(result.content);

  await withTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, transcriptId);
    // Locked, so a concurrent run that checkpointed first is not doubled.
    const source = requireSource(await lockItemById(client, filesDatabaseId, fileItemId), fileItemId);
    if (Object.hasOwn(source.computed, TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY)) return;
    const proposedSpeakers = await proposeSpeakerMappings(client, { transcriptId, suggestions });
    await writeComputed(client, filesDatabaseId, fileItemId, TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY, {
      proposedSpeakers,
    });
  });
}

/**
 * Step 8 (`finalize`): sets `status = done` and `item_automation` to `done` (clearing any earlier
 * attempt's `error`) in one transaction, and only once that transaction itself sees the committed
 * `segments` and this instruction's summary — a run that failed before either landed leaves the
 * row as the failure handling in `createTranscriptionTask` records it. `status` goes through
 * `updateItemWithClient`, which announces it over the generic realtime channel. A row that is
 * already `done` only has its `item_automation` settled again, since the attempt that reached this
 * step reopened it as `pending`.
 */
async function runFinalizeStep(
  { pool, transcriptId }: TranscriptionStepContext,
  instruction: SummaryInstruction,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, transcriptId);
    const transcriptsDatabaseId = await requireTranscriptsDatabaseId(client);
    const transcript = requireTranscript(await lockItemById(client, transcriptsDatabaseId, transcriptId), transcriptId);
    if (transcript.properties.status === "done") {
      await markItemAutomationDone(client, transcriptId);
      return;
    }
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

/** Steps 1–8; step 0 runs before them, since it creates the row the attempt is counted on. */
function createTranscriptionSteps(
  blobStorage: BlobStorageWriter,
  gatewayClient: AudioGatewayClient,
  summaryClient: AiGatewayClientPort,
  summaryInstruction: SummaryInstruction,
): readonly TranscriptionStep[] {
  return [
    (context) => runPrepareStep(context, blobStorage),
    (context) => runDiarizeStep(context, blobStorage, gatewayClient),
    (context) => runAsrStep(context, blobStorage, gatewayClient),
    runMergeStep,
    (context) => runSummarizeStep(context, summaryClient, summaryInstruction),
    runMatchStep,
    (context) => runSuggestSpeakersStep(context, summaryClient),
    (context) => runFinalizeStep(context, summaryInstruction),
  ];
}

/**
 * Opens this attempt on the Transcriptions row step 0 created: counts it in the cumulative
 * `item_automation.attempts` and moves the row back to `pending`. Returns the row's id, or `null`
 * when a user locked it — the pipeline then does nothing more to it.
 */
async function startTranscriptionAttempt({
  pool,
  filesDatabaseId,
  fileItemId,
}: TranscriptionSourceContext): Promise<string | null> {
  return withTransaction(pool, async (client) => {
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    const transcriptId = requireTranscriptId(source, fileItemId);
    await ensureItemAutomation(client, transcriptId);
    const automation = await startItemAutomationAttempt(client, transcriptId);
    return automation ? transcriptId : null;
  });
}

/** A rejection by the gateway's budget caps: no retry can succeed until the cap resets, so the failure is permanent at once. */
function isBudgetRejection(err: unknown): boolean {
  return (
    err instanceof AudioGatewayBudgetExceededError ||
    (err instanceof AiGatewayFailedError && err.reason === "budget_exceeded")
  );
}

/**
 * Records a failed attempt on the Transcriptions row, all in one transaction. While retries
 * remain, only `item_automation.error` is written and the row stays `pending`/`processing`. A
 * permanent failure also sets `item_automation.status = 'error'` and `status = error`, and writes
 * one `automation_error` notification keyed by the cumulative attempt count, so replaying the same
 * attempt's failure never adds a second one while every later permanent failure gets its own.
 * Returns `false`, writing nothing, when a user locked the row in the meantime.
 */
async function recordTranscriptionFailure(
  client: PoolClient,
  transcriptId: string,
  message: string,
  permanent: boolean,
): Promise<boolean> {
  const automation = await lockItemAutomation(client, transcriptId);
  if (!automation || automation.status === "locked") return false;
  const written = await recordItemAutomationFailure(client, transcriptId, message, permanent ? "error" : "pending");
  if (!written) throw new Error(`item_automation row for item ${transcriptId} was not updated while locked`);
  if (!permanent) return true;

  await updateItemWithClient(
    client,
    {
      databaseId: await requireTranscriptsDatabaseId(client),
      itemId: transcriptId,
      propertiesPatch: { status: "error" },
    },
    { allowedSystemKeys: ["status"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
  );
  const userId = await getEarliestUserId(client);
  if (!userId) {
    logger.warn({ transcriptId }, "No user to notify about a permanent transcription failure");
    return true;
  }
  await writeNotification(client, {
    userId,
    kind: "automation_error",
    // Transcriptions have no dedicated page to link to yet.
    linkHref: null,
    sourceTable: "item_automation",
    sourceId: transcriptId,
    transitionInstance: `attempt:${automation.attempts}`,
  });
  return true;
}

/** The part of graphile-worker's `JobHelpers` this task reads: which attempt of how many this run is. */
export interface TranscriptionJobHelpers {
  job: { attempts: number; max_attempts: number };
}

function requireGatewayInternalToken(): string {
  const token = process.env.AI_GATEWAY_INTERNAL_TOKEN;
  if (!token) throw new Error("AI_GATEWAY_INTERNAL_TOKEN is not set");
  return token;
}

/**
 * Runs each declared transcription step in order; each skips itself once its checkpoint exists,
 * so a retried attempt (`transcriptionJob` is enqueued with `max_attempts: 3` and graphile-worker's
 * built-in exponential backoff) resumes from the last checkpoint without repeating a paid call.
 * Every attempt is counted on the Transcriptions row's `item_automation`, and a row a user locked
 * is left alone — checked inside every step transaction (`requireTranscriptionUnlocked`), so a lock
 * set mid-run keeps the running step's pending write from landing and stops the pipeline. A failure
 * is recorded by `recordTranscriptionFailure` and rethrown for graphile-worker to retry, except a
 * budget rejection: that is permanent at once, so once recorded the job completes instead of
 * spending its remaining attempts on calls the gateway will reject. A failure in step 0 happens
 * before there is a Transcriptions row to record it on and is only rethrown.
 * `blobStorage` defaults to the same local-filesystem backend semprec-api writes Files blobs to
 * (issue #246), configured via `FILES_STORAGE_DIR`. `gatewayClient` defaults to a loopback HTTP
 * client for `semprec-ai-gateway`'s `/internal/diarize` and `/internal/transcribe` routes
 * (issue #182), and `summaryClient` to `@semprec/ai-gateway-client`'s client for its
 * `/internal/complete` route (issue #183) — also the client step 7 suggests speaker mappings
 * with (issue #185) — both configured via
 * `AI_GATEWAY_PORT`/`AI_GATEWAY_INTERNAL_TOKEN` — the only path from this service to an AI
 * provider, per `docs/adr/2026-09-10-ai-gateway-monopoly-on-provider-calls.md`.
 * `summaryInstruction` selects the instruction step 5 summarizes with and step 8 requires.
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

  return async (payload: unknown, helpers: TranscriptionJobHelpers): Promise<void> => {
    const { fileItemId } = transcriptionJobPayloadSchema.parse(payload);
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, FILES_MODULE_ID));
    if (!files) throw new NotFoundError("Files database not found");
    const sourceContext: TranscriptionSourceContext = { pool, filesDatabaseId: files.id, fileItemId };

    await runCreateStep(sourceContext);
    const transcriptId = await startTranscriptionAttempt(sourceContext);
    if (!transcriptId) return;
    const context: TranscriptionStepContext = { ...sourceContext, transcriptId };

    const transcriptionSteps = createTranscriptionSteps(
      blobStorage,
      resolveGatewayClient(),
      resolveSummaryClient(),
      summaryInstruction,
    );
    try {
      for (const step of transcriptionSteps) await step(context);
    } catch (err) {
      if (err instanceof TranscriptionLockedError) return;
      const budgetRejected = isBudgetRejection(err);
      const permanent = budgetRejected || helpers.job.attempts >= helpers.job.max_attempts;
      const message = err instanceof Error ? err.message : String(err);
      try {
        await withTransaction(pool, (client) => recordTranscriptionFailure(client, transcriptId, message, permanent));
      } catch (recordErr) {
        // The attempt's own failure is what the caller must see; this one is only logged.
        logger.error({ err: recordErr, transcriptId }, "Failed to record a transcription failure");
        throw err;
      }
      if (budgetRejected) {
        logger.warn({ err, transcriptId }, "Transcription rejected by the gateway budget; not retrying");
        return;
      }
      throw err;
    }
  };
}
