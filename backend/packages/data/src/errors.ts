/** Error categories the choke point raises; the HTTP layer maps `status` to a response code. */
export class ChokePointError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ChokePointError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(400, "validation_failed", message, details);
    this.name = "ValidationError";
  }
}

/**
 * An external host the request depended on was unreachable or answered with a failure; the caller may retry.
 * `details` holds only a reason keyword, never a URL or host.
 */
export class UpstreamUnavailableError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(502, "upstream_unavailable", message, details);
    this.name = "UpstreamUnavailableError";
  }
}

/** The detected type of uploaded blob bytes is not allowed; the bytes are removed before this surfaces. */
export class UnsupportedMediaTypeError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(415, "unsupported_media_type", message, details);
    this.name = "UnsupportedMediaTypeError";
  }
}

/** The blob's stored mime type cannot be attached to an Inbox item. */
export class UnsupportedAttachmentTypeError extends ChokePointError {
  declare readonly details: { blobId: string; mimeType: string };

  constructor(details: { blobId: string; mimeType: string }) {
    super(415, "unsupported_attachment_type", "The blob's type cannot be attached to an Inbox item", details);
    this.name = "UnsupportedAttachmentTypeError";
  }
}

export class ForbiddenError extends ChokePointError {
  constructor(message: string, details?: unknown, code = "forbidden") {
    super(403, code, message, details);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends ChokePointError {
  constructor(message: string, details?: unknown, code = "version_conflict") {
    super(409, code, message, details);
    this.name = "ConflictError";
  }
}

export class ProposalLockedError extends ChokePointError {
  constructor() {
    super(409, "proposal_locked", "Proposal is locked");
    this.name = "ProposalLockedError";
  }
}

export class ApprovalResourceBusyError extends ChokePointError {
  constructor() {
    super(409, "approval_resource_busy", "Approval resource is busy");
    this.name = "ApprovalResourceBusyError";
  }
}

export class ValueLinkBusyError extends ChokePointError {
  constructor() {
    super(409, "value_link_busy", "Value-link relation is busy");
    this.name = "ValueLinkBusyError";
  }
}

/** An edge write would violate the relation's cardinality (`enforce_relation_cardinality` trigger). */
export class CardinalityViolationError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(409, "cardinality_violation", message, details);
    this.name = "CardinalityViolationError";
  }
}

export class NotFoundError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(404, "not_found", message, details);
    this.name = "NotFoundError";
  }
}

/** `openDocVersionAt` was asked for a past timestamp outside retained history; never a partial reconstruction. */
export class HistoryNotRetainedError extends ChokePointError {
  constructor(docId: string, at: Date) {
    super(410, "history_not_retained", `Doc ${docId} has no retained history at ${at.toISOString()}`, {
      docId,
      at: at.toISOString(),
    });
    this.name = "HistoryNotRetainedError";
  }
}

/**
 * Every login/session failure uses this same generic 401 so the response never reveals which check
 * failed; do not attach `details`.
 */
export class UnauthorizedError extends ChokePointError {
  constructor(message = "Invalid or missing credentials") {
    super(401, "unauthorized", message);
    this.name = "UnauthorizedError";
  }
}

/** `retryAfterSeconds` is sent as the `Retry-After` header by the REST adapter, not in the body. */
export class RateLimitedError extends ChokePointError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(429, "rate_limited", "Too many attempts; try again later");
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The owning database's schema is locked. Extends `ForbiddenError` so `instanceof ForbiddenError` still matches.
 */
export class SchemaLockedError extends ForbiddenError {
  constructor(message: string, details?: unknown) {
    super(message, details, "schema_locked");
    this.name = "SchemaLockedError";
  }
}

export class PropertyLockedError extends ForbiddenError {
  constructor(message: string, details?: unknown) {
    super(message, details, "property_locked");
    this.name = "PropertyLockedError";
  }
}

/**
 * Another option of the property already has this label (stored, or as its Czech or English catalog label).
 * `details.key` is that option's key.
 */
export class OptionLabelExistsError extends ChokePointError {
  declare readonly details: { key: string };

