/** `semp_problems.dedupe_key` is tenant-scoped, not category-scoped, so each key carries a prefix. */

export function agentHeartbeatProblemKey(heartbeatId: string): string {
  return `agents:heartbeat:${heartbeatId}`;
}

/** The first run of the retry chain (follow `retry_of_run_id` to `NULL`), so every attempt merges. */
export function agentRunProblemKey(firstRunId: string): string {
  return `agents:run:${firstRunId}`;
}

/** Every attempt and manual retry of a reply merges. */
export function agentReplyProblemKey(replyToMessageId: string): string {
  return `agents:reply:${replyToMessageId}`;
}
