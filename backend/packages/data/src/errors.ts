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
  constructor(message: string, details?: unknown) {
    super(403, "forbidden", message, details);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(409, "version_conflict", message, details);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends ChokePointError {
  constructor(message: string, details?: unknown) {
    super(404, "not_found", message, details);
    this.name = "NotFoundError";
  }
}
