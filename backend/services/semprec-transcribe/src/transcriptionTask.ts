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
  TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY,
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
  proposeSpeakerMappings,
  readSpeakerSuggestionContext,
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
import { buildSpeakerSuggestionRequest, parseSpeakerSuggestionContent } from "./speakerSuggestion.js";
import { raiseTranscriptionProblem, resolveTranscriptionProblem } from "./transcriptionProblems.js";
import { linkTranscriptToUploadEvent } from "./uploadEventLink.js";

/** Source types an iOS player can play and seek as they are; any other type gets a rendition (`renderPlaybackAudio`). */
const DIRECTLY_PLAYABLE_MIME_TYPES: ReadonlySet<string> = new Set(["audio/mp4", "audio/mpeg", "audio/wav"]);

function isDirectlyPlayable(mimeType: string): boolean {
  return DIRECTLY_PLAYABLE_MIME_TYPES.has(mimeType.split(";")[0]!.trim().toLowerCase());
}

interface PrepareStepResult {
  normalizedBlobId: string;
  /** The blob the app plays and seeks on the segments' timeline: the original for a directly playable type, else the rendition's. Absent from checkpoints written before this field existed. */
  playbackBlobId?: string | undefined;
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

/**
 * The Transcriptions row or its source Files item is in Trash or gone. Thrown by a step's first
 * read, before it writes or makes a paid call; the handler marks `item_automation` `error`/`deleted`
 * and ends the job successfully, with no notification.
 */
export class TranscriptionStoppedError extends Error {
  constructor(what: string, itemId: string) {
    super(`${what} '${itemId}' was deleted`);
    this.name = "TranscriptionStoppedError";
  }
}

/**
 * A shutdown signal (graphile-worker's `Runner.stop()` aborting `helpers.abortSignal`) arrived
 * between checkpoints. Thrown instead of letting the step continue, so the handler's `catch`
 * re-enqueues a fresh job to resume from the checkpoints already written rather than losing the
 * in-flight step to a SIGKILL.
 */
export class TranscriptionInterruptedError extends Error {
  constructor(fileItemId: string, where: string) {
    super(`Shutdown requested while transcribing Files item '${fileItemId}' (${where})`);
    this.name = "TranscriptionInterruptedError";
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
  /** True once graphile-worker's `Runner.stop()` has begun; checked between checkpoints via `throwIfShutdownRequested`. */
  shutdownRequested: () => boolean;
}

/** Throws `TranscriptionInterruptedError` when the step context's shutdown signal has fired. Called between checkpoints, never mid-write, so it never interrupts a step's own transaction. */
function throwIfShutdownRequested(context: TranscriptionStepContext, where: string): void {
  if (context.shutdownRequested()) throw new TranscriptionInterruptedError(context.fileItemId, where);
}

/**
 * One checkpointed step. It opens its own transactions, so a step doing slow non-database work
 * (step 1's ffmpeg) never holds one open across it, and it is a no-op once its checkpoint exists.
 */
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
  playbackBlobId: z.string().optional(),
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
 * `withTransaction` at `repeatable read`, the default for bracketed transaction phases.
 * The prepare write phase uses the narrower recording-specific READ COMMITTED exception.
 * The isolation level is set by `withTransaction`'s `isolation` option on the `BEGIN` itself.
 * Built on `withTransaction` rather than `createPoolClientTransactionRunner` because only the
 * former fires the `runAfterCommit` invalidations `updateItemWithClient` registers.
 */
function withRepeatableReadTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(pool, fn, { isolation: "repeatable_read" });
}

/**
 * Locks the Files source, transcript and automation in that order in the caller's transaction and throws
 * `TranscriptionLockedError` when a user locked it. Held until that transaction ends, so a user's
 * lock cannot land between this check and the writes after it — it waits for them to commit.
 * Each step checks at entry, and again before a checkpoint write or the next chunk's paid call,
 * so a lock set while a step runs stops the pipeline before its next write or paid call.
 * Then throws `TranscriptionStoppedError` when the transcript or the source Files item is in
 * Trash or gone, so no step writes to or pays for deleted data. Returns the transcript row it
 * locked, for a step that decides on the transcript's `status`.
 */
async function requireTranscriptionUnlocked(
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

type TranscriptionStepContextIds = Pick<TranscriptionStepContext, "filesDatabaseId" | "fileItemId" | "transcriptId">;

/**
 * Step 0: database-only, so one transaction covers the checkpoint check, the Transcripts row and the
 * checkpoint. The transcript's `name` is written only from the upload's own name (`recording_requests.name`),
 * when it set one, and never from the Files item's filename (issue #1830). When the upload named an Event
 * (`recording_requests.event_item_id`, issue #1644), the same transaction writes the Transcripts `event` edge
 * to it, provided the Event is still in this tenant's Events database and not in the Trash; otherwise no edge
 * is written and step 6 matches the transcript as usual. See docs/adr/2026-11-10-transcription-create-writes-the-uploads-event.md.
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
          // The user-owned `name` comes only from the upload's own name, never from the filename (issue #1830).
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

    // The recording prepare ADR requires a fresh statement snapshot after the item reservations.
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
 * Step 3 (`ASR`): calls `gateway.transcribe()` once per 20-minute, 30-second-overlap chunk of the
 * normalized recording (`computeAsrChunkBoundaries`), checkpointing each chunk's raw result right
 * after it completes so a crash mid-stage repeats only the unfinished chunks. The language detected
 * on chunk 0 is passed explicitly to every later chunk, including across a resume.
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

/** Whether step 5 has stored the transcript's `meetingNotes` (issue #1695). */
function hasMeetingNotes(transcript: ItemRow): boolean {
  return Object.hasOwn(transcript.computed, TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY);
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
 * Step 5 (`summarize`, issue #1695): asks `gateway.complete()` for structured meeting notes over the
 * merged transcript and stores them, normalized, as `computed.meetingNotes`. The prompt carries the
 * recording's calendar day and weekday in the tenant's time zone (`Transcripts.date` with
 * `getSystemTimezone`), so the model can resolve a relative due date. Skipped when `meetingNotes`
 * already exists, so a retry after a stored result makes no second paid call. Bracketed like steps 2
 * and 3: the gateway call runs outside any transaction, and the write transaction re-checks the key
 * under the transcript's row lock, so a concurrent run's notes are kept. A transcript with no
 * segments (no speech) gets empty notes without a paid call. Older `summaryByInstruction` values are
 * left as they are; no new one is written.
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
 * Step 6 (`match`): links the one Event whose time interval overlaps the recording's interval, or
 * otherwise creates the transcript's single suggestion card; with two or more overlapping Events one
 * paid call recommends one of them (`runEventMatch`, issue #1848). A retry of an unfinished transcript
 * converges: an existing card, or an existing edge to an Event that is not in the Trash, is left as it
 * is; an edge to an Event in the Trash is no link (issue #1743). A transcript whose `status` is already
 * `done` is not matched at all (issue #1712), so a later run of its job neither links an Event again
 * nor adds a card after the user removed the edge. The status is read from the row `lockTranscription`
 * locked. See docs/adr/2026-11-10-finished-transcripts-are-not-matched-or-suggested-again.md.
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

/**
 * Step 7 (`suggestSpeakers`): proposes a card for each unmapped speaker. When candidates exist,
 * one gateway call suggests mappings; otherwise cards need clarification without a call. The
 * gateway call runs outside the transactions, and cards and checkpoint commit together. A replay
 * after that commit makes no second call; a crash before commit can repeat the call. A user must
 * confirm a card before a mapping is written. A transcript whose `status` is already `done` gets no
 * call, no card and no checkpoint (issue #1712), whether or not the checkpoint exists: the status is
 * read from the locked row before the call, and again in the transaction that would write the cards.
 * See docs/adr/2026-11-10-finished-transcripts-are-not-matched-or-suggested-again.md.
 */
async function runSuggestSpeakersStep(
  { pool, filesDatabaseId, fileItemId, transcriptId }: TranscriptionStepContext,
  completionClient: AiGatewayClientPort,
): Promise<void> {
  const snapshot = await withRepeatableReadTransaction(pool, async (client) => {
    const locked = await requireTranscriptionUnlocked(client, { filesDatabaseId, fileItemId, transcriptId });
    if (locked.properties.status === "done") return null;
    const source = requireSource(await getItemById(client, filesDatabaseId, fileItemId), fileItemId);
    if (Object.hasOwn(source.computed, TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY)) return null;
    const transcriptsDatabaseId = await requireTranscriptsDatabaseId(client);
    const transcript = requireTranscript(await getItemById(client, transcriptsDatabaseId, transcriptId), transcriptId);
    const segments = requireSegments(transcript);
    const context = await readSpeakerSuggestionContext(client, transcriptId);
    return context ? { segments, context } : null;
  });
  if (!snapshot) return;

  const suggestions = snapshot.context.candidates.length
    ? parseSpeakerSuggestionContent(
        (await completionClient.complete(buildSpeakerSuggestionRequest(snapshot.segments, snapshot.context))).content,
      )
    : [];

  await withTransaction(pool, async (client) => {
    const locked = await requireTranscriptionUnlocked(client, { filesDatabaseId, fileItemId, transcriptId });
    // A run that finished the transcript while the call was out leaves it as that run left it.
    if (locked.properties.status === "done") return;
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
 * `segments` and `meetingNotes` (issue #1695) — a run that failed before either landed leaves the
 * row as the failure handling in `createTranscriptionTask` records it. `status` goes through
 * `updateItemWithClient`, which announces it over the generic realtime channel. The same transaction
 * resolves the transcript's `transcription` Semp problem as `recovered` (issue gh-1945). A row that is
 * already `done` only has its `item_automation` settled again, since the attempt that reached this
 * step reopened it as `pending`.
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

/** Steps 1–8; step 0 runs before them, since it creates the row the attempt is counted on. */
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

/**
 * Opens this attempt on the Transcriptions row step 0 created: counts it in the cumulative
 * `item_automation.attempts` and moves the row back to `pending`. Returns the row's id, or `null`
 * when a target is deleted or a user locked the automation.
 */
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

/** A rejection by the gateway's budget caps: no retry can succeed until the cap resets, so the failure is permanent at once. */
/**
 * Maps a pipeline failure onto the stable code stored beside its diagnostic message: budget
 * exhaustion, an `ffmpeg`/`ffprobe` failure, any other gateway failure, otherwise `unknown`.
 */
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
 * Records a failed attempt on the Transcriptions row, all in one transaction. While retries
 * remain, only `item_automation.error` and `error_code` are written and the row stays `pending`/`processing`. A
 * permanent failure also sets `item_automation.status = 'error'` and `status = error`, and writes
 * one `automation_error` notification keyed by the cumulative attempt count, so replaying the same
 * attempt's failure never adds a second one while every later permanent failure gets its own. The
 * same transaction raises the transcript's `transcription` Semp problem after the notification (issue
 * gh-1945), counting the attempt as its occurrence, so a repeated permanent failure merges into the
 * one active problem; a tenant without a user gets neither the notification nor the problem.
 * A permanent failure of a re-run of a transcript whose `status` is already `done` (issue #1712's
 * meeting-notes backfill, a manual rerun) is recorded in `item_automation` only: `status` stays
 * `done` and no notification or problem is written, because the user's finished transcript is still complete.
 * Missing or trashed targets stop without an item update or notification; an existing unlocked
 * automation is marked `error`/`deleted`. A locked automation remains unchanged.
 * Returns `"locked"` for a live target with a user lock, `"deleted"` for the stop, otherwise `"recorded"`.
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

/** The part of graphile-worker's `JobHelpers` this task reads: which attempt of how many this run is. */
export interface TranscriptionJobHelpers {
  job: { attempts: number; max_attempts: number };
  /** graphile-worker 0.17 aborts this `gracefulShutdownAbortTimeout` (5s) after `Runner.stop()` begins. Optional so existing tests' `{ job: {...} }` helpers keep compiling. */
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

/** Creates the transcript checkpoint without entering the media pipeline. */
export function createTranscriptionCreateTask(pool: Pool) {
  return async (payload: unknown): Promise<void> => {
    const { fileItemId } = transcriptionJobPayloadSchema.parse(payload);
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, FILES_MODULE_ID));
    if (!files) throw new NotFoundError("Files database not found");
    await runCreateStep({ pool, filesDatabaseId: files.id, fileItemId });
  };
}

/**
 * Runs each declared transcription step in order; each skips itself once its checkpoint exists,
 * so a retried attempt (`transcriptionJob` is enqueued with `max_attempts: 3` and graphile-worker's
 * built-in exponential backoff) resumes from the last checkpoint without repeating a paid call.
 * Every attempt is counted on the Transcriptions row's `item_automation`, and a row a user locked
 * is left alone — checked at step entry and before checkpoint writes (`requireTranscriptionUnlocked`),
 * so a lock set mid-run keeps the running step's pending write from landing. A failure
 * is recorded by `recordTranscriptionFailure` and a safe error reaches graphile-worker for retry, except a
 * budget rejection: that is permanent at once, so once recorded the job completes instead of
 * spending its remaining attempts on calls the gateway will reject. A failure in step 0 happens
 * before there is a Transcriptions row to record it on and is returned as a safe error. When
 * `helpers.abortSignal` fires (graphile-worker's `Runner.stop()`, given the systemd unit's
 * `TimeoutStopSec` to let the in-flight chunk finish and checkpoint), the next
 * `throwIfShutdownRequested` check — before a step or an ASR chunk — throws
 * `TranscriptionInterruptedError`; the handler re-enqueues a fresh job for the same file and
 * returns normally, recording no failure, so the interrupted attempt spends none of the job's
 * three attempts and resumes from the checkpoints already written.
 * `blobStorage` defaults to the same local-filesystem backend semprec-api writes Files blobs to
 * (issue #246), configured via `FILES_STORAGE_DIR`. `gatewayClient` defaults to a loopback HTTP
 * client for `semprec-ai-gateway`'s `/internal/diarize` and `/internal/transcribe` routes
 * (issue #182), and `summaryClient` to `@semprec/ai-gateway-client`'s client for its
 * `/internal/complete` route (issue #183) — also the client step 7 suggests speaker mappings
 * with (issue #185) — both configured via
 * `AI_GATEWAY_PORT`/`AI_GATEWAY_INTERNAL_TOKEN` — the only path from this service to an AI
 * provider, per `docs/adr/2026-09-10-ai-gateway-monopoly-on-provider-calls.md`.
 */
export function createTranscriptionTask(
  pool: Pool,
  blobStorage: BlobStorageWriter = new LocalFsBlobStorageWriter(resolveBlobStorageDir("FILES_STORAGE_DIR")),
  gatewayClient?: AudioGatewayClient,
  summaryClient?: AiGatewayClientPort,
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
