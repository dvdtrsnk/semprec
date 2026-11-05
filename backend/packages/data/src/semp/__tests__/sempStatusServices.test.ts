import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../../auth/usersStore.js";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { ensureMailAccountSyncState, recordGmailActivity } from "../../mail/mailAccountSyncStateStore.js";
import { recordRestoreTestResult } from "../../observability/restoreTestResult.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { raiseProblem } from "../sempProblemsStore.js";
import { getSempStatusReport } from "../sempStatusReport.js";

let admin: Pool;
let data: Pool;
let own: string;
let other: string;
let user: string;
describe("Semp status services", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify service role", () =>
      data.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    own = await createTestTenant(admin);
    other = await createTestTenant(admin);
    const created = await runAsSystem("create service user", () =>
      createUser(admin, { tenantId: own, email: `${randomUUID()}@example.test`, passwordHash: "unused", locale: "en" }),
    );
    user = created.id;
    for (const tenant of [own, other]) await runInTenant(tenant, () => seedSystem(data));
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });
  async function mailbox(tenant: string, name: string, provider: "gmail" | "outlook") {
    return runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const db = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === "mailboxes");
      if (!db) throw new Error("Missing mailboxes database");
      const item = await cp.createItem({ databaseId: db.id, properties: { name, provider } });
      const activity = await withTransaction(data, async (client) => {
        await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: "gmail_api" });
        await recordGmailActivity(client, {
          itemId: item.id,
          historyId: "1",
          nextExpectedActivityAt: new Date("2030-01-01T00:00:00Z"),
        });
        const row = await client.query<{ last_activity_at: Date }>(
          "SELECT last_activity_at FROM mail_account_sync_state WHERE item_id = $1",
          [item.id],
        );
        return row.rows[0]!.last_activity_at.toISOString();
      });
      return { id: item.id, activity };
    });
  }
  it("combines mailbox activity and problem state without leaking another tenant", async () => {
    const first = await mailbox(own, "Personal", "gmail");
    const second = await mailbox(own, "Work", "outlook");
    const foreign = await mailbox(other, "Foreign", "gmail");
    const foreignUser = await runAsSystem("create foreign service user", () =>
      createUser(admin, {
        tenantId: other,
        email: `${randomUUID()}@example.test`,
        passwordHash: "unused",
        locale: "en",
      }),
    );
    const foreignProblem = await runInTenant(other, () =>
      withTransaction(data, (client) =>
        raiseProblem(client, {
          userId: foreignUser.id,
          category: "agents",
          kind: "agentHeartbeat",
          severity: "warning",
          sourceTable: "items",
          sourceId: foreign.id,
          dedupeKey: `agents:foreign:${foreign.id}`,
        }),
      ),
    );
    const since = new Date("2026-01-02T03:04:05Z");
    await runInTenant(own, () =>
      withTransaction(data, (client) =>
        raiseProblem(client, {
          userId: user,
          category: "mail",
          kind: "mailSyncError",
          severity: "warning",
          sourceTable: "items",
          sourceId: first.id,
          dedupeKey: `mail:${first.id}`,
          since,
        }),
      ),
    );
    const report = await runInTenant(own, () => getSempStatusReport(data));
    expect(report.services).toContainEqual({
      key: `mail:${first.id}`,
      name: "Personal - Gmail",
      state: "error",
      since: since.toISOString(),
      lastActivityAt: first.activity,
      detail: null,
    });
    expect(report.services).toContainEqual({
      key: `mail:${second.id}`,
      name: "Work - Outlook",
      state: "ok",
      since: null,
      lastActivityAt: second.activity,
      detail: null,
    });
    expect(report.services).toContainEqual({
      key: "agents",
      name: "Semp and agents",
      state: "ok",
      since: null,
      lastActivityAt: null,
      detail: null,
    });
    expect(report.services.some((service) => service.key.startsWith("calendar"))).toBe(false);
    expect(JSON.stringify(report)).not.toContain(foreign.id);
    expect(JSON.stringify(report)).not.toContain(foreignProblem.problemId);
  });
  it("exposes the latest restore outcome without operator failure detail", async () => {
    await runAsSystem("record restore tests", async () => {
      await recordRestoreTestResult(data, { status: "passed", runId: "20260101T000000Z-1" });
      await recordRestoreTestResult(data, { status: "passed", runId: "20260201T000000Z-2" });
    });
    let report = await runInTenant(own, () => getSempStatusReport(data));
    expect(report.services.find((service) => service.key === "backup")).toMatchObject({
      lastActivityAt: "2026-02-01T00:00:00.000Z",
      detail: { lastTestAt: "2026-02-01T00:00:00.000Z", ok: true },
    });
    await runAsSystem("record failed restore", () =>
      recordRestoreTestResult(data, {
        status: "failed",
        runId: "20260301T000000Z-3",
        failedCheck: "tenantKeysRestore",
      }),
    );
    report = await runInTenant(own, () => getSempStatusReport(data));
    expect(report.services.find((service) => service.key === "backup")).toMatchObject({
      lastActivityAt: "2026-03-01T00:00:00.000Z",
      detail: { lastTestAt: "2026-03-01T00:00:00.000Z", ok: false },
    });
    expect(JSON.stringify(report)).not.toContain("tenantKeysRestore");
  });
  it("reports the latest actual agent run activity", async () => {
    await runInTenant(own, async () => {
      await withTransaction(data, (client) =>
        createAgentRun(client, { triggeredBy: "user", userId: user, task: "First" }),
      );
      const latest = await withTransaction(data, (client) =>
        createAgentRun(client, { triggeredBy: "user", userId: user, task: "Second" }),
      );
      const agents = (await getSempStatusReport(data)).services.find((service) => service.key === "agents");
      expect(agents?.lastActivityAt).toBe(latest.startedAt);
    });
  });
});
