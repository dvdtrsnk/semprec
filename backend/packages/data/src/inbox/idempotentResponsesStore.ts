// Owns the `idempotent_responses` table (issue gh-1894): the first response of a card action per Idempotency-Key.
// Constrained by: docs/adr/2026-11-13-card-actions-replay-the-stored-response-of-an-idempotency-key.md
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { canonicalizeJson, type TenantScope } from "@semprec/shared";
import { requireManagedTransaction, requireSingleRow } from "../db/pool.js";
import { ValidationError } from "../errors.js";

/** How long a stored response answers a repeat of its key. */
export const IDEMPOTENT_RESPONSE_TTL_HOURS = 24;

/** The most expired rows one write or one purge deletes, so no request pays for a backlog. */
const EXPIRED_DELETE_BATCH_SIZE = 100;

/** The longest `Idempotency-Key` a card route takes; a longer one is refused instead of stored. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** What one call of `runIdempotent` is about: the caller, the key, the route template and the request. */
export interface IdempotentRequest {
  /** The scope the request runs in, as `currentTenantScope()` returns it; the key is held per tenant, so a missing or system scope is refused. */
  tenantScope: TenantScope | undefined;
  userId: string;
  key: string;
  /** The route template, for example `PATCH /api/proposals/:id/values`, never the resolved path. */
  route: string;
  /** `hashIdempotentRequest` of everything the request carries that changes what it does, the resolved path parameters included. */
  requestHash: string;
}

/** A response the store keeps: the status and the JSON body of what the action answered. */
export interface IdempotentResponse {
  status: number;
  body: object;
}

interface StoredResponseRow {
  request_hash: string;
  status: number;
  body: unknown;
}

/** The hash `IdempotentRequest.requestHash` takes: SHA-256, hex, of the canonical JSON of `request`. */
export function hashIdempotentRequest(request: unknown): string {
  return createHash("sha256").update(canonicalizeJson(request)).digest("hex");
}

/**
 * The `Idempotency-Key` of a request, or `undefined` when it carries none or an empty one. A key that is not a single
 * header value or is longer than `MAX_IDEMPOTENCY_KEY_LENGTH` is a `ValidationError` on the header.
 */
export function readIdempotencyKeyHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  const value = headers?.["idempotency-key"];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ValidationError(
      `'Idempotency-Key' must be one header of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      { field: "Idempotency-Key" },
    );
  }
  return value;
}

/**
 * Deletes at most one batch of the tenant's expired rows and answers how many it deleted; none is a normal outcome.
 * Rows another transaction is deleting are skipped. Runs in the caller's transaction and tenant scope.
 */
export async function deleteExpiredIdempotentResponses(client: PoolClient): Promise<number> {
  const result = await client.query(
    `DELETE FROM idempotent_responses
      WHERE tenant_id = app_tenant_default()
        AND (user_id, key, route) IN (
          SELECT user_id, key, route FROM idempotent_responses
           WHERE tenant_id = app_tenant_default() AND expires_at <= now()
           ORDER BY expires_at
           LIMIT $1
             FOR UPDATE SKIP LOCKED)`,
    [EXPIRED_DELETE_BATCH_SIZE],
  );
  return result.rowCount ?? 0;
}

/**
 * Runs `action` once per (tenant, user, key, route) within the stored response's 24 hours and answers what it
 * answered the first time to every repeat. Must run in a managed transaction (`withTransaction`) of the caller's
 * tenant; `action` runs in that transaction too, on the same `client`.
 *
 * The transaction first takes a transaction-scoped advisory lock on the (tenant, user, key, route) tuple, so a
 * concurrent call with the same tuple waits for the first one to commit or roll back and then reads its row. Under
 * the lock, a live row of the same `requestHash` is answered as stored and `action` is not called; a live row of
 * another hash is a `ValidationError` (`validation_failed`) and nothing runs; with no live row `action` runs and,
 * when it answers a status below 400, its response is stored and returned as the database holds it. A response of
 * 400 or above is returned and not stored. An error `action` throws propagates, and the caller's transaction rolls
 * back with nothing stored, which leaves the key free. An expired row is replaced by the new response. Each stored response also deletes one batch of the
 * tenant's expired rows (`deleteExpiredIdempotentResponses`).
 */
export async function runIdempotent(
  client: PoolClient,
  request: IdempotentRequest,
  action: () => Promise<IdempotentResponse>,
): Promise<IdempotentResponse> {
  requireManagedTransaction(client);
  const { tenantScope, userId, key, route, requestHash } = request;
  if (tenantScope?.kind !== "tenant") {
    throw new Error("runIdempotent requires an active tenant scope");
  }
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('idempotentResponse', $1::text, $2::text, $3::text, $4::text)::text, 0))",
    [tenantScope.tenantId, userId, key, route],
  );

  const { rows } = await client.query<StoredResponseRow>(
    `SELECT request_hash, status, body FROM idempotent_responses
      WHERE tenant_id = app_tenant_default() AND user_id = $1 AND key = $2 AND route = $3 AND expires_at > now()`,
    [userId, key, route],
  );
  const stored = rows[0];
  if (stored !== undefined) {
    if (stored.request_hash !== requestHash) {
      throw new ValidationError("The idempotency key was used for a different request", { field: "Idempotency-Key" });
    }
    return { status: stored.status, body: storedBody(stored.body) };
  }

  const response = await action();
  if (response.status >= 400) return response;

  // The lookup above ran under the tuple's lock and found no live row, so a conflict here is with an expired row.
  const written = await client.query<StoredResponseRow>(
    `INSERT INTO idempotent_responses (user_id, key, route, request_hash, status, body, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now() + make_interval(hours => $7::int))
     ON CONFLICT (tenant_id, user_id, key, route) DO UPDATE
       SET request_hash = EXCLUDED.request_hash, status = EXCLUDED.status, body = EXCLUDED.body,
           created_at = now(), expires_at = EXCLUDED.expires_at
     RETURNING request_hash, status, body`,
    [userId, key, route, requestHash, response.status, JSON.stringify(response.body), IDEMPOTENT_RESPONSE_TTL_HOURS],
  );
  const kept = requireSingleRow(written.rows, "idempotent_responses insert");
  await deleteExpiredIdempotentResponses(client);
  return { status: kept.status, body: storedBody(kept.body) };
}

/** A stored body is the JSON object `runIdempotent` wrote; anything else in the column is a corrupted row. */
function storedBody(body: unknown): object {
  if (typeof body !== "object" || body === null) {
    throw new Error("A stored idempotent response body is not a JSON object or array");
  }
  return body;
}
