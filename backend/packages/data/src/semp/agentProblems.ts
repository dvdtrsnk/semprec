import type { PoolClient } from "pg";
import { ValidationError } from "../errors.js";
import { agentHeartbeatProblemKey, agentRunProblemKey } from "./agentProblemKeys.js";
import { raiseProblem, resolveProblem, type RaiseProblemResult } from "./sempProblemsStore.js";

/** `occurrenceKey` (failed run or sweep job id) makes replays idempotent. */
export function raiseAgentHeartbeatProblem(
  client: PoolClient,
  input: { userId: string; heartbeatId: string; occurrenceKey: string },
): Promise<RaiseProblemResult> {
  return raiseProblem(client, {
    userId: input.userId,
    category: "agents",
    kind: "agentHeartbeat",
    severity: "warning",
    sourceTable: "project_heartbeats",
    sourceId: input.heartbeatId,
    dedupeKey: agentHeartbeatProblemKey(input.heartbeatId),
    occurrenceKey: input.occurrenceKey,
  });
}

/**
 * Raises the `agents` problem of a failed run that is neither a heartbeat tick nor a chat turn, keyed by the
 * retry chain's `firstRunId`.
 *
 * `agent_runs.project_item_id` has no foreign key and can dangle after a purge, which `raiseProblem` rejects.
 * The close must not fail over bookkeeping, so only that rejection is caught and the problem is raised again
 * without a project; `raiseProblem` writes nothing before rejecting, so the retry is safe.
 */
export async function raiseAgentRunProblem(
  client: PoolClient,
  input: { userId: string; firstRunId: string; failedRunId: string; projectItemId: string | null },
): Promise<RaiseProblemResult> {
  const raise = (projectItemId: string | null): Promise<RaiseProblemResult> =>
    raiseProblem(client, {
      userId: input.userId,
      category: "agents",
      kind: "agentRun",
      severity: "warning",
      sourceTable: "agent_runs",
      sourceId: input.firstRunId,
      dedupeKey: agentRunProblemKey(input.firstRunId),
      projectItemId,
      occurrenceKey: input.failedRunId,
    });
  if (input.projectItemId === null) return raise(null);
  try {
    return await raise(input.projectItemId);
  } catch (error) {
    if (!isRejectedProjectReference(error)) throw error;
    return raise(null);
  }
}

function isRejectedProjectReference(error: unknown): boolean {
  if (!(error instanceof ValidationError)) return false;
  const details: unknown = error.details;
  return typeof details === "object" && details !== null && "field" in details && details.field === "projectItemId";
}

/** The caller decides the tick recovered. Returns whether a problem was active. */
export function resolveAgentHeartbeatProblem(client: PoolClient, heartbeatId: string): Promise<boolean> {
  return resolveProblem(client, { dedupeKey: agentHeartbeatProblemKey(heartbeatId), resolutionKind: "recovered" });
}

/** Once a run of the chain succeeded. Returns whether a problem was active. */
export function resolveAgentRunProblem(client: PoolClient, firstRunId: string): Promise<boolean> {
  return resolveProblem(client, { dedupeKey: agentRunProblemKey(firstRunId), resolutionKind: "recovered" });
}
