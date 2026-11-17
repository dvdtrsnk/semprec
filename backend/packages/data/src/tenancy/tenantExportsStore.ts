import type { PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { requireAffectedRows, type Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";

/**
 * One row per requested export of the tenant in scope. Row-level security confines every statement; no
 * function takes a tenant id.
 */

const TENANT_EXPORT_STATUSES = ["pending", "running", "ready", "failed"] as const;

export type TenantExportStatus = (typeof TENANT_EXPORT_STATUSES)[number];

/** A ready export is downloadable this long after completion; failed rows are kept as long. */
const TENANT_EXPORT_RETENTION_DAYS = 7;

export interface TenantExportSummary {
  id: string;
  status: TenantExportStatus;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  byteSize: number | null;
}

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

/** Used at request time and when an interrupted build is requeued. */
export function tenantExportJobKey(exportId: string): string {
  return `tenantExport:${exportId}`;
}

export interface RequestedTenantExport {
  export: TenantExportSummary;
  /** `false` when the tenant already had a pending or running export, which is returned instead. */
  created: boolean;
}

/** Retries when the colliding active export finished before it could be read back; each retry re-inserts. */
const REQUEST_ATTEMPTS = 3;

/**
 * Without a pending or running export, inserts a `pending` row and enqueues its job in the caller's
 * transaction (they commit together); otherwise returns the active one with `created: false`. The
 * conflict is decided by the insert against `tenant_exports_active_uq`, not a prior read; an export
 * finishing before the read-back triggers a retry.
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

/** Unexpired exports, newest first; pending, running and failed ones have no expiry yet and are listed. */
export async function listTenantExports(client: Queryable): Promise<TenantExportSummary[]> {
  const { rows } = await client.query<TenantExportDbRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM tenant_exports
      WHERE expires_at IS NULL OR expires_at > now()
      ORDER BY created_at DESC, id DESC`,
  );
  return rows.map(toSummary);
}

/** `null` unless `ready` and unexpired in the tenant in scope (a foreign id included). */
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

/** Row locked until the caller's transaction ends; `null` when the tenant has none. */
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

/** `running` → `ready` with key and size; expires `TENANT_EXPORT_RETENTION_DAYS` later. Throws when the row is missing or not running. */
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

/** `running` → `pending` for a build requeued after shutdown. Throws when the row is missing or not running. */
export async function markTenantExportPending(client: Queryable, id: string): Promise<void> {
  const result = await client.query(
    "UPDATE tenant_exports SET status = 'pending' WHERE id = $1 AND status = 'running'",
    [id],
  );
  requireAffectedRows(result, "marking a running tenant export pending");
}

/**
 * Deletes expired exports and failed ones older than the retention, returning storage keys of deleted
 * archives for the caller to delete after commit.
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
