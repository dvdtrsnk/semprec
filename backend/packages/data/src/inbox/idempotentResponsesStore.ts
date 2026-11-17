// Stores the first response of a card action per Idempotency-Key.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { canonicalizeJson, type TenantScope } from "@semprec/shared";
import { requireManagedTransaction, requireSingleRow } from "../db/pool.js";
import { ValidationError } from "../errors.js";

export const IDEMPOTENT_RESPONSE_TTL_HOURS = 24;

/** Bounded so no request pays for a backlog. */
const EXPIRED_DELETE_BATCH_SIZE = 100;

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export interface IdempotentRequest {
  /** Keys are held per tenant, so a missing or system scope is refused. */
  tenantScope: TenantScope | undefined;
  userId: string;
  key: string;
  /** The route template, never the resolved path. */
  route: string;
  /** Must include the resolved path parameters. */
  requestHash: string;
}

export interface IdempotentResponse {
  status: number;
  body: object;
}

interface StoredResponseRow {
  request_hash: string;
  status: number;
  body: unknown;
}

export function hashIdempotentRequest(request: unknown): string {
  return createHash("sha256").update(canonicalizeJson(request)).digest("hex");
}

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

/** Rows another transaction is deleting are skipped. */
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
 * Must run in a managed transaction of the caller's tenant; `action` runs on the same `client`.
 *
 * A transaction-scoped advisory lock on (tenant, user, key, route) makes a concurrent repeat wait for the first to
 * finish and then read its row. A live row with the same `requestHash` is replayed without calling `action`; another
 * hash is a `ValidationError`. Only responses below 400 are stored. A thrown error rolls back with nothing stored,
 * leaving the key free. Each stored response also sweeps one batch of expired rows.
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
