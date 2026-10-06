import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { enqueueJob } from "@semprec/queue";
import { runAsSystem } from "@semprec/shared";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createTestTenant, withTenantTransaction } from "../testSupport/tenantFixtures.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { upsertProcessHeartbeat } from "../health/processHeartbeats.js";
import { ensureMailAccountSyncState, recordSyncError } from "../mail/mailAccountSyncStateStore.js";
import { handleObservabilityCheckSystemTask } from "../observability/observabilityCheckSystem.js";

let pool: Pool;

async function createTestUser(tenantId = getTenantZeroId()): Promise<string> {
  const passwordHash = await hashPassword("s3cret-password");
  const user = await createUser(pool, { email: `${randomUUID()}@example.test`, passwordHash, locale: "en", tenantId });
  return user.id;
}

interface ObservabilityCheckRow {
  id: string;
  status: "ok" | "alerting";
  changed_at: Date;
}

async function getCheck(checkKey: string): Promise<ObservabilityCheckRow | undefined> {
  const { rows } = await pool.query<ObservabilityCheckRow>(
    `SELECT id, status, changed_at FROM observability_checks WHERE check_key = $1`,
    [checkKey],
  );
  return rows[0];
}

async function getTenantCheck(checkKey: string): Promise<(ObservabilityCheckRow & { tenant_id: string }) | undefined> {
  const { rows } = await pool.query<ObservabilityCheckRow & { tenant_id: string }>(
    `SELECT id, tenant_id, status, changed_at FROM tenant_observability_checks WHERE check_key = $1`,
    [checkKey],
  );
  return rows[0];
}

async function notificationsFor(sourceId: string): Promise<Array<{ kind: string; source_table: string }>> {
  const { rows } = await pool.query<{ kind: string; source_table: string }>(
    `SELECT kind, source_table FROM notifications WHERE source_id = $1 ORDER BY created_at`,
    [sourceId],
  );
  return rows;
}

/** Fresh beats for every fixed process so an unrelated process never triggers `process_stale` in a test that isn't about it. */
async function markAllProcessesFresh(): Promise<void> {
  for (const process of ["api", "agents", "transcribe", "ai-gateway"]) {
    await upsertProcessHeartbeat(pool, { process, pid: 1, version: "1.0.0" }, new Date());
  }
}

async function runCheck(jobId = randomUUID(), onPool: Pool = pool): Promise<void> {
  await runAsSystem("test", () => handleObservabilityCheckSystemTask(onPool, { job: { id: jobId } }));
}

