/** The closed `{ code, details }` domain-error code set any code path of a generic operation can raise. */
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
  "option_label_exists",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainError {
  code: DomainErrorCode;
  details?: unknown;
}
