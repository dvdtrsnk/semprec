import type { PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@alldots/queue";
import { tenantLane } from "../tenancy/tenantLane.js";

/** The instruction's text is read from the history entry `instructionEntryId`, never carried here. */
export const transcriptCardRecomputePayloadSchema = z.object({ proposalId: z.uuid(), instructionEntryId: z.uuid() });
export type TranscriptCardRecomputePayload = z.infer<typeof transcriptCardRecomputePayloadSchema>;

/** One job per instruction: a repeat enqueue for the same card and entry converges onto one job. */
export function transcriptCardRecomputeJobKey(input: TranscriptCardRecomputePayload): string {
  return `transcript-card-recompute:${input.proposalId}:${input.instructionEntryId}`;
}

/**
 * Runs on the caller's transaction right after the instruction is appended to the card's history, so
 * the job exists exactly when the instruction does.
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
