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
  TRANSCRIPT_DURATION_SECONDS_COMPUTED_KEY,
  TRANSCRIPT_FINALIZED_AT_COMPUTED_KEY,
  TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
  TRANSCRIPT_LANGUAGE_COMPUTED_KEY,
  TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY,
  TRANSCRIPTION_OWNER_PROCESS,
  transcriptionSourceLink,
  createItemWithClient,
  createRelationWithClient,
  createBlob,
  getBlob,
  enqueueTranscriptionJob,
  ensureItemAutomation,
  findIdempotentReplay,
  getTenantUserId,
  getItemById,
  getSystemTimezone,
  getDatabaseByModuleId,
  lockItemAutomation,
  lockItemById,
  listPropertiesByDatabase,
  markItemAutomationDone,
  readRecordingRequest,
  readBlobId,
  recordItemAutomationFailure,
  startItemAutomationAttempt,
  tenantBlobStorageKey,
  transcriptionJobPayloadSchema,
  updateItemWithClient,
  withTransaction,
  writeComputed,
  writeComputedAndAnnounce,
  writeNotification,
  LocalFsBlobStorageWriter,
  resolveBlobStorageDir,
} from "@semprec/data";
import type { BlobStorageWriter } from "@semprec/data";
import { NotFoundError, ValidationError } from "@semprec/data";
import type { ItemAutomationErrorCode, ItemRow } from "@semprec/data";
import {
  discardStoredAudio,
  downloadToTempFile,
  extractAudioChunkBytes,
  MediaToolError,
  normalizeAudio,
  probeMedia,
  probeNormalizedDuration,
  removeTempFile,
  renderPlaybackAudio,
  type MediaProbeResult,
  type NormalizedAudioResult,
} from "./mediaNormalization.js";
import { createHttpAiGatewayClient } from "@semprec/ai-gateway-client";
import { AiGatewayFailedError, type AiGatewayClientPort } from "@semprec/shared";
import { computeAsrChunkBoundaries } from "./asrChunking.js";
import {
  AudioGatewayBudgetExceededError,
  AudioGatewayCallError,
  createHttpAudioGatewayClient,
  type AudioGatewayClient,
} from "./audioGatewayClient.js";
import { logger } from "./logger.js";
import { mergeTranscriptSegments, type TranscriptSegment } from "./segmentMerge.js";
import {
  buildMeetingNotesRequest,
  emptyMeetingNotes,
  normalizeMeetingNotes,
  parseMeetingNotesContent,
  recordingDay,
} from "./transcriptSummary.js";
import { runEventMatch } from "./eventRecommendationStep.js";
import { runSpeakerSuggestion } from "./speakerSuggestionStep.js";
import { raiseTranscriptionProblem, resolveTranscriptionProblem } from "./transcriptionProblems.js";
import { linkTranscriptToUploadEvent } from "./uploadEventLink.js";

/** Source types an iOS player can play and seek as they are; any other type gets a rendition (`renderPlaybackAudio`). */
const DIRECTLY_PLAYABLE_MIME_TYPES: ReadonlySet<string> = new Set(["audio/mp4", "audio/mpeg", "audio/wav"]);

function isDirectlyPlayable(mimeType: string): boolean {
  return DIRECTLY_PLAYABLE_MIME_TYPES.has(mimeType.split(";")[0]!.trim().toLowerCase());
}

interface PrepareStepResult {
  normalizedBlobId: string;
  /** The original for a directly playable type, else the rendition. May be absent from older checkpoints. */
  playbackBlobId?: string | undefined;
  durationSeconds: number;
  /** The recording's own `creation_time`; `null` when it had none usable and `date` fell back to the upload time. */
  creationTime: string | null;
}

/** The source's `file` was replaced while ffmpeg ran. Nothing is written; retryable. */
export class TranscriptionSourceChangedError extends Error {
  constructor(fileItemId: string) {
    super(`Files item '${fileItemId}' changed its file while step 1 was normalizing it`);
    this.name = "TranscriptionSourceChangedError";
  }
}

/** A user locked the Transcriptions row; the pipeline stops without recording a failure. */
export class TranscriptionLockedError extends Error {
  constructor(transcriptId: string) {
    super(`Transcriptions item '${transcriptId}' was locked by a user`);
    this.name = "TranscriptionLockedError";
  }
}

/**
 * The transcript or its source is in Trash or gone. Thrown before any write or paid call; the
 * handler marks `item_automation` `error`/`deleted` and ends the job successfully.
 */
export class TranscriptionStoppedError extends Error {
  constructor(what: string, itemId: string) {
    super(`${what} '${itemId}' was deleted`);
    this.name = "TranscriptionStoppedError";
  }
}

