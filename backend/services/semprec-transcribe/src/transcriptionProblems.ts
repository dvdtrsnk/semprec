import type { PoolClient } from "pg";
import { raiseProblem, resolveProblem } from "@semprec/data";
import { transcriptionProblemKey } from "@semprec/shared";

/**
 * Raises the one `transcription` Semp problem of a transcript whose last attempt failed permanently (issue
 * gh-1945), in the caller's open transaction. A repeated permanent failure merges into the active problem and
 * adds an occurrence. The occurrence is the cumulative attempt count of the transcript's `item_automation`
 * (`attempts`), the same instance that keys the failure's `automation_error` notification, so a replay of the
 * same attempt's report adds nothing and every later permanent failure counts once. `userId` is the tenant's
 * user, who the problem is shown to.
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

/**
 * Resolves the transcript's active `transcription` problem as `recovered` in the caller's open transaction;
 * the finalize step calls it in the transaction that sets the transcript to `done`. A transcript without an
 * active problem changes nothing.
 */
export async function resolveTranscriptionProblem(client: PoolClient, transcriptId: string): Promise<void> {
  await resolveProblem(client, { dedupeKey: transcriptionProblemKey(transcriptId), resolutionKind: "recovered" });
}
