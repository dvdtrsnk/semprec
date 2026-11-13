import type { AgentRunRow } from "./agentRunsStore.js";
import type { ReplyOutcome } from "./replyOutcome.js";

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
 * 4. `error` when the run is finished and its reply is incomplete (issue #1890): the run closed as `done`
 *    but its reply left a failed tool call. Only a finished run is reclassified; a run that is still
 *    `running` or waits for approval keeps that status.
 * 5. `done` otherwise. A request that is `approved` and queued for execution is no longer pending,
 *    so the user's decision already counts as done.
 *
 * `run.replyOutcome` is the outcome of the run's reply (`getAgentRunReplyOutcome`); a run that has none,
 * which every MCP run is, leaves it out.
 */
export function deriveRunDisplayStatus(
  run: Pick<AgentRunRow, "status"> & { replyOutcome?: ReplyOutcome["outcome"] | null },
  approvals: { pending: number },
): AgentRunDisplayStatus {
  if (run.status === "error") return "error";
  if (approvals.pending > 0) return "waiting_approval";
  if (run.status === "running") return "running";
  if (run.replyOutcome === "incomplete") return "error";
  return "done";
}
