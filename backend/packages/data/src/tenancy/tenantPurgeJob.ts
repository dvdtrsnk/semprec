import { rm } from "node:fs/promises";
import { join } from "node:path";
import { escapeIdentifier, type Pool, type PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { normalizeEmail } from "../auth/emailNormalization.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { assertAnotherActiveAdminRemains, LastAdminError, lockAdminMembership } from "./accountsAdminStore.js";
import { beginTenantDeletion } from "./deleteAccount.js";
import { logger } from "./logger.js";
import { orderTablesForPurge, type TableForeignKey } from "./tenantPurgeOrder.js";

/**
 * The sweep that erases a `deleting` tenant (issue #1055). Why it deletes outside the choke point,
 * bytes before rows, and per-tenant try-locks: `docs/adr/2026-10-18-tenant-purge-erases-outside-the-choke-point.md`.
 */

/** Rows deleted per statement and blobs read per page. */
const ROW_CHUNK = 1000;
const BLOB_PAGE = 500;

/** How long dropping an `items` partition may wait for its `ACCESS EXCLUSIVE` lock before the tenant is retried next run. */
const PARTITION_LOCK_TIMEOUT = "5s";

/** The two blob roots a tenant's bytes can live under. */
export interface TenantPurgeDirs {
  files: string;
  mailAttachments: string;
}

/** The part of graphile-worker's `JobHelpers` the purge reads. */
export interface TenantPurgeHelpers {
  abortSignal?: AbortSignal;
}

/** Thrown between chunks once the worker is shutting down; the handler stops and returns normally. */
class TenantPurgeInterruptedError extends Error {
  constructor() {
    super("Tenant purge interrupted by worker shutdown");
    this.name = "TenantPurgeInterruptedError";
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

interface PurgeContext {
  pool: Pool;
  tenantId: string;
  roots: string[];
  signal: AbortSignal | undefined;
}

/** Called only between committed units of work, never inside a transaction. */
function checkpoint(ctx: PurgeContext): void {
  if (ctx.signal?.aborted) throw new TenantPurgeInterruptedError();
}

interface BlobPageRow {
  id: string;
  storage_key: string;
}

interface CatalogTable {
  name: string;
  partitioned: boolean;
}

async function readCatalog(pool: Pool): Promise<{ tables: CatalogTable[]; foreignKeys: TableForeignKey[] }> {
  const { rows: tableRows } = await pool.query<{ relname: string; relkind: string }>(
    `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND obj_description(c.oid, 'pg_class') = 'semprec:tenancy=tenant'
      ORDER BY 1`,
  );
  const { rows: fkRows } = await pool.query<{ table_name: string; referenced_table: string }>(
    `SELECT child.relname AS table_name, parent.relname AS referenced_table
       FROM pg_constraint con
       JOIN pg_class child ON child.oid = con.conrelid
       JOIN pg_class parent ON parent.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = child.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public' AND NOT child.relispartition AND NOT parent.relispartition`,
  );
  return {
    tables: tableRows.map((row) => ({ name: row.relname, partitioned: row.relkind === "p" })),
    foreignKeys: fkRows.map((row) => ({ table: row.table_name, referencedTable: row.referenced_table })),
  };
}

/** Removes the tenant's unlocked queued jobs, the way `queueFailedJobsPrune.ts` removes failed ones. */
async function purgeQueuedJobs(ctx: PurgeContext): Promise<number> {
  let removed = 0;
  for (;;) {
    checkpoint(ctx);
    const completed = await withTransaction(ctx.pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT jobs.id FROM graphile_worker._private_jobs AS jobs
          WHERE jobs.payload->>'tenantId' = $1 AND jobs.locked_at IS NULL
          LIMIT $2
            FOR UPDATE OF jobs SKIP LOCKED`,
        [ctx.tenantId, ROW_CHUNK],
      );
      if (rows.length === 0) return 0;
      const { rows: done } = await client.query(`SELECT * FROM graphile_worker.complete_jobs($1::bigint[])`, [
        rows.map((row) => row.id),
      ]);
      return done.length;
    });
    if (completed === 0) return removed;
    removed += completed;
  }
}

/**
 * Deletes the tenant's blob and export bytes. A blob's bytes can sit in either root (uploads and
 * mail attachments share content-hash deduplication), so each key is removed from both; the
 * removal is idempotent. Any failure throws, so the tenant is not finalised with bytes left behind.
 */
async function readBlobPage(ctx: PurgeContext, afterId: string | null): Promise<BlobPageRow[]> {
  const { rows } = await ctx.pool.query<BlobPageRow>(
    `SELECT id, storage_key FROM blobs
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT $3`,
    [ctx.tenantId, afterId, BLOB_PAGE],
  );
  return rows;
}

async function purgeBytes(ctx: PurgeContext): Promise<number> {
  const writers = ctx.roots.map((root) => new LocalFsBlobStorageWriter(root));
  let removed = 0;
  let afterId: string | null = null;
  for (;;) {
    checkpoint(ctx);
    const rows = await readBlobPage(ctx, afterId);
    for (const row of rows) {
      for (const writer of writers) await writer.delete(row.storage_key);
    }
    removed += rows.length;
    const last = rows[rows.length - 1];
    if (!last || rows.length < BLOB_PAGE) break;
    afterId = last.id;
  }

  checkpoint(ctx);
  const { rows: exports } = await ctx.pool.query<{ storage_key: string }>(
    "SELECT storage_key FROM tenant_exports WHERE tenant_id = $1 AND storage_key IS NOT NULL",
    [ctx.tenantId],
  );
  for (const row of exports) {
    for (const writer of writers) await writer.delete(row.storage_key);
  }
  removed += exports.length;

  await removeTenantDirectories(ctx);
  return removed;
}

/**
 * Removes `<root>/<tenantId>` under both roots. Runs in the bytes step and again once the rows are
 * gone, so bytes a writer already running at deletion time stored after the bytes step are erased too.
 */
async function removeTenantDirectories(ctx: PurgeContext): Promise<void> {
  for (const root of ctx.roots) await rm(join(root, ctx.tenantId), { recursive: true, force: true });
}

/**
 * Drops the `items` partition of each of the tenant's databases, one transaction each
 * (`set_config(…, true)` is `SET LOCAL`). Runs as its own step and again right before `items`
 * is deleted, so a database a writer already running at deletion time created after the first
 * pass loses its partition too.
 */
async function purgePartitions(ctx: PurgeContext): Promise<number> {
  const { rows } = await ctx.pool.query<{ id: string }>("SELECT id FROM databases WHERE tenant_id = $1 ORDER BY id", [
    ctx.tenantId,
  ]);
  for (const row of rows) {
    checkpoint(ctx);
    await withTransaction(ctx.pool, async (client) => {
      await client.query("SELECT set_config('lock_timeout', $1, true)", [PARTITION_LOCK_TIMEOUT]);
      await client.query("SELECT drop_items_partition($1)", [row.id]);
    });
  }
  return rows.length;
}

/** Deletes the tenant's rows of `table` in chunks of `ROW_CHUNK`, one transaction per chunk. */
async function deleteInChunks(ctx: PurgeContext, table: string): Promise<number> {
  const quoted = escapeIdentifier(table);
  let deleted = 0;
  for (;;) {
    checkpoint(ctx);
    const result = await withTransaction(ctx.pool, (client) =>
      client.query(
        `DELETE FROM ${quoted} WHERE ctid = ANY(ARRAY(SELECT ctid FROM ${quoted} WHERE tenant_id = $1 LIMIT $2))`,
        [ctx.tenantId, ROW_CHUNK],
      ),
    );
    const count = result.rowCount ?? 0;
    if (count === 0) return deleted;
    deleted += count;
  }
}

/** Deletes every tenant row of `table` in one statement, so a self-referencing foreign key sees the whole set. */
async function deleteInOneStatement(ctx: PurgeContext, table: string): Promise<number> {
  checkpoint(ctx);
  const result = await withTransaction(ctx.pool, (client) =>
    client.query(`DELETE FROM ${escapeIdentifier(table)} WHERE tenant_id = $1`, [ctx.tenantId]),
  );
  return result.rowCount ?? 0;
}

/**
 * Deletes `agent_run_mcp_credentials` (global, references `agent_runs`) and then every tenant table,
 * children before parents. `items` and any other partitioned table cannot use the `ctid` chunking
 * (a `ctid` is only unique within one partition), so they are deleted by predicate: the partitions
 * are dropped again just before `items` (which precedes `databases`, its parent) and the statement
 * must affect nothing. Rows it does find come from a database created after that second pass: they
 * are deleted (committed) and the tenant fails before `databases` is reached, so the retry still
 * finds that database and drops its partition.
 */
async function purgeRows(ctx: PurgeContext): Promise<number> {
  const { tables, foreignKeys } = await readCatalog(ctx.pool);
  const order = orderTablesForPurge(
    tables.map((table) => table.name),
    foreignKeys,
  );
  const partitioned = new Set(tables.filter((table) => table.partitioned).map((table) => table.name));
  const selfReferencing = new Set(foreignKeys.filter((fk) => fk.table === fk.referencedTable).map((fk) => fk.table));

  let total = 0;
  checkpoint(ctx);
  const credentials = await ctx.pool.query(`DELETE FROM agent_run_mcp_credentials WHERE tenant_id = $1`, [
    ctx.tenantId,
  ]);
  total += credentials.rowCount ?? 0;
  for (const table of order) {
    if (table === "items") {
      logger.info(
        { tenantId: ctx.tenantId, step: "latePartitions", count: await purgePartitions(ctx) },
        "tenant_purge_step",
      );
    }
    const count =
      partitioned.has(table) || selfReferencing.has(table)
        ? await deleteInOneStatement(ctx, table)
        : await deleteInChunks(ctx, table);
    total += count;
    if (partitioned.has(table) && count > 0) {
      throw new Error(`Tenant purge deleted ${count} rows of ${table} after its partitions were dropped`);
    }
  }
  return total;
}

/** Throws naming every table (never a row) that still holds a row of the tenant. */
async function assertNothingRemains(client: PoolClient, tenantId: string, tables: string[]): Promise<void> {
  const remaining: string[] = [];
  for (const table of [...tables, "agent_run_mcp_credentials"]) {
    const { rows } = await client.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${escapeIdentifier(table)} WHERE tenant_id = $1) AS present`,
      [tenantId],
    );
    if (requireSingleRow(rows, "tenant row presence").present) remaining.push(table);
  }
  if (remaining.length > 0) throw new Error(`Tenant purge left rows behind in: ${remaining.join(", ")}`);
}

/**
 * Finalises the purge in one transaction: asserts nothing tenant-owned remains, erases the
 * tenant's identity rows, records the tombstone and deletes the `tenants` row.
 */
async function finalise(ctx: PurgeContext): Promise<void> {
  const { tables } = await readCatalog(ctx.pool);
  await withTransaction(ctx.pool, async (client) => {
    await assertNothingRemains(
      client,
      ctx.tenantId,
      tables.map((table) => table.name),
    );
    const { rows: users } = await client.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE COALESCE(tenant_id, app_sole_tenant()) = $1",
      [ctx.tenantId],
    );
    for (const user of users) {
      const email = normalizeEmail(user.email);
      // Zero rows is valid for each of these: a user may have no sessions, tokens, attempts or invites.
      const pushSubscriptions = await client.query("DELETE FROM push_subscriptions WHERE user_id = $1", [user.id]);
      const sessions = await client.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
      const resetTokens = await client.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [user.id]);
      const loginAttempts = await client.query("DELETE FROM login_attempts WHERE email = $1", [email]);
      const invites = await client.query("DELETE FROM invites WHERE email = $1", [email]);
      logger.info(
        {
          tenantId: ctx.tenantId,
          step: "identity",
          counts: {
            pushSubscriptions: pushSubscriptions.rowCount ?? 0,
            sessions: sessions.rowCount ?? 0,
            resetTokens: resetTokens.rowCount ?? 0,
            loginAttempts: loginAttempts.rowCount ?? 0,
            invites: invites.rowCount ?? 0,
          },
        },
        "tenant_purge_step",
      );
      requireAffectedRows(await client.query("DELETE FROM users WHERE id = $1", [user.id]), "users delete");
    }
    requireAffectedRows(
      await client.query(
        `INSERT INTO tenant_deletions (tenant_id, requested_at)
         SELECT id, status_changed_at FROM tenants WHERE id = $1 AND status = 'deleting'`,
        [ctx.tenantId],
      ),
      "tenant_deletions insert",
    );
    requireAffectedRows(
      await client.query("DELETE FROM tenants WHERE id = $1 AND status = 'deleting'", [ctx.tenantId]),
      "tenants delete",
    );
  });
}

/** Runs every purge step for one tenant, in order; each is idempotent and resumable after a crash. */
async function purgeTenant(ctx: PurgeContext): Promise<void> {
  const { tenantId } = ctx;
  await runInTenant(tenantId, async () => {
    const keys = await ctx.pool.query("DELETE FROM tenant_keys WHERE tenant_id = $1", [tenantId]);
    logger.info({ tenantId, step: "keys", count: keys.rowCount ?? 0 }, "tenant_purge_step");
    logger.info({ tenantId, step: "jobs", count: await purgeQueuedJobs(ctx) }, "tenant_purge_step");
    logger.info({ tenantId, step: "bytes", count: await purgeBytes(ctx) }, "tenant_purge_step");
    logger.info({ tenantId, step: "partitions", count: await purgePartitions(ctx) }, "tenant_purge_step");
    logger.info({ tenantId, step: "rows", count: await purgeRows(ctx) }, "tenant_purge_step");
    checkpoint(ctx);
    await removeTenantDirectories(ctx);
    await finalise(ctx);
  });
  logger.info({ tenantId }, "tenant_purge_completed");
}

/**
 * Runs `purgeTenant` while holding the tenant's session-level advisory lock on a dedicated
 * connection. Returns `false` without purging when another run holds the lock, or when the tenant
 * is no longer `deleting` once the lock is held (a run that held it finished first).
 */
async function purgeUnderLock(
  pool: Pool,
  dirs: TenantPurgeDirs,
  tenantId: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  // A dedicated connection, not `withTransaction`: the advisory lock is session-level and must stay
  // held across the many transactions `purgeTenant` commits. The `finally` below unlocks and
  // releases it on every path (this is the write-safety baseline's leaked-connect entry for this file).
  const client = await pool.connect();
  let releaseError: Error | undefined;
  let locked = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended('semprec_tenant_purge:' || $1::text, 0)) AS locked",
      [tenantId],
    );
    locked = requireSingleRow(rows, "pg_try_advisory_lock").locked;
    if (!locked) return false;

    const { rows: current } = await client.query("SELECT 1 FROM tenants WHERE id = $1 AND status = 'deleting'", [
      tenantId,
    ]);
    if (current.length === 0) return false;

    await purgeTenant({ pool, tenantId, roots: [dirs.files, dirs.mailAttachments], signal });
    return true;
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended('semprec_tenant_purge:' || $1::text, 0))", [
          tenantId,
        ]);
      } catch (unlockErr) {
        // A failed unlock leaves the session holding the lock; destroying the connection drops it.
        releaseError = unlockErr instanceof Error ? unlockErr : new Error(String(unlockErr));
        logger.error({ tenantId, errorName: errorName(unlockErr) }, "tenant_purge_unlock_failed");
      }
    }
    client.release(releaseError);
  }
}

