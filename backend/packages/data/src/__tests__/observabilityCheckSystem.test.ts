import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { enqueueJob } from "@semprec/queue";
import "../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createUser, listAdminRecipients } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { mailSyncProcessName, upsertProcessHeartbeat } from "../health/processHeartbeats.js";
import { ensureMailAccountSyncState, recordSyncError } from "../mail/mailAccountSyncStateStore.js";
import { handleObservabilityCheckSystemTask } from "../observability/observabilityCheckSystem.js";

let pool: Pool;

/** Tenant zero's admin by default; a further tenant's user when `tenantId` is given. */
async function createTestUser(tenantId = getTenantZeroId(), role: "admin" | "member" = "admin"): Promise<string> {
  const passwordHash = await hashPassword("s3cret-password");
  const user = await createUser(pool, {
    email: `${randomUUID()}@example.test`,
    passwordHash,
    locale: "en",
    tenantId,
    role,
  });
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

/** A real Mailbox item (the liveness list joins `items`) plus its sync-state row, in tenant zero. */
async function createActiveMailbox(): Promise<string> {
  return runInTenant(getTenantZeroId(), () =>
    withTransaction(pool, async (client) => {
      const database = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
      if (!database) throw new Error("fixture: no mailboxes database");
      const item = await createItemWithClient(client, {
        databaseId: database.id,
        properties: { name: "Liveness", provider: "generic" },
      });
      await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: "imap" });
      return item.id;
    }),
  );
}

async function beatMailbox(mailboxId: string, ageMs: number): Promise<void> {
  await upsertProcessHeartbeat(pool, { process: mailSyncProcessName(mailboxId), pid: 1, version: "1.0.0" }, new Date());
  await pool.query(
    "UPDATE process_heartbeats SET beat_at = now() - ($2::bigint * interval '1 millisecond') WHERE process = $1",
    [mailSyncProcessName(mailboxId), ageMs],
  );
}

