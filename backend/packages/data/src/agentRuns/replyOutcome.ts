import type { SempReplyStep } from "../semp/sempReplySteps.js";
import { parseStoredSempReplySteps } from "../semp/sempStoredSteps.js";

/** Canonical keys; the texts are the `agentRun.incomplete.*` catalog entries. */
export const REPLY_INCOMPLETE_REASONS = ["toolTimeout", "toolUnavailable", "toolError"] as const;
export type ReplyIncompleteReason = (typeof REPLY_INCOMPLETE_REASONS)[number];

/** The part of a stored `semp_messages.steps` entry that decides completeness; a `SempReplyStep` satisfies it. */
export type ReplyOutcomeStep = Pick<
  SempReplyStep,
  | "status"
  | "operation"
  | "toolName"
  | "errorCode"
  | "mcpToolRegistrationId"
  | "mcpServerItemId"
  | "connectorName"
  | "timeoutMs"
>;

export interface IncompleteReplyOutcome {
  outcome: "incomplete";
  incompleteReason: ReplyIncompleteReason;
  /** Absent when the failed call is not an MCP call. */
  mcpServerItemId?: string;
  /**
   * The MCP server's name for an MCP call, else the model-facing tool (or operation) name; absent when neither is known.
   */
  connectorName?: string;
  timeoutMs?: number;
}

/** Derived on every read from the stored steps. */
export type ReplyOutcome = { outcome: "complete" } | IncompleteReplyOutcome;

/** An error code alone counts as a failure, even when the stored status says otherwise. */
function stepFailed(step: ReplyOutcomeStep): boolean {
  return step.status === "error" || step.errorCode !== undefined;
}

/** Matches a retry to the failure it repeats. `null` steps never cancel or get cancelled. */
function toolKey(step: ReplyOutcomeStep): string | null {
  if (step.operation !== undefined) return `operation:${step.operation}`;
  if (step.mcpToolRegistrationId !== undefined) return `mcp:${step.mcpToolRegistrationId}`;
  if (step.toolName !== undefined) return `tool:${step.toolName}`;
  return null;
}

/**
 * Only an MCP call has a failure kind (stored as its error code); a generic operation's `ChokePointError` code is
 * always a plain tool error.
 */
function reasonOf(step: ReplyOutcomeStep): ReplyIncompleteReason {
  if (step.operation !== undefined) return "toolError";
  if (step.errorCode === "timeout") return "toolTimeout";
  if (step.errorCode === "unavailable") return "toolUnavailable";
  return "toolError";
}

/**
 * Derived from the steps alone, never from the model's own words. A failed step is cancelled by a later `ok` step
 * of the same tool (a successful retry); a step waiting for approval cancels nothing. The reason, server and
 * timeout are those of the last uncancelled failure.
 */
export function deriveReplyOutcome(steps: readonly ReplyOutcomeStep[]): ReplyOutcome {
  let last: ReplyOutcomeStep | undefined;
  for (const [index, step] of steps.entries()) {
    if (!stepFailed(step)) continue;
    const key = toolKey(step);
    const retried =
      key !== null && steps.slice(index + 1).some((later) => later.status === "ok" && toolKey(later) === key);
    if (!retried) last = step;
  }
  if (last === undefined) return { outcome: "complete" };
  const incompleteReason = reasonOf(last);
  const connectorName = last.connectorName ?? last.toolName ?? last.operation;
  return {
    outcome: "incomplete",
    incompleteReason,
    ...(last.mcpServerItemId !== undefined ? { mcpServerItemId: last.mcpServerItemId } : {}),
    ...(connectorName !== undefined ? { connectorName } : {}),
    ...(incompleteReason === "toolTimeout" && last.timeoutMs !== undefined ? { timeoutMs: last.timeoutMs } : {}),
  };
}

/** `null` reads as no steps; a malformed column throws the `parseStoredSempReplySteps` error. */
export function replyOutcomeOfStoredSteps(steps: unknown): ReplyOutcome {
  return deriveReplyOutcome(parseStoredSempReplySteps(steps) ?? []);
}
