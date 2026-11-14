/** Error categories the choke-point raises; a later HTTP layer maps `status` to a response code. */
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
 * An external host the request depended on could not be reached or did not answer with a success status (issue
 * gh-1812: the host of a library cover candidate). Distinct from `ValidationError`: the caller sent nothing wrong
 * and may try again. `details` is flat and holds only a reason keyword, never a URL or host.
 */
export class UpstreamUnavailableError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(502, "upstream_unavailable", message, details);
    this.name = "UpstreamUnavailableError";
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

/** Raised when an edge write would violate its relation definition's declared cardinality (see item_relations' `enforce_relation_cardinality` trigger). */
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

/**
 * Raised by `openDocVersionAt` (issue #216) for a nonfuture timestamp that is nonetheless
 * outside retained history — before the doc's `history_available_from` baseline, or before
 * the configured retention cutoff. A stable, explicit "not retained" result rather than a
 * misleading partial reconstruction.
 */
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
 * Raised for every login/session-verification failure — bad password, unknown email, missing
 * token, expired session, revoked session — all with the same generic message. Issue #140's
 * requirement is a single public 401 contract that never reveals which of those conditions
 * applied, so callers must not attach a more specific `details` payload here.
 */
export class UnauthorizedError extends ChokePointError {
  constructor(message = "Invalid or missing credentials") {
    super(401, "unauthorized", message);
    this.name = "UnauthorizedError";
  }
}

/**
 * The `rate_limited` code (issue gh-1750): the caller made more attempts than a throttle grants inside its
 * window. `retryAfterSeconds` is the whole number of seconds until an attempt can be granted again. The REST
 * adapter of `semprec-api` sends it as the `Retry-After` header (`adapter/adapterRoute.ts`); it is not in
 * the body.
 */
export class RateLimitedError extends ChokePointError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(429, "rate_limited", "Too many attempts; try again later");
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The `schema_locked` code of the REST error contract (issue #238) — a write rejected because
 * the owning database's schema is locked (`databases.schema_locked`), raised by
 * `assertDatabaseSchemaUnlocked` in `chokePoint/propertiesStore.ts` (issue #240). Extends
 * `ForbiddenError` rather than `ChokePointError` directly so existing `instanceof ForbiddenError`
 * call sites (`chokePoint.test.ts`) keep matching it — only its `code` changed, not its category.
 */
export class SchemaLockedError extends ForbiddenError {
  constructor(message: string, details?: unknown) {
    super(message, details, "schema_locked");
    this.name = "SchemaLockedError";
  }
}

/**
 * The `property_locked` code of the REST error contract (issue #238) — a schema change rejected
 * because the individual property is itself locked (`properties.locked`), raised by
 * `assertPropertySchemaMutable` in `chokePoint/propertiesStore.ts` (issue #240).
 */
export class PropertyLockedError extends ForbiddenError {
  constructor(message: string, details?: unknown) {
    super(message, details, "property_locked");
    this.name = "PropertyLockedError";
  }
}

/**
 * The `option_label_exists` code of the REST error contract (issue #1699) — an option was to be added or renamed
 * to a label that another option of the same property already has, as its stored label or as its Czech or English
 * catalog label. `details.key` is that option's key, so the caller can use the existing option instead.
 */
export class OptionLabelExistsError extends ChokePointError {
  declare readonly details: { key: string };

  constructor(message: string, details: { key: string }) {
    super(409, "option_label_exists", message, details);
    this.name = "OptionLabelExistsError";
  }
}

/**
 * The `duplicate_item` code of the REST error contract (issue gh-1784) — a write would leave a second non-deleted
 * item where a database allows one per key (the sleep settings, a night exception). `details.field` names the
 * key: `sleepSettings` for the settings item, `night` for an exception.
 */
export class DuplicateItemError extends ChokePointError {
  declare readonly details: { field: string };

  constructor(message: string, details: { field: string }) {
    super(409, "duplicate_item", message, details);
    this.name = "DuplicateItemError";
  }
}

/**
 * The `approval_required` code of the REST error contract (issue #238) — raised in place of
 * performing an agent-originated write that the module contract flags as approval-gated (see
 * `docs/adr/2026-09-10-agent-writes-are-proposals-not-direct-writes.md`). `details` links the
 * caller to the approval request the write was turned into instead, so a REST caller can poll or
 * navigate to it. The in-process AgentTool adapter takes a different path for the same situation —
 * it queues the same approval request and reports a synthetic success back to the model instead
 * of surfacing this error.
 */
export class ApprovalRequiredError extends ChokePointError {
  /** Narrows the base class's `unknown` `details` to what this error's constructor always sets, so a catcher reads it typed instead of casting blind. */
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
 * The `heartbeat_event_triggered` code of the REST error contract (issue #238) — a manual trigger
 * of an `onItemEvent` heartbeat, which only ever fires from the write that produced the event,
 * never on demand. The AgentTool surface for the same rejection already exists as the plain
 * string constant `HEARTBEAT_EVENT_TRIGGERED_ERROR` in `scheduler/heartbeatAgentTools.ts`; this
 * class is the equivalent for a REST caller that wants to raise or match on this specific code.
 * Kept distinct from `validation_failed` so a client can offer a specific "this heartbeat fires
 * automatically" message instead of a generic bad-request one.
 */
export class HeartbeatEventTriggeredError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(409, "heartbeat_event_triggered", message, details);
    this.name = "HeartbeatEventTriggeredError";
  }
}

/**
 * The `heartbeat_disabled` code of the REST error contract (issue #1453) — a manual trigger of a
 * heartbeat the user disabled. Kept distinct from `heartbeat_event_triggered` and `validation_failed`
 * so a client can offer "enable it first" instead of a generic bad-request message.
 */
export class HeartbeatDisabledError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(409, "heartbeat_disabled", message, details);
    this.name = "HeartbeatDisabledError";
  }
}