  constructor(message: string, details: { key: string }) {
    super(409, "option_label_exists", message, details);
    this.name = "OptionLabelExistsError";
  }
}

/**
 * A write would leave a second live item where a database allows one per key. `details.field` names the key
 * (`sleepSettings`, `night`).
 */
export class DuplicateItemError extends ChokePointError {
  declare readonly details: { field: string };

  constructor(message: string, details: { field: string }) {
    super(409, "duplicate_item", message, details);
    this.name = "DuplicateItemError";
  }
}

/**
 * An agent-originated, approval-gated write was turned into an approval request instead; `details` links to it.
 * The in-process AgentTool adapter queues the same request but reports success to the model instead of this error.
 */
export class ApprovalRequiredError extends ChokePointError {
  declare readonly details: { approvalRequestId: string; link: string };

  constructor(message: string, details: { approvalRequestId: string; link: string }) {
    super(403, "approval_required", message, details);
    this.name = "ApprovalRequiredError";
  }
}

export interface ApprovalWriteReason {
  kind: string;
}

/** Internal refusal of a flagged write; the gateway creates the approval after rollback. */
export class ApprovalRequiredForWrite extends Error {
  constructor(readonly reasons: readonly ApprovalWriteReason[]) {
    super("The flagged write requires approval");
    this.name = "ApprovalRequiredForWrite";
  }
}

/**
 * Manual trigger of an `onItemEvent` heartbeat, which only fires from the write that produced the event.
 * The AgentTool counterpart is `HEARTBEAT_EVENT_TRIGGERED_ERROR` in `scheduler/heartbeatAgentTools.ts`.
 */
export class HeartbeatEventTriggeredError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(409, "heartbeat_event_triggered", message, details);
    this.name = "HeartbeatEventTriggeredError";
  }
}

export class HeartbeatDisabledError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(409, "heartbeat_disabled", message, details);
    this.name = "HeartbeatDisabledError";
  }
}

/** An active heartbeat run as error details show it; task text and result stay out. */
export interface ActiveHeartbeatRunSummary {
  id: string;
  status: string;
  triggeredBy: string;
  startedAt: string;
  threadId: string | null;
}

/**
 * Manual trigger while a run is active or a fire job is waiting. `details.activeRun` is `null` while only
 * a job is waiting.
 */
export class HeartbeatRunningError extends ChokePointError {
  declare readonly details: { activeRun: ActiveHeartbeatRunSummary | null };

  constructor(message: string, details: { activeRun: ActiveHeartbeatRunSummary | null }) {
    super(409, "heartbeat_running", message, details);
    this.name = "HeartbeatRunningError";
  }
}

/**
 * The run can never be retried (not failed, not a scheduled heartbeat occurrence, or already retried).
 * Unlike `retry_pending`, which means a later attempt may still make it retryable.
 */
export class NotRetryableError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(409, "not_retryable", message, details);
    this.name = "NotRetryableError";
  }
}

/** The failed run's heartbeat occurrence is still queued or running; try again later. */
export class RetryPendingError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(409, "retry_pending", message, details);
    this.name = "RetryPendingError";
  }
}

const PASSWORD_RESET_TOKEN_ERROR_MESSAGES = {
  invalid: "Password reset token is invalid",
  expired: "Password reset token has expired",
  consumed: "Password reset token has already been used",
} as const;

export type PasswordResetTokenErrorReason = keyof typeof PASSWORD_RESET_TOKEN_ERROR_MESSAGES;

/**
 * A reset token that is not live, unconsumed and unexpired. Unlike login, `reason` (and `code`) deliberately
 * distinguishes invalid, expired and consumed.
 */
export class PasswordResetTokenError extends ChokePointError {
  readonly reason: PasswordResetTokenErrorReason;

  constructor(reason: PasswordResetTokenErrorReason) {
    super(400, `password_reset_token_${reason}`, PASSWORD_RESET_TOKEN_ERROR_MESSAGES[reason]);
    this.name = "PasswordResetTokenError";
    this.reason = reason;
  }
}
