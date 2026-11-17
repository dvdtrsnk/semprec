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

/** Erases `deleting` tenants outside the choke point: bytes before rows, under per-tenant try-locks. */

/** Rows deleted per statement and blobs read per page. */
const ROW_CHUNK = 1000;
const BLOB_PAGE = 500;

/** Wait for the job table `LOCK TABLE` or a queue row lock during finalisation before the run fails. */
const QUEUE_LOCK_TIMEOUT = "2s";

/** `:<tenantId>` suffix of `tenantLane`: a colon and a 36-character UUID. */
const TENANT_QUEUE_SUFFIX_LENGTH = 37;

export interface TenantPurgeDirs {
  files: string;
  mailAttachments: string;
}

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

async function readCatalog(pool: Pool): Promise<{ tables: string[]; foreignKeys: TableForeignKey[] }> {
  const { rows: tableRows } = await pool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
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
    tables: tableRows.map((row) => row.relname),
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

/** Each key is removed from both roots (content-hash dedup spans them). Any failure throws before finalising. */
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

/** Repeated after the rows are gone, catching bytes an in-flight writer stored after the bytes step. */
async function removeTenantDirectories(ctx: PurgeContext): Promise<void> {
  for (const root of ctx.roots) await rm(join(root, ctx.tenantId), { recursive: true, force: true });
}

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

/** Children before parents, so no delete removes a row that a row still to be deleted references. */
async function purgeRows(ctx: PurgeContext): Promise<number> {
  const { tables, foreignKeys } = await readCatalog(ctx.pool);
  const order = orderTablesForPurge(tables, foreignKeys);
  const selfReferencing = new Set(foreignKeys.filter((fk) => fk.table === fk.referencedTable).map((fk) => fk.table));

  let total = 0;
  checkpoint(ctx);
  const credentials = await ctx.pool.query(`DELETE FROM agent_run_mcp_credentials WHERE tenant_id = $1`, [
    ctx.tenantId,
  ]);
  total += credentials.rowCount ?? 0;
  for (const table of order) {
    total += selfReferencing.has(table) ? await deleteInOneStatement(ctx, table) : await deleteInChunks(ctx, table);
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
 * `add_job` takes no queue row lock and `job_queue_id` has no FK, so without the table lock a job from a
 * still-open transaction would be left pointing at a deleted queue. A queue still in use fails the run.
 */
async function eraseIdleQueues(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('lock_timeout', $1, true)", [QUEUE_LOCK_TIMEOUT]);
  await client.query("LOCK TABLE graphile_worker._private_jobs IN SHARE ROW EXCLUSIVE MODE");
  // Zero rows is valid: a tenant may never have enqueued into a lane; a held queue is caught below.
  const erased = await client.query(
    `DELETE FROM graphile_worker._private_job_queues AS q
      WHERE right(q.queue_name, $2::int) = ':' || $1::text
        AND q.locked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM graphile_worker._private_jobs AS j WHERE j.job_queue_id = q.id)`,
    [tenantId, TENANT_QUEUE_SUFFIX_LENGTH],
  );
  logger.info({ tenantId, step: "queues", count: erased.rowCount ?? 0 }, "tenant_purge_step");
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM graphile_worker._private_job_queues AS q
        WHERE right(q.queue_name, $2::int) = ':' || $1::text
     ) AS present`,
    [tenantId, TENANT_QUEUE_SUFFIX_LENGTH],
  );
  if (requireSingleRow(rows, "tenant queue presence").present) {
    throw new Error("Tenant purge left rows behind in: graphile_worker._private_job_queues");
  }
}

/** One transaction: assert nothing remains, erase identity rows, tombstone, delete the tenant, erase idle queues. */
async function finalise(ctx: PurgeContext): Promise<void> {
  const { tables } = await readCatalog(ctx.pool);
  await withTransaction(ctx.pool, async (client) => {
    await assertNothingRemains(client, ctx.tenantId, tables);
    const { rows: users } = await client.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE tenant_id = $1",
      [ctx.tenantId],
    );
    for (const user of users) {
      const email = normalizeEmail(user.email);
      // Zero rows is valid: a user may have no sessions, tokens, attempts or invites.
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
    await eraseIdleQueues(client, ctx.tenantId);
  });
}

/** Each step is idempotent and resumable after a crash. */
async function purgeTenant(ctx: PurgeContext): Promise<void> {
  const { tenantId } = ctx;
  await runInTenant(tenantId, async () => {
    const keys = await ctx.pool.query("DELETE FROM tenant_keys WHERE tenant_id = $1", [tenantId]);
    logger.info({ tenantId, step: "keys", count: keys.rowCount ?? 0 }, "tenant_purge_step");
    logger.info({ tenantId, step: "jobs", count: await purgeQueuedJobs(ctx) }, "tenant_purge_step");
    logger.info({ tenantId, step: "bytes", count: await purgeBytes(ctx) }, "tenant_purge_step");
    logger.info({ tenantId, step: "rows", count: await purgeRows(ctx) }, "tenant_purge_step");
    checkpoint(ctx);
    await removeTenantDirectories(ctx);
    await finalise(ctx);
  });
  logger.info({ tenantId }, "tenant_purge_completed");
}

/** Under the tenant's session-level advisory lock; `false` when locked elsewhere or no longer `deleting`. */
async function purgeUnderLock(
  pool: Pool,
  dirs: TenantPurgeDirs,
  tenantId: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  // A dedicated connection, not `withTransaction`: the session-level lock must span the many transactions
  // `purgeTenant` commits. The `finally` unlocks and releases on every path.
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
 * Oldest request first; locked tenants are skipped. Failures are logged by class only (messages can carry
 * tenant content) and rethrown as one `AggregateError`. On abort it stops between chunks and returns.
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

export interface TenantDeletionReplayResult {
  marked: string[];
  alreadyDeleting: string[];
  absent: string[];
  refused: { tenantId: string; reason: "lastAdmin" | "unexpectedStatus" }[];
}

type ReplayOutcome = "marked" | "alreadyDeleting" | "absent" | "lastAdmin" | "unexpectedStatus";

/** Decides, and for an `active`/`suspended` tenant starts, one tenant's deletion in its scope. */
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

    // Only an admin of an active tenant counts towards the guard. `users_tenant_id_key` allows one user per
    // tenant, so excluding that user excludes the tenant.
    if (status === "active") {
      const { rows: admins } = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' ORDER BY id",
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
 * Re-applies a backup ledger's deletions to a restored database, one transaction per tenant, in order.
 * `deleting`/absent tenants are left alone; the last active admin's tenant and other statuses are `refused`.
 * Other failures stop the loop; a rerun skips marked tenants. A `lastAdmin` refusal needs an operator.
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
