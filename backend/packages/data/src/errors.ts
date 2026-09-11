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

export class ForbiddenError extends ChokePointError {
  constructor(message: string, details?: unknown, code = "forbidden") {
    super(403, code, message, details);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(409, "version_conflict", message, details);
    this.name = "ConflictError";
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
 * The `schema_locked` code of the REST error contract (issue #238) — a write rejected because
 * the owning database's schema is locked (`databases.schema_locked`, enforced today as a plain
 * `ForbiddenError` by `assertDatabaseSchemaUnlocked` in `chokePoint/propertiesStore.ts`). This
 * dedicated class is for a caller that wants to raise or match on this specific code.
 */
export class SchemaLockedError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(403, "schema_locked", message, details);
    this.name = "SchemaLockedError";
  }
}

/**
 * The `property_locked` code of the REST error contract (issue #238) — a schema change rejected
 * because the individual property is itself locked (`properties.locked`, enforced today as a
 * plain `ForbiddenError` by `assertPropertySchemaMutable` in `chokePoint/propertiesStore.ts`).
 */
export class PropertyLockedError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(403, "property_locked", message, details);
    this.name = "PropertyLockedError";
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
  constructor(message: string, details: { approvalRequestId: string; link: string }) {
    super(403, "approval_required", message, details);
    this.name = "ApprovalRequiredError";
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
