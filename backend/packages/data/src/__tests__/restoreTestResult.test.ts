import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import {
  RESTORE_TEST_CHECK_KEY,
  readRestoreTestOutcome,
  recordRestoreTestResult,
} from "../observability/restoreTestResult.js";

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

function record(result: Parameters<typeof recordRestoreTestResult>[1], taskPool: Pool = pool) {
  return runAsSystem("test", () => recordRestoreTestResult(taskPool, result));
}

const checkRowSchema = z.object({
  id: z.string(),
  status: z.enum(["ok", "alerting"]),
  detail: z.record(z.string(), z.unknown()),
});
type CheckRow = z.infer<typeof checkRowSchema>;

async function getRestoreCheck(): Promise<CheckRow | undefined> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT id, status, detail FROM observability_checks WHERE check_key = $1`,
    [RESTORE_TEST_CHECK_KEY],
  );
  return rows[0] === undefined ? undefined : checkRowSchema.parse(rows[0]);
}

const notificationRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  kind: z.string(),
  title: z.string(),
  source_table: z.string(),
  source_id: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
type NotificationRow = z.infer<typeof notificationRowSchema>;

/**
 * The `backup_restore_failed` notifications only. A failure also raises its Semp problem, which writes
 * a `semp_problem` notification per admin (issue #1466); that one is not what these tests assert.
 */
async function listNotifications(): Promise<NotificationRow[]> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT id, user_id, kind, title, source_table, source_id, payload FROM notifications
      WHERE kind = 'backup_restore_failed' ORDER BY created_at`,
  );
  return z.array(notificationRowSchema).parse(rows);
}