/**
 * The `tenantPurge` task: erases every `deleting` tenant, oldest request first. A tenant whose
 * lock another run holds is skipped. One tenant's failure does not skip the others: failures are
 * logged by class name only (an error message can echo tenant content), collected, and rethrown
 * together as an `AggregateError` after the loop. When `helpers.abortSignal` aborts, the run stops
 * between chunks and returns normally; the next minute's run resumes.
 */
export async function handleTenantPurgeTask(
  pool: Pool,
  dirs: TenantPurgeDirs,
  helpers: TenantPurgeHelpers = {},
): Promise<void> {
  await runAsSystem("tenant-purge", async () => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM tenants WHERE status = 'deleting' ORDER BY status_changed_at",
    );
    const errors: unknown[] = [];
    for (const row of rows) {
      if (helpers.abortSignal?.aborted) break;
      try {
        await purgeUnderLock(pool, dirs, row.id, helpers.abortSignal);
      } catch (err) {
        if (err instanceof TenantPurgeInterruptedError) break;
        logger.error({ errorName: errorName(err), tenantId: row.id }, "tenant_purge_failed");
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `tenantPurge: ${errors.length} of ${rows.length} tenants failed`);
    }
  });
}

/** What `replayTenantDeletions` did with the ids it was given. */
export interface TenantDeletionReplayResult {
  marked: string[];
  alreadyDeleting: string[];
  absent: string[];
  refused: { tenantId: string; reason: "lastAdmin" | "unexpectedStatus" }[];
}

