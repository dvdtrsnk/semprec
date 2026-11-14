import type { PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { tenantLane } from "../tenancy/tenantLane.js";

/**
 * The payload of a `transcriptCardRecompute` job (issue gh-1940): the Processing proposals card and the `id` of the
 * history entry that holds the user's instruction. The instruction's text is read from that entry, never carried here.
 */
export const transcriptCardRecomputePayloadSchema = z.object({ proposalId: z.uuid(), instructionEntryId: z.uuid() });
export type TranscriptCardRecomputePayload = z.infer<typeof transcriptCardRecomputePayloadSchema>;

/** One job per instruction: a repeat enqueue for the same card and entry converges onto one job. */
export function transcriptCardRecomputeJobKey(input: TranscriptCardRecomputePayload): string {
  return `transcript-card-recompute:${input.proposalId}:${input.instructionEntryId}`;
}

/**
 * Enqueues the recompute of a transcript card for one user instruction, on the caller's open transaction: the
 * message-only branch of `reviseProposalWithClient` calls it right after it appends the instruction to the card's
 * history, so the job exists exactly when the instruction does. `maxAttempts: 3` with graphile-worker's backoff is its
 * retry policy; the tenant is the producer's own scope, as for every job (`enqueueJob`).
 */
export async function enqueueTranscriptCardRecompute(
  client: PoolClient,
  input: TranscriptCardRecomputePayload,
): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.TRANSCRIPT_CARD_RECOMPUTE,
    { proposalId: input.proposalId, instructionEntryId: input.instructionEntryId },
    {
      jobKey: transcriptCardRecomputeJobKey(input),
      maxAttempts: 3,
      queueName: tenantLane("transcript-card-recompute"),
    },
  );
}
