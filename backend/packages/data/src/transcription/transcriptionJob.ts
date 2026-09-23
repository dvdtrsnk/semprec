import type { PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";

/** The sole process allowed to write Transcriptions' system-owned fields. */
export const TRANSCRIPTION_OWNER_PROCESS = "transcribe";

/** Issue #180's fixed job-key scheme: a repeat enqueue for the same file converges onto one job (`jobKeyMode` default `'replace'`), satisfying "repeated delivery converges on one job" without any extra dedup check. */
export function transcriptionJobKey(fileItemId: string): string {
  return `transcription-job:${fileItemId}`;
}

const TRANSCRIPTION_SOURCE_LINK_PREFIX = "semprec://items/";

/** The Transcriptions row's `link`: the Files item it was transcribed from, which is also its job's key. */
export function transcriptionSourceLink(fileItemId: string): string {
  return `${TRANSCRIPTION_SOURCE_LINK_PREFIX}${fileItemId}`;
}

/**
 * Reads the Files item id back out of a Transcriptions row's `link` (issue #186's requeue and
 * rerun paths), or `null` when the value is not a link `transcriptionSourceLink` produced — the
 * property is read from a JSONB column, so it is checked here rather than trusted.
 */
export function readTranscriptionSourceFileItemId(link: unknown): string | null {
  if (typeof link !== "string" || !link.startsWith(TRANSCRIPTION_SOURCE_LINK_PREFIX)) return null;
  const parsed = z.string().uuid().safeParse(link.slice(TRANSCRIPTION_SOURCE_LINK_PREFIX.length));
  return parsed.success ? parsed.data : null;
}

export const transcriptionJobPayloadSchema = z.object({ fileItemId: z.string().uuid() });
export type TranscriptionJobPayload = z.infer<typeof transcriptionJobPayloadSchema>;

export interface EnqueueTranscriptionJobInput {
  fileItemId: string;
}

/**
 * Shared by every producer (the Files `onItemEvent:create` trigger, `POST /api/transcriptions`,
 * the daily requeue sweep and `POST /api/transcriptions/:id/rerun`) so the job-key/task-name
 * pairing can't drift between them. A repeat enqueue replaces a still-queued job under the same
 * key with a fresh batch; one graphile-worker has exhausted is detached from the key and never
 * runs again, while the fresh batch takes the key — either way one runnable job per file. Takes an already-open `client` so a
 * caller can enqueue inside its own transaction (state-writes: the enqueue is the write here,
 * there is nothing else to gate it against). `maxAttempts: 3` with graphile-worker's built-in
 * exponential backoff is the job's retry policy (issue #248); every attempt resumes from the
 * pipeline's checkpoints.
 */
export async function enqueueTranscriptionJob(client: PoolClient, input: EnqueueTranscriptionJobInput): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.TRANSCRIPTION_JOB,
    { fileItemId: input.fileItemId },
    { jobKey: transcriptionJobKey(input.fileItemId), maxAttempts: 3 },
  );
}

/**
 * Whether a `transcriptionJob` is already queued for this file (`POST /api/transcriptions`'s
 * `transcription_exists` 409 check) — graphile-worker deletes a job row on success, so this only
 * ever reports a still in-flight or failed-but-not-yet-cleared job, not a long-completed one; this
 * issue ships no consumer that ever completes the job, so that gap is out of its scope.
 */
export async function findTranscriptionJobId(client: PoolClient, fileItemId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM graphile_worker.jobs WHERE key = $1`,
    [transcriptionJobKey(fileItemId)],
  );
  return rows[0]?.id ?? null;
}

/**
 * Issue #180's Task explicitly excludes the actual transcription pipeline ("no special upload
 * endpoint or paid pipeline yet") — this handler only proves the job is well-formed and
 * processable; a later issue replaces this body with the real work (calling the AI gateway,
 * writing the Transcripts item). Deliberately performs no item write of its own.
 */
export async function handleTranscriptionJobTask(payload: unknown): Promise<void> {
  transcriptionJobPayloadSchema.parse(payload);
}
