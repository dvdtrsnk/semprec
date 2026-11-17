import type { ActiveHeartbeatRunSummary, ChokePointError, ItemRow } from "@semprec/data";
import { toItemEnvelope, type ItemEnvelope } from "./itemEnvelope.js";

/**
 * The closed enum of REST error codes. Growing it is an additive contract change; removing or
 * repurposing a code is a breaking one.
 */
export const ITEM_ERROR_CODES = [
  "owner_violation",
  "computed_readonly",
  "schema_locked",
  "property_locked",
  "version_conflict",
  "value_link_conflict",
  "proposal_locked",
  "validation_failed",
  "not_found",
  "approval_required",
  "heartbeat_event_triggered",
  "heartbeat_disabled",
  "heartbeat_running",
  "not_retryable",
  "retry_pending",
  "cardinality_violation",
  "database_archived",
  "mail_auth_failed",
  "mail_app_password_required",
  "mail_server_unreachable",
  "mail_tls_failed",
  "mail_admin_consent_required",
  "mail_reauth_wrong_account",
  "option_label_exists",
  "duplicate_item",
  "mail_draft_already_sent",
  "mail_draft_not_editable",
  "mail_attachment_too_large",
  "mail_reauthorization_required",
  "mail_recipient_rejected",
  "mail_sent_folder_missing",
  "retry_not_latest",
  "regenerate_not_latest",
  "regenerate_after_writes",
  "regenerate_after_compaction",
  "unsupported_media_type",
  "unsupported_attachment_type",
] as const;

export type ItemErrorCode = (typeof ITEM_ERROR_CODES)[number];

/**
 * The single code-to-status table every route shares: 400 for a bad request shape, 403 for an
 * authorization boundary, 409 for a well-formed request that conflicts with the resource's current
 * state.
 */
export const ITEM_ERROR_STATUS_BY_CODE: Readonly<Record<ItemErrorCode, number>> = {
  owner_violation: 403,
  computed_readonly: 403,
  schema_locked: 403,
  property_locked: 403,
  version_conflict: 409,
  value_link_conflict: 409,
  proposal_locked: 409,
  validation_failed: 400,
  not_found: 404,
  approval_required: 403,
  heartbeat_event_triggered: 409,
  heartbeat_disabled: 409,
  heartbeat_running: 409,
  not_retryable: 409,
  retry_pending: 409,
  cardinality_violation: 409,
  database_archived: 403,
  mail_auth_failed: 400,
  mail_app_password_required: 400,
  mail_server_unreachable: 400,
  mail_tls_failed: 400,
  mail_admin_consent_required: 400,
  mail_reauth_wrong_account: 400,
  option_label_exists: 409,
  duplicate_item: 409,
  mail_draft_already_sent: 409,
  mail_draft_not_editable: 409,
  mail_attachment_too_large: 413,
  mail_reauthorization_required: 409,
  mail_recipient_rejected: 422,
  mail_sent_folder_missing: 409,
  retry_not_latest: 409,
  regenerate_not_latest: 409,
  regenerate_after_writes: 409,
  regenerate_after_compaction: 409,
  unsupported_media_type: 415,
  unsupported_attachment_type: 415,
};

function isItemErrorCode(code: string): code is ItemErrorCode {
  return (ITEM_ERROR_CODES as readonly string[]).includes(code);
}

/** A code outside the table answers with the error's own `status`. */
export function statusForError(err: ChokePointError): number {
  return isItemErrorCode(err.code) ? ITEM_ERROR_STATUS_BY_CODE[err.code] : err.status;
}

export interface ErrorResponseBody {
  error: {
    code: string;
    details?: unknown;
  };
}

/**
 * Checks `current`'s required fields, not just its presence, so a `ConflictError` with unrelated
 * `details` falls through to the generic branch instead of being projected as an item.
 */
function isVersionConflictDetails(details: unknown): details is { current: ItemRow } {
  if (typeof details !== "object" || details === null || !("current" in details)) return false;
  const current = details.current;
  if (typeof current !== "object" || current === null) return false;
  const row = current as Partial<ItemRow>;
  return (
    typeof row.id === "string" &&
    typeof row.databaseId === "string" &&
    typeof row.properties === "object" &&
    row.properties !== null &&
    typeof row.computed === "object" &&
    row.computed !== null &&
    typeof row.updatedAt === "string" &&
    typeof row.version === "string" &&
    (row.deletedAt === null || typeof row.deletedAt === "string")
  );
}

export interface VersionConflictDetails {
  currentItem: ItemEnvelope;
}

/** `null` while only a fire job is waiting. */
export interface HeartbeatRunningDetails {
  activeRun: ActiveHeartbeatRunSummary | null;
}

function isActiveRunSummary(value: unknown): value is ActiveHeartbeatRunSummary {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "status" in value &&
    typeof value.status === "string" &&
    "triggeredBy" in value &&
    typeof value.triggeredBy === "string" &&
    "startedAt" in value &&
    typeof value.startedAt === "string" &&
    "threadId" in value &&
    (value.threadId === null || typeof value.threadId === "string")
  );
}

function isHeartbeatRunningDetails(details: unknown): details is HeartbeatRunningDetails {
  if (typeof details !== "object" || details === null || !("activeRun" in details)) return false;
  return details.activeRun === null || isActiveRunSummary(details.activeRun);
}

/**
 * `details` is `unknown`, so a call site could pass a raw row, a foreign key or a file path. Only a
 * flat record of primitives (the shape every documented `details` payload has) is served; anything
 * else is dropped rather than risk leaking internal state.
 */
export function publicErrorDetails(details: unknown): Record<string, string | number | boolean | null> | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const entries = Object.entries(details as Record<string, unknown>);
  const isPrimitive = (value: unknown): value is string | number | boolean | null =>
    value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  return entries.every(([, value]) => isPrimitive(value))
    ? (details as Record<string, string | number | boolean | null>)
    : undefined;
}

/**
 * `version_conflict` projects its `{ current }` row onto the public item envelope, and
 * `heartbeat_running` projects its nested `activeRun` field by field (`publicErrorDetails` would
 * drop it). Every other code's `details` passes through `publicErrorDetails`.
 */
export function toErrorResponseBody(err: ChokePointError): ErrorResponseBody {
  if (err.code === "version_conflict" && isVersionConflictDetails(err.details)) {
    const details: VersionConflictDetails = { currentItem: toItemEnvelope(err.details.current) };
    return { error: { code: err.code, details } };
  }
  if (err.code === "heartbeat_running" && isHeartbeatRunningDetails(err.details)) {
    const run = err.details.activeRun;
    const details: HeartbeatRunningDetails = {
      activeRun:
        run === null
          ? null
          : {
              id: run.id,
              status: run.status,
              triggeredBy: run.triggeredBy,
              startedAt: run.startedAt,
              threadId: run.threadId,
            },
    };
    return { error: { code: err.code, details } };
  }
  return { error: { code: err.code, details: publicErrorDetails(err.details) } };
}

/**
 * The bespoke handlers' `{ error: message, code, details }` body, a different top-level shape from
 * `toErrorResponseBody`'s envelope kept for the additive-only contract.
 */
export function toPublicErrorBody(err: ChokePointError): {
  error: string;
  code: string;
  details?: Record<string, string | number | boolean | null>;
} {
  return { error: err.message, code: err.code, details: publicErrorDetails(err.details) };
}
