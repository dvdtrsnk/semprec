import type { ApprovalRequest } from "./approvalRequestsStore.js";

/**
 * Recorded next to the outcome text in `execution_result_jsonb`. `sourceChanged`: a module tool's source differed
 * from its snapshot.
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
 * Reads only the discriminators (`details.reason`, `outcomeKind`) and never copies text or values out. Older rows
 * and unknown shapes map to `approval.conflict.other`.
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
