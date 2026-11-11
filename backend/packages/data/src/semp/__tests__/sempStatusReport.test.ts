import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { recordTokenGatewayCall } from "../../aiGateway/aiGatewayCallsStore.js";
import { getAiUsageSummary } from "../../aiGateway/aiUsageSummary.js";
import { setTenantAiBudget } from "../../aiGateway/tenantAiBudgetsStore.js";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { requireAffectedRows, withTransaction } from "../../db/pool.js";
import { ValidationError } from "../../errors.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../../systemSettings.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createHeartbeat, setHeartbeatEnabled } from "../../scheduler/schedulerStore.js";
import { createAgentRun, createChainedAgentRun, finishAgentRun } from "../../agentRuns/agentRunsStore.js";
import { ensureMailAccountSyncState, recordSyncError } from "../../mail/mailAccountSyncStateStore.js";
import { getOrCreateTickThread } from "../sempTickThreadStore.js";
import { raiseProblem } from "../sempProblemsStore.js";
import { getSempStatusReport } from "../sempStatusReport.js";
import { createSempStatusRouteHandler } from "../sempStatusRouteHandler.js";

/** UTC+14 and UTC-11, neither with daylight saving: a reset time written in UTC is visibly not theirs. */
const KIRITIMATI = "Pacific/Kiritimati";
const PAGO_PAGO = "Pacific/Pago_Pago";

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
    // A tenant without a budget row lists `aiBudgetMissing` (issue gh-1871), so both get a row without caps.
    await adminSetsBudget(own, ownUser, { dailyCapUsd: null, monthlyCapUsd: null });
    await adminSetsBudget(foreign, foreignUser, { dailyCapUsd: null, monthlyCapUsd: null });
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });
  /** Writes the tenant's caps with the writer the admin route uses. */
  async function adminSetsBudget(
    tenantId: string,
    updatedBy: string,
    caps: { dailyCapUsd: number | null; monthlyCapUsd: number | null },
  ) {
    await runAsSystem("status test budget", () =>
      withTransaction(data, (client) => setTenantAiBudget(client, { tenantId, updatedBy, ...caps })),
    );
  }
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

  describe("AI budget problems (issue gh-1871)", () => {
    let catalogs: Awaited<ReturnType<typeof loadModuleCatalogs>>;

    /** The fields every AI budget problem carries besides its id and its three texts. */
    const BUDGET_PROBLEM_FIELDS = {
      category: "agents",
      severity: "critical",
      since: null,
      mergedCount: 1,
      projectName: null,
      source: { table: "tenant_ai_budgets", id: null },
      affectedService: "agents",
      actions: [],
    };

    beforeAll(async () => {
      catalogs = await loadModuleCatalogs(new URL("../sempStatusReport.js", import.meta.url).href);
    });

    /** A seeded tenant with one user and no budget row: the state of a new account. */
    async function tenantWithoutBudget(locale: "cs" | "en"): Promise<{ tenantId: string; userId: string }> {
      const tenantId = await createTestTenant(admin);
      const user = await runAsSystem("status test user without a budget", () =>
        createUser(admin, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused", locale }),
      );
      await runInTenant(tenantId, () => seedSystem(data));
      return { tenantId, userId: user.id };
    }

    async function setZone(tenantId: string, timezone: string): Promise<void> {
      await runInTenant(tenantId, async () => {
        const settings = await withTransaction(data, async (client) => ({
          databaseId: await getSystemSettingsDatabaseId(client),
          itemId: await getSystemSettingsItemId(client),
        }));
        await createChokePoint(data).updateItem({ ...settings, propertiesPatch: { timezone } });
      });
    }

    /** One settled call at `costUsd`, written by the gateway's accounting writer in the tenant's scope. */
    async function spend(tenantId: string, costUsd: number): Promise<string> {
      const call = await runInTenant(tenantId, () =>
        recordTokenGatewayCall(data, {
          provider: "anthropic",
          model: "status-test",
          inputTokens: 1,
          outputTokens: 1,
          costUsd,
        }),
      );
      return call.id;
    }

    const read = (tenantId: string) => runInTenant(tenantId, () => getSempStatusReport(data));

    /** The reset instant the budget summary reports; a summary without one fails the test rather than passing it. */
    async function resetInstant(tenantId: string): Promise<string> {
      const summary = await runInTenant(tenantId, () => getAiUsageSummary(data));
      if (summary.resetsAt === null) throw new Error("expected an exhausted window");
      return summary.resetsAt;
    }

    /**
     * The catalog entry itself, never the key the resolver falls back to, with the reset time put in
     * and whitespace collapsed as the report collapses it.
     */
    function catalogText(locale: "cs" | "en", key: string, resetTime = ""): string {
      const entry = catalogs[locale][key];
      if (entry === undefined) throw new Error(`Missing ${locale} catalog entry ${key}`);
      return entry.replace("{resetTime}", resetTime).replace(/\s+/g, " ").trim();
    }

    /**
     * The reset instant as its tenant reads it, written by `Intl` with the options the report gives
     * Luxon, which formats through `Intl` too. So no expectation depends on this runtime's ICU data.
     */
    function resetTimeText(locale: "cs" | "en", timeZone: string, resetsAt: string): string {
      return new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "long", timeStyle: "short" }).format(
        new Date(resetsAt),
      );
    }

    function exhaustedProblem(locale: "cs" | "en", timeZone: string, resetsAt: string) {
      const resetTime = resetTimeText(locale, timeZone, resetsAt);
      return {
        id: `aiBudgetExhausted:${resetsAt}`,
        ...BUDGET_PROBLEM_FIELDS,
        title: catalogText(locale, "status.aiBudgetExhausted.title"),
        text: catalogText(locale, "status.aiBudgetExhausted.text", resetTime),
        shortText: catalogText(locale, "status.aiBudgetExhausted.shortText", resetTime),
      };
    }

    /**
     * One fingerprint per table outside the system schemas: the position (`ctid`) and the inserting
     * transaction (`xmin`) of every row version. An insert, an update and a delete each change it, so
     * two equal snapshots mean no row was written in between. It reads through the superuser pool
     * because it must see every tenant's rows; it asserts nothing about isolation.
     */
    async function tableFingerprints(): Promise<Record<string, string>> {
      // Postgres assembles the statement and quotes every schema and table name itself (%L, %I).
      const generated = await admin.query<{ statement: string | null }>(
        `SELECT string_agg(
                  format('SELECT %L AS table_name, coalesce(md5(string_agg(t.ctid::text || '':'' || t.xmin::text, '','' ORDER BY t.ctid)), '''') AS fingerprint FROM %I.%I t',
                         n.nspname || '.' || c.relname, n.nspname, c.relname),
                  ' UNION ALL ' ORDER BY n.nspname, c.relname) AS statement
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`,
      );
      const statement = generated.rows[0]?.statement;
      if (!statement) throw new Error("Found no table to fingerprint");
      const { rows } = await admin.query<{ table_name: string; fingerprint: string }>(statement);
      return Object.fromEntries(rows.map((row) => [row.table_name, row.fingerprint]));
    }

    it("lists aiBudgetMissing in the user's locale for a tenant without a budget row, until an admin sets limits", async () => {
      expect(catalogText("en", "status.aiBudgetMissing.title")).toBe("AI has no limit set");
      for (const locale of ["en", "cs"] as const) {
        const bare = await tenantWithoutBudget(locale);
        const report = await read(bare.tenantId);
        expect(report.activeCount).toBe(1);
        expect(report.problems).toEqual([
          {
            id: "aiBudgetMissing",
            ...BUDGET_PROBLEM_FIELDS,
            title: catalogText(locale, "status.aiBudgetMissing.title"),
            text: catalogText(locale, "status.aiBudgetMissing.text"),
            shortText: catalogText(locale, "status.aiBudgetMissing.shortText"),
          },
        ]);
        await adminSetsBudget(bare.tenantId, bare.userId, { dailyCapUsd: 5, monthlyCapUsd: 50 });
        expect(await read(bare.tenantId)).toMatchObject({ activeCount: 0, problems: [] });
      }
      for (const field of ["title", "text", "shortText"]) {
        const key = `status.aiBudgetMissing.${field}`;
        expect(catalogText("cs", key)).not.toBe(catalogText("en", key));
      }
    });

    it.each([
      ["daily", { dailyCapUsd: 5, monthlyCapUsd: null }],
      ["monthly", { dailyCapUsd: null, monthlyCapUsd: 5 }],
    ] as const)(
      "lists aiBudgetExhausted for a %s cap with the reset time in the tenant's time zone and the user's locale",
      async (window, caps) => {
        for (const [tenantId, userId, locale, timeZone] of [
          [own, ownUser, "en", KIRITIMATI],
          [foreign, foreignUser, "cs", PAGO_PAGO],
        ] as const) {
          await setZone(tenantId, timeZone);
          await adminSetsBudget(tenantId, userId, caps);
          await spend(tenantId, 6);
          expect((await runInTenant(tenantId, () => getAiUsageSummary(data))).exhausted).toBe(window);

          // The window can roll between two reads, so the report may carry the reset instant of either side.
          const before = await resetInstant(tenantId);
          const report = await read(tenantId);
          const after = await resetInstant(tenantId);

          expect(report.activeCount).toBe(1);
          expect(report.problems).toHaveLength(1);
          expect([before, after].map((resetsAt) => exhaustedProblem(locale, timeZone, resetsAt))).toContainEqual(
            report.problems[0],
          );
          // Both texts take the reset time, and the tenant's zone reads differently from UTC.
          expect(catalogs[locale]["status.aiBudgetExhausted.text"]).toContain("{resetTime}");
          expect(catalogs[locale]["status.aiBudgetExhausted.shortText"]).toContain("{resetTime}");
          expect(resetTimeText(locale, timeZone, before)).not.toBe(resetTimeText(locale, "UTC", before));
        }
        for (const field of ["title", "text", "shortText"]) {
          const key = `status.aiBudgetExhausted.${field}`;
          expect(catalogText("cs", key)).not.toBe(catalogText("en", key));
        }
      },
    );

    // The settings writer accepts a fixed offset, and `Intl.DateTimeFormat` refuses one written this way
    // as its `timeZone`. Each is paired with an IANA zone that has had the same offset all year since
    // before 1970, so `Intl` can still write the expected text.
    it.each([
      ["UTC+2", "Etc/GMT-2"],
      ["UTC+5:30", "Asia/Kolkata"],
    ] as const)(
      "lists aiBudgetExhausted with the reset time for a tenant whose stored zone is the fixed offset %s",
      async (storedZone, sameOffsetZone) => {
        for (const [tenantId, userId, locale] of [
          [own, ownUser, "en"],
          [foreign, foreignUser, "cs"],
        ] as const) {
          await setZone(tenantId, storedZone);
          await adminSetsBudget(tenantId, userId, { dailyCapUsd: 5, monthlyCapUsd: null });
          await spend(tenantId, 6);

          // The window can roll between two reads, so the report may carry the reset instant of either side.
          const before = await resetInstant(tenantId);
          const report = await read(tenantId);
          const after = await resetInstant(tenantId);

          expect(report.activeCount).toBe(1);
          expect(report.problems).toHaveLength(1);
          expect([before, after].map((resetsAt) => exhaustedProblem(locale, sameOffsetZone, resetsAt))).toContainEqual(
            report.problems[0],
          );
          expect(resetTimeText(locale, sameOffsetZone, before)).not.toBe(resetTimeText(locale, "UTC", before));
        }
      },
    );

    it("validates the tenant's zone only for an exhausted window, and then refuses one Luxon cannot read", async () => {
      // Raw SQL: the settings writer refuses this zone, so only a row written past it holds one.
      // Postgres reads `GMT+2` as a POSIX zone, so the budget summary still reports the window.
      await runInTenant(own, async () => {
        const itemId = await withTransaction(data, (client) => getSystemSettingsItemId(client));
        requireAffectedRows(
          await data.query<{ id: string }>(
            `UPDATE items SET properties = jsonb_set(properties, '{timezone}', to_jsonb($2::text)) WHERE id = $1 RETURNING id`,
            [itemId, "GMT+2"],
          ),
          "storing a zone the settings writer refuses",
        );
      });
      await adminSetsBudget(own, ownUser, { dailyCapUsd: 5, monthlyCapUsd: null });
      expect(await read(own)).toMatchObject({ activeCount: 0, problems: [] });

      await spend(own, 6);
      expect(await resetInstant(own)).toEqual(expect.any(String));
      const failure = await read(own).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ValidationError);
      expect(failure).toMatchObject({ details: { field: "timezone" } });
    });

    it.each([
      ["daily", "day", { dailyCapUsd: 5, monthlyCapUsd: null }],
      ["monthly", "month", { dailyCapUsd: null, monthlyCapUsd: 5 }],
    ] as const)("no longer lists the exhausted problem once the %s window has rolled", async (_window, unit, caps) => {
      await setZone(own, KIRITIMATI);
      await adminSetsBudget(own, ownUser, caps);
      const callId = await spend(own, 6);
      expect((await read(own)).problems.map((problem) => problem.id)).toEqual([
        expect.stringMatching(/^aiBudgetExhausted:/),
      ]);

      // The accounting writer stamps now and the test cannot move the database clock. A call one minute
      // before the start of the current window is the state after that call's reset instant has passed.
      await runInTenant(own, async () =>
        requireAffectedRows(
          await data.query<{ id: string }>(
            `UPDATE ai_gateway_calls
                SET at = (date_trunc($2, now() AT TIME ZONE $3) AT TIME ZONE $3) - interval '1 minute'
              WHERE id = $1 RETURNING id`,
            [callId, unit, KIRITIMATI],
          ),
          "backdating test call",
        ),
      );

      expect(await read(own)).toMatchObject({ activeCount: 0, problems: [] });
    });

    it("keeps the id of an exhausted window when the exhaustion ends and returns before the reset instant", async () => {
      const exhaustedIds = async () => (await read(own)).problems.map((problem) => problem.id);
      await adminSetsBudget(own, ownUser, { dailyCapUsd: null, monthlyCapUsd: 5 });
      await spend(own, 6);
      const window = await resetInstant(own);
      const first = await exhaustedIds();
      expect(first).toEqual([`aiBudgetExhausted:${window}`]);

      // An administrator raises the cap, which ends the exhaustion inside its window.
      await adminSetsBudget(own, ownUser, { dailyCapUsd: null, monthlyCapUsd: 10 });
      expect(await read(own)).toMatchObject({ activeCount: 0, problems: [] });

      // The raised cap is reached before the window resets.
      await spend(own, 6);
      expect(await exhaustedIds()).toEqual(first);
      expect(await resetInstant(own)).toBe(window);
    });

    it("lists the budget problem first and counts it with the stored problems", async () => {
      const bare = await tenantWithoutBudget("en");
      const stored = await runInTenant(bare.tenantId, () =>
        withTransaction(data, (client) =>
          raiseProblem(client, {
            userId: bare.userId,
            category: "mail",
            kind: "mailSyncError",
            severity: "critical",
            sourceTable: "items",
            sourceId: randomUUID(),
            dedupeKey: "fixture:critical",
          }),
        ),
      );
      const report = await read(bare.tenantId);
      expect(report.activeCount).toBe(2);
      expect(report.problems.map((problem) => problem.id)).toEqual(["aiBudgetMissing", stored.problemId]);
    });

    it("lists no budget problem below the tenant's own caps, whatever other tenants spend or lack", async () => {
      // The operator-wide caps live in the gateway, outside this package. Another tenant's spend far
      // above this tenant's caps stands in for the all-tenant total that reaches them; the refusal
      // itself is driven in packages/ai-gateway/src/__tests__/gateway.test.ts.
      const bare = await tenantWithoutBudget("en");
      await adminSetsBudget(own, ownUser, { dailyCapUsd: 10, monthlyCapUsd: 100 });
      await spend(own, 1);
      await adminSetsBudget(foreign, foreignUser, { dailyCapUsd: 5, monthlyCapUsd: null });
      await spend(foreign, 1000);

      expect(await read(own)).toMatchObject({ activeCount: 0, problems: [] });
      expect((await read(foreign)).problems.map((problem) => problem.id)).toEqual([
        expect.stringMatching(/^aiBudgetExhausted:/),
      ]);
      expect((await read(bare.tenantId)).problems.map((problem) => problem.id)).toEqual(["aiBudgetMissing"]);
    });

    it("writes no row to any table when the status is read", async () => {
      const bare = await tenantWithoutBudget("cs");
      await adminSetsBudget(own, ownUser, { dailyCapUsd: 5, monthlyCapUsd: null });
      await spend(own, 6);
      const handler = createSempStatusRouteHandler(data);

      const before = await tableFingerprints();
      const answers = [];
      for (const tenantId of [bare.tenantId, own, foreign]) answers.push(await runInTenant(tenantId, () => handler()));
      const after = await tableFingerprints();

      expect(answers.map((answer) => answer.body.problems.map((problem) => problem.id))).toEqual([
        ["aiBudgetMissing"],
        [expect.stringMatching(/^aiBudgetExhausted:/)],
        [],
      ]);
      expect(after).toEqual(before);
      expect(Object.keys(before)).toEqual(
        expect.arrayContaining([
          "public.semp_problems",
          "public.notifications",
          "public.tenant_ai_budgets",
          "public.ai_gateway_calls",
        ]),
      );

      // The fingerprint does change when a row is written, so the equality above can fail.
      await runInTenant(own, () =>
        withTransaction(data, (client) =>
          raiseProblem(client, {
            userId: ownUser,
            category: "mail",
            kind: "mailSyncError",
            severity: "warning",
            sourceTable: "items",
            sourceId: randomUUID(),
            dedupeKey: "fixture:written",
          }),
        ),
      );
      const written = await tableFingerprints();
      expect(written["public.semp_problems"]).not.toBe(before["public.semp_problems"]);
      expect(written["public.notifications"]).not.toBe(before["public.notifications"]);
    });
  });
});
