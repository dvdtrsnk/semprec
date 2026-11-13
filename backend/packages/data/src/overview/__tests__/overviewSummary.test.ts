import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId, listAllDatabases } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { createInboxCardsCountRouteHandler } from "../../inbox/inboxRouteHandlers.js";
import { getOrCreateJournalItem } from "../../journal/journalStore.js";
import { LocalFsBlobStorageWriter } from "../../mail/blobStorage.js";
import { ensureFolderItem } from "../../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../../mail/ingest.js";
import { resolveMailModuleIds } from "../../mail/mailModuleIds.js";
import { createMailSummaryRouteHandler } from "../../mail/mailSummary.js";
import {
  createCollectionMetadataResolver,
  type CollectionMetadataResolver,
} from "../../manifest/collectionMetadata.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { createPendingApprovalRequest } from "../../mcp/approvalRequestsStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { raiseProblem } from "../../semp/sempProblemsStore.js";
import { createSempStatusSummaryRouteHandler } from "../../semp/sempStatusRouteHandler.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../../systemSettings.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createOverviewRouteHandler, overviewSummarySchema } from "../overviewRouteHandler.js";
import { getOverviewSummary, type OverviewSummary } from "../overviewSummary.js";

/** Friday 16 October 2026, 12:00 in Europe/Prague, the zone of a seeded tenant. */
const NOW = new Date("2026-10-16T10:00:00.000Z");
const TODAY = "2026-10-16";
const YESTERDAY = "2026-10-15";
const TOMORROW = "2026-10-17";

interface Tenant {
  id: string;
  userId: string;
}

let admin: Pool;
let runtime: Pool;
let cp: ChokePoint;
let resolver: CollectionMetadataResolver;
let storageRoot: string;
let storage: LocalFsBlobStorageWriter;
let tenant: Tenant;

/** Runs `fn` in one transaction of `owner`, on the runtime role row-level security applies to. */
function inTenant<T>(owner: Tenant, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(owner.id, () => withTransaction(runtime, fn));
}

async function newTenant(): Promise<Tenant> {
  const id = await createTestTenant(admin);
  await runInTenant(id, () => seedSystem(runtime, createViewTypeRegistry()));
  // `users` is a global identity table, written outside the tenant scope as account creation does.
  const user = await createUser(admin, { email: `${randomUUID()}@example.com`, passwordHash: "unused", tenantId: id });
  return { id, userId: user.id };
}

async function databaseId(owner: Tenant, moduleId: string): Promise<string> {
  const database = await inTenant(owner, (client) => getDatabaseByModuleId(client, moduleId));
  if (!database) throw new Error(`No ${moduleId} database in tenant ${owner.id}`);
  return database.id;
}

/** The summary of `owner` for `userId`, read the way the route reads it: inside the tenant, at the fixed clock. */
function summaryOf(owner: Tenant, userId: string = owner.userId): Promise<OverviewSummary> {
  return runInTenant(owner.id, () => getOverviewSummary(runtime, { ownerUserId: userId, now: NOW }));
}

async function createRecord(owner: Tenant, moduleId: string, properties: Record<string, unknown>): Promise<string> {
  const item = await runInTenant(owner.id, async () =>
    cp.createItem({ databaseId: await databaseId(owner, moduleId), properties }),
  );
  return item.id;
}

/** A task dated `date`; with `done` it is completed at the current (faked) instant, as the user's tick does. */
async function task(owner: Tenant, date: string, done = false): Promise<string> {
  const id = await createRecord(owner, "tasks", { name: "Task", date });
  if (done) {
    await runInTenant(owner.id, async () =>
      cp.updateItem({
        databaseId: await databaseId(owner, "tasks"),
        itemId: id,
        propertiesPatch: { status: "done" },
      }),
    );
  }
  return id;
}

