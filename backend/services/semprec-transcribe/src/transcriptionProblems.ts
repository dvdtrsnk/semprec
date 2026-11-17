import type { PoolClient } from "pg";
import { raiseProblem, resolveProblem } from "@semprec/data";
import { transcriptionProblemKey } from "@semprec/shared";

/**
 * In the caller's transaction. The occurrence is the cumulative attempt count, the same key as the
 * `automation_error` notification, so a replay adds nothing and each later failure counts once.
 */
export async function raiseTranscriptionProblem(
  client: PoolClient,
  input: { userId: string; transcriptId: string; attempts: number },
): Promise<void> {
  await raiseProblem(client, {
    userId: input.userId,
    category: "transcription",
    kind: "transcriptionFailed",
    severity: "warning",
    sourceTable: "item_automation",
    sourceId: input.transcriptId,
    dedupeKey: transcriptionProblemKey(input.transcriptId),
    occurrenceKey: `attempt:${input.attempts}`,
  });
}

/** In the caller's transaction (finalize's); a no-op without an active problem. */
export async function resolveTranscriptionProblem(client: PoolClient, transcriptId: string): Promise<void> {
  await resolveProblem(client, { dedupeKey: transcriptionProblemKey(transcriptId), resolutionKind: "recovered" });
}
