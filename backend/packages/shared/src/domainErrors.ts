/**
 * The closed set of `{ code, details }` domain-error codes every transport projects.
 * `forbidden` is the data layer's generic `ForbiddenError` code (see `@semprec/data`'s
 * errors.ts), the rest are #37's original enum plus #83's `database_archived`. Per-transport
 * parity over this union is tested by the consumers (REST in #219, MCP and AgentTool in #220).
 */
export const DOMAIN_ERROR_CODES = [
  // #37's closed enum.
  "validation_failed",
  "not_found",
  "version_conflict",
  "owner_violation",
  "computed_readonly",
  "schema_locked",
  "property_locked",
  "approval_required",
  "heartbeat_event_triggered",
  // Raised by the data layer today as `ForbiddenError`'s default code.
  "forbidden",
  // #83: an item or relation mutation against an archived database.
  "database_archived",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainError {
  code: DomainErrorCode;
  details?: unknown;
}
