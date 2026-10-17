import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { enqueueJob } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestModuleItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { mailSyncProcessName, upsertProcessHeartbeat } from "../health/processHeartbeats.js";
import { ensureMailAccountSyncState, recordSyncError } from "../mail/mailAccountSyncStateStore.js";
import { createAgentRun, finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { getSystemHealthReport } from "../observability/systemHealthReport.js";

let pool: Pool;
let runtimePool: Pool;

/**
 * Creates one tenant and a user in it through the admin pool. Each test then seeds that tenant's
 * own rows through the `semprec_data` runtime pool inside `runInTenant`, and writes the global
 * tables (`process_heartbeats`, `observability_checks`) and the queue through the admin pool;
 * `enqueueJob` stamps the job's tenant from the scope it runs in.
 */
async function seedTenant(): Promise<{ tenantId: string; userId: string }> {
  const tenantId = await createTestTenant(pool);
  const user = await createUser(pool, { email: `${randomUUID()}@example.com`, passwordHash: "unused", tenantId });
  return { tenantId, userId: user.id };
}

/** One errored `item_automation` row on a fresh Tasks item in `tenantId`; returns the item's database id. */
async function seedAutomationError(tenantId: string): Promise<string | undefined> {
  return runInTenant(tenantId, async () => {
    const itemId = await createTestModuleItem(runtimePool, TASKS_MODULE_ID);
    // Raw insert: no production writer sets an `item_automation` error on a fixture item.
    await runtimePool.query(`INSERT INTO item_automation (item_id, status, error) VALUES ($1, 'error', 'boom')`, [
      itemId,
    ]);
    const { rows } = await pool.query<{ database_id: string }>(`SELECT database_id FROM items WHERE id = $1`, [itemId]);
    return rows[0]?.database_id;
  });
}

async function createMailbox(tenantId: string): Promise<string> {
  return runInTenant(tenantId, () => createTestModuleItem(runtimePool, "mailboxes"));
}

describe("getSystemHealthReport (issue #170, per-tenant since #1052)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
  });

  it("reports the caller's mailbox processes only, never the fixed processes or another tenant's mailbox", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const mailboxA = await createMailbox(a.tenantId);
    const mailboxB = await createMailbox(b.tenantId);
    await runInTenant(a.tenantId, () =>
      ensureMailAccountSyncState(runtimePool, { itemId: mailboxA, syncMode: "imap" }),
    );
    await runInTenant(b.tenantId, () =>
      ensureMailAccountSyncState(runtimePool, { itemId: mailboxB, syncMode: "imap" }),
    );
    for (const itemId of [mailboxA, mailboxB]) {
      await upsertProcessHeartbeat(
        pool,
        { process: mailSyncProcessName(itemId), pid: 2, version: "1.2.3" },
        new Date(),
      );
    }
    for (const process of ["api", "agents", "transcribe", "ai-gateway"]) {
      await upsertProcessHeartbeat(pool, { process, pid: 1, version: "1.2.3" }, new Date());
    }

    const reportB = await runInTenant(b.tenantId, () => getSystemHealthReport(runtimePool));

    expect(reportB.processes.map((p) => p.process)).toEqual([mailSyncProcessName(mailboxB)]);
    expect(reportB.processes[0]).toMatchObject({ present: true, stale: false, pid: 2, version: "1.2.3" });
  });

  it("reports a caller's mailbox process with no heartbeat as absent and stale", async () => {
    const a = await seedTenant();
    const mailboxA = await createMailbox(a.tenantId);
    await runInTenant(a.tenantId, () =>
      ensureMailAccountSyncState(runtimePool, { itemId: mailboxA, syncMode: "imap" }),
    );

    const reportA = await runInTenant(a.tenantId, () => getSystemHealthReport(runtimePool));

    expect(reportA.processes).toMatchObject([
      { process: mailSyncProcessName(mailboxA), present: false, stale: true, pid: null, uptimeMs: null },
    ]);
  });

  it("lists the caller's alerting tenant checks and never the global observability checks", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    // Raw insert: alerting rows are written by the observability system task, not a choke-point API.
    await pool.query(
      `INSERT INTO tenant_observability_checks (tenant_id, check_key, status, detail)
       VALUES ($1, 'mailbox:stalled', 'alerting', '{}'::jsonb)`,
      [a.tenantId],
    );
    await pool.query(
      `INSERT INTO observability_checks (check_key, status, detail) VALUES ('queue:backlog', 'alerting', '{}'::jsonb)`,
    );

    const reportA = await runInTenant(a.tenantId, () => getSystemHealthReport(runtimePool));
    const reportB = await runInTenant(b.tenantId, () => getSystemHealthReport(runtimePool));

    expect(reportA.alertingChecks).toMatchObject([{ checkKey: "mailbox:stalled" }]);
    expect(reportB.alertingChecks).toEqual([]);
  });

  it("counts only the caller's queue jobs, and a system-scope job for neither tenant", async () => {
    const a = await seedTenant();
    const b = await seedTenant();

    await runInTenant(a.tenantId, async () => {
      await enqueueJob(pool, "someUnregisteredTask", {}, { jobKey: "a-pending" });
      await enqueueJob(pool, "someUnregisteredTask", {}, { jobKey: "a-overdue" });
      await pool.query(`UPDATE graphile_worker._private_jobs SET run_at = now() - interval '1 hour' WHERE key = $1`, [
        "a-overdue",
      ]);
      await enqueueJob(pool, "someUnregisteredTask", {}, { jobKey: "a-permanent", maxAttempts: 1 });
      await pool.query(`UPDATE graphile_worker._private_jobs SET attempts = 1 WHERE key = $1`, ["a-permanent"]);
    });
    await runInTenant(b.tenantId, () => enqueueJob(pool, "someUnregisteredTask", {}, { jobKey: "b-pending" }));
    await runAsSystem("test: a job enqueued by system work belongs to neither tenant", () =>
      enqueueJob(pool, "someUnregisteredTask", {}, { jobKey: "system-pending" }),
    );

    const reportA = await runInTenant(a.tenantId, () => getSystemHealthReport(runtimePool));
    const reportB = await runInTenant(b.tenantId, () => getSystemHealthReport(runtimePool));

    expect(reportA.queue).toEqual({ pending: 2, overdue: 1, permanent: 1 });
    expect(reportB.queue).toEqual({ pending: 1, overdue: 0, permanent: 0 });
  });

  it("does not count the caller's in-flight final-attempt job as permanently failed", async () => {
    const a = await seedTenant();
    await runInTenant(a.tenantId, async () => {
      await enqueueJob(pool, "someUnregisteredTask", {}, { jobKey: "a-locked-final", maxAttempts: 1 });
      await pool.query(`UPDATE graphile_worker._private_jobs SET attempts = 1, locked_at = now() WHERE key = $1`, [
        "a-locked-final",
      ]);
      await enqueueJob(pool, "someUnregisteredTask", {}, { jobKey: "a-failed-final", maxAttempts: 1 });
      await pool.query(`UPDATE graphile_worker._private_jobs SET attempts = 1 WHERE key = $1`, ["a-failed-final"]);
    });

    const reportA = await runInTenant(a.tenantId, () => getSystemHealthReport(runtimePool));

    expect(reportA.queue).toEqual({ pending: 0, overdue: 0, permanent: 1 });
  });

  it("groups the caller's item_automation errors by database and keeps them out of another tenant's report", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const databaseIdA = await seedAutomationError(a.tenantId);
    await seedAutomationError(a.tenantId);
    const databaseIdB = await seedAutomationError(b.tenantId);
    if (!databaseIdA || !databaseIdB) throw new Error("fixture item has no database");

    const reportA = await runInTenant(a.tenantId, () => getSystemHealthReport(runtimePool));
    const reportB = await runInTenant(b.tenantId, () => getSystemHealthReport(runtimePool));

    expect(reportA.itemAutomationErrorsByDatabase).toEqual([{ databaseId: databaseIdA, errorCount: 2 }]);
    expect(reportB.itemAutomationErrorsByDatabase).toEqual([{ databaseId: databaseIdB, errorCount: 1 }]);
    expect(JSON.stringify(reportB)).not.toContain(databaseIdA);
  });

  it("narrows the explicitly guarded sections by tenant even on a pool that bypasses row-level security", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const databaseIdA = await seedAutomationError(a.tenantId);
    if (!databaseIdA) throw new Error("fixture item has no database");
    await runInTenant(a.tenantId, async () => {
      const run = await createAgentRun(runtimePool, { triggeredBy: "user", task: "a-run", unit: "invocation" });
      await finishAgentRun(runtimePool, run.id, "error", "boom");
    });
    // Raw insert: alerting rows are written by the observability system task, not a choke-point API.
    await pool.query(
      `INSERT INTO tenant_observability_checks (tenant_id, check_key, status, detail)
       VALUES ($1, 'mailbox:stalled', 'alerting', '{}'::jsonb)`,
      [a.tenantId],
    );

    // The admin pool is a superuser, so RLS filters nothing here: only the queries' own
    // `tenant_id = app_current_tenant()` predicates keep A's rows out of B's report. Processes and
    // mailboxes rely on RLS alone and are not asserted.
    const reportB = await withTenantTransaction(pool, b.tenantId, (client) => getSystemHealthReport(client));

    expect(reportB.itemAutomationErrorsByDatabase).toEqual([]);
    expect(reportB.agentRunErrors7d).toBe(0);
    expect(reportB.alertingChecks).toEqual([]);
  });

  it("keeps the caller's agent-run and mailbox errors out of another tenant's report", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const mailboxA = await createMailbox(a.tenantId);
    await runInTenant(a.tenantId, async () => {
      await ensureMailAccountSyncState(runtimePool, { itemId: mailboxA, syncMode: "imap" });
      await recordSyncError(runtimePool, mailboxA, "connection refused");
      const run = await createAgentRun(runtimePool, { triggeredBy: "user", task: "a-run", unit: "invocation" });
      await finishAgentRun(runtimePool, run.id, "error", "boom");
    });

    const reportA = await runInTenant(a.tenantId, () => getSystemHealthReport(runtimePool));
    const reportB = await runInTenant(b.tenantId, () => getSystemHealthReport(runtimePool));

    expect(reportA.agentRunErrors7d).toBe(1);
    expect(reportA.mailboxes).toMatchObject([{ mailboxItemId: mailboxA, lastError: "connection refused" }]);
    expect(reportB.agentRunErrors7d).toBe(0);
    expect(reportB.mailboxes).toEqual([]);
    expect(JSON.stringify(reportB)).not.toContain(mailboxA);
    expect(JSON.stringify(reportB)).not.toContain("connection refused");
  });

  it("counts agent-run errors from the last seven days only", async () => {
    const a = await seedTenant();
    await runInTenant(a.tenantId, async () => {
      const recentErrorRun = await createAgentRun(runtimePool, {
        triggeredBy: "user",
        task: "recent",
        unit: "invocation",
      });
      await finishAgentRun(runtimePool, recentErrorRun.id, "error", "boom");

      const oldErrorRun = await createAgentRun(runtimePool, { triggeredBy: "user", task: "old", unit: "invocation" });
      await finishAgentRun(runtimePool, oldErrorRun.id, "error", "boom");
      await pool.query(`UPDATE agent_runs SET started_at = now() - interval '8 days' WHERE id = $1`, [oldErrorRun.id]);

      const doneRun = await createAgentRun(runtimePool, { triggeredBy: "user", task: "fine", unit: "invocation" });
      await finishAgentRun(runtimePool, doneRun.id, "done", "ok");
    });

    const reportA = await runInTenant(a.tenantId, () => getSystemHealthReport(runtimePool));

    expect(reportA.agentRunErrors7d).toBe(1);
  });

  it("throws, and returns no report, when no tenant scope is active", async () => {
    await expect(getSystemHealthReport(runtimePool)).rejects.toThrow("requires an active tenant scope");
  });

  it("persists no rows of its own — a plain live snapshot", async () => {
    const a = await seedTenant();
    const before = await pool.query("SELECT count(*) FROM tenant_observability_checks");
    await runInTenant(a.tenantId, () => getSystemHealthReport(runtimePool));
    const after = await pool.query("SELECT count(*) FROM tenant_observability_checks");
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
