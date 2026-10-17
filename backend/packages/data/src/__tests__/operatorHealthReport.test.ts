import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  withTenantTransaction,
} from "../testSupport/tenantFixtures.js";
import { createTestModuleItem } from "../testSupport/projectFixtures.js";
import { withTransaction } from "../db/pool.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { getExpectedProcessNames, mailSyncProcessName, upsertProcessHeartbeat } from "../health/processHeartbeats.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { createAgentRun, finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { getOperatorHealthReport } from "../observability/systemHealthReport.js";
import { createUser } from "../auth/usersStore.js";

let pool: Pool;

/** Errored agent run inside one tenant, actor `userId`; `ageDays` moves its start time into the past. */
async function seedErroredAgentRun(tenantId: string, userId: string, ageDays = 0): Promise<void> {
  await withTenantTransaction(pool, tenantId, async (client) => {
    const run = await createAgentRun(client, { triggeredBy: "user", task: "fixture", unit: "invocation", userId });
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
    client.query(`INSERT INTO item_automation (tenant_id, item_id, status, error) VALUES ($1, $2, 'error', 'boom')`, [
      tenantId,
      randomUUID(),
    ]),
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

/**
 * Two tenants, each with one errored agent run in the last seven days, one `item_automation` error
 * and one alerting tenant check, plus one agent-run error older than seven days in the first.
 */
async function seedTwoTenantErrors(): Promise<void> {
  const tenantA = await createTestTenant(pool);
  const tenantB = await createTestTenant(pool);
  const userA = await createUser(pool, {
    email: `a-${randomUUID()}@example.test`,
    passwordHash: "unused",
    tenantId: tenantA,
  });
  const userB = await createUser(pool, {
    email: `b-${randomUUID()}@example.test`,
    passwordHash: "unused",
    tenantId: tenantB,
  });
  await seedErroredAgentRun(tenantA, userA.id);
  await seedErroredAgentRun(tenantB, userB.id);
  for (const tenantId of [tenantA, tenantB]) {
    await seedAutomationError(tenantId);
    await seedAlertingTenantCheck(tenantId);
  }
  await seedErroredAgentRun(tenantA, userA.id, 8);
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
    await seedTwoTenantErrors();

    const report = await getOperatorHealthReport(pool);

    expect(report.tenantAggregates).toEqual({ agentRunErrors7d: 2, itemAutomationErrors: 2, alertingTenantChecks: 2 });
  });

  it("lists exactly the four fixed processes, never a mailbox row", async () => {
    for (const process of ["api", "agents", "transcribe", "ai-gateway"]) {
      await upsertProcessHeartbeat(pool, { process, pid: 1, version: "1.2.3" }, new Date());
    }
    const dataPool = await createRuntimeRolePool(pool, "semprec_data");
    let mailboxItemId: string;
    try {
      // A live (non-deleted) Mailbox item with a sync-state row, so the tenant-visible process list
      // would include its `mailsync:<id>` process.
      mailboxItemId = await runInTenant(getTenantZeroId(), async () => {
        const itemId = await createTestModuleItem(dataPool, MAILBOXES_MODULE_ID);
        await withTransaction(dataPool, (client) => ensureMailAccountSyncState(client, { itemId, syncMode: "imap" }));
        return itemId;
      });
    } finally {
      await dataPool.end();
    }
    await upsertProcessHeartbeat(
      pool,
      { process: mailSyncProcessName(mailboxItemId), pid: 2, version: "1.2.3" },
      new Date(),
    );
    expect(await getExpectedProcessNames(pool)).toContain(mailSyncProcessName(mailboxItemId));

    const report = await getOperatorHealthReport(pool);

    expect(report.processes.map((process) => process.process)).toEqual(["api", "agents", "transcribe", "ai-gateway"]);
  });

  it("reports each tenant status count and zero for a status with no tenant", async () => {
    await createTestTenant(pool, { status: "suspended" });
    await createTestTenant(pool, { status: "deleting" });

    const report = await getOperatorHealthReport(pool);

    // Tenant zero, re-created `active` by `resetDatabase`, is the one active tenant.
    expect(report.tenants).toEqual({ provisioning: 0, active: 1, suspended: 1, deleting: 1 });
  });

  it("reports only global observability checks, never a tenant's alerting check", async () => {
    const tenantId = await createTestTenant(pool);
    await seedAlertingTenantCheck(tenantId);
    await pool.query(
      `INSERT INTO observability_checks (check_key, status, detail) VALUES ('queue:backlog', 'alerting', '{}'::jsonb)`,
    );

    const report = await getOperatorHealthReport(pool);

    expect(report.alertingChecks.map((check) => check.checkKey)).toEqual(["queue:backlog"]);
  });

  it("omits legacy per-mailbox global checks that carry a mailbox id and its lastError", async () => {
    const mailboxItemId = randomUUID();
    // Raw SQL: no current writer produces these legacy global rows; they survive only until the
    // check-system tick purges them, which is the window this test covers.
    for (const checkKey of [`mail:${mailboxItemId}`, `process:mailsync:${mailboxItemId}`, "queue:backlog"]) {
      await pool.query(`INSERT INTO observability_checks (check_key, status, detail) VALUES ($1, 'alerting', $2)`, [
        checkKey,
        JSON.stringify({ mailboxItemId, lastError: "SECRET-MAILBOX-ERROR" }),
      ]);
    }

    const report = await getOperatorHealthReport(pool);

    expect(report.alertingChecks.map((check) => check.checkKey)).toEqual(["queue:backlog"]);
    expect(JSON.stringify(report.alertingChecks.map((check) => check.checkKey))).not.toContain(mailboxItemId);
  });

  it("throws instead of reporting zero errors when ops_health_counts() returns no row", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Replaced inside a rolled-back transaction: a broken function is the only way to get no row.
      await client.query(
        `CREATE OR REPLACE FUNCTION ops_health_counts()
         RETURNS TABLE (agent_run_errors_7d bigint, item_automation_errors bigint, alerting_tenant_checks bigint)
         LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
         AS $$ SELECT 0::bigint, 0::bigint, 0::bigint WHERE false $$`,
      );
      await expect(getOperatorHealthReport(client)).rejects.toThrow("ops_health_counts() returned no row");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("lets semprec_data count every tenant through ops_health_counts() while it sees no tenant row directly", async () => {
    await seedTwoTenantErrors();
    const dataPool = await createRuntimeRolePool(pool, "semprec_data");
    try {
      await runAsSystem("test", async () => {
        const counts = await dataPool.query<{
          agent_run_errors_7d: string;
          item_automation_errors: string;
          alerting_tenant_checks: string;
        }>("SELECT agent_run_errors_7d, item_automation_errors, alerting_tenant_checks FROM ops_health_counts()");
        expect(counts.rows).toEqual([
          { agent_run_errors_7d: "2", item_automation_errors: "2", alerting_tenant_checks: "2" },
        ]);

        for (const table of ["agent_runs", "item_automation", "tenant_observability_checks"] as const) {
          const direct = await dataPool.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
          expect(direct.rows, table).toEqual([{ count: "0" }]);
        }

        // The whole report, as the admin route builds it: the semprec_data pool in system scope.
        const report = await getOperatorHealthReport(dataPool);
        expect(report.tenantAggregates).toEqual({
          agentRunErrors7d: 2,
          itemAutomationErrors: 2,
          alertingTenantChecks: 2,
        });
        expect(report.tenants).toEqual({ provisioning: 0, active: 3, suspended: 0, deleting: 0 });
      });
    } finally {
      await dataPool.end();
    }
  });

  it("refuses ops_health_counts() to semprec_side", async () => {
    const sidePool = await createRuntimeRolePool(pool, "semprec_side");
    try {
      await expect(runAsSystem("test", () => sidePool.query("SELECT * FROM ops_health_counts()"))).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await sidePool.end();
    }
  });

  it("owns ops_health_counts() as semprec_router, SECURITY DEFINER with a pinned search_path", async () => {
    const { rows } = await pool.query<{ owner: string; secdef: boolean; config: string[] | null }>(
      `SELECT p.proowner::regrole::text AS owner, p.prosecdef AS secdef, p.proconfig AS config
         FROM pg_proc p WHERE p.proname = 'ops_health_counts'`,
    );
    expect(rows).toEqual([{ owner: "semprec_router", secdef: true, config: ["search_path=pg_catalog, public"] }]);
  });

  it("grants semprec_router only the listed SELECT columns on the three counted tables", async () => {
    const tables = ["agent_runs", "item_automation", "tenant_observability_checks"];
    const tablePrivileges = await pool.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.table_privileges
        WHERE grantee = 'semprec_router' AND table_schema = 'public' AND table_name = ANY($1)`,
      [tables],
    );
    expect(tablePrivileges.rows).toEqual([]);

    const columnPrivileges = await pool.query<{ table_name: string; column_name: string; privilege_type: string }>(
      `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
        WHERE grantee = 'semprec_router' AND table_schema = 'public' AND table_name = ANY($1)
        ORDER BY table_name, column_name, privilege_type`,
      [tables],
    );
    expect(columnPrivileges.rows).toEqual([
      { table_name: "agent_runs", column_name: "started_at", privilege_type: "SELECT" },
      { table_name: "agent_runs", column_name: "status", privilege_type: "SELECT" },
      { table_name: "item_automation", column_name: "status", privilege_type: "SELECT" },
      { table_name: "tenant_observability_checks", column_name: "status", privilege_type: "SELECT" },
    ]);
  });
});