type ReplayOutcome = "marked" | "alreadyDeleting" | "absent" | "lastAdmin" | "unexpectedStatus";

/** Decides and, for an `active` or `suspended` tenant, starts the deletion of one tenant; runs in the tenant's scope. */
async function replayOneTenant(pool: Pool, tenantId: string): Promise<ReplayOutcome> {
  return withTransaction(pool, async (client): Promise<ReplayOutcome> => {
    // Same order as the account-deletion routes: the membership lock first, then the tenant row.
    await lockAdminMembership(client);
    const { rows } = await client.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1 FOR UPDATE", [
      tenantId,
    ]);
    const status = rows[0]?.status;
    if (status === undefined) return "absent";
    if (status === "deleting") return "alreadyDeleting";
    if (status !== "active" && status !== "suspended") return "unexpectedStatus";

    // Only an admin of an active tenant counts towards the guard, as in deleteAccount.
    if (status === "active") {
      const { rows: admins } = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE COALESCE(tenant_id, app_sole_tenant()) = $1 AND role = 'admin' ORDER BY id",
        [tenantId],
      );
      for (const admin of admins) {
        try {
          await assertAnotherActiveAdminRemains(client, admin.id);
        } catch (err) {
          if (err instanceof LastAdminError) return "lastAdmin";
          throw err;
        }
      }
    }
    await beginTenantDeletion(client, tenantId);
    return "marked";
  });
}

