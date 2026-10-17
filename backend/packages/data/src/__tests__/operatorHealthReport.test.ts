import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createRuntimeRolePool, createTestTenant, withTenantTransaction } from "../testSupport/tenantFixtures.js";
import { upsertProcessHeartbeat } from "../health/processHeartbeats.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { createAgentRun, finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { getOperatorHealthReport } from "../observability/systemHealthReport.js";

let pool: Pool;

/** Errored agent run inside one tenant; `ageDays` moves its start time into the past. */
async function seedErroredAgentRun(tenantId: string, ageDays = 0): Promise<void> {
  await withTenantTransaction(pool, tenantId, async (client) => {
    const run = await createAgentRun(client, { triggeredBy: "user", task: "fixture", unit: "invocation" });
    await finishAgentRun(client, run.id, "error", "boom");
    if (ageDays > 0) {
      await client.query(`UPDATE agent_runs SET started_at = now() - make_interval(days => $2) WHERE id = $1`, [
        run.id,
        ageDays,
      ]);
    }
  });
}

/**
 * Raw SQL: no production writer sets an `item_automation` error from a fixture item, and the
 * operator counts only read `status`, so a random item id is enough.
 */
async function seedAutomationError(tenantId: string): Promise<void> {
  await withTenantTransaction(pool, tenantId, (client) =>
    client.query(`INSERT INTO item_automation (item_id, status, error) VALUES ($1, 'error', 'boom')`, [randomUUID()]),
  );
}

/** Raw SQL: `tenant_observability_checks` has no production writer for an arbitrary check key here. */
async function seedAlertingTenantCheck(tenantId: string): Promise<void> {
  await withTenantTransaction(pool, tenantId, (client) =>
    client.query(
      `INSERT INTO tenant_observability_checks (check_key, status, detail) VALUES ('mailbox:stall', 'alerting', '{}'::jsonb)`,
    ),
  );
}

describe("getOperatorHealthReport (issue #1038)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("sums errors across tenants, excludes agent-run errors older than seven days", async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);
    for (const tenantId of [tenantA, tenantB]) {
      await seedErroredAgentRun(tenantId);
      await seedAutomationError(tenantId);
      await seedAlertingTenantCheck(tenantId);
    }
    await seedErroredAgentRun(tenantA, 8);

    const report = await getOperatorHealthReport(pool);

    expect(report.tenantAggregates).toEqual({ agentRunErrors7d: 2, itemAutomationErrors: 2, alertingTenantChecks: 2 });
  });

  it("lists exactly the four fixed processes, never a mailbox row", async () => {
    for (const process of ["api", "agents", "transcribe", "ai-gateway"]) {
      await upsertProcessHeartbeat(pool, { process, pid: 1, version: "1.2.3" }, new Date());
    }
    const mailboxItemId = randomUUID();
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "imap" });
    await upsertProcessHeartbeat(pool, { process: `mailsync:${mailboxItemId}`, pid: 2, version: "1.2.3" }, new Date());

    const report = await getOperatorHealthReport(pool);

    expect(report.processes.map((process) => process.process)).toEqual(["api", "agents", "transcribe", "ai-gateway"]);
  });

  it("reports each tenant status count and zero for a status with no tenant", async () => {
    await createTestTenant(pool, { status: "suspended" });
    await createTestTenant(pool, { status: "deleting" });

    const report = await getOperatorHealthReport(pool);

    expect(report.tenants).toMatchObject({ suspended: 1, deleting: 1, provisioning: 0 });
  });

  it("reports only global observability checks, never a tenant's alerting check", async () => {
    const tenantId = await createTestTenant(pool);
    await seedAlertingTenantCheck(tenantId);
    await pool.query(`INSERT INTO observability_checks (check_key, status, detail) VALUES ('queue:backlog', 'alerting', '{}'::jsonb)`);

    const report = await getOperatorHealthReport(pool);

    expect(report.alertingChecks.map((check) => check.checkKey)).toEqual(["queue:backlog"]);
  });

  it("lets semprec_data run ops_health_counts() and refuses semprec_side", async () => {
    const dataPool = await createRuntimeRolePool(pool, "semprec_data");
    const sidePool = await createRuntimeRolePool(pool, "semprec_side");
    try {
      await expect(dataPool.query("SELECT * FROM ops_health_counts()")).resolves.toMatchObject({ rowCount: 1 });
      await expect(sidePool.query("SELECT * FROM ops_health_counts()")).rejects.toThrow(/permission denied/);
    } finally {
      await dataPool.end();
      await sidePool.end();
    }
  });

  it("owns ops_health_counts() as semprec_router, SECURITY DEFINER with a pinned search_path", async () => {
    const { rows } = await pool.query<{ owner: string; secdef: boolean; config: string[] | null }>(
      `SELECT p.proowner::regrole::text AS owner, p.prosecdef AS secdef, p.proconfig AS config
         FROM pg_proc p WHERE p.proname = 'ops_health_counts'`,
    );
    expect(rows).toEqual([
      { owner: "semprec_router", secdef: true, config: ["search_path=pg_catalog, public"] },
    ]);
  });
});