/**
 * Shutdown (`helpers.abortSignal`) arrived between checkpoints. The handler re-enqueues a fresh
 * job that resumes from the written checkpoints instead of losing the step to a SIGKILL.
 */
export class TranscriptionInterruptedError extends Error {
  constructor(fileItemId: string, where: string) {
    super(`Shutdown requested while transcribing Files item '${fileItemId}' (${where})`);
    this.name = "TranscriptionInterruptedError";
  }
}

interface TranscriptionSourceContext {
  pool: Pool;
  filesDatabaseId: string;
  fileItemId: string;
}

interface TranscriptionStepContext extends TranscriptionSourceContext {
  transcriptId: string;
  shutdownRequested: () => boolean;
}

/** Called between checkpoints only, never inside a step's transaction. */
function throwIfShutdownRequested(context: TranscriptionStepContext, where: string): void {
  if (context.shutdownRequested()) throw new TranscriptionInterruptedError(context.fileItemId, where);
}

/** A step opens its own transactions (none held across slow work) and is a no-op once checkpointed. */
type TranscriptionStep = (context: TranscriptionStepContext) => Promise<void>;

async function lockTranscriptionItem(client: PoolClient, databaseId: string, itemId: string): Promise<ItemRow | null> {
  const item = await lockItemById(client, databaseId, itemId);
  if (!item) return null;
  const jsonObject = z.record(z.string(), z.unknown());
  return { ...item, properties: jsonObject.parse(item.properties), computed: jsonObject.parse(item.computed) };
}

function requireSource(source: ItemRow | null, fileItemId: string): ItemRow {
  if (!source) throw new TranscriptionStoppedError("Files item", fileItemId);
  return source;
}

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
  playbackBlobId: z.string().optional(),
  durationSeconds: z.number(),
  creationTime: z.string().nullable(),
});

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

function readAsrCheckpoint(source: ItemRow): AsrCheckpoint {
  const raw = source.computed[TRANSCRIPTION_ASR_COMPUTED_KEY];
  if (raw === undefined) return { language: null, chunks: {} };
  return asrCheckpointSchema.parse(raw);
}

/**
 * Bracketed phases run at `repeatable read` (the prepare write phase is the READ COMMITTED
 * exception). Uses `withTransaction` because only it fires the `runAfterCommit` invalidations
 * `updateItemWithClient` registers.
 */
function withRepeatableReadTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(pool, fn, { isolation: "repeatable_read" });
}

/**
 * Locks source, transcript and automation in that order until the caller's transaction ends, so a
 * user's lock cannot land between this check and the writes after it. Steps call it at entry and
 * before each checkpoint write or paid call. Returns the locked transcript row.
 */
export async function requireTranscriptionUnlocked(
  client: PoolClient,
  { filesDatabaseId, fileItemId, transcriptId }: TranscriptionStepContextIds,
): Promise<ItemRow> {
  const source = await lockTranscriptionItem(client, filesDatabaseId, fileItemId);
  const transcript = await lockTranscriptionItem(client, await requireTranscriptsDatabaseId(client), transcriptId);
  const automation = await lockItemAutomation(client, transcriptId);
  if (!source || source.deletedAt) throw new TranscriptionStoppedError("Files item", fileItemId);
  if (!transcript || transcript.deletedAt) throw new TranscriptionStoppedError("Transcriptions item", transcriptId);
  if (!automation) {
    throw new NotFoundError(`item_automation row for item '${transcriptId}' not found`, {
      resource: "item",
      itemId: transcriptId,
    });
  }
  if (automation.status === "locked") throw new TranscriptionLockedError(transcriptId);
  return transcript;
}

export type TranscriptionStepContextIds = Pick<
  TranscriptionStepContext,
  "filesDatabaseId" | "fileItemId" | "transcriptId"
>;

/**
 * Step 0, one transaction. `name` comes only from the upload's own name, never the filename. An
 * Event named by the upload gets the `event` edge here when it is live in this tenant; otherwise
 * step 6 matches as usual.
 */