async function runCheck(jobId = randomUUID(), taskPool: Pool = pool): Promise<void> {
  await runAsSystem("test", () => handleObservabilityCheckSystemTask(taskPool, { job: { id: jobId } }));
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

  it("skips notifying before any admin exists, but still records the transition", async () => {
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

  describe("per-mailbox process liveness (issue #1000)", () => {
    /** `beatAt` is null when the mailbox has never beaten, an ISO timestamp once it has. */
    type LivenessNotificationRow = {
      kind: string;
      source_table: string;
      payload: { mailboxItemId: string; beatAt: string | null };
    };

    beforeEach(async () => {
      await seedSystem(pool);
    });

    it("keeps the mailbox out of the global plane and alerts once in the tenant table", async () => {
      await createTestUser();
      await markAllProcessesFresh();
      const mailboxId = await createActiveMailbox();
      await beatMailbox(mailboxId, 5 * 60_000);

      await runCheck();
      await runCheck();

      const globalRows = await pool.query<{ check_key: string; status: string }>(
        `SELECT check_key, status FROM observability_checks
         WHERE check_key LIKE 'process:%' OR check_key LIKE '%' || $1 || '%' OR detail::text LIKE '%' || $1 || '%'
         ORDER BY check_key`,
        [mailboxId],
      );
      expect(globalRows.rows).toEqual([
        { check_key: "process:agents", status: "ok" },
        { check_key: "process:ai-gateway", status: "ok" },
        { check_key: "process:api", status: "ok" },
        { check_key: "process:transcribe", status: "ok" },
      ]);
      const stale = await pool.query(`SELECT 1 FROM notifications WHERE kind = 'process_stale'`);
      expect(stale.rows).toEqual([]);

      const row = await getTenantCheck(`process:mailsync:${mailboxId}`);
      expect(row?.status).toBe("alerting");
      expect(row?.tenant_id).toBe(getTenantZeroId());
      const detail = await pool.query<{ detail: { process: string; present: boolean; beatAt: string | null } }>(
        `SELECT detail FROM tenant_observability_checks WHERE id = $1`,
        [row!.id],
      );
      expect(detail.rows[0]?.detail).toEqual({
        process: `mailsync:${mailboxId}`,
        present: true,
        beatAt: expect.any(String),
      });
      const notifications = await pool.query<LivenessNotificationRow>(
        `SELECT kind, source_table, payload FROM notifications WHERE source_id = $1`,
        [row!.id],
      );
      expect(notifications.rows).toEqual([
        {
          kind: "mail_sync_stalled",
          source_table: "tenant_observability_checks",
          payload: { mailboxItemId: mailboxId, beatAt: detail.rows[0]!.detail.beatAt },
        },
      ]);
    });

    it("alerts on a missing heartbeat, recovers on a fresh one and notifies again on a later fault", async () => {
      await createTestUser();
      await markAllProcessesFresh();
      const mailboxId = await createActiveMailbox();
      const checkKey = `process:mailsync:${mailboxId}`;

      await runCheck();
      const alerting = await getTenantCheck(checkKey);
      expect(alerting?.status).toBe("alerting");
      const missing = await pool.query<{ detail: { present: boolean; beatAt: string | null } }>(
        `SELECT detail FROM tenant_observability_checks WHERE id = $1`,
        [alerting!.id],
      );
      expect(missing.rows[0]?.detail).toMatchObject({ present: false, beatAt: null });
      const firstAlert = await pool.query<LivenessNotificationRow>(
        `SELECT kind, source_table, payload FROM notifications WHERE source_id = $1`,
        [alerting!.id],
      );
      expect(firstAlert.rows).toEqual([
        {
          kind: "mail_sync_stalled",
          source_table: "tenant_observability_checks",
          payload: { mailboxItemId: mailboxId, beatAt: null },
        },
      ]);

      await beatMailbox(mailboxId, 0);
      await runCheck();
      expect((await getTenantCheck(checkKey))?.status).toBe("ok");

      await beatMailbox(mailboxId, 5 * 60_000);
      await runCheck();
      expect((await getTenantCheck(checkKey))?.status).toBe("alerting");
      expect(await notificationsFor(alerting!.id)).toHaveLength(2);
    });

    it("removes the tenant row of a soft-deleted mailbox and purges legacy global mailsync rows", async () => {
      await createTestUser();
      await markAllProcessesFresh();
      const mailboxId = await createActiveMailbox();
      await runCheck();
      expect(await getTenantCheck(`process:mailsync:${mailboxId}`)).toBeDefined();

      await pool.query("UPDATE items SET deleted_at = now() WHERE id = $1", [mailboxId]);
      const legacyKey = `process:mailsync:${randomUUID()}`;
      await pool.query(`INSERT INTO observability_checks (check_key, status) VALUES ($1, 'alerting')`, [legacyKey]);

      await runCheck();

      expect(await getTenantCheck(`process:mailsync:${mailboxId}`)).toBeUndefined();
      expect(await getCheck(legacyKey)).toBeUndefined();
    });
  });

  describe("operator alerts reach every admin (issue #1019)", () => {
    let runtimePool: Pool;
    let adminZero: string;
    let tenantB: string;
    let adminB: string;

    beforeEach(async () => {
      await seedSystem(pool);
      await markAllProcessesFresh();
      adminZero = await createTestUser();
      tenantB = await createTestTenant(pool);
      adminB = await createTestUser(tenantB);
      const tenantC = await createTestTenant(pool);
      await createTestUser(tenantC, "member");
      runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    });

    afterEach(async () => {
      await runtimePool.end();
    });

    interface AlertRow {
      user_id: string;
      tenant_id: string;
      payload: Record<string, unknown>;
    }

    async function alertRows(kind: string): Promise<AlertRow[]> {
      const { rows } = await pool.query<AlertRow>(
        `SELECT user_id, tenant_id, payload FROM notifications WHERE kind = $1 ORDER BY user_id`,
        [kind],
      );
      return rows;
    }

    function sortedBy(rows: AlertRow[]): AlertRow[] {
      return [...rows].sort((a, b) => a.user_id.localeCompare(b.user_id));
    }

    /**
     * Makes every `notifications` insert for `userId` raise. The id reaches the trigger as a row of a
     * test table written with a bound parameter, never spliced into the function body; the
     * SECURITY DEFINER function reads that table as its owner, so the runtime role needs no grant.
     */
    async function failNotificationsFor(userId: string): Promise<void> {
      await pool.query("CREATE TABLE test_failing_notification_users (user_id uuid PRIMARY KEY)");
      await pool.query("INSERT INTO test_failing_notification_users VALUES ($1)", [userId]);
      await pool.query(`
        CREATE FUNCTION test_fail_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM test_failing_notification_users WHERE user_id = NEW.user_id) THEN
            RAISE EXCEPTION 'injected recipient failure';
          END IF;
          RETURN NEW;
        END $$`);
      await pool.query(
        `CREATE TRIGGER test_fail_notification BEFORE INSERT ON notifications
         FOR EACH ROW EXECUTE FUNCTION test_fail_notification()`,
      );
    }

    async function removeNotificationFailure(): Promise<void> {
      await pool.query("DROP TRIGGER IF EXISTS test_fail_notification ON notifications");
      await pool.query("DROP FUNCTION IF EXISTS test_fail_notification()");
      await pool.query("DROP TABLE IF EXISTS test_failing_notification_users");
    }

    async function makeAgentsStale(): Promise<void> {
      await pool.query(`UPDATE process_heartbeats SET beat_at = now() - interval '5 minutes' WHERE process = 'agents'`);
    }

    it("writes one content-free row per admin, none for a tenant with only a member, and deduplicates a retry", async () => {
      await makeAgentsStale();
      const jobId = randomUUID();

      await runCheck(jobId, runtimePool);
      const rows = await alertRows("process_stale");
      const expected = sortedBy([
        {
          user_id: adminZero,
          tenant_id: getTenantZeroId(),
          payload: { process: "agents", beatAt: expect.any(String) },
        },
        { user_id: adminB, tenant_id: tenantB, payload: { process: "agents", beatAt: expect.any(String) } },
      ]);
      expect(rows).toEqual(expected);

      await runCheck(jobId, runtimePool);
      expect(await alertRows("process_stale")).toEqual(expected);
    });

    it("rolls the transition back when one admin's write fails, skips no other admin and redelivers on retry", async () => {
      // A healthy tick first, so the check row (and its id, the notification's source) outlives the rolled-back transition.
      await runCheck(randomUUID(), runtimePool);
      await makeAgentsStale();
      const jobId = randomUUID();
      try {
        await failNotificationsFor(adminB);
        await expect(runCheck(jobId, runtimePool)).rejects.toBeInstanceOf(AggregateError);
        expect((await getCheck("process:agents"))?.status).not.toBe("alerting");
        expect((await alertRows("process_stale")).map((row) => row.user_id)).toEqual([adminZero]);
      } finally {
        await removeNotificationFailure();
      }

      await runCheck(jobId, runtimePool);
      expect((await getCheck("process:agents"))?.status).toBe("alerting");
      expect((await alertRows("process_stale")).map((row) => row.user_id).sort()).toEqual([adminZero, adminB].sort());
    });

    it("re-alerts the admins already written on each new job id while one admin's write keeps failing", async () => {
      // The documented at-least-once bound: the rolled-back transition is retried under a new
      // transitionInstance by the next tick, so dedupe holds only within one job's retries.
      await runCheck(randomUUID(), runtimePool);
      await makeAgentsStale();
      try {
        await failNotificationsFor(adminB);
        await expect(runCheck(randomUUID(), runtimePool)).rejects.toBeInstanceOf(AggregateError);
        await expect(runCheck(randomUUID(), runtimePool)).rejects.toBeInstanceOf(AggregateError);
        expect((await getCheck("process:agents"))?.status).not.toBe("alerting");
        expect((await alertRows("process_stale")).map((row) => row.user_id)).toEqual([adminZero, adminZero]);
      } finally {
        await removeNotificationFailure();
      }
    });

    it("skips an admin of a suspended tenant and still records the transition with no admin at all", async () => {
      await makeAgentsStale();
      await pool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantB]);

      await runCheck(randomUUID(), runtimePool);
      expect((await alertRows("process_stale")).map((row) => row.user_id)).toEqual([adminZero]);

      await pool.query("UPDATE users SET role = 'member'");
      await pool.query(`UPDATE process_heartbeats SET beat_at = now() - interval '5 minutes' WHERE process = 'api'`);
      await runCheck(randomUUID(), runtimePool);
      expect((await getCheck("process:api"))?.status).toBe("alerting");
      expect(await alertRows("process_stale")).toHaveLength(1);
    });

    it("sends the backlog and permanently-failed-jobs alerts to every admin with their own payloads", async () => {
      await enqueueJob(pool, "someUnregisteredTask", {}, { maxAttempts: 1 });
      await pool.query(`UPDATE graphile_worker._private_jobs SET attempts = 1`);
      for (let i = 0; i < 101; i += 1) {
        await enqueueJob(pool, "someUnregisteredTask", { i });
      }

      await runCheck(randomUUID(), runtimePool);

      const rows = await alertRows("queue_backlog");
      const recipients = sortedBy([
        { user_id: adminZero, tenant_id: getTenantZeroId(), payload: {} },
        { user_id: adminB, tenant_id: tenantB, payload: {} },
      ]);
      expect(rows.filter((row) => "pending" in row.payload)).toEqual(
        recipients.map((recipient) => ({ ...recipient, payload: { pending: 101, oldestAgeMs: expect.any(Number) } })),
      );
      expect(rows.filter((row) => "count" in row.payload)).toEqual(
        recipients.map((recipient) => ({ ...recipient, payload: { count: 1 } })),
      );
      expect(rows).toHaveLength(4);
    });

    it("notifies only the tenant's own user of a mailbox stall and keeps mailbox content out of operator rows", async () => {
      await makeAgentsStale();
      const mailboxId = randomUUID();
      await runInTenant(tenantB, () =>
        withTransaction(pool, async (client) => {
          await ensureMailAccountSyncState(client, { itemId: mailboxId, syncMode: "imap" });
          await recordSyncError(client, mailboxId, "boom");
        }),
      );

      await runCheck(randomUUID(), runtimePool);

      const stalls = await alertRows("mail_sync_stalled");
      expect(stalls).toEqual([
        { user_id: adminB, tenant_id: tenantB, payload: { mailboxItemId: mailboxId, lastError: "boom" } },
      ]);
      const operatorRows = await pool.query<{ payload: string }>(
        `SELECT payload::text AS payload FROM notifications WHERE kind IN ('process_stale', 'queue_backlog')`,
      );
      expect(operatorRows.rows).toHaveLength(2);
      for (const row of operatorRows.rows) {
        expect(row.payload).not.toContain("mailboxItemId");
        expect(row.payload).not.toContain("lastError");
        expect(row.payload).not.toContain("boom");
      }
    });

    it("lists only admins of active tenants, oldest account first", async () => {
      const suspended = await createTestTenant(pool, { status: "suspended" });
      await createTestUser(suspended);
      const lateAdmin = await createTestTenant(pool);
      const adminLate = await createTestUser(lateAdmin);

      expect(await listAdminRecipients(pool)).toEqual([
        { userId: adminZero, tenantId: getTenantZeroId() },
        { userId: adminB, tenantId: tenantB },
        { userId: adminLate, tenantId: lateAdmin },
      ]);
    });
  });
});