/**
 * Re-applies deletions recorded in a backup ledger to a restored database (issue #1078): every
 * `active` or `suspended` tenant in `tenantIds` goes through `beginTenantDeletion`, one transaction
 * per tenant, and the purge sweep then erases it. A tenant that is already `deleting` or absent is
 * reported and left alone; the last active admin's tenant and a tenant in another status (e.g.
 * `provisioning`) are `refused` and left unchanged. Any other failure propagates, so a replay that
 * could not finish never reports success: the loop stops there on purpose, the tenants already
 * marked stay marked, and running the replay again skips them as `alreadyDeleting`.
 *
 * Tenants are handled in the order given, and each one sees the admins left by the ones before it.
 * If every active admin's tenant was deleted before the backup, the last of them in the ledger is
 * refused as `lastAdmin` although its deletion was recorded: a `lastAdmin` refusal means a recorded
 * deletion was not applied and needs an operator's decision.
 */
export async function replayTenantDeletions(
  pool: Pool,
  tenantIds: readonly string[],
): Promise<TenantDeletionReplayResult> {
  const result: TenantDeletionReplayResult = { marked: [], alreadyDeleting: [], absent: [], refused: [] };
  for (const tenantId of tenantIds) {
    const outcome = await runInTenant(tenantId, () => replayOneTenant(pool, tenantId));
    if (outcome === "lastAdmin" || outcome === "unexpectedStatus") result.refused.push({ tenantId, reason: outcome });
    else result[outcome].push(tenantId);
  }
  return result;
}
