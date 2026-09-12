import type { ChokePointError, ItemRow } from "@semprec/data";
import { toItemEnvelope, type ItemEnvelope } from "./itemEnvelope.js";

/**
 * The closed enum of error codes the `semprec-api` REST adapter speaks (issue #238). Every route
 * built on this adapter maps its `ChokePointError`s onto exactly one of these — there is no
 * escape hatch to invent a new code from a route handler. Growing this list is an additive
 * contract change (new code, same shape for the existing ones); removing or repurposing one is
 * a breaking change and needs a transition period, per the adapter's "no URL versioning, additive
 * only" evolution rule.
 */
export const ITEM_ERROR_CODES = [
  "owner_violation",
  "computed_readonly",
  "schema_locked",
  "property_locked",
  "version_conflict",
  "validation_failed",
  "not_found",
  "approval_required",
  "heartbeat_event_triggered",
  "cardinality_violation",
] as const;

export type ItemErrorCode = (typeof ITEM_ERROR_CODES)[number];

/**
 * The single code→status table every route built on this adapter shares, so no later slice can
 * drift into mapping the same code to two different statuses. `version_conflict` and
 * `approval_required`/`computed_readonly`/`schema_locked`/`property_locked`/`not_found` are fixed
 * by the issue's approved behavior; `owner_violation`, `validation_failed`, and
 * `heartbeat_event_triggered` are this adapter's own deterministic choice (400 for a bad request
 * shape, 403 for an authorization boundary, 409 for a request that is well-formed but conflicts
 * with the addressed resource's current state).
 */
export const ITEM_ERROR_STATUS_BY_CODE: Readonly<Record<ItemErrorCode, number>> = {
  owner_violation: 403,
  computed_readonly: 403,
  schema_locked: 403,
  property_locked: 403,
  version_conflict: 409,
  validation_failed: 400,
  not_found: 404,
  approval_required: 403,
  heartbeat_event_triggered: 409,
  cardinality_violation: 409,
};

function isItemErrorCode(code: string): code is ItemErrorCode {
  return (ITEM_ERROR_CODES as readonly string[]).includes(code);
}

/** The `status` this adapter answers with for a given `ChokePointError` — the table above when the error's `code` is one of the nine, its own `status` otherwise (forward-compatible with a code this contract hasn't named yet). */
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
 * `ConflictError`'s internal details shape (`{ current: ItemRow }`) — see `chokePoint/itemsStore.ts`'s
 * `ifVersion` check. Checks `current`'s required fields, not just its presence, so a `ConflictError`
 * some future call site raises with an unrelated `details` shape falls through to the generic
 * verbatim-`details` branch below instead of being projected as if it were an item.
 */
function isVersionConflictDetails(details: unknown): details is { current: ItemRow } {
  if (typeof details !== "object" || details === null || !("current" in details)) return false;
  const current = details.current;
  return (
    typeof current === "object" &&
    current !== null &&
    typeof (current as Partial<ItemRow>).id === "string" &&
    typeof (current as Partial<ItemRow>).databaseId === "string" &&
    typeof (current as Partial<ItemRow>).properties === "object" &&
    typeof (current as Partial<ItemRow>).updatedAt === "string"
  );
}

export interface VersionConflictDetails {
  currentItem: ItemEnvelope;
}

/**
 * `details` is `unknown` on `ChokePointError`, so nothing here stops a future call site — a
 * `SchemaLockedError`/`PropertyLockedError`/`HeartbeatEventTriggeredError` thrown with a raw
 * database row, a foreign key, or a file path as `details` — from having that value forwarded
 * to an HTTP client verbatim. Only a flat record of primitive values (the shape every documented
 * `details` payload in this contract actually has — `{ field }`, `{ approvalRequestId, link }`)
 * is safe to serve as-is; anything else is dropped rather than risk leaking internal state.
 */
function safeDetails(details: unknown): Record<string, string | number | boolean | null> | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const entries = Object.entries(details as Record<string, unknown>);
  const isPrimitive = (value: unknown): value is string | number | boolean | null =>
    value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  return entries.every(([, value]) => isPrimitive(value))
    ? (details as Record<string, string | number | boolean | null>)
    : undefined;
}

/**
 * The single place a thrown `ChokePointError` becomes the `{ error: { code, details } }` body
 * defined by issue #238's error contract — no route handler builds this shape itself.
 * `version_conflict`'s `details.currentItem` is the one code whose wire shape isn't just the
 * choke-point error's own `details` verbatim: the choke-point raises it with `{ current }` (an
 * `ItemRow`), and this is where that gets projected onto the public item envelope. Every other
 * code's `details` passes through `safeDetails` rather than verbatim.
 */
export function toErrorResponseBody(err: ChokePointError): ErrorResponseBody {
  if (err.code === "version_conflict" && isVersionConflictDetails(err.details)) {
    const details: VersionConflictDetails = { currentItem: toItemEnvelope(err.details.current) };
    return { error: { code: err.code, details } };
  }
  return { error: { code: err.code, details: safeDetails(err.details) } };
}
