import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  raiseProblem,
  resolveProblem,
  type SempProblemCategory,
  type SempProblemSeverity,
} from "../sempProblemsStore.js";
import { AGENTS_PROCESS_PROBLEM_KEY, BACKUP_RESTORE_PROBLEM_KEY, mailProblemKey } from "../sourceProblemKeys.js";
import { getSempStatusReport } from "../sempStatusReport.js";
import { getSempStatusSummary } from "../sempStatusSummary.js";
import { createSempStatusSummaryRouteHandler } from "../sempStatusRouteHandler.js";

let admin: Pool;
let data: Pool;
let own: string;
let foreign: string;
let ownUser: string;
let foreignUser: string;

const catalogs = await loadModuleCatalogs(new URL("../sempStatusReport.js", import.meta.url).href);
const label = (locale: "en" | "cs", key: string) =>
  resolveCatalogLabel(undefined, locale === "cs" ? catalogs.cs : catalogs.en, catalogs.en, key);

async function mailbox(tenant: string): Promise<string> {
  return runInTenant(tenant, async () => {
    const cp = createChokePoint(data);
    const db = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === "mailboxes");
    if (!db) throw new Error("Missing mailboxes database");
    return (await cp.createItem({ databaseId: db.id, properties: { name: "Inbox", provider: "generic" } })).id;
  });
}

async function raise(
  tenant: string,
  userId: string,
  input: {
    category: SempProblemCategory;
    kind: string;
    severity: SempProblemSeverity;
    sourceTable: string;
    sourceId: string;
    dedupeKey: string;
  },
): Promise<string> {
  const result = await runInTenant(tenant, () =>
    withTransaction(data, (client) => raiseProblem(client, { userId, ...input, occurrenceKey: randomUUID() })),
  );
  return result.problemId;
}

const mailProblem = (tenant: string, userId: string, mailboxId: string, severity: SempProblemSeverity) =>
  raise(tenant, userId, {
    category: "mail",
    kind: "mailSyncError",
    severity,
    sourceTable: "mail_account_sync_state",
    sourceId: mailboxId,
    dedupeKey: mailProblemKey(mailboxId),
  });

const agentsProblem = (tenant: string, userId: string) =>
  raise(tenant, userId, {
    category: "agents",
    kind: "processStale",
    severity: "critical",
    sourceTable: "observability_checks",
    sourceId: randomUUID(),
    dedupeKey: AGENTS_PROCESS_PROBLEM_KEY,
  });

