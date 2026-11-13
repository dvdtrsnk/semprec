import type { SempReplyStep } from "../semp/sempReplySteps.js";
import { parseStoredSempReplySteps } from "../semp/sempStoredSteps.js";

/** Why a Semp reply is incomplete (issue #1890); canonical keys, with the texts in the `agentRun.incomplete.*` catalog entries. */
export const REPLY_INCOMPLETE_REASONS = ["toolTimeout", "toolUnavailable", "toolError"] as const;
export type ReplyIncompleteReason = (typeof REPLY_INCOMPLETE_REASONS)[number];

/**
 * The part of a stored step (`semp_messages.steps`, issue #1860) that decides whether a reply is complete. A
 * `SempReplyStep` is one, so the steps of a freshly projected turn go through `deriveReplyOutcome` unchanged.
 */
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

/** An incomplete reply: it left a failed tool call. */
export interface IncompleteReplyOutcome {
  outcome: "incomplete";
  incompleteReason: ReplyIncompleteReason;
  /** The MCP server of the failed call; absent for a failed call that is no MCP call. */
  mcpServerItemId?: string;
  /**
   * The name the reason's text uses for the failed tool: the MCP server's name for an MCP call, else the
   * model-facing name of the tool (or its operation), so that a failed generic operation reads "tool item_patch
   * returned an error"; absent when the step names neither.
   */
  connectorName?: string;
  /** The timeout in milliseconds of a call that timed out. */
  timeoutMs?: number;
}

/** Whether a reply left a failed tool call, derived on every read from the steps stored on it. */
export type ReplyOutcome = { outcome: "complete" } | IncompleteReplyOutcome;

/**
 * A step failed when it ended in `error`: the stored status is `error` for a call that has an error code, a
 * generic operation whose result carried `details.error`, an interrupted tool result (issue #1374) and a call
 * that never returned. An error code alone also counts, even when the stored status says otherwise.
 */
function stepFailed(step: ReplyOutcomeStep): boolean {
  return step.status === "error" || step.errorCode !== undefined;
}

/**
 * What identifies the tool a step called, for matching a retry to the failure it repeats: the generic
 * operation, else the MCP tool registration, else the model-facing tool name of a step stored without
 * either. `null` for a step that names none of them, which no step ever cancels or is cancelled by.
 */
function toolKey(step: ReplyOutcomeStep): string | null {
  if (step.operation !== undefined) return `operation:${step.operation}`;
  if (step.mcpToolRegistrationId !== undefined) return `mcp:${step.mcpToolRegistrationId}`;
  if (step.toolName !== undefined) return `tool:${step.toolName}`;
  return null;
}

/**
 * The reason of a failed step. Only an MCP call has a failure kind (issue #1444), stored as its error code; a
 * generic operation's code is a `ChokePointError` code and is always a plain tool error.
 */
function reasonOf(step: ReplyOutcomeStep): ReplyIncompleteReason {
  if (step.operation !== undefined) return "toolError";
  if (step.errorCode === "timeout") return "toolTimeout";
  if (step.errorCode === "unavailable") return "toolUnavailable";
  return "toolError";
}

/**
 * Whether the reply that made `steps` left a failed tool call (issue #1890). The model's own words are not
 * trusted for this; it is derived from the steps alone and stores nothing.
 *
 * A failed step is cancelled by a later `ok` step of the same tool (same operation, or same MCP tool
 * registration): a successful retry makes up for the failure. A step that waits for approval does not cancel
 * one, because nothing has succeeded yet. The reply is incomplete when a failed step is left, and its reason,
 * server and timeout are those of the last such step.
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

/**
 * The outcome of the reply that stored `steps`, a `semp_messages.steps` column as the driver returns it: the
 * steps as `parseStoredSempReplySteps` (issue #1887, the one reader of the column) checks them, then
 * `deriveReplyOutcome`. `null` (a message that stored no summary) reads as no steps; a malformed column throws
 * the reader's error.
 */
export function replyOutcomeOfStoredSteps(steps: unknown): ReplyOutcome {
  return deriveReplyOutcome(parseStoredSempReplySteps(steps) ?? []);
}
