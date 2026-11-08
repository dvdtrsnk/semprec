import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createHeartbeat, setHeartbeatEnabled } from "../../scheduler/schedulerStore.js";
import { createAgentRun, createChainedAgentRun, finishAgentRun } from "../../agentRuns/agentRunsStore.js";
import { ensureMailAccountSyncState, recordSyncError } from "../../mail/mailAccountSyncStateStore.js";
import { getOrCreateTickThread } from "../sempTickThreadStore.js";
import { raiseProblem } from "../sempProblemsStore.js";
import { getSempStatusReport } from "../sempStatusReport.js";
let admin: Pool;
let data: Pool;
let own: string;
let foreign: string;
let ownUser: string;
let foreignUser: string;
describe("Semp status report", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify status test role", () =>
      data.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    own = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    const users = await runAsSystem("status test users", () =>
      Promise.all([
        createUser(admin, {
          tenantId: own,
          email: `${randomUUID()}@example.test`,
          passwordHash: "unused",
          locale: "en",
        }),
        createUser(admin, {
          tenantId: foreign,
          email: `${randomUUID()}@example.test`,
          passwordHash: "unused",
          locale: "cs",
        }),
      ]),
    );
    ownUser = users[0].id;
    foreignUser = users[1].id;
    for (const tenant of [own, foreign]) await runInTenant(tenant, () => seedSystem(data));
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });
  async function mailboxProblem(tenant: string, userId: string) {
    return runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const db = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === "mailboxes");
      if (!db) throw new Error("Missing mailboxes database");
      const item = await cp.createItem({ databaseId: db.id, properties: { name: "Inbox", provider: "generic" } });
      const since = new Date("2026-01-02T03:04:05.000Z");
      await withTransaction(data, async (client) => {
        await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: "imap" });
        expect(await recordSyncError(client, item.id, "private-provider-error", "other")).not.toBeNull();
      });
      for (let i = 0; i < 4; i++)
        await withTransaction(data, (client) =>
          raiseProblem(client, {
            userId,
            category: "mail",
            kind: "mailSyncError",
            severity: "warning",
            sourceTable: "mail_account_sync_state",
            sourceId: item.id,
            dedupeKey: `mail:${item.id}`,
            since: new Date(since.getTime() + i * 60_000),
            occurrenceKey: `run-${i}`,
          }),
        );
      return { item, since };
    });
  }
  it("returns merged localized problems only in the current tenant", async () => {
    const first = await mailboxProblem(own, ownUser);
    const second = await mailboxProblem(foreign, foreignUser);
    const report = await runInTenant(own, () => getSempStatusReport(data));
    expect(report.activeCount).toBe(1);
    expect(report.problems[0]).toMatchObject({
      title: "Mailbox is not syncing",
      mergedCount: 4,
      since: first.since.toISOString(),
      source: { id: first.item.id },
      actions: [{ kind: "reauthMailbox", target: first.item.id }],
    });
    expect(JSON.stringify(report)).not.toContain(second.item.id);
    expect(JSON.stringify(report)).not.toContain("private-provider-error");
    const cs = await runInTenant(foreign, () => getSempStatusReport(data));
    expect(cs.problems[0]?.title).toBe("Schránka se nesynchronizuje");
  });
  it("returns an empty list without active problems", async () => {
    expect(await runInTenant(own, () => getSempStatusReport(data))).toMatchObject({ activeCount: 0, problems: [] });
  });
  it("renders each supported kind in both locales", async () => {
    const cases = [
      ["mailSyncError", "mail"],
      ["agentHeartbeat", "agents"],
      ["agentRun", "agents"],
      ["reply", "agents"],
      ["guidanceDrift", "guidance"],
      ["libraryAutomation", "automation"],
      ["backupRestore", "backup"],
      ["processStale", "agents"],
      ["transcriptionFailed", "transcription"],
    ] as const;
    const sourceIds = new Map<string, Map<string, string>>();
    for (const [tenant, userId] of [
      [own, ownUser],
      [foreign, foreignUser],
    ] as const) {
      await runInTenant(tenant, () =>
        withTransaction(data, async (client) => {
          const byKind = new Map<string, string>();
          sourceIds.set(tenant, byKind);
          for (const [kind, category] of cases) {
            const sourceId = randomUUID();
            byKind.set(kind, sourceId);
            await raiseProblem(client, {
              userId,
              category,
              kind,
              severity: "warning",
              sourceTable: "items",
              sourceId,
              dedupeKey: `fixture:${kind}`,
            });
          }
        }),
      );
    }
    const en = await runInTenant(own, () => getSempStatusReport(data));
    const cs = await runInTenant(foreign, () => getSempStatusReport(data));
    expect(en.problems).toHaveLength(cases.length);
    expect(cs.problems).toHaveLength(cases.length);
    const catalogs = await loadModuleCatalogs(new URL("../sempStatusReport.js", import.meta.url).href);
    for (const [kind] of cases) {
      const key = `status.${kind}.title`;
      expect(en.problems.map((p) => p.title)).toContain(resolveCatalogLabel(undefined, catalogs.en, catalogs.en, key));
      expect(cs.problems.map((p) => p.title)).toContain(resolveCatalogLabel(undefined, catalogs.cs, catalogs.en, key));
      expect(JSON.stringify(en)).not.toContain(`status.${kind}.`);
      expect(JSON.stringify(cs)).not.toContain(`status.${kind}.`);
      const english = en.problems.find((problem) => problem.source.id === sourceIds.get(own)?.get(kind));
      const czech = cs.problems.find((problem) => problem.source.id === sourceIds.get(foreign)?.get(kind));
      if (!english || !czech) throw new Error(`Missing localized ${kind} problem`);
      expect(english.title).toBe(resolveCatalogLabel(undefined, catalogs.en, catalogs.en, key));
      expect(czech.title).toBe(resolveCatalogLabel(undefined, catalogs.cs, catalogs.en, key));
      const textKey = `status.${kind}.${kind === "reply" ? "textUnnamed" : "text"}`;
      const shortKey = `status.${kind}.shortText`;
      const englishPrefix = resolveCatalogLabel(undefined, catalogs.en, catalogs.en, textKey).split("{")[0]!.trim();
      const czechPrefix = resolveCatalogLabel(undefined, catalogs.cs, catalogs.en, textKey).split("{")[0]!.trim();
      expect(english.text.startsWith(englishPrefix)).toBe(true);
      expect(czech.text.startsWith(czechPrefix)).toBe(true);
      expect(english.shortText).toBe(resolveCatalogLabel(undefined, catalogs.en, catalogs.en, shortKey));
      expect(czech.shortText).toBe(resolveCatalogLabel(undefined, catalogs.cs, catalogs.en, shortKey));
      expect(czech.shortText).not.toBe(english.shortText);
    }
  });
  it("keeps the number of report statements constant as problems grow", async () => {
    async function addProblem(index: number) {
      await runInTenant(own, () =>
        withTransaction(data, (client) =>
          raiseProblem(client, {
            userId: ownUser,
            category: "mail",
            kind: "mailSyncError",
            severity: "warning",
            sourceTable: "items",
            sourceId: randomUUID(),
            dedupeKey: `fixture:${index}`,
          }),
        ),
      );
    }
    async function count(expected: number) {
      const spies: Array<{ mock: { calls: unknown[][] }; mockRestore(): void }> = [];
      const observe = (client: PoolClient) => {
        spies.push(vi.spyOn(client, "query"));
      };
      data.on("acquire", observe);
      try {
        const report = await runInTenant(own, () => getSempStatusReport(data));
        expect(report.problems).toHaveLength(expected);
        return spies.flatMap((spy) => spy.mock.calls).length;
      } finally {
        data.off("acquire", observe);
        for (const spy of spies) spy.mockRestore();
      }
    }
    await addProblem(0);
    const one = await count(1);
    for (let i = 1; i < 50; i++) await addProblem(i);
    expect(await count(50)).toBe(one);
  });
  it("uses the latest failed heartbeat run and offers disable for an enabled user heartbeat", async () => {
    await runInTenant(own, async () => {
      const cp = createChokePoint(data);
      const projects = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === "projects");
      if (!projects) throw new Error("Missing projects");
      const project = await cp.createItem({ databaseId: projects.id, properties: { name: "Project" } });
      const heartbeat = await withTransaction(data, (client) =>
        createHeartbeat(client, {
          projectItemId: project.id,
          name: "Job",
          rule: { kind: "interval", minutes: 5 },
          actionId: "noop",
          origin: "user",
        }),
      );
      const thread = await withTransaction(data, (client) => getOrCreateTickThread(client, heartbeat.id));
      const first = await withTransaction(data, (client) =>
        createAgentRun(client, {
          projectItemId: project.id,
          heartbeatId: heartbeat.id,
          threadId: thread.id,
          triggeredBy: "heartbeat",
          task: "first",
        }),
      );
      await withTransaction(data, (client) => finishAgentRun(client, first.id, "error", "raw-secret", "internal"));
      const last = await withTransaction(data, (client) =>
        createChainedAgentRun(client, {
          projectItemId: project.id,
          heartbeatId: heartbeat.id,
          threadId: thread.id,
          triggeredBy: "heartbeat",
          task: "retry",
          retryOfRunId: first.id,
          attempt: 2,
        }),
      );
      if (!last) throw new Error("Missing chained run");
      await withTransaction(data, (client) => finishAgentRun(client, last.id, "error", "raw-secret", "internal"));
      await withTransaction(data, (client) =>
        raiseProblem(client, {
          userId: ownUser,
          category: "agents",
          kind: "agentHeartbeat",
          severity: "warning",
          sourceTable: "project_heartbeats",
          sourceId: heartbeat.id,
          dedupeKey: `agents:heartbeat:${heartbeat.id}`,
          projectItemId: project.id,
        }),
      );
      const report = await getSempStatusReport(data);
      expect(report.problems[0]?.actions).toEqual(
        expect.arrayContaining([
          { kind: "retryRun", target: last.id },
          { kind: "openThread", target: thread.id },
          { kind: "disableHeartbeat", target: heartbeat.id },
        ]),
      );
      expect(JSON.stringify(report)).not.toContain("raw-secret");
      const persisted = await data.query<Record<string, unknown>>(
        "SELECT enabled FROM project_heartbeats WHERE id = $1",
        [heartbeat.id],
      );
      expect(z.object({ enabled: z.boolean() }).parse(persisted.rows[0]).enabled).toBe(true);
      await withTransaction(data, (client) => setHeartbeatEnabled(client, heartbeat.id, false));
      expect((await getSempStatusReport(data)).problems[0]?.actions).not.toContainEqual({
        kind: "disableHeartbeat",
        target: heartbeat.id,
      });
      const system = await withTransaction(data, (client) =>
        createHeartbeat(client, {
          projectItemId: project.id,
          name: "System",
          rule: { kind: "interval", minutes: 5 },
          actionId: "noop",
          origin: "system",
        }),
      );
      await withTransaction(data, (client) =>
        raiseProblem(client, {
          userId: ownUser,
          category: "agents",
          kind: "agentHeartbeat",
          severity: "warning",
          sourceTable: "project_heartbeats",
          sourceId: system.id,
          dedupeKey: `agents:heartbeat:${system.id}`,
        }),
      );
      const systemProblem = (await getSempStatusReport(data)).problems.find(
        (problem) => problem.source.id === system.id,
      );
      expect(systemProblem).toBeDefined();
      expect(systemProblem?.actions).not.toContainEqual({ kind: "disableHeartbeat", target: system.id });
    });
  });

  it("renders both locales from the compiled report's own catalogs", async () => {
    await mailboxProblem(own, ownUser);
    await mailboxProblem(foreign, foreignUser);
    const url = new URL("../../../dist/semp/sempStatusReport.js", import.meta.url).href;
    const loaded: unknown = await import(/* @vite-ignore */ url);
    if (
      typeof loaded !== "object" ||
      loaded === null ||
      !("getSempStatusReport" in loaded) ||
      typeof loaded.getSempStatusReport !== "function"
    )
      throw new Error("Missing compiled report");
    const compiledReport = loaded.getSempStatusReport;
    const en: unknown = await runInTenant(own, () => {
      const result: unknown = Reflect.apply(compiledReport, undefined, [data]);
      return result;
    });
    const cs: unknown = await runInTenant(foreign, () => {
      const result: unknown = Reflect.apply(compiledReport, undefined, [data]);
      return result;
    });
    expect(en).toMatchObject({ problems: [{ title: "Mailbox is not syncing" }] });
    expect(cs).toMatchObject({ problems: [{ title: "Schránka se nesynchronizuje" }] });
  });

  it("returns retry and chat targets for a failed reply without copying its raw text", async () => {
    await runInTenant(own, async () => {
      // The reply-problem producer is delivered later; these rows are a synthetic source fixture.
      const messageId = await withTransaction(data, async (client) => {
        const thread = await client.query<{ id: string }>(
          "INSERT INTO semp_threads (kind, title) VALUES ('chat', 'Planning') RETURNING id",
        );
        expect(thread.rowCount).toBe(1);
        const message = await client.query<{ id: string }>(
          "INSERT INTO semp_messages (thread_id, role, status, text) VALUES ($1, 'assistant', 'error', 'private error') RETURNING id",
          [thread.rows[0]!.id],
        );
        expect(message.rowCount).toBe(1);
        await raiseProblem(client, {
          userId: ownUser,
          category: "agents",
          kind: "reply",
          severity: "warning",
          sourceTable: "semp_messages",
          sourceId: message.rows[0]!.id,
          dedupeKey: `agents:reply:${message.rows[0]!.id}`,
        });
        return { id: message.rows[0]!.id, threadId: thread.rows[0]!.id };
      });
      const report = await getSempStatusReport(data);
      expect(report.problems[0]?.actions).toEqual([
        { kind: "retryPrompt", target: messageId.id },
        { kind: "openChat", target: { threadId: messageId.threadId, messageId: messageId.id } },
      ]);
      expect(JSON.stringify(report)).not.toContain("private error");
      expect(report.problems[0]?.text).toContain("Planning");
    });
  });
});
