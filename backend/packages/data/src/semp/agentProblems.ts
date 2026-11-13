import type { PoolClient } from "pg";
import { ValidationError } from "../errors.js";
import { agentHeartbeatProblemKey, agentRunProblemKey } from "./agentProblemKeys.js";
import { raiseProblem, resolveProblem, type RaiseProblemResult } from "./sempProblemsStore.js";

/**
 * Raises the `agents` problem of a heartbeat whose tick failed (issue #1911), in the caller's open
 * transaction. The sweep, the run action's final failed attempt and a tick reply that left a failed tool
 * call all raise this one problem; `occurrenceKey` is the id of the failed run or of the sweep's job, so a
 * replay of the same report adds nothing. `userId` is the tenant's user, who the problem is shown to.
 */
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
 * Raises the `agents` problem of a failed run that is neither a heartbeat tick nor a chat turn (issue
 * #1911), in the caller's open transaction. Every attempt of one retry chain merges into the problem keyed
 * by the chain's `firstRunId`; `failedRunId`, the run that failed, is the occurrence.
 *
 * `agent_runs.project_item_id` carries no foreign key and a purged project leaves it dangling, while
 * `raiseProblem` rejects a project reference that does not name an item of the tenant's Projects database
 * (see `2026-10-31-tenant-scoped-project-references-for-semp-problems`). The problem is bookkeeping of a
 * close that must not fail because of it, so a rejected reference is dropped and the problem is raised
 * without a project. Only that one rejection is caught: `raiseProblem` writes nothing before it, so the
 * retry starts from the state the first call found, and every other error still reaches the caller.
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

/** Whether `error` is `raiseProblem`'s rejection of its `projectItemId`, as opposed to any other failure. */
function isRejectedProjectReference(error: unknown): boolean {
  if (!(error instanceof ValidationError)) return false;
  const details: unknown = error.details;
  return typeof details === "object" && details !== null && "field" in details && details.field === "projectItemId";
}

/**
 * Resolves the `agents` problem of a heartbeat whose tick recovered (issue #1915), in the caller's open
 * transaction. The caller decides that the tick recovered: its run ended `done` and the reply left no failed
 * tool call. Returns whether a problem was active.
 */
export function resolveAgentHeartbeatProblem(client: PoolClient, heartbeatId: string): Promise<boolean> {
  return resolveProblem(client, { dedupeKey: agentHeartbeatProblemKey(heartbeatId), resolutionKind: "recovered" });
}

/**
 * Resolves the `agents` problem of the retry chain that starts at `firstRunId` (issue #1915), in the caller's
 * open transaction, once a run of the chain succeeded. Returns whether a problem was active.
 */
export function resolveAgentRunProblem(client: PoolClient, firstRunId: string): Promise<boolean> {
  return resolveProblem(client, { dedupeKey: agentRunProblemKey(firstRunId), resolutionKind: "recovered" });
}