async function runCreateStep({
  pool,
  filesDatabaseId,
  fileItemId,
}: TranscriptionSourceContext): Promise<string | null> {
  return withTransaction(pool, async (client) => {
    const source = await lockTranscriptionItem(client, filesDatabaseId, fileItemId);
    if (source && Object.hasOwn(source.computed, TRANSCRIPTION_CREATE_COMPUTED_KEY))
      return requireTranscriptId(source, fileItemId);
    const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
    if (!transcripts) throw new NotFoundError("Transcripts database not found");
    if (!source || source.deletedAt) {
      const prior = await findIdempotentReplay(client, transcripts.id, `transcription:${fileItemId}`);
      return prior?.id ?? null;
    }
    const recording = await readRecordingRequest(client, fileItemId);
    const blobId = readBlobId(source.properties);
    const sourceBlob = blobId ? await getBlob(client, blobId) : null;
    const provisionalDate = recording?.recordedAt ?? sourceBlob?.createdAt;
    const transcript = await createItemWithClient(
      client,
      {
        databaseId: transcripts.id,
        idempotencyKey: `transcription:${fileItemId}`,
        properties: {
          ...(recording?.name ? { name: recording.name } : {}),
          status: "processing",
          link: transcriptionSourceLink(fileItemId),
          ...(provisionalDate ? { date: provisionalDate } : {}),
        },
      },
      { allowedSystemKeys: ["status", "link", "date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
    );
    const lockedTranscript = await lockTranscriptionItem(client, transcripts.id, transcript.id);
    if (!lockedTranscript || lockedTranscript.deletedAt) return transcript.id;
    if (recording?.projectItemId) {
      const projects = await getDatabaseByModuleId(client, "projects");
      if (!projects) throw new Error("Projects database not found");
      const project = await lockItemById(client, projects.id, recording.projectItemId);
      if (project && !project.deletedAt) {
        const property = (await listPropertiesByDatabase(client, transcripts.id)).find(
          (entry) => entry.key === "project",
        );
        if (!property) throw new Error("Transcript project relation not found");
        await createRelationWithClient(client, {
          relationPropertyId: property.id,
          callerItemId: transcript.id,
          targetItemId: project.id,
        });
      }
    }
    if (recording?.eventId) await linkTranscriptToUploadEvent(client, transcript, recording.eventId);
    await ensureItemAutomation(client, transcript.id);
    await writeComputed(client, filesDatabaseId, fileItemId, TRANSCRIPTION_CREATE_COMPUTED_KEY, transcript.id);
    return transcript.id;
  });
}

/**
 * Step 1 (`prepare`): a read transaction captures the source blob, ffmpeg runs outside any
 * transaction, and a write transaction re-checks the source before writing.
 */
async function runPrepareStep(
  { pool, filesDatabaseId, fileItemId, transcriptId }: TranscriptionStepContext,
  blobStorage: BlobStorageWriter,
): Promise<void> {
  const snapshot = await withRepeatableReadTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, { filesDatabaseId, fileItemId, transcriptId });
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    if (Object.hasOwn(source.computed, TRANSCRIPTION_PREPARE_COMPUTED_KEY)) return null;
    const sourceBlobId = readBlobId(source.properties);
    if (!sourceBlobId) throw new ValidationError("Source file has no blob", { field: "file" });
    const sourceBlob = await getBlob(client, sourceBlobId);
    if (!sourceBlob) throw new NotFoundError(`Blob '${sourceBlobId}' not found`, { resource: "blob" });
    const normalizedStorageKey = await tenantBlobStorageKey(client, `transcriptions/${randomUUID()}.opus`);
    const playbackStorageKey = isDirectlyPlayable(sourceBlob.mimeType)
      ? null
      : await tenantBlobStorageKey(client, `transcriptions/${randomUUID()}.m4a`);
    return {
      sourceBlobId,
      storageKey: sourceBlob.storageKey,
      uploadedAt: sourceBlob.createdAt,
      normalizedStorageKey,
      playbackStorageKey,
    };
  });
  if (!snapshot) return;

  const tempPath = await downloadToTempFile(blobStorage, snapshot.storageKey);
  let probe: MediaProbeResult;
  let normalized: NormalizedAudioResult;
  let playback: NormalizedAudioResult | null = null;
  try {
    probe = await probeMedia(tempPath);
    normalized = await normalizeAudio(tempPath, blobStorage, snapshot.normalizedStorageKey);
    if (snapshot.playbackStorageKey !== null) {
      try {
        playback = await renderPlaybackAudio(tempPath, blobStorage, snapshot.playbackStorageKey);
      } catch (err) {
        await discardStoredAudio(blobStorage, normalized.storageKey);
        throw err;
      }
    }
  } finally {
    await removeTempFile(tempPath);
  }

  // Set once the blobs row pointing at the normalized audio is written. If COMMIT then fails,
  // whether that row committed is unknown, and deleting audio a committed row references would be
  // worse than leaving an unreferenced file behind.
  let referenced = false;
  try {
    // Segment times refer to normalized audio, whose duration can differ from its source container
    // when an audio track starts late or a video continues after the audio ends.
    const durationSeconds = await probeNormalizedDuration(blobStorage, normalized.storageKey);

    // READ COMMITTED: needs a fresh statement snapshot after the item locks.
    await withTransaction(pool, async (client) => {
      const isolation = await client.query<{ transaction_isolation: string }>("SHOW transaction_isolation");
      if (isolation.rows[0]?.transaction_isolation !== "read committed") {
        throw new Error("Recording prepare write requires READ COMMITTED isolation");
      }
      await requireTranscriptionUnlocked(client, { filesDatabaseId, fileItemId, transcriptId });
      // Locked, so the checks below still hold when this transaction's writes land.
      const source = requireSource(await lockItemById(client, filesDatabaseId, fileItemId), fileItemId);
      // A concurrent run finished step 1 first: its checkpoint stands and this run's audio is discarded.
      if (Object.hasOwn(source.computed, TRANSCRIPTION_PREPARE_COMPUTED_KEY)) return;
      if (readBlobId(source.properties) !== snapshot.sourceBlobId)
        throw new TranscriptionSourceChangedError(fileItemId);

      const recording = await readRecordingRequest(client, fileItemId);
      const normalizedBlob = await createBlob(client, {
        mimeType: "audio/ogg",
        byteSize: normalized.byteSize,
        storageKey: normalized.storageKey,
        contentHash: normalized.contentHash,
      });
      const playbackBlob = playback
        ? await createBlob(client, {
            mimeType: "audio/mp4",
            byteSize: playback.byteSize,
            storageKey: playback.storageKey,
            contentHash: playback.contentHash,
          })
        : null;
      const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
      if (!transcripts) throw new NotFoundError("Transcripts database not found");
      await updateItemWithClient(
        client,
        {
          databaseId: transcripts.id,
          itemId: transcriptId,
          propertiesPatch: { date: recording?.recordedAt ?? probe.creationTime ?? snapshot.uploadedAt },
        },
        { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      const result: PrepareStepResult = {
        normalizedBlobId: normalizedBlob.id,
        playbackBlobId: playbackBlob?.id ?? snapshot.sourceBlobId,
        durationSeconds,
        creationTime: probe.creationTime,
      };
      await writeComputed(client, filesDatabaseId, fileItemId, TRANSCRIPTION_PREPARE_COMPUTED_KEY, result);
      await writeComputedAndAnnounce(
        client,
        transcripts.id,
        transcriptId,
        TRANSCRIPT_DURATION_SECONDS_COMPUTED_KEY,
        durationSeconds,
      );
      referenced = true;
    });
  } finally {
    if (!referenced) {
      await discardStoredAudio(blobStorage, normalized.storageKey);
      if (playback) await discardStoredAudio(blobStorage, playback.storageKey);
    }
  }
}

/** Step 2 (`diarize`): one unchunked call over the whole recording, bracketed like step 1. */
async function runDiarizeStep(
  { pool, filesDatabaseId, fileItemId, transcriptId }: TranscriptionStepContext,
  blobStorage: BlobStorageWriter,
  gatewayClient: AudioGatewayClient,
): Promise<void> {
  const prepare = await withTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, { filesDatabaseId, fileItemId, transcriptId });
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    if (Object.hasOwn(source.computed, TRANSCRIPTION_DIARIZE_COMPUTED_KEY)) return null;
    return {
      prepare: requirePrepareCheckpoint(source, fileItemId),
      recording: await readRecordingRequest(client, fileItemId),
    };
  });
  if (!prepare) return;
  const recording = prepare.recording;
  const numSpeakers =
    recording?.numSpeakersExact != null
      ? { exact: recording.numSpeakersExact }
      : recording?.numSpeakersMin != null
        ? { min: recording.numSpeakersMin }
        : undefined;

  const blob = await withTransaction(pool, (client) => getBlob(client, prepare.prepare.normalizedBlobId));
  if (!blob) throw new NotFoundError(`Blob '${prepare.prepare.normalizedBlobId}' not found`, { resource: "blob" });

  const tempPath = await downloadToTempFile(blobStorage, blob.storageKey);
  let turns;
  try {
    const audio = await readFile(tempPath);
    turns = await gatewayClient.diarize({
      audio,
      filename: "recording.opus",
      mimeType: blob.mimeType,
      audioSeconds: prepare.prepare.durationSeconds,
      numSpeakers,
    });
  } finally {
    await removeTempFile(tempPath);
  }

  await withTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, { filesDatabaseId, fileItemId, transcriptId });
    // Locked, so a concurrent run that checkpointed first is not overwritten.
    const source = requireSource(await lockItemById(client, filesDatabaseId, fileItemId), fileItemId);
    if (Object.hasOwn(source.computed, TRANSCRIPTION_DIARIZE_COMPUTED_KEY)) return;
    await writeComputed(client, filesDatabaseId, fileItemId, TRANSCRIPTION_DIARIZE_COMPUTED_KEY, turns);
  });
}

