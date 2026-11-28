import type { PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, cancelJob, enqueueJob } from "@alldots/queue";
import { tenantLane } from "../tenancy/tenantLane.js";

/** The sole process allowed to write Transcriptions' system-owned fields. */
export const TRANSCRIPTION_OWNER_PROCESS = "transcribe";

/** A repeat enqueue for the same file converges onto one job (`jobKeyMode` default `'replace'`). */
export function transcriptionJobKey(fileItemId: string): string {
  return `transcription-job:${fileItemId}`;
}

export function transcriptionCreateJobKey(fileItemId: string): string {
  return `transcription-create:${fileItemId}`;
}

const TRANSCRIPTION_SOURCE_LINK_PREFIX = "alldots://items/";

/** The Files item it was transcribed from, which is also its job's key. */
export function transcriptionSourceLink(fileItemId: string): string {
  return `${TRANSCRIPTION_SOURCE_LINK_PREFIX}${fileItemId}`;
}

/** `null` when not a link `transcriptionSourceLink` produced: the value comes from JSONB, so it is checked, not trusted. */
export function readTranscriptionSourceFileItemId(link: unknown): string | null {
  if (typeof link !== "string" || !link.startsWith(TRANSCRIPTION_SOURCE_LINK_PREFIX)) return null;
  const parsed = z.string().uuid().safeParse(link.slice(TRANSCRIPTION_SOURCE_LINK_PREFIX.length));
  return parsed.success ? parsed.data : null;
}

export const transcriptionJobPayloadSchema = z.object({ fileItemId: z.string().uuid() });
export type TranscriptionJobPayload = z.infer<typeof transcriptionJobPayloadSchema>;

const TRANSCRIPTION_LANE = "transcription";

export interface EnqueueTranscriptionJobInput {
  fileItemId: string;
}

/**
 * Shared by every producer so the job-key/task-name pairing cannot drift. A repeat enqueue replaces a
 * still-queued job with a fresh batch; an exhausted job is detached from the key and never runs again,
 * so there is one runnable job per file. Takes an open `client` so a caller can enqueue inside its own
 * transaction. Every attempt resumes from the pipeline's checkpoints.
 */
export async function enqueueTranscriptionJob(client: PoolClient, input: EnqueueTranscriptionJobInput): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.TRANSCRIPTION_JOB,
    { fileItemId: input.fileItemId },
    { jobKey: transcriptionJobKey(input.fileItemId), maxAttempts: 3, queueName: tenantLane(TRANSCRIPTION_LANE) },
  );
}

/** Independent of the long transcription lane. */
export async function enqueueTranscriptionCreate(
  client: PoolClient,
  input: EnqueueTranscriptionJobInput,
): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.TRANSCRIPTION_CREATE,
    { fileItemId: input.fileItemId },
    {
      jobKey: transcriptionCreateJobKey(input.fileItemId),
      maxAttempts: 3,
      queueName: tenantLane("transcription-create"),
    },
  );
}

/**
 * Backs the `transcription_exists` 409 check. graphile-worker deletes a job row on success, so this
 * only reports a still in-flight or failed-but-not-cleared job.
 */
export async function findTranscriptionJobId(client: PoolClient, fileItemId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM graphile_worker.jobs WHERE key = $1`,
    [transcriptionJobKey(fileItemId)],
  );
  return rows[0]?.id ?? null;
}

export async function findTranscriptionCreateJobId(client: PoolClient, fileItemId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM graphile_worker.jobs WHERE key = $1`,
    [transcriptionCreateJobKey(fileItemId)],
  );
  return rows[0]?.id ?? null;
}

/**
 * On the caller's open transaction, so the removal commits or rolls back with it. An unstarted job is
 * deleted; a running one is detached from its key and not retried. A Transcripts item an earlier run
 * created is not touched.
 */
export async function cancelTranscriptionJobs(client: PoolClient, fileItemId: string): Promise<void> {
  await cancelJob(client, transcriptionCreateJobKey(fileItemId));
  await cancelJob(client, transcriptionJobKey(fileItemId));
}

/** Only validates the payload; performs no item write of its own. */
export async function handleTranscriptionJobTask(payload: unknown): Promise<void> {
  transcriptionJobPayloadSchema.parse(payload);
}