/** A project in `areaId` (none when null) with the given stored properties. */
async function project(owner: Tenant, areaId: string | null, properties: Record<string, unknown>): Promise<string> {
  const id = await createRecord(owner, "projects", { name: "Project", ...properties });
  if (areaId !== null) {
    await runInTenant(owner.id, async () => {
      const databaseIdOfProjects = await databaseId(owner, "projects");
      const properties = await cp.listProperties(databaseIdOfProjects);
      const area = properties.find((candidate) => candidate.key === "area");
      if (!area) throw new Error("Projects has no area relation");
      await cp.setRelation({ relationPropertyId: area.id, callerItemId: id, targetItemId: areaId });
    });
  }
  return id;
}

/** A pending approval request of a tick run of `userId`; the Inbox counts it for that user only. */
async function pendingApproval(owner: Tenant, userId: string): Promise<void> {
  await runInTenant(owner.id, async () => {
    const run = await createAgentRun(runtime, { triggeredBy: "heartbeat", task: "overview probe", userId });
    await createPendingApprovalRequest(runtime, {
      agentRunId: run.id,
      toolName: "probe",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
  });
}

/** An open Processing proposals card of kind `inbox`, written as the Inbox pipeline writes one. */
async function proposalCard(owner: Tenant): Promise<void> {
  await inTenant(owner, async (client) => {
    const proposals = await getDatabaseByModuleId(client, "processingProposals");
    if (!proposals) throw new Error("No processingProposals database");
    await createItemWithClient(
      client,
      { databaseId: proposals.id, properties: { kind: "inbox", status: "proposed", proposal: null } },
      { allowedSystemKeys: ["kind", "status", "proposal"] },
    );
  });
}

/** `count` unread messages in the inbox folder of a new mailbox, through the ingest writer. */
async function unreadMessages(owner: Tenant, count: number): Promise<void> {
  await inTenant(owner, async (client) => {
    const ids = await resolveMailModuleIds(client);
    const propertyId = async (databaseIdOfProperty: string, key: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
        [databaseIdOfProperty, key],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error(`property '${key}' is not seeded`);
      return id;
    };
    const mailbox = await createItemWithClient(client, {
      databaseId: ids.mailboxesDatabaseId,
      properties: { name: "Personal", provider: "generic" },
    });
    const folder = await ensureFolderItem(client, {
      foldersDatabaseId: ids.foldersDatabaseId,
      mailboxItemId: mailbox.id,
      mailboxRelationPropertyId: await propertyId(ids.foldersDatabaseId, "mailbox"),
      providerId: "inbox",
      name: "inbox",
      behavior: "folder",
      specialPurpose: "inbox",
    });
    for (let n = 0; n < count; n += 1) {
      await ingestEmailMessage(client, {
        emailsDatabaseId: ids.emailsDatabaseId,
        filesDatabaseId: ids.filesDatabaseId,
        folderRelationPropertyId: await propertyId(ids.emailsDatabaseId, "folder"),
        attachmentsRelationPropertyId: await propertyId(ids.emailsDatabaseId, "attachments"),
        folderItemId: folder,
        mailboxItemId: mailbox.id,
        messageId: `<overview-${randomUUID()}@example.test>`,
        inReplyTo: null,
        references: [],
        subject: "Overview probe",
        envelope: {
          from: { name: "Sender", address: "sender@example.test" },
          to: [{ name: "Me", address: "me@example.test" }],
        },
        bodyText: "body",
        flags: [],
        attachments: [],
        storage,
        storageKeyPrefix: "overview-summary",
      });
    }
  });
}

/** Stores a time zone in the tenant's System settings, the way the user's edit of that setting does. */
async function setZone(owner: Tenant, timezone: string): Promise<void> {
  await runInTenant(owner.id, async () => {
    const settingsDatabaseId = await withTransaction(runtime, (client) => getSystemSettingsDatabaseId(client));
    const itemId = await withTransaction(runtime, (client) => getSystemSettingsItemId(client));
    await cp.updateItem({ databaseId: settingsDatabaseId, itemId, propertiesPatch: { timezone } });
  });
}

/** The open tasks of the Today view of `owner`, as the view lists them, and the whole list. */
async function todayList(owner: Tenant): Promise<{ all: string[]; open: string[] }> {
  const tasksId = await databaseId(owner, "tasks");
  const views = await runInTenant(owner.id, () => cp.listViewsByDatabase(tasksId));
  const view = views.find((candidate) => candidate.config.systemKey === "today");
  if (!view) throw new Error("The Today view is missing");
  const page = await runInTenant(owner.id, () => cp.queryView(view.id));
  return {
    all: page.items.map((item) => item.id),
    open: page.items.filter((item) => item.properties.status === "notDone").map((item) => item.id),
  };
}

/** The filter `item.count` runs for the active projects: user projects whose status is `inProgress` or `longTerm`. */
const ACTIVE_PROJECTS = {
  type: "and",
  nodes: [
    { type: "is_empty", property: "systemActive" },
    { type: "in", property: "status", value: ["inProgress", "longTerm"] },
  ],
};

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  const role = await runAsSystem("verify overview summary test role", () =>
    runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    ),
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  cp = createChokePoint(runtime);
  resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
  storageRoot = await mkdtemp(join(tmpdir(), "semprec-overview-summary-"));
  storage = new LocalFsBlobStorageWriter(storageRoot);
}, 120_000);