/**
 * Step 3 (`ASR`): one call per overlapping chunk, each checkpointed so a crash repeats only
 * unfinished chunks. Chunk 0's detected language is passed to every later chunk, also on resume.
 */
async function runAsrStep(
  context: TranscriptionStepContext,
  blobStorage: BlobStorageWriter,
  gatewayClient: AudioGatewayClient,
): Promise<void> {
  const { pool, filesDatabaseId, fileItemId, transcriptId } = context;
  const prepare = await withTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, { filesDatabaseId, fileItemId, transcriptId });
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    return {
      prepare: requirePrepareCheckpoint(source, fileItemId),
      recording: await readRecordingRequest(client, fileItemId),
    };
  });
  const boundaries = computeAsrChunkBoundaries(prepare.prepare.durationSeconds);
  if (boundaries.length === 0) return;

  const alreadyDone = await withTransaction(pool, async (client) => {
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    const checkpoint = readAsrCheckpoint(source);
    return boundaries.every((_boundary, index) => Object.hasOwn(checkpoint.chunks, String(index)));
  });
  if (alreadyDone) return;

  const blob = await withTransaction(pool, (client) => getBlob(client, prepare.prepare.normalizedBlobId));
  if (!blob) throw new NotFoundError(`Blob '${prepare.prepare.normalizedBlobId}' not found`, { resource: "blob" });

  const tempPath = await downloadToTempFile(blobStorage, blob.storageKey);
  try {
    let language: string | null = null;
    for (let index = 0; index < boundaries.length; index += 1) {
      const boundary = boundaries[index]!;
      const current = await withTransaction(pool, async (client) => {
        await requireTranscriptionUnlocked(client, { filesDatabaseId, fileItemId, transcriptId });
        const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
        return readAsrCheckpoint(source);
      });
      const existingChunk = current.chunks[String(index)];
      if (existingChunk) {
        language = current.language;
        continue;
      }

      throwIfShutdownRequested(context, `ASR chunk ${index}`);
      const chunkAudio = await extractAudioChunkBytes(tempPath, boundary.start, boundary.end - boundary.start);
      const result = await gatewayClient.transcribe({
        audio: chunkAudio,
        filename: `chunk-${index}.opus`,
        mimeType: "audio/ogg",
        audioSeconds: boundary.end - boundary.start,
        language: index === 0 ? (prepare.recording?.language ?? undefined) : (language ?? undefined),
      });
      if (index === 0) language = result.language;

      await withTransaction(pool, async (client) => {
        await requireTranscriptionUnlocked(client, { filesDatabaseId, fileItemId, transcriptId });
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

function requireSegments(transcript: ItemRow): TranscriptSegment[] {
  const parsed = segmentsSchema.safeParse(transcript.computed[TRANSCRIPT_SEGMENTS_COMPUTED_KEY]);
  if (!parsed.success)
    throw new NotFoundError(`Transcripts item '${transcript.id}' has no '${TRANSCRIPT_SEGMENTS_COMPUTED_KEY}' yet`, {
      resource: "item",
      itemId: transcript.id,
    });
  return parsed.data;
}

function hasMeetingNotes(transcript: ItemRow): boolean {
  return Object.hasOwn(transcript.computed, TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY);
}

/** Step 4 (`merge`), one transaction. Written once, so speaker keys are never rewritten. */
async function runMergeStep({
  pool,
  filesDatabaseId,
  fileItemId,
  transcriptId,
}: TranscriptionStepContext): Promise<void> {
  await withTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, { filesDatabaseId, fileItemId, transcriptId });
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
 * Step 5 (`summarize`): meeting notes into `computed.meetingNotes`, bracketed like steps 2-3. The
 * prompt carries the recording's day in the tenant's time zone so relative due dates resolve.
 * No segments means empty notes without a paid call.
 */
async function runSummarizeStep(
  { pool, filesDatabaseId, fileItemId, transcriptId }: TranscriptionStepContext,
  summaryClient: AiGatewayClientPort,
): Promise<void> {
  const snapshot = await withRepeatableReadTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, { filesDatabaseId, fileItemId, transcriptId });
    const transcriptsDatabaseId = await requireTranscriptsDatabaseId(client);
    const transcript = requireTranscript(await getItemById(client, transcriptsDatabaseId, transcriptId), transcriptId);
    if (hasMeetingNotes(transcript)) return null;
    const language = z.string().nullable().parse(transcript.computed[TRANSCRIPT_LANGUAGE_COMPUTED_KEY]);
    const recordedAt = z.string().nullish().parse(transcript.properties.date) ?? null;
    const day = recordedAt === null ? null : recordingDay(recordedAt, await getSystemTimezone(client));
    return { transcriptsDatabaseId, segments: requireSegments(transcript), language, day };
  });
  if (!snapshot) return;

  let notes = emptyMeetingNotes();
  if (snapshot.segments.length > 0) {
    const result = await summaryClient.complete(
      buildMeetingNotesRequest(snapshot.segments, snapshot.language, snapshot.day),
    );
    notes = normalizeMeetingNotes(parseMeetingNotesContent(result.content), snapshot.segments);
  }

  await withTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, { filesDatabaseId, fileItemId, transcriptId });
    // Locked, so notes a concurrent run stored first are kept.
    const transcript = requireTranscript(
      await lockItemById(client, snapshot.transcriptsDatabaseId, transcriptId),
      transcriptId,
    );
    if (hasMeetingNotes(transcript)) return;
    await writeComputedAndAnnounce(
      client,
      snapshot.transcriptsDatabaseId,
      transcriptId,
      TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY,
      notes,
    );
  });
}

