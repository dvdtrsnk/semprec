import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { currentTenantScope, runInTenant } from "@alldots/shared";
import { CORE_TASK_NAMES, enqueueJob, runOnce, type TaskList } from "@alldots/queue";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createDatabase, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { listAllRelationsForItem } from "../chokePoint/relationsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { handleDerivedValuesInvalidateTask } from "../derived/projectDerivedValueInvalidation.js";
import { ensureJournalPeriodDoc } from "../journal/journalStore.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  COMPANIES_MODULE_ID,
  EVENTS_MODULE_ID,
  FILES_MODULE_ID,
  HEALTH_RECORDS_MODULE_ID,
  JOURNAL_MODULE_ID,
  PEOPLE_MODULE_ID,
  PROJECTS_MODULE_ID,
  TASKS_MODULE_ID,
} from "../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createCoreTaskList } from "../worker.js";

/**
 * A change of a project's company edge queues `derivedValuesInvalidate`, which announces the
 * project's Events. Fixtures run on a `alldots_data` pool so RLS applies; announcements are recorded through
 * `setInvalidationHook` with the tenant scope it was called in (not WebSocket delivery).
 */

let admin: Pool;
let pool: Pool;
let chokePoint: ChokePoint;
let fanOutTaskList: TaskList;
let tenantA: string;
let tenantB: string;

function fanOutTaskListOver(handlerPool: Pool): TaskList {
  const handler = createCoreTaskList(handlerPool, createActionRegistry())[CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE];
  if (!handler) throw new Error("createCoreTaskList has no derivedValuesInvalidate handler");
  return { [CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE]: handler };
}

interface Catalog {
  projectsId: string;
  companiesId: string;
  tasksId: string;
  eventsId: string;
  filesId: string;
  healthRecordsId: string;
  journalId: string;
  peopleId: string;
  projectCompany: string;
  companyProjects: string;
  taskProject: string;
  eventProject: string;
  eventCompany: string;
  fileProjects: string;
  healthRecordProjects: string;
  journalProject: string;
  peopleProjects: string;
}

async function requireDatabaseId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await getDatabaseByModuleId(client, moduleId);
  if (!database) throw new Error(`Database '${moduleId}' was not seeded`);
  return database.id;
}

async function requirePropertyId(client: PoolClient, databaseId: string, key: string): Promise<string> {
  const property = await getPropertyByKey(client, databaseId, key);
  if (!property) throw new Error(`Property '${key}' was not seeded`);
  return property.id;
}

async function catalog(tenant: string): Promise<Catalog> {
  return runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const projectsId = await requireDatabaseId(client, PROJECTS_MODULE_ID);
      const companiesId = await requireDatabaseId(client, COMPANIES_MODULE_ID);
      const tasksId = await requireDatabaseId(client, TASKS_MODULE_ID);
      const eventsId = await requireDatabaseId(client, EVENTS_MODULE_ID);
      const filesId = await requireDatabaseId(client, FILES_MODULE_ID);
      const healthRecordsId = await requireDatabaseId(client, HEALTH_RECORDS_MODULE_ID);
      const journalId = await requireDatabaseId(client, JOURNAL_MODULE_ID);
      const peopleId = await requireDatabaseId(client, PEOPLE_MODULE_ID);
      return {
        projectsId,
        companiesId,
        tasksId,
        eventsId,
        filesId,
        healthRecordsId,
        journalId,
        peopleId,
        projectCompany: await requirePropertyId(client, projectsId, "company"),
        companyProjects: await requirePropertyId(client, companiesId, "projects"),
        taskProject: await requirePropertyId(client, tasksId, "project"),
        eventProject: await requirePropertyId(client, eventsId, "project"),
        eventCompany: await requirePropertyId(client, eventsId, "company"),
        fileProjects: await requirePropertyId(client, filesId, "projects"),
        healthRecordProjects: await requirePropertyId(client, healthRecordsId, "projects"),
        journalProject: await requirePropertyId(client, journalId, "project"),
        peopleProjects: await requirePropertyId(client, peopleId, "projects"),
      };
    }),
  );
}

