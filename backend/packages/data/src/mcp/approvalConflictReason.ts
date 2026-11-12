import type { ApprovalRequest } from "./approvalRequestsStore.js";

/**
 * Closed set of reasons the outcome write of an MCP or module-tool request records next to its text
 * in `execution_result_jsonb` (see `recordApprovalRequestOutcome` / `settleStaleApprovalRequestClaim`).
 * `sourceChanged` is a module-tool request whose source differed from its snapshot (issue #1791).
 */
export const APPROVAL_OUTCOME_KINDS = ["toolUnavailable", "callFailed", "staleClaim", "sourceChanged"] as const;
export type ApprovalOutcomeKind = (typeof APPROVAL_OUTCOME_KINDS)[number];

/** A translation key only: the client owns the catalog, and no execution-result text ever leaves here. */
export interface ApprovalConflictReason {
  key: string;
}

const OTHER: ApprovalConflictReason = { key: "approval.conflict.other" };

const GENERIC_REASON_KEYS: Readonly<Record<string, string>> = {
  not_found: "approval.conflict.deleted",
  owner_violation: "approval.conflict.provenanceChanged",
  database_archived: "approval.conflict.archived",
};

const OUTCOME_KIND_KEYS: Readonly<Record<ApprovalOutcomeKind, string>> = {
  toolUnavailable: "approval.conflict.toolUnavailable",
  callFailed: "approval.outcome.failed",
  staleClaim: "approval.conflict.other",
  sourceChanged: "approval.conflict.changed",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Names, as a stable translation key, why an approved request was not carried out. `null` unless
 * the request ended in `conflict`. Reads only the discriminators of `execution_result_jsonb` (the
 * generic operation's `details.reason`, the MCP `outcomeKind`) and never copies any text or value
 * out of it. Rows written before `outcomeKind` existed, and any shape not recognised, map to
 * `approval.conflict.other`.
 */
export function approvalConflictReason(
  executionStatus: ApprovalRequest["executionStatus"],
  executionResult: unknown,
): ApprovalConflictReason | null {
  if (executionStatus !== "conflict") return null;
  const result = asRecord(executionResult);
  if (!result) return OTHER;

  const outcomeKind = result.outcomeKind;
  if (typeof outcomeKind === "string" && Object.hasOwn(OUTCOME_KIND_KEYS, outcomeKind)) {
    return { key: OUTCOME_KIND_KEYS[outcomeKind as ApprovalOutcomeKind] };
  }

  const error = asRecord(result.error);
  if (error?.code !== "version_conflict") return OTHER;
  const reason = asRecord(error.details)?.reason;
  if (reason === undefined || reason === null) return { key: "approval.conflict.changed" };
  if (typeof reason === "string" && Object.hasOwn(GENERIC_REASON_KEYS, reason)) {
    return { key: GENERIC_REASON_KEYS[reason] as string };
  }
  return OTHER;
}
