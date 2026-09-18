import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { enqueueJob } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { upsertProcessHeartbeat } from "../health/processHeartbeats.js";
import { ensureMailAccountSyncState, recordSyncError } from "../mail/mailAccountSyncStateStore.js";
import { createAgentRun, finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { getSystemHealthReport } from "../observability/systemHealthReport.js";

let pool: Pool;
let chokePoint: ChokePoint;

/** Fresh beats for every fixed process so this report's process list is deterministic per test. */
async function markAllProcessesFresh(): Promise<void> {
  for (const process of ["api", "agents", "transcribe", "ai-gateway"]) {
    await upsertProcessHeartbeat(pool, { process, pid: 1, version: "1.2.3" }, new Date());
  }
}

describe("getSystemHealthReport (issue #170)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    chokePoint = createChokePoint(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reports each expected process's freshness, version, and uptime", async () => {
    await markAllProcessesFresh();
    await pool.query(`UPDATE process_heartbeats SET beat_at = now() - interval '5 minutes' WHERE process = 'agents'`);

    const report = await getSystemHealthReport(pool);

    const api = report.processes.find((p) => p.process === "api");
    expect(api).toMatchObject({ present: true, stale: false, pid: 1, version: "1.2.3" });
    expect(api?.uptimeMs).toBeGreaterThanOrEqual(0);

    const agents = report.processes.find((p) => p.process === "agents");
    expect(agents).toMatchObject({ present: true, stale: true });
  });

  it("reports a never-beaten expected process as absent and stale", async () => {
    const report = await getSystemHealthReport(pool);
    const transcribe = report.processes.find((p) => p.process === "transcribe");
    expect(transcribe).toMatchObject({ present: false, stale: true, pid: null, version: null, uptimeMs: null });
  });

  it("lists every currently-alerting observability check and omits recovered ones", async () => {
    await pool.query(
      `INSERT INTO observability_checks (check_key, status, detail) VALUES ('process:agents', 'alerting', '{"beatAt": null}'::jsonb)`,
    );
    await pool.query(
      `INSERT INTO observability_checks (check_key, status, detail) VALUES ('queue:backlog', 'ok', '{}'::jsonb)`,
    );

    const report = await getSystemHealthReport(pool);
    expect(report.alertingChecks).toMatchObject([{ checkKey: "process:agents" }]);
  });

  it("counts pending, overdue, and permanently-failed queue jobs separately", async () => {
    await enqueueJob(pool, "someUnregisteredTask", {}, { jobKey: "pending-job" });
    await enqueueJob(pool, "someUnregisteredTask", {}, { jobKey: "overdue-job" });
    await pool.query(`UPDATE graphile_worker._private_jobs SET run_at = now() - interval '1 hour' WHERE key = $1`, [
      "overdue-job",
    ]);
    await enqueueJob(pool, "someUnregisteredTask", {}, { jobKey: "permanent-job", maxAttempts: 1 });
    await pool.query(`UPDATE graphile_worker._private_jobs SET attempts = 1 WHERE key = $1`, ["permanent-job"]);

    const report = await getSystemHealthReport(pool);
    expect(report.queue).toEqual({ pending: 2, overdue: 1, permanent: 1 });
  });

  it("groups item_automation error rows by their item's database", async () => {
    const tasksDb = await withTransaction(pool, (client) => getDatabaseByModuleId(client, TASKS_MODULE_ID));
    const item = await chokePoint.createItem({ databaseId: tasksDb!.id, properties: { name: "Do the thing" } });
    await pool.query(`INSERT INTO item_automation (item_id, status, error) VALUES ($1, 'error', 'boom')`, [item.id]);

    const report = await getSystemHealthReport(pool);
    expect(report.itemAutomationErrorsByDatabase).toMatchObject([{ databaseId: tasksDb!.id, errorCount: 1 }]);
  });

  it("counts agent-run errors from the last seven days only", async () => {
    const recentErrorRun = await createAgentRun(pool, { triggeredBy: "user", task: "recent", unit: "invocation" });
    await finishAgentRun(pool, recentErrorRun.id, "error", "boom");

    const oldErrorRun = await createAgentRun(pool, { triggeredBy: "user", task: "old", unit: "invocation" });
    await finishAgentRun(pool, oldErrorRun.id, "error", "boom");
    await pool.query(`UPDATE agent_runs SET started_at = now() - interval '8 days' WHERE id = $1`, [oldErrorRun.id]);

    const doneRun = await createAgentRun(pool, { triggeredBy: "user", task: "fine", unit: "invocation" });
    await finishAgentRun(pool, doneRun.id, "done", "ok");

    const report = await getSystemHealthReport(pool);
    expect(report.agentRunErrors7d).toBe(1);
  });

  it("reports each mailbox's activity and error state", async () => {
    const mailboxItemId = randomUUID();
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "imap" });
    await recordSyncError(pool, mailboxItemId, "connection refused");

    const report = await getSystemHealthReport(pool);
    expect(report.mailboxes).toMatchObject([{ mailboxItemId, lastError: "connection refused" }]);
  });

  it("persists no rows of its own — a plain live snapshot", async () => {
    await markAllProcessesFresh();
    const before = await pool.query("SELECT count(*) FROM observability_checks");
    await getSystemHealthReport(pool);
    const after = await pool.query("SELECT count(*) FROM observability_checks");
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