async function createItem(
  tenant: string,
  databaseId: string,
  properties: Record<string, unknown> = { name: "Item" },
): Promise<string> {
  return runInTenant(tenant, async () => (await chokePoint.createItem({ databaseId, properties })).id);
}

async function link(tenant: string, relationPropertyId: string, callerItemId: string, targetItemId: string) {
  await runInTenant(tenant, () => chokePoint.createRelation({ relationPropertyId, callerItemId, targetItemId }));
}

async function setTarget(tenant: string, relationPropertyId: string, callerItemId: string, targetItemId: string) {
  await runInTenant(tenant, () => chokePoint.setRelation({ relationPropertyId, callerItemId, targetItemId }));
}

interface QueuedJob {
  key: string | null;
  queue_name: string | null;
  attempts: number;
  max_attempts: number;
}

async function queuedFanOuts(): Promise<QueuedJob[]> {
  const { rows } = await admin.query<QueuedJob>(
    "SELECT key, queue_name, attempts, max_attempts FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
    [CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE],
  );
  return rows;
}

function fanOutJob(tenant: string, projectId: string): QueuedJob {
  return {
    key: `derived-values-invalidate:${projectId}`,
    queue_name: `derived-values-invalidate:${tenant}`,
    attempts: 0,
    max_attempts: 3,
  };
}

async function discardQueuedJobs(): Promise<void> {
  await admin.query(
    "SELECT graphile_worker.complete_jobs(ARRAY(SELECT id FROM graphile_worker.jobs WHERE locked_at IS NULL))",
  );
}

interface Announcement {
  tenantId: string | null;
  event: InvalidationEvent;
}

/** Drains the fan-outs once and returns what was announced; `onAnnouncement` runs inside the hook, which is removed on every path. */
async function runFanOuts(
  taskList: TaskList = fanOutTaskList,
  onAnnouncement: () => void = () => undefined,
): Promise<Announcement[]> {
  const announcements: Announcement[] = [];
  setInvalidationHook((event) => {
    const scope = currentTenantScope();
    announcements.push({ tenantId: scope?.kind === "tenant" ? scope.tenantId : null, event });
    onAnnouncement();
  });
  try {
    await runOnce({ pgPool: admin, taskList });
  } finally {
    setInvalidationHook(() => {});
  }
  return announcements;
}

async function announcementOf(tenant: string, databaseId: string, itemId: string): Promise<Announcement> {
  const item = await runInTenant(tenant, () => chokePoint.getItem(databaseId, itemId));
  if (!item) throw new Error("item not found");
  return {
    tenantId: tenant,
    event: { scope: "item", databaseId, itemId, op: "update", updatedAt: item.updatedAt },
  };
}

function byItemId(left: Announcement, right: Announcement): number {
  const leftId = "itemId" in left.event ? left.event.itemId : "";
  const rightId = "itemId" in right.event ? right.event.itemId : "";
  return leftId.localeCompare(rightId);
}

function announcedItemIds(announcements: Announcement[]): string[] {
  return announcements.map(({ event }) =>
    event.scope === "item" ? event.itemId : `not an item event: ${event.scope}`,
  );
}

function collapseAnnouncements(steps: string[]): string[] {
  const collapsed: string[] = [];
  let run = 0;
  for (const step of [...steps, "end"]) {
    if (step === "announce") {
      run += 1;
      continue;
    }
    if (run > 0) collapsed.push(`announce x${run}`);
    run = 0;
    if (step !== "end") collapsed.push(step);
  }
  return collapsed;
}

async function createLinkedItems(
  tenant: string,
  databaseId: string,
  relationPropertyId: string,
  projectId: string,
  count: number,
): Promise<string[]> {
  return runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const item = await createItemWithClient(client, {
          databaseId,
          properties: { name: `Item ${index}`, date: "2026-10-16" },
        });
        await createRelationWithClient(client, { relationPropertyId, callerItemId: item.id, targetItemId: projectId });
        ids.push(item.id);
      }
      return ids;
    }),
  );
}

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "alldots_data");
  chokePoint = createChokePoint(pool);
  fanOutTaskList = fanOutTaskListOver(pool);
});

