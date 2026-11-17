import type { AgentRunRow } from "./agentRunsStore.js";
import type { ReplyOutcome } from "./replyOutcome.js";

/** Derived at read time from `status` and the run's approval requests; never stored. */
export type AgentRunDisplayStatus = "running" | "done" | "waiting_approval" | "error";

/**
 * Precedence:
 * 1. `error` when `status` is `error`, even with a pending request.
 * 2. `waiting_approval` when any request is `pending` (such a run is stored as `done`).
 * 3. `running` when `status` is `running`.
 * 4. `error` when the run finished but its reply left a failed tool call.
 * 5. `done` otherwise; an `approved` request queued for execution no longer counts as pending.
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