/**
 * Step 6 (`match`, see `runEventMatch`). A `done` transcript is not matched again, so a rerun never
 * re-links an Event or re-adds a card the user removed.
 */
function runMatchStep(context: TranscriptionStepContext, completionClient: AiGatewayClientPort): Promise<void> {
  const { pool, filesDatabaseId, fileItemId, transcriptId } = context;
  return runEventMatch(
    {
      pool,
      transcriptId,
      lockTranscription: (client) => requireTranscriptionUnlocked(client, context),
      readSource: async (client, lock) => {
        const source = requireSource(
          await (lock ? lockItemById : getItemById)(client, filesDatabaseId, fileItemId),
          fileItemId,
        );
        return { source, durationSeconds: requirePrepareCheckpoint(source, fileItemId).durationSeconds };
      },
    },
    completionClient,
  );
}

/** Step 7 (`suggestSpeakers`, see `runSpeakerSuggestion`). A `done` transcript gets no call, card or checkpoint. */
function runSuggestSpeakersStep(
  context: TranscriptionStepContext,
  completionClient: AiGatewayClientPort,
): Promise<void> {
  const { pool, filesDatabaseId, fileItemId, transcriptId } = context;
  return runSpeakerSuggestion(
    {
      pool,
      transcriptId,
      filesDatabaseId,
      fileItemId,
      skipFinished: true,
      lockRun: (client) => requireTranscriptionUnlocked(client, context),
      readSource: async (client, lock) =>
        requireSource(await (lock ? lockItemById : getItemById)(client, filesDatabaseId, fileItemId), fileItemId),
    },
    completionClient,
  );
}