describe("observability.checkSystem (issue #169)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await pool.query("DELETE FROM tenant_observability_checks");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("notifies once on a sustained process_stale fault and rearms after recovery", async () => {
    await createTestUser();
    await markAllProcessesFresh();
    await pool.query(`UPDATE process_heartbeats SET beat_at = now() - interval '5 minutes' WHERE process = 'agents'`);

    await runCheck();
    const afterFirst = await getCheck("process:agents");
    expect(afterFirst?.status).toBe("alerting");
    expect(await notificationsFor(afterFirst!.id)).toMatchObject([
      { kind: "process_stale", source_table: "observability_checks" },
    ]);

    // A second tick, still stale: state is read from Postgres, not memory, so this also covers
    // "notifies once across restarts" — a fresh process re-running this task sees the same row.
    await runCheck();
    expect(await notificationsFor(afterFirst!.id)).toHaveLength(1);

    // Recovery.
    await upsertProcessHeartbeat(pool, { process: "agents", pid: 1, version: "1.0.0" }, new Date());
    await runCheck();
    const afterRecovery = await getCheck("process:agents");
    expect(afterRecovery?.status).toBe("ok");

    // A later, independent fault rearms the notification.
    await pool.query(`UPDATE process_heartbeats SET beat_at = now() - interval '5 minutes' WHERE process = 'agents'`);
    await runCheck();
    const afterSecondFault = await getCheck("process:agents");
    expect(afterSecondFault?.status).toBe("alerting");
    expect(await notificationsFor(afterSecondFault!.id)).toHaveLength(2);
  });

  it("skips notifying before any user account exists, but still records the transition", async () => {
    await markAllProcessesFresh();
    await pool.query(
      `UPDATE process_heartbeats SET beat_at = now() - interval '5 minutes' WHERE process = 'transcribe'`,
    );

    await runCheck();
    const check = await getCheck("process:transcribe");
    expect(check?.status).toBe("alerting");
    expect(await notificationsFor(check!.id)).toHaveLength(0);
  });

  it("applies queue-backlog hysteresis: enters alerting past the full threshold, only recovers below half", async () => {
    await createTestUser();
    await markAllProcessesFresh();

    for (let i = 0; i < 101; i += 1) {
      await enqueueJob(pool, "someUnregisteredTask", { i });
    }

    await runCheck();
    const alerting = await getCheck("queue:backlog");
    expect(alerting?.status).toBe("alerting");
    expect(await notificationsFor(alerting!.id)).toMatchObject([{ kind: "queue_backlog" }]);

    // Drain to just below the alert threshold but still above the recover threshold (half):
    // hysteresis must keep this alerting, not flip back to ok.
    await pool.query(
      `DELETE FROM graphile_worker._private_jobs WHERE id IN (
         SELECT id FROM graphile_worker._private_jobs ORDER BY id LIMIT 21
       )`,
    );
    await runCheck();
    expect((await getCheck("queue:backlog"))?.status).toBe("alerting");
    expect(await notificationsFor(alerting!.id)).toHaveLength(1);

    // Drain below half (50) to actually recover.
    await pool.query(
      `DELETE FROM graphile_worker._private_jobs WHERE id IN (
         SELECT id FROM graphile_worker._private_jobs ORDER BY id LIMIT 40
       )`,
    );
    await runCheck();
    expect((await getCheck("queue:backlog"))?.status).toBe("ok");
  });

  it("flags a permanently-failed job (attempts >= max_attempts) as queue_backlog", async () => {
    await createTestUser();
    await markAllProcessesFresh();
    await enqueueJob(pool, "someUnregisteredTask", {}, { maxAttempts: 1 });
    await pool.query(`UPDATE graphile_worker._private_jobs SET attempts = 1`);

    await runCheck();
    const check = await getCheck("queue:permanentlyFailedJobs");
    expect(check?.status).toBe("alerting");
    expect(await notificationsFor(check!.id)).toMatchObject([{ kind: "queue_backlog" }]);
  });

  it("stays ok when the only permanently-failed job is locked (still running after a mid-run re-enqueue)", async () => {
    await createTestUser();
    await markAllProcessesFresh();
    await enqueueJob(pool, "someUnregisteredTask", {}, { maxAttempts: 1 });
    await pool.query(
      `UPDATE graphile_worker._private_jobs SET attempts = 1, locked_at = now(), locked_by = 'test-worker'`,
    );

    await runCheck();
    const check = await getCheck("queue:permanentlyFailedJobs");
    expect(check?.status).toBe("ok");
  });

  it("stays ok when the only permanently-failed job is past the prune retention window", async () => {
    await createTestUser();
    await markAllProcessesFresh();
    await enqueueJob(pool, "someUnregisteredTask", {}, { maxAttempts: 1 });
    await pool.query(`UPDATE graphile_worker._private_jobs SET attempts = 1, updated_at = now() - interval '8 days'`);

    await runCheck();
    const check = await getCheck("queue:permanentlyFailedJobs");
    expect(check?.status).toBe("ok");
  });

  it("folds an overdue next_expected_activity_at and a non-null last_error into one mail_sync_stalled predicate", async () => {
    await createTestUser();
    await markAllProcessesFresh();
    const overdueMailbox = randomUUID();
    await ensureMailAccountSyncState(pool, { itemId: overdueMailbox, syncMode: "imap" });
    await pool.query(
      `UPDATE mail_account_sync_state SET next_expected_activity_at = now() - interval '1 minute' WHERE item_id = $1`,
      [overdueMailbox],
    );

    const erroredMailbox = randomUUID();
    await ensureMailAccountSyncState(pool, { itemId: erroredMailbox, syncMode: "imap" });
    // A connection-limit backoff pushes next_expected_activity_at into the future while last_error
    // stays set — this account is not "due" for another sync pass, but must still alert.
    await recordSyncError(pool, erroredMailbox, "boom");
    await pool.query(
      `UPDATE mail_account_sync_state SET next_expected_activity_at = now() + interval '1 hour' WHERE item_id = $1`,
      [erroredMailbox],
    );

    const healthyMailbox = randomUUID();
    await ensureMailAccountSyncState(pool, { itemId: healthyMailbox, syncMode: "imap" });
    await pool.query(
      `UPDATE mail_account_sync_state SET next_expected_activity_at = now() + interval '1 hour' WHERE item_id = $1`,
      [healthyMailbox],
    );

    await runCheck();

    const overdueCheck = await getTenantCheck(`mail:${overdueMailbox}`);
    expect(overdueCheck?.status).toBe("alerting");
    expect(overdueCheck?.tenant_id).toBe(getTenantZeroId());
    const notifications = await pool.query<{ kind: string; source_table: string }>(
      `SELECT kind, source_table FROM notifications WHERE source_id = $1`,
      [overdueCheck!.id],
    );
    expect(notifications.rows).toEqual([{ kind: "mail_sync_stalled", source_table: "tenant_observability_checks" }]);

    const erroredCheck = await getTenantCheck(`mail:${erroredMailbox}`);
    expect(erroredCheck?.status).toBe("alerting");
    expect(erroredCheck?.tenant_id).toBe(getTenantZeroId());

    const healthyCheck = await getTenantCheck(`mail:${healthyMailbox}`);
    expect(healthyCheck?.status).toBe("ok");
    expect(healthyCheck?.tenant_id).toBe(getTenantZeroId());

    const globalRows = await pool.query<{ check_key: string; detail: string }>(
      `SELECT check_key, detail::text AS detail FROM observability_checks`,
    );
    expect(globalRows.rows.filter((row) => row.check_key.startsWith("mail:"))).toEqual([]);
    expect(globalRows.rows.some((row) => row.detail.includes("boom"))).toBe(false);
  });

  it("keeps hysteresis: a second run writes no notification and leaves changed_at, recovery flips to ok", async () => {
    await createTestUser();
    await markAllProcessesFresh();
    const mailboxItemId = randomUUID();
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "imap" });
    await recordSyncError(pool, mailboxItemId, "boom");

    await runCheck();
    const first = await getTenantCheck(`mail:${mailboxItemId}`);
    expect(first?.status).toBe("alerting");

    await runCheck();
    const second = await getTenantCheck(`mail:${mailboxItemId}`);
    expect(second?.changed_at).toEqual(first!.changed_at);
    expect(await notificationsFor(first!.id)).toHaveLength(1);

    await pool.query(`UPDATE mail_account_sync_state SET last_error = NULL WHERE item_id = $1`, [mailboxItemId]);
    await runCheck();
    expect((await getTenantCheck(`mail:${mailboxItemId}`))?.status).toBe("ok");
  });

  it("drops an orphaned mail check once its account is deleted, instead of leaving it alerting forever", async () => {
    await createTestUser();
    await markAllProcessesFresh();
    const mailboxItemId = randomUUID();
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "imap" });
    await recordSyncError(pool, mailboxItemId, "boom");

    await runCheck();
    expect((await getTenantCheck(`mail:${mailboxItemId}`))?.status).toBe("alerting");

    await pool.query(`DELETE FROM mail_account_sync_state WHERE item_id = $1`, [mailboxItemId]);
    await runCheck();
    expect(await getTenantCheck(`mail:${mailboxItemId}`)).toBeUndefined();
  });

  it("purges a legacy global mail: row that still carries a lastError", async () => {
    await markAllProcessesFresh();
    const legacyKey = `mail:${randomUUID()}`;
    await pool.query(
      `INSERT INTO observability_checks (check_key, status, detail) VALUES ($1, 'alerting', $2::jsonb)`,
      [legacyKey, JSON.stringify({ lastError: "boom" })],
    );

    await runCheck();
    expect(await getCheck(legacyKey)).toBeUndefined();
  });

  it("references the specific check row that transitioned as the notification's source", async () => {
    await createTestUser();
    await markAllProcessesFresh();
    await pool.query(`UPDATE process_heartbeats SET beat_at = now() - interval '5 minutes' WHERE process = 'api'`);

    await runCheck();
    const check = await getCheck("process:api");
    const { rows } = await pool.query<{ source_table: string; source_id: string }>(
      `SELECT source_table, source_id FROM notifications WHERE kind = 'process_stale'`,
    );
    expect(rows).toMatchObject([{ source_table: "observability_checks", source_id: check!.id }]);
  });

  it("notifies the user of the stalled mailbox's own tenant, not the globally earliest user", async () => {
    // Tenant zero's user is created first, so a global "earliest user" pick would choose it.
    const tenantZeroUser = await createTestUser();
    const otherTenantId = await createTestTenant(pool);
    const otherTenantUser = await createTestUser(otherTenantId);
    await markAllProcessesFresh();
    const mailboxItemId = randomUUID();
    await withTenantTransaction(pool, otherTenantId, async (client) => {
      await ensureMailAccountSyncState(client, { itemId: mailboxItemId, syncMode: "imap" });
      await recordSyncError(client, mailboxItemId, "boom");
    });

    // The superuser pool bypasses RLS and would show the one mailbox row to both tenants; the runtime role scopes it.
    const dataPool = await createRuntimeRolePool(pool, "semprec_data");
    try {
      await runCheck(randomUUID(), dataPool);
    } finally {
      await dataPool.end();
    }

    const { rows: checks } = await pool.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM tenant_observability_checks WHERE check_key = $1`,
      [`mail:${mailboxItemId}`],
    );
    expect(checks).toMatchObject([{ tenant_id: otherTenantId }]);
    const check = checks[0];
    const { rows } = await pool.query<{ user_id: string }>(`SELECT user_id FROM notifications WHERE source_id = $1`, [
      check!.id,
    ]);
    expect(rows).toEqual([{ user_id: otherTenantUser }]);
    expect(rows).not.toContainEqual({ user_id: tenantZeroUser });
  });
});