beforeEach(async () => {
  await resetDatabase(admin);
  tenantA = await createTestTenant(admin);
  tenantB = await createTestTenant(admin);
  for (const tenant of [tenantA, tenantB]) {
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
  }
  await discardQueuedJobs();
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("derived value invalidation of a project's items (issue #1710)", () => {
  it("changing a project's company queues one job; its run announces the project's live events, and nothing else", async () => {
    const c = await catalog(tenantA);
    const firstCompany = await createItem(tenantA, c.companiesId);
    const secondCompany = await createItem(tenantA, c.companiesId);
    const project = await createItem(tenantA, c.projectsId);
    const otherProject = await createItem(tenantA, c.projectsId);
    await link(tenantA, c.projectCompany, project, firstCompany);
    await link(tenantA, c.projectCompany, otherProject, firstCompany);

    const event = await createItem(tenantA, c.eventsId, { name: "Event", date: "2026-10-16" });
    await link(tenantA, c.eventProject, event, project);

    // Not owed an announcement: these items derive no value from their project.
    const task = await createItem(tenantA, c.tasksId);
    const file = await createItem(tenantA, c.filesId);
    const healthRecord = await createItem(tenantA, c.healthRecordsId);
    const journalDay = (
      await runInTenant(tenantA, () =>
        withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", "2026-10-16")),
      )
    ).itemId;
    await link(tenantA, c.taskProject, task, project);
    await link(tenantA, c.fileProjects, file, project);
    await link(tenantA, c.healthRecordProjects, healthRecord, project);
    await link(tenantA, c.journalProject, journalDay, project);
    await link(tenantA, c.peopleProjects, await createItem(tenantA, c.peopleId), project);
    const trashedEvent = await createItem(tenantA, c.eventsId, { name: "Trashed", date: "2026-10-16" });
    await link(tenantA, c.eventProject, trashedEvent, project);
    await runInTenant(tenantA, () => chokePoint.softDeleteItem(c.eventsId, trashedEvent));
    const otherEvent = await createItem(tenantA, c.eventsId, { name: "Other", date: "2026-10-16" });
    await link(tenantA, c.eventProject, otherEvent, otherProject);
    await createItem(tenantA, c.eventsId, { name: "Without project", date: "2026-10-16" });
    await discardQueuedJobs();

    await setTarget(tenantA, c.projectCompany, project, secondCompany);
    expect(await queuedFanOuts()).toEqual([fanOutJob(tenantA, project)]);

    const announced = await runFanOuts();
    expect(announced).toEqual([await announcementOf(tenantA, c.eventsId, event)]);
    expect(await queuedFanOuts()).toEqual([]);
  });

  it("a first company, its removal and a link written from the Companies side each queue the project's job; a metadata update and other relations queue none", async () => {
    const c = await catalog(tenantA);
    const company = await createItem(tenantA, c.companiesId);
    const project = await createItem(tenantA, c.projectsId);
    await discardQueuedJobs();

    await link(tenantA, c.projectCompany, project, company);
    expect(await queuedFanOuts()).toEqual([fanOutJob(tenantA, project)]);
    await discardQueuedJobs();

    await runInTenant(tenantA, () =>
      chokePoint.updateRelation({
        relationPropertyId: c.projectCompany,
        callerItemId: project,
        targetItemId: company,
        metadata: { note: "unchanged ends" },
      }),
    );
    expect(await queuedFanOuts()).toEqual([]);

    const removed = await runInTenant(tenantA, () =>
      chokePoint.deleteRelation({ relationPropertyId: c.projectCompany, callerItemId: project, targetItemId: company }),
    );
    expect(removed).not.toBeNull();
    expect(await queuedFanOuts()).toEqual([fanOutJob(tenantA, project)]);
    await discardQueuedJobs();

    // The same definition written through its other property: the caller is the company, the job is the project's.
    await link(tenantA, c.companyProjects, company, project);
    expect(await queuedFanOuts()).toEqual([fanOutJob(tenantA, project)]);
    await discardQueuedJobs();

    // Relations of other databases, one of them also keyed `company`.
    const event = await createItem(tenantA, c.eventsId, { name: "Event", date: "2026-10-16" });
    await link(tenantA, c.eventCompany, event, company);
    await link(tenantA, c.taskProject, await createItem(tenantA, c.tasksId), project);
    expect(await queuedFanOuts()).toEqual([]);
  });

  it("identifies the project when the Projects property is side A of its relation definition", async () => {
    // The seed always makes `Projects.company` property B, so this tenant is built without the seed to get property A.
    const tenant = await createTestTenant(admin);
    const { projectsId, vendorsId } = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const projects = await createDatabase(client, {
          name: "Projects",
          system: true,
          ownerModuleId: PROJECTS_MODULE_ID,
        });
        const vendors = await createDatabase(client, { name: "Vendors" });
        return { projectsId: projects.id, vendorsId: vendors.id };
      }),
    );
    const { property } = await runInTenant(tenant, () =>
      chokePoint.createRelationProperty({
        sourceDatabaseId: projectsId,
        key: "company",
        name: "Company",
        targetDatabaseId: vendorsId,
        cardinality: "many_to_many",
      }),
    );
    const project = await createItem(tenant, projectsId, {});
    const vendor = await createItem(tenant, vendorsId, {});
    await discardQueuedJobs();

    const edge = await runInTenant(tenant, () =>
      chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: project, targetItemId: vendor }),
    );
    expect(edge.itemA).toBe(project);
    expect(await queuedFanOuts()).toEqual([fanOutJob(tenant, project)]);
  });

  it("queues nothing when the edge write rolls back", async () => {
    const c = await catalog(tenantA);
    const company = await createItem(tenantA, c.companiesId);
    const project = await createItem(tenantA, c.projectsId);
    await discardQueuedJobs();

    await expect(
      runInTenant(tenantA, () =>
        withTransaction(pool, async (client) => {
          await createRelationWithClient(client, {
            relationPropertyId: c.projectCompany,
            callerItemId: project,
            targetItemId: company,
          });
          throw new Error("rolled back by the test");
        }),
      ),
    ).rejects.toThrow("rolled back by the test");
    expect(await queuedFanOuts()).toEqual([]);
  });

  it("several changes before the job runs collapse into one job and one fan-out", async () => {
    const c = await catalog(tenantA);
    const companies = [
      await createItem(tenantA, c.companiesId),
      await createItem(tenantA, c.companiesId),
      await createItem(tenantA, c.companiesId),
    ];
    const project = await createItem(tenantA, c.projectsId);
    const task = await createItem(tenantA, c.tasksId);
    const event = await createItem(tenantA, c.eventsId, { name: "Event", date: "2026-10-16" });
    await link(tenantA, c.taskProject, task, project);
    await link(tenantA, c.eventProject, event, project);
    await discardQueuedJobs();

    for (const company of companies) await setTarget(tenantA, c.projectCompany, project, company);
    expect(await queuedFanOuts()).toEqual([fanOutJob(tenantA, project)]);

    // The task derives nothing from its project, so only the event is announced.
    expect(await runFanOuts()).toEqual([await announcementOf(tenantA, c.eventsId, event)]);
    expect(await queuedFanOuts()).toEqual([]);
  });

  it("a project with more items than one batch holds is announced completely, each item once, each batch after its own commit", async () => {
    const c = await catalog(tenantA);
    const company = await createItem(tenantA, c.companiesId);
    const project = await createItem(tenantA, c.projectsId);
    // 230 events against a batch of 100.
    const ids = await createLinkedItems(tenantA, c.eventsId, c.eventProject, project, 230);
    await discardQueuedJobs();
    await link(tenantA, c.projectCompany, project, company);

    // A dedicated, traced pool; vitest numbers all mock calls on one counter, ordering statements and announcements.
    const tracedPool = await createRuntimeRolePool(admin, "alldots_data");
    const querySpies: Array<{ mock: { calls: unknown[][]; invocationCallOrder: number[] }; mockRestore(): void }> = [];
    tracedPool.on("connect", (client) => querySpies.push(vi.spyOn(client, "query")));
    const onAnnouncement = vi.fn<() => void>();
    let announced: Announcement[];
    let steps: Array<{ order: number; step: string }>;
    try {
      announced = await runFanOuts(fanOutTaskListOver(tracedPool), onAnnouncement);
      steps = [
        ...querySpies.flatMap((spy) =>
          spy.mock.calls.flatMap(([text], index) =>
            text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK"
              ? [{ order: spy.mock.invocationCallOrder[index] ?? Number.NaN, step: text }]
              : [],
          ),
        ),
        ...onAnnouncement.mock.invocationCallOrder.map((order) => ({ order, step: "announce" })),
      ].sort((left, right) => left.order - right.order);
    } finally {
      for (const spy of querySpies) spy.mockRestore();
      await tracedPool.end();
    }

    expect(new Set(ids).size).toBe(230);
    expect(announcedItemIds(announced).sort()).toEqual([...ids].sort());
    expect(announced.every((announcement) => announcement.tenantId === tenantA)).toBe(true);
    expect(await queuedFanOuts()).toEqual([]);

    expect(steps.every((step) => Number.isInteger(step.order))).toBe(true);
    // Each batch is one transaction, and its announcements follow that transaction's COMMIT.
    expect(collapseAnnouncements(steps.map((step) => step.step))).toEqual([
      "BEGIN",
      "COMMIT",
      "announce x100",
      "BEGIN",
      "COMMIT",
      "announce x100",
      "BEGIN",
      "COMMIT",
      "announce x30",
    ]);
  });

  it("a batch that fails keeps the earlier batch announced and fails the job; the retry announces every item again", async () => {
    const c = await catalog(tenantA);
    const company = await createItem(tenantA, c.companiesId);
    const project = await createItem(tenantA, c.projectsId);
    // 150 events against a batch of 100: the first batch holds the 100 lowest ids, the second the other 50.
    const ids = (await createLinkedItems(tenantA, c.eventsId, c.eventProject, project, 150)).sort();
    await discardQueuedJobs();
    await link(tenantA, c.projectCompany, project, company);

    // Ended by the first announcement, made only after the first batch committed, so the second batch cannot open.
    const failingPool = await createRuntimeRolePool(admin, "alldots_data");
    let ending: Promise<void> | undefined;
    let firstAttempt: Announcement[];
    try {
      firstAttempt = await runFanOuts(fanOutTaskListOver(failingPool), () => {
        ending ??= failingPool.end();
      });
    } finally {
      await (ending ?? failingPool.end());
    }

    expect(announcedItemIds(firstAttempt)).toEqual(ids.slice(0, 100));
    const failed = await admin.query<{ id: string; attempts: number; last_error: string | null }>(
      "SELECT id::text AS id, attempts, last_error FROM graphile_worker.jobs WHERE task_identifier = $1",
      [CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE],
    );
    expect(failed.rows).toEqual([
      {
        id: expect.any(String),
        attempts: 1,
        last_error: expect.stringContaining("Cannot use a pool after calling end"),
      },
    ]);

    // The retry is due after graphile-worker's backoff; its public `reschedule_jobs` makes it due now.
    const rescheduled = await admin.query("SELECT * FROM graphile_worker.reschedule_jobs($1::bigint[], now())", [
      failed.rows.map((row) => row.id),
    ]);
    expect(rescheduled.rowCount).toBe(1);
    const retry = await runFanOuts();

    expect(announcedItemIds(retry)).toEqual(ids);
    // The first batch's items are announced a second time, with the same event as the first time.
    expect(retry.slice(0, 100)).toEqual(firstAttempt);
    expect(await queuedFanOuts()).toEqual([]);
  });

  it("a project in the Trash announces nothing, though its items are live and still linked to it", async () => {
    const c = await catalog(tenantA);
    const company = await createItem(tenantA, c.companiesId);
    const project = await createItem(tenantA, c.projectsId);
    const event = await createItem(tenantA, c.eventsId, { name: "Event", date: "2026-10-16" });
    await link(tenantA, c.eventProject, event, project);
    await discardQueuedJobs();
    await link(tenantA, c.projectCompany, project, company);
    await runInTenant(tenantA, () => chokePoint.softDeleteItem(c.projectsId, project));

    // Read from the stored edges: the choke point's relation reads leave a trashed target out.
    const edges = await runInTenant(tenantA, () =>
      withTransaction(pool, (client) => listAllRelationsForItem(client, event)),
    );
    expect(edges.map((edge) => [edge.itemA, edge.itemB])).toContainEqual([project, event]);
    expect((await runInTenant(tenantA, () => chokePoint.getItem(c.eventsId, event)))?.deletedAt).toBeNull();
    expect(await queuedFanOuts()).toEqual([fanOutJob(tenantA, project)]);

    expect(await runFanOuts()).toEqual([]);
    expect(await queuedFanOuts()).toEqual([]);
  });

  it("a job naming a project that does not exist announces nothing and completes", async () => {
    const c = await catalog(tenantA);
    const project = await createItem(tenantA, c.projectsId);
    await link(tenantA, c.taskProject, await createItem(tenantA, c.tasksId), project);
    await discardQueuedJobs();

    await runInTenant(tenantA, () =>
      enqueueJob(pool, CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE, { projectItemId: randomUUID() }),
    );
    expect(await queuedFanOuts()).toHaveLength(1);

    expect(await runFanOuts()).toEqual([]);
    expect(await queuedFanOuts()).toEqual([]);
  });

  it("each tenant's job announces only that tenant's items, and a job naming another tenant's project announces nothing", async () => {
    const a = await catalog(tenantA);
    const b = await catalog(tenantB);
    const projectA = await createItem(tenantA, a.projectsId);
    const eventA = await createItem(tenantA, a.eventsId, { name: "Event", date: "2026-10-16" });
    await link(tenantA, a.eventProject, eventA, projectA);
    const projectB = await createItem(tenantB, b.projectsId);
    const eventB = await createItem(tenantB, b.eventsId, { name: "Event", date: "2026-10-16" });
    await link(tenantB, b.eventProject, eventB, projectB);
    await discardQueuedJobs();

    await link(tenantA, a.projectCompany, projectA, await createItem(tenantA, a.companiesId));
    await link(tenantB, b.projectCompany, projectB, await createItem(tenantB, b.companiesId));
    const byKey = (left: QueuedJob, right: QueuedJob) => (left.key ?? "").localeCompare(right.key ?? "");
    expect((await queuedFanOuts()).sort(byKey)).toEqual(
      [fanOutJob(tenantA, projectA), fanOutJob(tenantB, projectB)].sort(byKey),
    );

    const announced = await runFanOuts();
    const owed = [await announcementOf(tenantA, a.eventsId, eventA), await announcementOf(tenantB, b.eventsId, eventB)];
    expect(announced.sort(byItemId)).toEqual(owed.sort(byItemId));
    expect(await queuedFanOuts()).toEqual([]);

    // A's project id inside B is no project of B: the job ends like one naming an id that does not exist.
    await runInTenant(tenantB, () =>
      enqueueJob(pool, CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE, { projectItemId: projectA }),
    );
    expect(await runFanOuts()).toEqual([]);
    expect(await queuedFanOuts()).toEqual([]);
  });

  it.each([
    ["no project id", {}],
    ["a project id that is not a UUID", { projectItemId: "project" }],
    ["an unknown field", { projectItemId: randomUUID(), tenantId: randomUUID() }],
  ])("the handler refuses a payload with %s before announcing anything", async (_what, payload) => {
    const announcements: InvalidationEvent[] = [];
    setInvalidationHook((event) => announcements.push(event));
    try {
      await expect(runInTenant(tenantA, () => handleDerivedValuesInvalidateTask(pool, payload))).rejects.toThrow();
    } finally {
      setInvalidationHook(() => {});
    }
    expect(announcements).toEqual([]);
  });
});