describe("recordRestoreTestResult (issue #178)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("marks the check alerting and writes one backup_restore_failed notification on failure", async () => {
    const userId = await createTestUser();

    const outcome = await record({
      status: "failed",
      runId: "run-1",
      failedCheck: "itemsFreshness",
    });

    const check = await getRestoreCheck();
    expect(check?.status).toBe("alerting");
    expect(check?.detail).toMatchObject({ runId: "run-1", failedCheck: "itemsFreshness" });
    const notifications = await listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: outcome.notificationIds[0],
      user_id: userId,
      kind: "backup_restore_failed",
      title: "Backup restore test failed",
      source_table: "observability_checks",
      source_id: check?.id,
      payload: { runId: "run-1", failedCheck: "itemsFreshness" },
    });
  });

  it("does not duplicate the notification when the same run is recorded again", async () => {
    await createTestUser();
    const input = { status: "failed", runId: "run-1", failedCheck: "pgRestore" } as const;

    const first = await record(input);
    const second = await record(input);

    expect(first.notificationIds).toHaveLength(1);
    expect(second.notificationIds).toEqual(first.notificationIds);
    expect(await listNotifications()).toHaveLength(1);
  });

  it("notifies again for a later failed run while the check is still alerting", async () => {
    await createTestUser();

    await record({ status: "failed", runId: "run-1", failedCheck: "pgRestore" });
    await record({ status: "failed", runId: "run-2", failedCheck: "blobObjects" });

    const notifications = await listNotifications();
    expect(notifications.map((notification) => notification.payload)).toEqual([
      { runId: "run-1", failedCheck: "pgRestore" },
      { runId: "run-2", failedCheck: "blobObjects" },
    ]);
  });

  it("returns the check to ok on a passed run without notifying", async () => {
    await createTestUser();
    await record({ status: "failed", runId: "run-1", failedCheck: "cleanup" });

    const outcome = await record({ status: "passed", runId: "run-2" });

    expect(outcome.notificationIds).toEqual([]);
    const check = await getRestoreCheck();
    expect(check?.status).toBe("ok");
    expect(check?.detail).toMatchObject({ runId: "run-2" });
    expect(await listNotifications()).toHaveLength(1);
  });

  it("records the failure without a notification when no admin exists", async () => {
    const outcome = await record({
      status: "failed",
      runId: "run-1",
      failedCheck: "snapshotRestore",
    });

    expect(outcome.notificationIds).toEqual([]);
    expect((await getRestoreCheck())?.status).toBe("alerting");
    expect(await listNotifications()).toHaveLength(0);
  });

  it("writes one notification per admin of an active tenant and none for members or suspended tenants", async () => {
    const adminZero = await createTestUser();
    const tenantB = await createTestTenant(pool);
    const adminB = await createTestUser(tenantB);
    const tenantC = await createTestTenant(pool);
    await createTestUser(tenantC, "member");
    const suspended = await createTestTenant(pool, { status: "suspended" });
    await createTestUser(suspended);
    const input = { status: "failed", runId: "run-1", failedCheck: "pgRestore" } as const;
    // With a second tenant present the record runs as the runtime role, so RLS governs each admin's write.
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");

    let first: Awaited<ReturnType<typeof record>>;
    let second: Awaited<ReturnType<typeof record>>;
    try {
      first = await record(input, runtimePool);
      second = await record(input, runtimePool);
    } finally {
      await runtimePool.end();
    }

    const notifications = await listNotifications();
    expect(notifications.map((notification) => notification.user_id).sort()).toEqual([adminZero, adminB].sort());
    expect(notifications.map((notification) => notification.id).sort()).toEqual([...first.notificationIds].sort());
    expect(first.notificationIds).toHaveLength(2);
    expect([...second.notificationIds].sort()).toEqual([...first.notificationIds].sort());
    for (const notification of notifications) {
      expect(notification.payload).toEqual({ runId: "run-1", failedCheck: "pgRestore" });
    }
  });

  describe("ranAt", () => {
    async function getChangedAt(): Promise<Date> {
      const { rows } = await pool.query<{ changed_at: Date }>(
        `SELECT changed_at FROM observability_checks WHERE check_key = $1`,
        [RESTORE_TEST_CHECK_KEY],
      );
      return rows[0]!.changed_at;
    }

    it("stores the run id's time and moves it on a second passed run while changed_at stays", async () => {
      await record({ status: "passed", runId: "20260901T031500Z-111" });
      const check = await getRestoreCheck();
      expect(check?.detail).toEqual({ runId: "20260901T031500Z-111", ranAt: "2026-09-01T03:15:00.000Z" });
      const changedAt = await getChangedAt();

      await record({ status: "passed", runId: "20261001T031500Z-222" });

      expect((await getRestoreCheck())?.detail).toEqual({
        runId: "20261001T031500Z-222",
        ranAt: "2026-10-01T03:15:00.000Z",
      });
      expect(await getChangedAt()).toEqual(changedAt);
    });

    it("stores ranAt for a failed run and the reader returns ok false without failedCheck", async () => {
      await record({ status: "failed", runId: "20261001T031500Z-333", failedCheck: "pgRestore" });

      const check = await getRestoreCheck();
      expect(check?.detail).toMatchObject({ ranAt: "2026-10-01T03:15:00.000Z", failedCheck: "pgRestore" });
      const outcome = readRestoreTestOutcome(check!.detail, check!.status);
      expect(outcome).toEqual({ lastTestAt: "2026-10-01T03:15:00.000Z", ok: false });
      expect(outcome).not.toHaveProperty("failedCheck");
    });

    it("falls back to the recording time for an unparsable run id", async () => {
      const before = Date.now();
      await record({ status: "passed", runId: "run-1" });
      const after = Date.now();

      const ranAt = new Date(z.string().parse((await getRestoreCheck())?.detail.ranAt)).getTime();
      expect(ranAt).toBeGreaterThanOrEqual(before);
      expect(ranAt).toBeLessThanOrEqual(after);
    });

    it("falls back to the recording time for an impossible calendar time in a run id", async () => {
      const before = Date.now();
      await record({ status: "passed", runId: "20261301T031500Z-1" });

      const ranAt = new Date(z.string().parse((await getRestoreCheck())?.detail.ranAt)).getTime();
      expect(ranAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe("readRestoreTestOutcome", () => {
    it("reads the time from runId for a row written before ranAt existed", () => {
      expect(readRestoreTestOutcome({ runId: "20260901T031500Z-111" }, "ok")).toEqual({
        lastTestAt: "2026-09-01T03:15:00.000Z",
        ok: true,
      });
    });

    it("returns a null time when neither ranAt nor a parsable runId exists", () => {
      expect(readRestoreTestOutcome({ runId: "run-1" }, "ok")).toEqual({ lastTestAt: null, ok: true });
      expect(readRestoreTestOutcome({}, "alerting")).toEqual({ lastTestAt: null, ok: false });
    });
  });
});
