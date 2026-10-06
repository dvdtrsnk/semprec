import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  withTenantTransaction,
  resetDatabase,
} from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { upsertProcessHeartbeat } from "../health/processHeartbeats.js";
import { ensureMailAccountSyncState, recordSyncError } from "../mail/mailAccountSyncStateStore.js";
import { handleObservabilityCheckSystemTask } from "../observability/observabilityCheckSystem.js";
import { getSystemHealthReport } from "../observability/systemHealthReport.js";

let pool: Pool;
let dataPool: Pool | undefined;

async function markAllProcessesFresh(): Promise<void> {
  for (const process of ["api", "agents", "transcribe", "ai-gateway"]) {
    await upsertProcessHeartbeat(pool, { process, pid: 1, version: "1.0.0" }, new Date());
  }
}

function runCheck(onPool: Pool): Promise<void> {
  return runAsSystem("test", () => handleObservabilityCheckSystemTask(onPool, { job: { id: randomUUID() } }));
}

async function addErroredMailbox(tenantId: string): Promise<string> {
  const itemId = randomUUID();
  await withTenantTransaction(pool, tenantId, async (client) => {
    await ensureMailAccountSyncState(client, { itemId, syncMode: "imap" });
    await recordSyncError(client, itemId, "boom");
  });
  return itemId;
}

async function tenantCheckRows(): Promise<Array<{ check_key: string; tenant_id: string; status: string }>> {
  const { rows } = await pool.query<{ check_key: string; tenant_id: string; status: string }>(
    `SELECT check_key, tenant_id, status FROM tenant_observability_checks ORDER BY check_key`,
  );
  return rows;
}

describe("tenant_observability_checks (issue #999)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await pool.query("DELETE FROM tenant_observability_checks");
    await pool.query("DROP TRIGGER IF EXISTS fail_tenant_check_insert ON tenant_observability_checks");
    await markAllProcessesFresh();
  });

  afterEach(async () => {
    await pool.query("DROP TRIGGER IF EXISTS fail_tenant_check_insert ON tenant_observability_checks");
    await dataPool?.end();
    dataPool = undefined;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reports the caller's alerting tenant check next to an alerting global check, ordered by changed_at, without ok rows", async () => {
    await pool.query(
      `INSERT INTO observability_checks (check_key, status, changed_at) VALUES
         ('queue:backlog', 'alerting', now() - interval '2 minutes'),
         ('process:api', 'ok', now() - interval '3 minutes')`,
    );
    await pool.query(
      `INSERT INTO tenant_observability_checks (check_key, status, changed_at) VALUES
         ('mail:a', 'alerting', now() - interval '1 minute'),
         ('mail:b', 'ok', now() - interval '4 minutes')`,
    );

    const report = await withTransaction(pool, (client) => getSystemHealthReport(client));
    expect(report.alertingChecks.map((check) => check.checkKey)).toEqual(["queue:backlog", "mail:a"]);
  });

  describe("with a second tenant", () => {
    it("writes a stalled mailbox of tenant B only under B and keeps it out of tenant zero's report", async () => {
      const tenantB = await createTestTenant(pool);
      const mailboxB = await addErroredMailbox(tenantB);
      dataPool = await createRuntimeRolePool(pool, "semprec_data");

      await runCheck(dataPool);

      expect(await tenantCheckRows()).toEqual([
        { check_key: `mail:${mailboxB}`, tenant_id: tenantB, status: "alerting" },
      ]);

      const zeroReport = await runInTenant(getTenantZeroId(), () =>
        withTransaction(dataPool!, (client) => getSystemHealthReport(client)),
      );
      expect(zeroReport.alertingChecks.filter((check) => check.checkKey.startsWith("mail:"))).toEqual([]);

      const bReport = await runInTenant(tenantB, () =>
        withTransaction(dataPool!, (client) => getSystemHealthReport(client)),
      );
      expect(bReport.alertingChecks.map((check) => check.checkKey)).toContain(`mail:${mailboxB}`);
    });

    it("does not evaluate the mailboxes of a suspended tenant", async () => {
      const tenantB = await createTestTenant(pool, { status: "suspended" });
      await addErroredMailbox(tenantB);
      dataPool = await createRuntimeRolePool(pool, "semprec_data");

      await runCheck(dataPool);

      expect(await tenantCheckRows()).toEqual([]);
    });

    it("still commits tenant zero's checks when tenant B's pass fails, then rejects", async () => {
      const tenantB = await createTestTenant(pool);
      const mailboxZero = await addErroredMailbox(getTenantZeroId());
      await addErroredMailbox(tenantB);
      await pool.query(
        `CREATE OR REPLACE FUNCTION fail_tenant_check_insert() RETURNS trigger AS $$
         BEGIN
           IF NEW.tenant_id = '${tenantB}'::uuid THEN RAISE EXCEPTION 'injected failure'; END IF;
           RETURN NEW;
         END $$ LANGUAGE plpgsql`,
      );
      await pool.query(
        `CREATE TRIGGER fail_tenant_check_insert BEFORE INSERT ON tenant_observability_checks
         FOR EACH ROW EXECUTE FUNCTION fail_tenant_check_insert()`,
      );
      dataPool = await createRuntimeRolePool(pool, "semprec_data");

      await expect(runCheck(dataPool)).rejects.toBeInstanceOf(AggregateError);

      expect(await tenantCheckRows()).toEqual([
        { check_key: `mail:${mailboxZero}`, tenant_id: getTenantZeroId(), status: "alerting" },
      ]);
    });
  });
});
