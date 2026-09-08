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
