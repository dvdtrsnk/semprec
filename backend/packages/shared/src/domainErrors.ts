/**
 * The closed set of `{ code, details }` domain-error codes every transport projects: #37's
 * original union plus the codes its successors added, including #83's `database_archived`.
 * Per-transport parity over this union is tested by the consumers (REST in #219, MCP and
 * AgentTool in #220).
 */
export const DOMAIN_ERROR_CODES = [
  "validation_failed",
  "not_found",
  "version_conflict",
  "forbidden",
  "owner_violation",
  "computed_readonly",
  "schema_locked",
  "property_locked",
  "database_archived",
  "approval_required",
  "heartbeat_event_triggered",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainError {
  code: DomainErrorCode;
  details?: unknown;
}