/**
 * The run of a heartbeat that is still active, as the REST error contract shows it: ids, status and
 * timestamps only. The run's task text and result stay out of an error response.
 */
export interface ActiveHeartbeatRunSummary {
  id: string;
  status: string;
  triggeredBy: string;
  startedAt: string;
  threadId: string | null;
}

/**
 * The `heartbeat_running` code of the REST error contract (issue #1453) — a manual trigger while a
 * run of the heartbeat is running or a fire job of it is already waiting. `details.activeRun` is the
 * running run, or `null` while only a job is waiting for a worker to create the run.
 */
export class HeartbeatRunningError extends ChokePointError {
  declare readonly details: { activeRun: ActiveHeartbeatRunSummary | null };

  constructor(message: string, details: { activeRun: ActiveHeartbeatRunSummary | null }) {
    super(409, "heartbeat_running", message, details);
    this.name = "HeartbeatRunningError";
  }
}

/**
 * The `not_retryable` code of the REST error contract (issue #1908) — a retry of an agent run that can never be
 * retried: it did not fail, it is not a run of a scheduled heartbeat occurrence, or it was retried already.
 * Distinct from `retry_pending`, which means a later attempt may still make the run retryable.
 */
export class NotRetryableError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(409, "not_retryable", message, details);
    this.name = "NotRetryableError";
  }
}

/**
 * The `retry_pending` code of the REST error contract (issue #1908) — a retry of a failed run whose heartbeat
 * occurrence is still queued or running, so an automatic attempt may still run. The caller can try again later.
 */
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
 * Raised by `resetPassword` (issue #142) when a presented token doesn't identify a live,
 * unconsumed, unexpired `password_reset_tokens` row. Unlike `UnauthorizedError`, the issue's
 * Task explicitly asks for "deterministic invalid/expired/consumed responses" here — so, unlike
 * login, `reason` (and thus `code`) is allowed to tell the three apart.
 */
export class PasswordResetTokenError extends ChokePointError {
  readonly reason: PasswordResetTokenErrorReason;

  constructor(reason: PasswordResetTokenErrorReason) {
    super(400, `password_reset_token_${reason}`, PASSWORD_RESET_TOKEN_ERROR_MESSAGES[reason]);
    this.name = "PasswordResetTokenError";
    this.reason = reason;
  }
}
