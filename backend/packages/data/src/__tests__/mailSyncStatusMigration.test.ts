import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, enqueueJob, ensureQueueSchema, runOnce } from "@semprec/queue";
import { createCoreTaskList } from "../worker.js";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { withTransaction } from "../db/pool.js";

it("upgrades historical mailbox sync states and preserves legacy writes", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // The identifier is a fixed prefix followed only by UUID hex digits.
  const name = `mail_sync_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-mail-sync-upgrade-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const target = "0115_mail_sync_status_tracking.sql";
  const ids = {
    success: randomUUID(),
    failure: randomUUID(),
    failureWithoutActivity: randomUUID(),
    never: randomUUID(),
  };
  const timestamp = "2026-01-02T03:04:05.000Z";
  let scratch: Pool | undefined;
  let created = false;
  const failures: unknown[] = [];
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({ connectionString: scratchUrl.toString() });
    for (const file of (await readdir(migrations)).filter((entry) => entry.endsWith(".sql") && entry < target).sort()) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(scratch, dir);
    const tenant = await scratch.query<{ id: string }>("SELECT id FROM tenants ORDER BY id LIMIT 1");
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error("Missing initial tenant");
    const database = scratch;
    // Historical states predate the four columns and cannot be created through the current store.
    await runInTenant(tenantId, () =>
      withTransaction(database, async (client) => {
        await client.query(
          "INSERT INTO mail_account_sync_state (item_id, sync_mode, last_error, last_activity_at, next_expected_activity_at) VALUES ($1, 'imap', NULL, $2, '2099-01-01'), ($3, 'imap', 'failed', $2, '2099-01-01'), ($4, 'imap', 'failed', NULL, '2099-01-01'), ($5, 'imap', NULL, NULL, '2099-01-01')",
          [ids.success, timestamp, ids.failure, ids.failureWithoutActivity, ids.never],
        );
      }),
    );
    await copyFile(path.join(migrations, target), path.join(dir, target));
    await runMigrations(database, dir);
    const rows = await runInTenant(tenantId, () =>
      withTransaction(database, (client) =>
        client.query<{
          item_id: string;
          last_successful_sync_at: Date | null;
          failing_since: Date | null;
          initial_sync_completed_at: Date | null;
          last_failure_kind: string | null;
        }>(
          "SELECT item_id, last_successful_sync_at, failing_since, initial_sync_completed_at, last_failure_kind FROM mail_account_sync_state",
        ),
      ),
    );
    const byId = new Map(rows.rows.map((row) => [row.item_id, row]));
    expect(byId.get(ids.success)).toMatchObject({
      last_successful_sync_at: new Date(timestamp),
      initial_sync_completed_at: new Date(timestamp),
      failing_since: null,
      last_failure_kind: null,
    });
    expect(byId.get(ids.failure)).toMatchObject({
      last_successful_sync_at: null,
      initial_sync_completed_at: null,
      failing_since: new Date(timestamp),
      last_failure_kind: "other",
    });
    expect(byId.get(ids.failureWithoutActivity)).toMatchObject({
      last_successful_sync_at: null,
      initial_sync_completed_at: null,
      failing_since: null,
      last_failure_kind: null,
    });
    expect(byId.get(ids.never)).toMatchObject({
      last_successful_sync_at: null,
      initial_sync_completed_at: null,
      failing_since: null,
      last_failure_kind: null,
    });
    // Run the current queued worker after the actual historical migration, preserving 0115 bytes.
    for (const file of (await readdir(migrations)).filter((entry) => entry.endsWith(".sql") && entry > target).sort()) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(database, dir);
    await ensureQueueSchema(database);
    await runAsSystem("test sweep", () => enqueueJob(database, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC_SWEEP, {}));
    await runOnce({ pgPool: database, taskList: createCoreTaskList(database, new Map()) });
    const repaired = await runInTenant(tenantId, () =>
      withTransaction(database, (client) =>
        client.query<{ last_failure_kind: string | null; failing_since: Date | null; last_activity_at: Date | null }>(
          "SELECT last_failure_kind, failing_since, last_activity_at FROM mail_account_sync_state WHERE item_id = $1",
          [ids.failureWithoutActivity],
        ),
      ),
    );
    expect(repaired.rows).toEqual([{ last_failure_kind: "other", failing_since: null, last_activity_at: null }]);
    await expect(
      runInTenant(tenantId, () =>
        withTransaction(database, (client) =>
          client.query("UPDATE mail_account_sync_state SET last_failure_kind = 'invalid' WHERE item_id = $1", [
            ids.success,
          ]),
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const legacy = randomUUID();
    await runInTenant(tenantId, () =>
      withTransaction(database, (client) =>
        client.query("INSERT INTO mail_account_sync_state (item_id, sync_mode) VALUES ($1, 'imap')", [legacy]),
      ),
    );
    const legacyRow = await runInTenant(tenantId, () =>
      withTransaction(database, (client) =>
        client.query<{ last_failure_kind: string | null }>(
          "SELECT last_failure_kind FROM mail_account_sync_state WHERE item_id = $1",
          [legacy],
        ),
      ),
    );
    expect(legacyRow.rows).toEqual([{ last_failure_kind: null }]);
  } catch (error) {
    failures.push(error);
  }
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    },
    async () => admin.end(),
    async () => rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Mail sync migration test failed and cleanup also failed");
}, 120_000);
