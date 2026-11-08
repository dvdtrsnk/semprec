/**
 * The shared `{ code, details }` domain-error union (issue #252): #37's original set plus every
 * predecessor addition raised by a code path a generic operation can reach, explicitly including
 * issue #83's `database_archived` and this issue's `empty_patch`/`relation_definition_required`
 * property-patch rejections. Per-transport parity tests over this union are added by the
 * consumers (REST in #219, MCP/AgentTool in #220) — this file only fixes the closed code set.
 */
export const DOMAIN_ERROR_CODES = [
  "validation_failed",
  "forbidden",
  "owner_violation",
  "schema_locked",
  "property_locked",
  "version_conflict",
  "cardinality_violation",
  "not_found",
  "database_archived",
  "empty_patch",
  "relation_definition_required",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainError {
  code: DomainErrorCode;
  details?: unknown;
}