beforeEach(async () => {
  await resetDatabase(admin);
  tenant = await newTenant();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await resetDatabase(admin);
  await runtime?.end();
  await admin?.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe("getOverviewSummary (issue gh-1837)", () => {
  it("equals what the owners' routes answer on the same data", async () => {
    await proposalCard(tenant);
    await proposalCard(tenant);
    await pendingApproval(tenant, tenant.userId);
    await unreadMessages(tenant, 2);
    await task(tenant, TODAY);
    await task(tenant, YESTERDAY);
    await task(tenant, TOMORROW);
    await inTenant(tenant, (client) =>
      raiseProblem(client, {
        userId: tenant.userId,
        category: "mail",
        kind: "mailSyncError",
        severity: "critical",
        sourceTable: "items",
        sourceId: randomUUID(),
        dedupeKey: "overview-problem",
      }),
    );

    const summary = await summaryOf(tenant);

    const inbox = (userId: string) =>
      runInTenant(tenant.id, () => createInboxCardsCountRouteHandler(runtime)({ identity: { user: { id: userId } } }));
    const ownInbox = await inbox(tenant.userId);
    expect(ownInbox).toEqual({ status: 200, body: { total: 3 } });
    expect(summary.inboxPending).toBe(3);

    const mail = await runInTenant(tenant.id, () => createMailSummaryRouteHandler(runtime)());
    expect(mail.body.unreadInbox).toBe(2);
    expect(summary.mailUnread).toBe(mail.body.unreadInbox);

    const semp = await runInTenant(tenant.id, () => createSempStatusSummaryRouteHandler(runtime)());
    // The stored mail problem and the missing AI budget of a fresh tenant.
    expect(semp.body.activeCount).toBe(2);
    expect(summary.problemCount).toBe(semp.body.activeCount);

    // The task of today and the overdue one are open in the Today list; the task of tomorrow is not in it.
    expect(summary.tasksToday).toBe(2);
    expect((await todayList(tenant)).open).toHaveLength(summary.tasksToday);
  });

  it("counts only the open tasks of the Today list: 7 open and 1 completed today give 7", async () => {
    for (let n = 0; n < 5; n += 1) await task(tenant, TODAY);
    for (let n = 0; n < 2; n += 1) await task(tenant, YESTERDAY);
    const completed = await task(tenant, TODAY, true);

    const list = await todayList(tenant);

    expect(list.all).toHaveLength(8);
    expect(list.all).toContain(completed);
    expect(list.open).toHaveLength(7);
    expect((await summaryOf(tenant)).tasksToday).toBe(7);
  });

  it("counts the approvals of the user it is given and not of another user", async () => {
    await pendingApproval(tenant, tenant.userId);

    expect((await summaryOf(tenant, tenant.userId)).inboxPending).toBe(1);
    expect((await summaryOf(tenant, randomUUID())).inboxPending).toBe(0);
  });

  it("lists one entry per client-visible system database, each counted like item.count with its collection filter", async () => {
    const area = await createRecord(tenant, "areas", { name: "Area" });
    await project(tenant, area, { status: "inProgress" });
    await project(tenant, area, { status: "done" });
    // A system project stores `systemActive`; a collection leaves it out. Raw write: no API stores that key for a user.
    const system = await project(tenant, null, { status: "inProgress" });
    await admin.query("UPDATE items SET properties = properties || '{\"systemActive\": true}'::jsonb WHERE id = $1", [
      system,
    ]);
    const userDatabase = await runInTenant(tenant.id, () => cp.createDatabase({ name: "Mine" }));

    const { collections } = await summaryOf(tenant);

    const databases = await inTenant(tenant, (client) => listAllDatabases(client));
    const expected = databases.filter(
      (database) => database.ownerModuleId !== null && resolver.resolve(database).clientVisible,
    );
    expect(collections.map((collection) => collection.databaseId).sort()).toEqual(
      expected.map((database) => database.id).sort(),
    );
    for (const database of expected) {
      const [counted] = await runInTenant(tenant.id, () =>
        cp.countItemsBatch([{ databaseId: database.id, collection: true }], { resolver, now: NOW }),
      );
      expect(collections.find((collection) => collection.databaseId === database.id)).toEqual({
        databaseId: database.id,
        ownerModuleId: database.ownerModuleId,
        itemCount: counted?.count,
      });
    }
    const projects = collections.find((collection) => collection.ownerModuleId === "projects");
    // Two user projects; the system project is not counted.
    expect(projects?.itemCount).toBe(2);
    expect(collections.map((collection) => collection.databaseId)).not.toContain(userDatabase.id);
    // A system database that no client lists is not a collection.
    const excluded = databases.filter(
      (database) => database.ownerModuleId !== null && !resolver.resolve(database).clientVisible,
    );
    expect(excluded.length).toBeGreaterThan(0);
    const listed = collections.map((collection) => collection.databaseId);
    expect(excluded.filter((database) => listed.includes(database.id))).toEqual([]);
  });

  it("lists each area with its active projects only, and leaves out an area without one", async () => {
    const [first, second, third] = [
      await createRecord(tenant, "areas", { name: "First" }),
      await createRecord(tenant, "areas", { name: "Second" }),
      await createRecord(tenant, "areas", { name: "Third" }),
    ];
    await project(tenant, first, { status: "inProgress" });
    await project(tenant, first, { status: "longTerm" });
    await project(tenant, first, { status: "done" });
    await project(tenant, second, { status: "inProgress" });
    await project(tenant, second, { status: "archived" });
    await project(tenant, third, { status: "done" });
    await project(tenant, null, { status: "inProgress" });
    const system = await project(tenant, second, { status: "inProgress" });
    await admin.query("UPDATE items SET properties = properties || '{\"systemActive\": true}'::jsonb WHERE id = $1", [
      system,
    ]);

    const { areas } = await summaryOf(tenant);

    // The grouped item.count with the same filter, read by the choke point on its own.
    const [counted] = await runInTenant(tenant.id, async () =>
      cp.countItemsBatch(
        [{ databaseId: await databaseId(tenant, "projects"), filter: ACTIVE_PROJECTS, groupBy: "area" }],
        { resolver, now: NOW },
      ),
    );
    const expected = (counted?.groups ?? []).flatMap((group) =>
      group.key === null ? [] : [{ id: group.key, activeProjectCount: group.count }],
    );
    expect(areas).toEqual(expected);
    expect([...areas].sort((left, right) => (left.id < right.id ? -1 : 1))).toEqual(
      [
        { id: first, activeProjectCount: 2 },
        { id: second, activeProjectCount: 1 },
      ].sort((left, right) => (left.id < right.id ? -1 : 1)),
    );
    expect(areas.map((area) => area.id)).not.toContain(third);
  });

  it("answers no areas and zero counts for a tenant that has no rows of its own", async () => {
    const summary = await summaryOf(tenant);

    expect(summary).toMatchObject({
      inboxPending: 0,
      mailUnread: 0,
      tasksToday: 0,
      areas: [],
      journalTodayItemId: null,
    });
    expect(summary.collections.every((collection) => Number.isInteger(collection.itemCount))).toBe(true);
  });

  describe("journalTodayItemId", () => {
    const journalItem = (owner: Tenant, type: "day" | "week", reference: Date, timezone: string) =>
      inTenant(owner, async (client) => {
        const journal = await getDatabaseByModuleId(client, "journal");
        if (!journal) throw new Error("Journal not seeded");
        return getOrCreateJournalItem(client, journal.id, type, reference, timezone);
      });

    it("is null while today's day item does not exist, and does not create it", async () => {
      await journalItem(tenant, "day", new Date("2026-10-15T10:00:00Z"), "Europe/Prague");
      await journalItem(tenant, "week", NOW, "Europe/Prague");
      const countJournal = async (): Promise<number> => {
        const { rows } = await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM items WHERE tenant_id = $1 AND database_id = $2",
          [tenant.id, await databaseId(tenant, "journal")],
        );
        return rows[0]?.n ?? -1;
      };
      const before = await countJournal();

      expect((await summaryOf(tenant)).journalTodayItemId).toBeNull();
      expect(await countJournal()).toBe(before);
    });

    it("is the id of today's live day item", async () => {
      const today = await journalItem(tenant, "day", NOW, "Europe/Prague");
      await journalItem(tenant, "day", new Date("2026-10-15T10:00:00Z"), "Europe/Prague");

      expect((await summaryOf(tenant)).journalTodayItemId).toBe(today.id);
    });

    it("does not return a trashed day item", async () => {
      const today = await journalItem(tenant, "day", NOW, "Europe/Prague");
      const databaseIdOfJournal = await databaseId(tenant, "journal");
      const trashed = await runInTenant(tenant.id, () => cp.softDeleteItem(databaseIdOfJournal, today.id));
      expect(trashed?.deletedAt).not.toBeNull();

      expect((await summaryOf(tenant)).journalTodayItemId).toBeNull();
    });

    it("uses today's date in the tenant time zone near midnight", async () => {
      await setZone(tenant, "America/New_York");
      // 23:30 on 12 November in New York is already 13 November in UTC.
      const instant = new Date("2026-11-13T04:30:00Z");
      const newYorkDay = await journalItem(tenant, "day", instant, "America/New_York");
      const utcDay = await journalItem(tenant, "day", instant, "UTC");
      expect(newYorkDay.properties.period).toBe("2026-11-12");
      expect(utcDay.properties.period).toBe("2026-11-13");

      const summary = await runInTenant(tenant.id, () =>
        getOverviewSummary(runtime, { ownerUserId: tenant.userId, now: instant }),
      );

      expect(summary.journalTodayItemId).toBe(newYorkDay.id);
    });
  });

  it("throws without a tenant scope and in a system scope, and reads nothing", async () => {
    const message = "getOverviewSummary requires an active tenant scope";

    await expect(getOverviewSummary(runtime, { ownerUserId: tenant.userId, now: NOW })).rejects.toThrow(message);
    await expect(
      runAsSystem("overview summary test", () => getOverviewSummary(runtime, { ownerUserId: tenant.userId, now: NOW })),
    ).rejects.toThrow(message);
  });

  it.each([
    ["journal", "The Journal database is missing"],
    ["projects", "The Projects database is missing"],
  ])("fails for a tenant whose %s database is missing, not with an empty overview", async (moduleId, message) => {
    // A state the seed never leaves: the database loses its owning module, so no module lookup finds it.
    await admin.query("UPDATE databases SET owner_module_id = NULL WHERE tenant_id = $1 AND owner_module_id = $2", [
      tenant.id,
      moduleId,
    ]);

    await expect(summaryOf(tenant)).rejects.toThrow(message);
  });

  it("shows nothing of another tenant in any field", async () => {
    const foreign = await newTenant();
    const foreignArea = await createRecord(foreign, "areas", { name: "Foreign area" });
    await project(foreign, foreignArea, { status: "inProgress" });
    await task(foreign, TODAY);
    await task(foreign, TODAY);
    await proposalCard(foreign);
    await pendingApproval(foreign, foreign.userId);
    await unreadMessages(foreign, 3);
    const foreignDay = await inTenant(foreign, async (client) => {
      const journal = await getDatabaseByModuleId(client, "journal");
      if (!journal) throw new Error("Journal not seeded");
      return getOrCreateJournalItem(client, journal.id, "day", NOW, "Europe/Prague");
    });
    await inTenant(foreign, (client) =>
      raiseProblem(client, {
        userId: foreign.userId,
        category: "mail",
        kind: "mailSyncError",
        severity: "critical",
        sourceTable: "items",
        sourceId: randomUUID(),
        dedupeKey: "overview-foreign-problem",
      }),
    );

    // The other tenant sees its own rows, so they exist and are countable.
    const ofForeign = await summaryOf(foreign);
    expect(ofForeign).toMatchObject({
      inboxPending: 2,
      mailUnread: 3,
      tasksToday: 2,
      problemCount: 2,
      journalTodayItemId: foreignDay.id,
      areas: [{ id: foreignArea, activeProjectCount: 1 }],
    });

    const own = await summaryOf(tenant);
    expect(own).toMatchObject({
      inboxPending: 0,
      mailUnread: 0,
      tasksToday: 0,
      // The missing AI budget of a fresh tenant; the other tenant's stored problem is not counted.
      problemCount: 1,
      areas: [],
      journalTodayItemId: null,
    });
    const foreignDatabaseIds = ofForeign.collections.map((collection) => collection.databaseId);
    expect(
      own.collections.map((collection) => collection.databaseId).filter((id) => foreignDatabaseIds.includes(id)),
    ).toEqual([]);
    expect(own.collections.length).toBe(ofForeign.collections.length);
  });
});

describe("createOverviewRouteHandler (issue gh-1837)", () => {
  it("answers 200 with the summary of the session user, in the shape the schema declares", async () => {
    await proposalCard(tenant);
    await pendingApproval(tenant, tenant.userId);
    await task(tenant, TODAY);

    const answer = await runInTenant(tenant.id, () =>
      createOverviewRouteHandler(runtime)({ identity: { user: { id: tenant.userId } } }),
    );

    expect(answer.status).toBe(200);
    const body = overviewSummarySchema.parse(answer.body);
    expect(body.inboxPending).toBe(2);
    expect(body.tasksToday).toBe(1);
    expect(Object.keys(body).sort()).toEqual([
      "areas",
      "collections",
      "inboxPending",
      "journalTodayItemId",
      "mailUnread",
      "problemCount",
      "tasksToday",
    ]);
  });

  it("counts the approvals of the session user and not of another user", async () => {
    await pendingApproval(tenant, tenant.userId);
    const stranger = randomUUID();

    const handler = createOverviewRouteHandler(runtime);
    const own = await runInTenant(tenant.id, () => handler({ identity: { user: { id: tenant.userId } } }));
    const other = await runInTenant(tenant.id, () => handler({ identity: { user: { id: stranger } } }));

    expect(overviewSummarySchema.parse(own.body).inboxPending).toBe(1);
    expect(overviewSummarySchema.parse(other.body).inboxPending).toBe(0);
  });

  it("rejects a body with a field the schema does not declare, a negative count and a malformed id", async () => {
    const valid: OverviewSummary = {
      inboxPending: 0,
      mailUnread: 0,
      tasksToday: 0,
      areas: [{ id: randomUUID(), activeProjectCount: 1 }],
      collections: [{ databaseId: randomUUID(), ownerModuleId: "tasks", itemCount: 0 }],
      problemCount: 0,
      journalTodayItemId: randomUUID(),
    };
    expect(overviewSummarySchema.safeParse(valid).success).toBe(true);
    expect(overviewSummarySchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(overviewSummarySchema.safeParse({ ...valid, mailUnread: -1 }).success).toBe(false);
    expect(overviewSummarySchema.safeParse({ ...valid, journalTodayItemId: "today" }).success).toBe(false);
    expect(overviewSummarySchema.safeParse({ ...valid, areas: [{ id: "x", activeProjectCount: 1 }] }).success).toBe(
      false,
    );
  });
});
