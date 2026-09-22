import type { PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";

/** The sole process allowed to write Transcriptions' system-owned fields. */
export const TRANSCRIPTION_OWNER_PROCESS = "transcribe";

/** Issue #180's fixed job-key scheme: a repeat enqueue for the same file converges onto one job (`jobKeyMode` default `'replace'`), satisfying "repeated delivery converges on one job" without any extra dedup check. */
export function transcriptionJobKey(fileItemId: string): string {
  return `transcription-job:${fileItemId}`;
}

export const transcriptionJobPayloadSchema = z.object({ fileItemId: z.string().uuid() });
export type TranscriptionJobPayload = z.infer<typeof transcriptionJobPayloadSchema>;

export interface EnqueueTranscriptionJobInput {
  fileItemId: string;
}

/**
 * Shared by both producers (the Files `onItemEvent:create` trigger and `POST /api/transcriptions`)
 * so the job-key/task-name pairing can't drift between them. Takes an already-open `client` so a
 * caller can enqueue inside its own transaction (state-writes: the enqueue is the write here,
 * there is nothing else to gate it against).
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
