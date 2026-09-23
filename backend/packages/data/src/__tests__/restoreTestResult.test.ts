import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { RESTORE_TEST_CHECK_KEY, recordRestoreTestResult } from "../observability/restoreTestResult.js";

let pool: Pool;

async function createTestUser(): Promise<string> {
  const passwordHash = await hashPassword("s3cret-password");
  const user = await createUser(pool, { email: `${randomUUID()}@example.test`, passwordHash, locale: "en" });
  return user.id;
}

interface CheckRow {
  id: string;
  status: "ok" | "alerting";
  detail: Record<string, unknown>;
}

async function getRestoreCheck(): Promise<CheckRow | undefined> {
  const { rows } = await pool.query<CheckRow>(`SELECT id, status, detail FROM observability_checks WHERE check_key = $1`, [
    RESTORE_TEST_CHECK_KEY,
  ]);
  return rows[0];
}

interface NotificationRow {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  source_table: string;
  source_id: string;
  payload: Record<string, unknown>;
}

async function listNotifications(): Promise<NotificationRow[]> {
  const { rows } = await pool.query<NotificationRow>(
    `SELECT id, user_id, kind, title, source_table, source_id, payload FROM notifications ORDER BY created_at`,
  );
  return rows;
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

    const outcome = await recordRestoreTestResult(pool, {
      status: "failed",
      runId: "run-1",
      failedCheck: "itemsFreshness",
    });

    const check = await getRestoreCheck();
    expect(check?.status).toBe("alerting");
    expect(check?.detail).toEqual({ runId: "run-1", failedCheck: "itemsFreshness" });
    const notifications = await listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: outcome.notificationId,
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

    const first = await recordRestoreTestResult(pool, input);
    const second = await recordRestoreTestResult(pool, input);

    expect(second.notificationId).toBe(first.notificationId);
    expect(await listNotifications()).toHaveLength(1);
  });

  it("notifies again for a later failed run while the check is still alerting", async () => {
    await createTestUser();

    await recordRestoreTestResult(pool, { status: "failed", runId: "run-1", failedCheck: "pgRestore" });
    await recordRestoreTestResult(pool, { status: "failed", runId: "run-2", failedCheck: "blobObjects" });

    const notifications = await listNotifications();
    expect(notifications.map((notification) => notification.payload)).toEqual([
      { runId: "run-1", failedCheck: "pgRestore" },
      { runId: "run-2", failedCheck: "blobObjects" },
    ]);
  });

  it("returns the check to ok on a passed run without notifying", async () => {
    await createTestUser();
    await recordRestoreTestResult(pool, { status: "failed", runId: "run-1", failedCheck: "cleanup" });

    const outcome = await recordRestoreTestResult(pool, { status: "passed", runId: "run-2" });

    expect(outcome.notificationId).toBeNull();
    const check = await getRestoreCheck();
    expect(check?.status).toBe("ok");
    expect(check?.detail).toEqual({ runId: "run-2" });
    expect(await listNotifications()).toHaveLength(1);
  });

  it("records the failure without a notification when no user exists yet", async () => {
    const outcome = await recordRestoreTestResult(pool, {
      status: "failed",
      runId: "run-1",
      failedCheck: "snapshotRestore",
    });

    expect(outcome.notificationId).toBeNull();
    expect((await getRestoreCheck())?.status).toBe("alerting");
    expect(await listNotifications()).toHaveLength(0);
  });
});
