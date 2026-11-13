/**
 * Dedupe keys of the `agents` problems that heartbeat ticks and agent runs raise (issue #1911).
 * `semp_problems.dedupe_key` is scoped to the tenant, not to the category, so each builder
 * carries its own prefix.
 */

/**
 * The one problem of a heartbeat whose tick fails, whichever of the sweep, the run action or the tick
 * reply reports it and however many attempts and notifications the failure produced.
 */
export function agentHeartbeatProblemKey(heartbeatId: string): string {
  return `agents:heartbeat:${heartbeatId}`;
}

/**
 * The one problem of a failed run that is neither a heartbeat tick nor a chat turn, keyed by the first run
 * of its retry chain (the run reached by following `retry_of_run_id` until it is `NULL`) so every attempt
 * of the chain merges into it.
 */
export function agentRunProblemKey(firstRunId: string): string {
  return `agents:run:${firstRunId}`;
}
