import type { PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { requireAffectedRows, type Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";

/**
 * The `tenant_exports` store (issue #1043): one row per requested export of the tenant in scope.
 * Every statement runs under the caller's tenant scope and lets row-level security confine it to
 * that tenant; no function here takes a tenant id. `tenantExportJob.ts` builds the archive and
 * drives the status writers; `deleteExpiredTenantExports` is the expiry sweep's delete.
 */

const TENANT_EXPORT_STATUSES = ["pending", "running", "ready", "failed"] as const;

export type TenantExportStatus = (typeof TENANT_EXPORT_STATUSES)[number];

/** A ready export can be downloaded for this long after it completed; a failed row is kept as long. */
const TENANT_EXPORT_RETENTION_DAYS = 7;

export interface TenantExportSummary {
  id: string;
  status: TenantExportStatus;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  byteSize: number | null;
}

/** A `ready`, unexpired export: what the download route needs to stream it. */
export interface DownloadableTenantExport extends TenantExportSummary {
  storageKey: string;
  byteSize: number;
  completedAt: string;
}

const SUMMARY_COLUMNS = "id, status, created_at, completed_at, expires_at, byte_size, storage_key";

interface TenantExportDbRow {
  id: string;
  status: string;
  created_at: Date;
  completed_at: Date | null;
  expires_at: Date | null;
  /** `bigint`, which `pg` returns as a string. */
  byte_size: string | null;
  storage_key: string | null;
}

function toSummary(row: TenantExportDbRow): TenantExportSummary {
  return {
    id: row.id,
    status: assertKnownValue(TENANT_EXPORT_STATUSES, row.status, "tenant_exports.status"),
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
  };
}

/** The `tenantExport` job's key, used when the export is requested and when an interrupted build is queued again. */
export function tenantExportJobKey(exportId: string): string {
  return `tenantExport:${exportId}`;
}

export interface RequestedTenantExport {
  export: TenantExportSummary;
  /** `false` when the tenant already had a pending or running export, which is returned instead. */
  created: boolean;
}

/**
 * How many times `requestTenantExport` retries when the active export it collided with finished
 * before it could be read back. Each retry is another insert, so a second collision means another
 * request created a new active export, which the next read returns.
 */
const REQUEST_ATTEMPTS = 3;

/**
 * Requests an export for the tenant in scope. When the tenant has no pending or running export a
 * new `pending` row is inserted and its `tenantExport` job is enqueued in the caller's transaction,
 * so the row and its job commit or roll back together. Otherwise the active export is returned with
 * `created: false` and nothing is enqueued.
 *
 * The conflict is decided by the insert itself against `tenant_exports_active_uq`, not by a prior
 * read. An active export can still finish between the ignored insert and the read-back; the insert
 * is then retried.
 */
export async function requestTenantExport(client: PoolClient, requestedBy: string): Promise<RequestedTenantExport> {
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    const inserted = await client.query<TenantExportDbRow>(
      `INSERT INTO tenant_exports (requested_by) VALUES ($1)
       ON CONFLICT (tenant_id) WHERE status IN ('pending', 'running') DO NOTHING
       RETURNING ${SUMMARY_COLUMNS}`,
      [requestedBy],
    );
    const row = inserted.rows[0];
    if (row) {
      await enqueueJob(
        client,
        CORE_TASK_NAMES.TENANT_EXPORT,
        { exportId: row.id },
        { jobKey: tenantExportJobKey(row.id), maxAttempts: 1 },
      );
      return { export: toSummary(row), created: true };
    }
    const active = await client.query<TenantExportDbRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM tenant_exports WHERE status IN ('pending', 'running')`,
    );
    const existing = active.rows[0];
    if (existing) return { export: toSummary(existing), created: false };
  }
  throw new Error(`requestTenantExport: no export was inserted or found active after ${REQUEST_ATTEMPTS} attempts`);
}

/** The tenant's exports that have not expired, newest first. A pending, running or failed export has no expiry yet and is listed. */
export async function listTenantExports(client: Queryable): Promise<TenantExportSummary[]> {
  const { rows } = await client.query<TenantExportDbRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM tenant_exports
      WHERE expires_at IS NULL OR expires_at > now()
      ORDER BY created_at DESC, id DESC`,
  );
  return rows.map(toSummary);
}

/** The export with this id when it is `ready` and unexpired in the tenant in scope; `null` for every other case, a foreign id included. */
export async function getDownloadableTenantExport(
  client: Queryable,
  id: string,
): Promise<DownloadableTenantExport | null> {
  const { rows } = await client.query<TenantExportDbRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM tenant_exports WHERE id = $1 AND status = 'ready' AND expires_at > now()`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const summary = toSummary(row);
  // `markTenantExportReady` sets all three together with the `ready` status.
  if (row.storage_key === null || summary.byteSize === null || summary.completedAt === null) {
    throw new Error(`tenant_exports row ${id} is ready without a storage key, byte size or completion time`);
  }
  return { ...summary, storageKey: row.storage_key, byteSize: summary.byteSize, completedAt: summary.completedAt };
}

/** The export with this id, its row locked until the caller's transaction ends; `null` when the tenant in scope has none. */
export async function getTenantExportForUpdate(client: PoolClient, id: string): Promise<TenantExportSummary | null> {
  const { rows } = await client.query<TenantExportDbRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM tenant_exports WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ? toSummary(rows[0]) : null;
}

/** `pending` → `running`. Throws when the row is missing or not pending. */
export async function markTenantExportRunning(client: Queryable, id: string): Promise<void> {
  const result = await client.query(
    "UPDATE tenant_exports SET status = 'running' WHERE id = $1 AND status = 'pending'",
    [id],
  );
  requireAffectedRows(result, "marking a pending tenant export running");
}

/**
 * `running` → `ready`, recording the archive's key and size; it expires
 * `TENANT_EXPORT_RETENTION_DAYS` after it completed. Throws when the row is missing or not running.
 */
export async function markTenantExportReady(
  client: Queryable,
  id: string,
  archive: { storageKey: string; byteSize: number },
): Promise<void> {
  const result = await client.query(
    `UPDATE tenant_exports
        SET status = 'ready', storage_key = $2, byte_size = $3, completed_at = now(),
            expires_at = now() + make_interval(days => $4)
      WHERE id = $1 AND status = 'running'`,
    [id, archive.storageKey, String(archive.byteSize), TENANT_EXPORT_RETENTION_DAYS],
  );
  requireAffectedRows(result, "marking a running tenant export ready");
}

/** `running` → `failed`. Throws when the row is missing or not running. */
export async function markTenantExportFailed(client: Queryable, id: string): Promise<void> {
  const result = await client.query(
    "UPDATE tenant_exports SET status = 'failed' WHERE id = $1 AND status = 'running'",
    [id],
  );
  requireAffectedRows(result, "marking a running tenant export failed");
}

/** `running` → `pending`, for a build interrupted by shutdown that is queued again. Throws when the row is missing or not running. */
export async function markTenantExportPending(client: Queryable, id: string): Promise<void> {
  const result = await client.query(
    "UPDATE tenant_exports SET status = 'pending' WHERE id = $1 AND status = 'running'",
    [id],
  );
  requireAffectedRows(result, "marking a running tenant export pending");
}

/**
 * Deletes the tenant's expired exports and its failed exports older than
 * `TENANT_EXPORT_RETENTION_DAYS`, returning the storage keys of the deleted rows that had an
 * archive. The caller deletes those files after its transaction commits.
 */
export async function deleteExpiredTenantExports(client: Queryable): Promise<string[]> {
  const { rows } = await client.query<{ storage_key: string | null }>(
    `DELETE FROM tenant_exports
      WHERE expires_at <= now()
         OR (status = 'failed' AND created_at <= now() - make_interval(days => $1))
      RETURNING storage_key`,
    [TENANT_EXPORT_RETENTION_DAYS],
  );
  return rows.flatMap((row) => (row.storage_key === null ? [] : [row.storage_key]));
}