describe("Semp status summary (issue #1631)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("summary test role", () =>
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
    ownUser = (
      await createUser(admin, { tenantId: own, email: `${randomUUID()}@example.test`, passwordHash: "x", locale: "en" })
    ).id;
    foreignUser = (
      await createUser(admin, {
        tenantId: foreign,
        email: `${randomUUID()}@example.test`,
        passwordHash: "x",
        locale: "cs",
      })
    ).id;
    for (const tenant of [own, foreign]) await runInTenant(tenant, () => seedSystem(data));
  });

  afterAll(async () => {
    await data.end();
    await admin.end();
  });

  it("answers activeCount 0 and no banner without active problems", async () => {
    expect(await runInTenant(own, () => getSempStatusSummary(data))).toEqual({ activeCount: 0, banner: null });
    expect(await runInTenant(own, () => createSempStatusSummaryRouteHandler(data)())).toEqual({
      status: 200,
      body: { activeCount: 0, banner: null },
    });
  });

  it("makes an active critical mailbox problem the banner with the report's text and its id as instance", async () => {
    const problemId = await mailProblem(own, ownUser, await mailbox(own), "critical");
    const summary = await runInTenant(own, () => getSempStatusSummary(data));
    const report = await runInTenant(own, () => getSempStatusReport(data));
    expect(summary).toEqual({
      activeCount: 1,
      banner: {
        problemId,
        title: "Mailbox is not syncing",
        shortText: "Mail is not syncing.",
        impactKey: "mailNotSyncing",
        instanceId: problemId,
      },
    });
    expect(report.problems[0]).toMatchObject({
      id: problemId,
      title: summary.banner?.title,
      shortText: summary.banner?.shortText,
    });
    expect(report.activeCount).toBe(summary.activeCount);
  });

  it("counts warning-only problems without a banner", async () => {
    await mailProblem(own, ownUser, await mailbox(own), "warning");
    await mailProblem(own, ownUser, await mailbox(own), "warning");
    expect(await runInTenant(own, () => getSempStatusSummary(data))).toEqual({ activeCount: 2, banner: null });
  });

  it("does not make a critical problem of another category the banner", async () => {
    await raise(own, ownUser, {
      category: "backup",
      kind: "backupRestore",
      severity: "critical",
      sourceTable: "observability_checks",
      sourceId: randomUUID(),
      dedupeKey: BACKUP_RESTORE_PROBLEM_KEY,
    });
    expect(await runInTenant(own, () => getSempStatusSummary(data))).toEqual({ activeCount: 1, banner: null });
  });

  it("prefers a critical problem over a later warning, and the latest seen of two critical ones", async () => {
    const critical = await agentsProblem(own, ownUser);
    await mailProblem(own, ownUser, await mailbox(own), "warning");
    const first = await runInTenant(own, () => getSempStatusSummary(data));
    expect(first).toMatchObject({
      activeCount: 2,
      banner: {
        problemId: critical,
        instanceId: critical,
        impactKey: "agentsNotRunning",
        title: "Semp is unavailable",
      },
    });
    const laterCritical = await mailProblem(own, ownUser, await mailbox(own), "critical");
    const second = await runInTenant(own, () => getSempStatusSummary(data));
    expect(second).toMatchObject({ activeCount: 3, banner: { problemId: laterCritical, impactKey: "mailNotSyncing" } });
  });

  it("changes instanceId when the problem is resolved and the failure returns", async () => {
    const mailboxId = await mailbox(own);
    const before = await mailProblem(own, ownUser, mailboxId, "critical");
    expect((await runInTenant(own, () => getSempStatusSummary(data))).banner?.instanceId).toBe(before);
    await runInTenant(own, () =>
      withTransaction(data, (client) =>
        resolveProblem(client, { dedupeKey: mailProblemKey(mailboxId), resolutionKind: "recovered" }),
      ),
    );
    expect(await runInTenant(own, () => getSempStatusSummary(data))).toEqual({ activeCount: 0, banner: null });
    const after = await mailProblem(own, ownUser, mailboxId, "critical");
    const summary = await runInTenant(own, () => getSempStatusSummary(data));
    expect(after).not.toBe(before);
    expect(summary.banner).toMatchObject({ problemId: after, instanceId: after });
  });

  it("renders the banner in the tenant user's locale", async () => {
    await mailProblem(own, ownUser, await mailbox(own), "critical");
    await mailProblem(foreign, foreignUser, await mailbox(foreign), "critical");
    const en = await runInTenant(own, () => getSempStatusSummary(data));
    const cs = await runInTenant(foreign, () => getSempStatusSummary(data));
    expect(en.banner).toMatchObject({
      title: label("en", "status.mailSyncError.title"),
      shortText: label("en", "status.mailSyncError.shortText"),
    });
    expect(cs.banner).toMatchObject({
      title: label("cs", "status.mailSyncError.title"),
      shortText: label("cs", "status.mailSyncError.shortText"),
    });
    expect(cs.banner?.title).not.toBe(en.banner?.title);
  });

  it("is not affected by another tenant's problems", async () => {
    const foreignProblem = await mailProblem(foreign, foreignUser, await mailbox(foreign), "critical");
    await agentsProblem(foreign, foreignUser);
    expect(await runInTenant(own, () => getSempStatusSummary(data))).toEqual({ activeCount: 0, banner: null });
    const ownProblem = await mailProblem(own, ownUser, await mailbox(own), "warning");
    const summary = await runInTenant(own, () => getSempStatusSummary(data));
    expect(summary).toEqual({ activeCount: 1, banner: null });
    expect(JSON.stringify(summary)).not.toContain(foreignProblem);
    expect(ownProblem).toEqual(expect.any(String));
  });
});