/**
 * Step 8 (`finalize`): one transaction sets `status = done` and `item_automation` `done` only when it
 * sees committed `segments` and `meetingNotes`, and resolves the `transcription` problem. An already
 * `done` row only has `item_automation` settled again (this attempt reopened it as `pending`).
 */
async function runFinalizeStep({
  pool,
  filesDatabaseId,
  fileItemId,
  transcriptId,
}: TranscriptionStepContext): Promise<void> {
  await withTransaction(pool, async (client) => {
    await requireTranscriptionUnlocked(client, { filesDatabaseId, fileItemId, transcriptId });
    const transcriptsDatabaseId = await requireTranscriptsDatabaseId(client);
    const transcript = requireTranscript(await lockItemById(client, transcriptsDatabaseId, transcriptId), transcriptId);
    if (transcript.properties.status === "done") {
      await markItemAutomationDone(client, transcriptId);
      return;
    }
    requireSegments(transcript);
    if (!hasMeetingNotes(transcript))
      throw new NotFoundError(
        `Transcripts item '${transcriptId}' has no '${TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY}' yet`,
        {
          resource: "item",
          itemId: transcriptId,
        },
      );

    await updateItemWithClient(
      client,
      { databaseId: transcriptsDatabaseId, itemId: transcriptId, propertiesPatch: { status: "done" } },
      { allowedSystemKeys: ["status"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
    );
    await writeComputedAndAnnounce(
      client,
      transcriptsDatabaseId,
      transcriptId,
      TRANSCRIPT_FINALIZED_AT_COMPUTED_KEY,
      new Date().toISOString(),
    );
    await markItemAutomationDone(client, transcriptId);
    await resolveTranscriptionProblem(client, transcriptId);
  });
}

function createTranscriptionSteps(
  blobStorage: BlobStorageWriter,
  gatewayClient: AudioGatewayClient,
  summaryClient: AiGatewayClientPort,
): readonly TranscriptionStep[] {
  return [
    (context) => runPrepareStep(context, blobStorage),
    (context) => runDiarizeStep(context, blobStorage, gatewayClient),
    (context) => runAsrStep(context, blobStorage, gatewayClient),
    runMergeStep,
    (context) => runSummarizeStep(context, summaryClient),
    (context) => runMatchStep(context, summaryClient),
    (context) => runSuggestSpeakersStep(context, summaryClient),
    runFinalizeStep,
  ];
}

/** Counts the attempt and moves the row to `pending`; `null` when a target is deleted or locked. */
async function startTranscriptionAttempt(
  { pool, filesDatabaseId, fileItemId }: TranscriptionSourceContext,
  transcriptId: string,
): Promise<string | null> {
  return withTransaction(pool, async (client) => {
    const source = await lockTranscriptionItem(client, filesDatabaseId, fileItemId);
    const transcript = await lockTranscriptionItem(client, await requireTranscriptsDatabaseId(client), transcriptId);
    const automation = await lockItemAutomation(client, transcriptId);
    if (!source || source.deletedAt || !transcript || transcript.deletedAt) {
      if (automation && automation.status !== "locked")
        await recordItemAutomationFailure(
          client,
          transcriptId,
          "Transcript or source file deleted",
          "error",
          "deleted",
        );
      return null;
    }
    if (requireTranscriptId(source, fileItemId) !== transcriptId)
      throw new Error("Transcription checkpoint changed before the attempt started");
    await ensureItemAutomation(client, transcriptId);
    const started = await startItemAutomationAttempt(client, transcriptId);
    return started ? transcriptId : null;
  });
}

export function classifyTranscriptionFailure(err: unknown): ItemAutomationErrorCode {
  if (isBudgetRejection(err)) return "budgetExceeded";
  if (err instanceof MediaToolError) return "mediaUnreadable";
  if (err instanceof AudioGatewayCallError || err instanceof AiGatewayFailedError) return "providerFailed";
  return "unknown";
}

function isBudgetRejection(err: unknown): boolean {
  return (
    err instanceof AudioGatewayBudgetExceededError ||
    (err instanceof AiGatewayFailedError && err.reason === "budget_exceeded")
  );
}

/**
 * Records a failed attempt in one transaction. While retries remain only `item_automation.error`
 * is written. A permanent failure also sets `status = error`, writes one `automation_error`
 * notification keyed by the cumulative attempt count (replay-safe) and raises the `transcription`
 * problem. A `done` transcript records the failure in `item_automation` only. Missing or trashed
 * targets mark an unlocked automation `error`/`deleted`.
 */
async function recordTranscriptionFailure(
  client: PoolClient,
  { filesDatabaseId, fileItemId, transcriptId }: TranscriptionStepContextIds,
  message: string,
  errorCode: ItemAutomationErrorCode,
  permanent: boolean,
): Promise<"recorded" | "locked" | "deleted"> {
  const source = await lockTranscriptionItem(client, filesDatabaseId, fileItemId);
  const transcriptsDatabaseId = await requireTranscriptsDatabaseId(client);
  const transcript = await lockTranscriptionItem(client, transcriptsDatabaseId, transcriptId);
  const automation = await lockItemAutomation(client, transcriptId);
  if (!source || source.deletedAt || !transcript || transcript.deletedAt) {
    if (automation && automation.status !== "locked")
      await recordItemAutomationFailure(client, transcriptId, message, "error", "deleted");
    return "deleted";
  }
  if (!automation)
    throw new NotFoundError(`item_automation row for item '${transcriptId}' not found`, {
      resource: "item",
      itemId: transcriptId,
    });
  if (automation.status === "locked") return "locked";
  const written = await recordItemAutomationFailure(
    client,
    transcriptId,
    message,
    permanent ? "error" : "pending",
    errorCode,
  );
  if (!written) throw new Error(`item_automation row for item ${transcriptId} was not updated while locked`);
  if (!permanent || transcript.properties.status === "done") return "recorded";

  await updateItemWithClient(
    client,
    {
      databaseId: transcriptsDatabaseId,
      itemId: transcriptId,
      propertiesPatch: { status: "error" },
    },
    { allowedSystemKeys: ["status"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
  );
  const userId = await getTenantUserId(client);
  if (!userId) {
    logger.warn({ transcriptId }, "No user to notify about a permanent transcription failure");
    return "recorded";
  }
  await writeNotification(client, {
    userId,
    kind: "automation_error",
    linkHref: `?page=transcript&id=${transcriptId}`,
    sourceTable: "item_automation",
    sourceId: transcriptId,
    transitionInstance: `attempt:${automation.attempts}`,
  });
  await raiseTranscriptionProblem(client, { userId, transcriptId, attempts: automation.attempts });
  return "recorded";
}

export interface TranscriptionJobHelpers {
  job: { attempts: number; max_attempts: number };
  /** Aborted `gracefulShutdownAbortTimeout` after `Runner.stop()` begins. */
  abortSignal?: AbortSignal;
}

function requireGatewayInternalToken(): string {
  const token = process.env.AI_GATEWAY_INTERNAL_TOKEN;
  if (!token) throw new Error("AI_GATEWAY_INTERNAL_TOKEN is not set");
  return token;
}

class TranscriptionQueueError extends Error {
  readonly code: ItemAutomationErrorCode;

  constructor(code: ItemAutomationErrorCode) {
    super("Transcription task failed");
    this.name = "TranscriptionQueueError";
    this.code = code;
  }
}

export function createTranscriptionCreateTask(pool: Pool) {
  return async (payload: unknown): Promise<void> => {
    const { fileItemId } = transcriptionJobPayloadSchema.parse(payload);
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, FILES_MODULE_ID));
    if (!files) throw new NotFoundError("Files database not found");
    await runCreateStep({ pool, filesDatabaseId: files.id, fileItemId });
  };
}

/**
 * Runs the steps in order; each skips itself once checkpointed, so a retry resumes without
 * repeating a paid call. A budget rejection is permanent at once: the job completes after
 * recording it instead of spending retries. On shutdown the job is re-enqueued and returns
 * normally, spending none of its attempts. All AI calls go through semprec-ai-gateway.
 */
export function createTranscriptionTask(
  pool: Pool,
  blobStorage: BlobStorageWriter = new LocalFsBlobStorageWriter(resolveBlobStorageDir("FILES_STORAGE_DIR")),
  gatewayClient?: AudioGatewayClient,
  summaryClient?: AiGatewayClientPort,
) {
  // Lazy, so callers that never reach step 2 do not need AI_GATEWAY_INTERNAL_TOKEN set.
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

  const run = async (payload: unknown, helpers: TranscriptionJobHelpers): Promise<void> => {
    const { fileItemId } = transcriptionJobPayloadSchema.parse(payload);
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, FILES_MODULE_ID));
    if (!files) throw new NotFoundError("Files database not found");
    const sourceContext: TranscriptionSourceContext = { pool, filesDatabaseId: files.id, fileItemId };

    const createdTranscriptId = await runCreateStep(sourceContext);
    if (!createdTranscriptId) return;
    const transcriptId = await startTranscriptionAttempt(sourceContext, createdTranscriptId);
    if (!transcriptId) return;
    const context: TranscriptionStepContext = {
      ...sourceContext,
      transcriptId,
      shutdownRequested: () => helpers.abortSignal?.aborted === true,
    };

    const transcriptionSteps = createTranscriptionSteps(blobStorage, resolveGatewayClient(), resolveSummaryClient());
    try {
      for (const step of transcriptionSteps) {
        throwIfShutdownRequested(context, "between steps");
        await step(context);
      }
    } catch (err) {
      if (err instanceof TranscriptionLockedError) return;
      if (err instanceof TranscriptionStoppedError) {
        await withTransaction(pool, async (client) => {
          const automation = await lockItemAutomation(client, transcriptId);
          if (!automation || automation.status === "locked") return;
          await recordItemAutomationFailure(client, transcriptId, err.message, "error", "deleted");
        });
        logger.info({ transcriptId, fileItemId }, "Transcript or source file deleted; transcription stopped");
        return;
      }
      if (err instanceof TranscriptionInterruptedError) {
        await withTransaction(pool, (client) => enqueueTranscriptionJob(client, { fileItemId }));
        logger.info(
          { transcriptId, fileItemId },
          "Shutdown requested; re-enqueued the transcription to resume from its checkpoints",
        );
        return;
      }
      const budgetRejected = isBudgetRejection(err);
      const permanent = budgetRejected || helpers.job.attempts >= helpers.job.max_attempts;
      const message = err instanceof Error ? err.message : String(err);
      const errorCode = classifyTranscriptionFailure(err);
      let outcome: Awaited<ReturnType<typeof recordTranscriptionFailure>>;
      try {
        outcome = await withTransaction(pool, (client) =>
          recordTranscriptionFailure(client, context, message, errorCode, permanent),
        );
      } catch {
        // The attempt's own failure is what the caller must see; this one is only logged.
        logger.error({ transcriptId }, "Failed to record a transcription failure");
        throw err;
      }
      if (outcome === "deleted") {
        logger.info({ transcriptId, fileItemId }, "Transcript deleted; transcription stopped without a failure");
        return;
      }
      if (budgetRejected) {
        logger.warn({ errorCode, transcriptId }, "Transcription rejected by the gateway budget; not retrying");
        return;
      }
      throw err;
    }
  };
  return async (payload: unknown, helpers: TranscriptionJobHelpers): Promise<void> => {
    try {
      await run(payload, helpers);
    } catch (error) {
      throw new TranscriptionQueueError(classifyTranscriptionFailure(error));
    }
  };
}
