import type { AgentRunRow } from "./agentRunsStore.js";

/**
 * What a client shows as the state of a run (issue #1820). It is derived at read time from the run's
 * `status` and its approval requests and is never stored: `agent_runs.status` stays `running`, `done`
 * or `error`.
 */
export type AgentRunDisplayStatus = "running" | "done" | "waiting_approval" | "error";

/**
 * The display status of a run, from the run's `status` and the approval counts of the run detail:
 *
 * 1. `error` when the run's `status` is `error`, even when a request is still pending.
 * 2. `waiting_approval` when at least one of the run's approval requests is `pending`. A run that
 *    asked for a decision is closed as `done`, so this is what tells it from a run that finished.
 * 3. `running` when the run's `status` is `running`.
 * 4. `done` otherwise. A request that is `approved` and queued for execution is no longer pending,
 *    so the user's decision already counts as done.
 *
 * Both parameters are objects so that a later input (an unfinished reply, issue #1890) can be added
 * to either without changing the callers that already pass what exists today.
 */
export function deriveRunDisplayStatus(
  run: Pick<AgentRunRow, "status">,
  approvals: { pending: number },
): AgentRunDisplayStatus {
  if (run.status === "error") return "error";
  if (approvals.pending > 0) return "waiting_approval";
  if (run.status === "running") return "running";
  return "done";
}
