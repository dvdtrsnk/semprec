import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { currentTenantScope, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, enqueueJob, runOnce, type TaskList } from "@semprec/queue";
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
  AREAS_MODULE_ID,
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
 * Issue #1710: a change of a project's area or company edge queues `derivedValuesInvalidate`, which
 * announces the project's items. Fixtures are written through the choke point and the writers it is built
 * from, on a `semprec_data` pool, so row-level security applies; the job runs through the production
 * `createCoreTaskList` handler drained with `runOnce`. Announcements are recorded through
 * `setInvalidationHook`, the in-process hook `@semprec/realtime` publishes as NOTIFYs, together with the
 * tenant scope the hook was called in; that shows what the job announced and for which tenant, not WebSocket
 * delivery.
 */

let admin: Pool;
let pool: Pool;
let chokePoint: ChokePoint;
let fanOutTaskList: TaskList;
let tenantA: string;
let tenantB: string;

/** The one fan-out handler of `createCoreTaskList` over `handlerPool`, so a drain runs nothing else. */
function fanOutTaskListOver(handlerPool: Pool): TaskList {
  const handler = createCoreTaskList(handlerPool, createActionRegistry())[CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE];
  if (!handler) throw new Error("createCoreTaskList has no derivedValuesInvalidate handler");
  return { [CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE]: handler };
}

interface Catalog {
  areasId: string;
  projectsId: string;
  companiesId: string;
  tasksId: string;
  eventsId: string;
  filesId: string;
  healthRecordsId: string;
  journalId: string;
  peopleId: string;
  projectArea: string;
  projectCompany: string;
  areaProjects: string;
  taskProject: string;
  eventProject: string;
  eventCompany: string;
  fileProjects: string;
  fileArea: string;
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
      const areasId = await requireDatabaseId(client, AREAS_MODULE_ID);
      const projectsId = await requireDatabaseId(client, PROJECTS_MODULE_ID);
      const companiesId = await requireDatabaseId(client, COMPANIES_MODULE_ID);
      const tasksId = await requireDatabaseId(client, TASKS_MODULE_ID);
      const eventsId = await requireDatabaseId(client, EVENTS_MODULE_ID);
      const filesId = await requireDatabaseId(client, FILES_MODULE_ID);
      const healthRecordsId = await requireDatabaseId(client, HEALTH_RECORDS_MODULE_ID);
      const journalId = await requireDatabaseId(client, JOURNAL_MODULE_ID);
      const peopleId = await requireDatabaseId(client, PEOPLE_MODULE_ID);
      return {
        areasId,
        projectsId,
        companiesId,
        tasksId,
        eventsId,
        filesId,
        healthRecordsId,
        journalId,
        peopleId,
        projectArea: await requirePropertyId(client, projectsId, "area"),
        projectCompany: await requirePropertyId(client, projectsId, "company"),
        areaProjects: await requirePropertyId(client, areasId, "projects"),
        taskProject: await requirePropertyId(client, tasksId, "project"),
        eventProject: await requirePropertyId(client, eventsId, "project"),
        eventCompany: await requirePropertyId(client, eventsId, "company"),
        fileProjects: await requirePropertyId(client, filesId, "projects"),
        fileArea: await requirePropertyId(client, filesId, "area"),
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

/** Replaces the single target of `callerItemId` on a single-valued relation, as a client changing it does. */
async function setTarget(tenant: string, relationPropertyId: string, callerItemId: string, targetItemId: string) {
  await runInTenant(tenant, () => chokePoint.setRelation({ relationPropertyId, callerItemId, targetItemId }));
}

interface QueuedJob {
  key: string | null;
  queue_name: string | null;
  attempts: number;
  max_attempts: number;
}

/** The queued `derivedValuesInvalidate` jobs, read through graphile-worker's public `jobs` view. */
async function queuedFanOuts(): Promise<QueuedJob[]> {
  const { rows } = await admin.query<QueuedJob>(
    "SELECT key, queue_name, attempts, max_attempts FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
    [CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE],
  );
  return rows;
}

/** The job the hook queues for `projectId` in `tenant`, before any attempt. */
function fanOutJob(tenant: string, projectId: string): QueuedJob {
  return {
    key: `derived-values-invalidate:${projectId}`,
    queue_name: `derived-values-invalidate:${tenant}`,
    attempts: 0,
    max_attempts: 3,
  };
}

/** Completes every queued job without running it, through graphile-worker's public `complete_jobs`. */
async function discardQueuedJobs(): Promise<void> {
  await admin.query(
    "SELECT graphile_worker.complete_jobs(ARRAY(SELECT id FROM graphile_worker.jobs WHERE locked_at IS NULL))",
  );
}

interface Announcement {
  /** The tenant scope the invalidation hook was called in; `null` outside a tenant scope. */
  tenantId: string | null;
  event: InvalidationEvent;
}

/**
 * Drains the queued fan-outs once with `taskList` and returns what was announced meanwhile. `onAnnouncement`
 * runs inside the hook, after the announcement was recorded. The hook is removed on every path.
 */
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

/** The announcement the job owes a live item: its thin `item` update with the `updatedAt` the choke point reads. */
async function announcementOf(tenant: string, databaseId: string, itemId: string): Promise<Announcement> {
  const item = await runInTenant(tenant, () => chokePoint.getItem(databaseId, itemId));
  if (!item) throw new Error("item not found");
  return {
    tenantId: tenant,
    event: { scope: "item", databaseId, itemId, op: "update", updatedAt: item.updatedAt },
  };
}

function byItemId(left: Announcement, right: Announcement): number {
  const leftId = left.event.scope === "schema" ? "" : left.event.itemId;
  const rightId = right.event.scope === "schema" ? "" : right.event.itemId;
  return leftId.localeCompare(rightId);
}

function announcedItemIds(announcements: Announcement[]): string[] {
  return announcements.map(({ event }) =>
    event.scope === "item" ? event.itemId : `not an item event: ${event.scope}`,
  );
}

/** `steps` with every run of consecutive `announce` entries replaced by one `announce x<length>` entry. */
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

/** `count` items of `databaseId`, each linked to `projectId` through `relationPropertyId`, written in one transaction. */
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
        const item = await createItemWithClient(client, { databaseId, properties: { name: `Item ${index}` } });
        await createRelationWithClient(client, { relationPropertyId, callerItemId: item.id, targetItemId: projectId });
        ids.push(item.id);
      }
      return ids;
    }),
  );
}

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
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
  it("changing a project's area queues one job; its run announces the project's live tasks, events, files, health records and journal entries, and nothing else", async () => {
    const c = await catalog(tenantA);
    const firstArea = await createItem(tenantA, c.areasId);
    const secondArea = await createItem(tenantA, c.areasId);
    const project = await createItem(tenantA, c.projectsId);
    const otherProject = await createItem(tenantA, c.projectsId);
    await link(tenantA, c.projectArea, project, firstArea);
    await link(tenantA, c.projectArea, otherProject, firstArea);

    const task = await createItem(tenantA, c.tasksId);
    const event = await createItem(tenantA, c.eventsId, { name: "Event", date: "2026-10-16" });
    const file = await createItem(tenantA, c.filesId);
    const healthRecord = await createItem(tenantA, c.healthRecordsId);
    const journalDay = (
      await runInTenant(tenantA, () =>
        withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", "2026-10-16")),
      )
    ).itemId;
    await link(tenantA, c.taskProject, task, project);
    await link(tenantA, c.eventProject, event, project);
    await link(tenantA, c.fileProjects, file, project);
    await link(tenantA, c.healthRecordProjects, healthRecord, project);
    await link(tenantA, c.journalProject, journalDay, project);

    // Not owed an announcement: a trashed task of the project, a task of another project, a task without a
    // project, and a person of the project (People is not a database that derives a value from its project).
    const trashedTask = await createItem(tenantA, c.tasksId);
    await link(tenantA, c.taskProject, trashedTask, project);
    await runInTenant(tenantA, () => chokePoint.softDeleteItem(c.tasksId, trashedTask));
    await link(tenantA, c.taskProject, await createItem(tenantA, c.tasksId), otherProject);
    await createItem(tenantA, c.tasksId);
    await link(tenantA, c.peopleProjects, await createItem(tenantA, c.peopleId), project);
    await discardQueuedJobs();

    await setTarget(tenantA, c.projectArea, project, secondArea);
    expect(await queuedFanOuts()).toEqual([fanOutJob(tenantA, project)]);

    const announced = await runFanOuts();
    const owed = [
      await announcementOf(tenantA, c.tasksId, task),
      await announcementOf(tenantA, c.eventsId, event),
      await announcementOf(tenantA, c.filesId, file),
      await announcementOf(tenantA, c.healthRecordsId, healthRecord),
      await announcementOf(tenantA, c.journalId, journalDay),
    ];
    expect(announced.sort(byItemId)).toEqual(owed.sort(byItemId));
    expect(await queuedFanOuts()).toEqual([]);
  });

  it("a first area, its removal and a link written from the Areas side each queue the project's job; a metadata update and other relations queue none", async () => {
    const c = await catalog(tenantA);
    const area = await createItem(tenantA, c.areasId);
    const project = await createItem(tenantA, c.projectsId);
    await discardQueuedJobs();

    await link(tenantA, c.projectArea, project, area);
    expect(await queuedFanOuts()).toEqual([fanOutJob(tenantA, project)]);
    await discardQueuedJobs();

    await runInTenant(tenantA, () =>
      chokePoint.updateRelation({
        relationPropertyId: c.projectArea,
        callerItemId: project,
        targetItemId: area,
        metadata: { note: "unchanged ends" },
      }),
    );
    expect(await queuedFanOuts()).toEqual([]);

    const removed = await runInTenant(tenantA, () =>
      chokePoint.deleteRelation({ relationPropertyId: c.projectArea, callerItemId: project, targetItemId: area }),
    );
    expect(removed).not.toBeNull();
    expect(await queuedFanOuts()).toEqual([fanOutJob(tenantA, project)]);
    await discardQueuedJobs();

    // The same definition written through its other property: the caller is the area, the job is the project's.
    await link(tenantA, c.areaProjects, area, project);
    expect(await queuedFanOuts()).toEqual([fanOutJob(tenantA, project)]);
    await discardQueuedJobs();

    // Relations of other databases, two of them also keyed `area` and `company`.
    const company = await createItem(tenantA, c.companiesId);
    const event = await createItem(tenantA, c.eventsId, { name: "Event", date: "2026-10-16" });
    const file = await createItem(tenantA, c.filesId);
    await link(tenantA, c.eventCompany, event, company);
    await link(tenantA, c.fileArea, file, area);
    await link(tenantA, c.taskProject, await createItem(tenantA, c.tasksId), project);
    expect(await queuedFanOuts()).toEqual([]);
  });

  it("identifies the project when the Projects property is side A of its relation definition", async () => {
    // A tenant whose `Projects.company` is property A of its definition. The seed always makes it property B
    // (the inverse of `Companies.projects`), so this tenant is built without the seed, from a bare system
    // Projects database and a relation property created from the Projects side.
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
    const area = await createItem(tenantA, c.areasId);
    const project = await createItem(tenantA, c.projectsId);
    await discardQueuedJobs();

    await expect(
      runInTenant(tenantA, () =>
        withTransaction(pool, async (client) => {
          await createRelationWithClient(client, {
            relationPropertyId: c.projectArea,
            callerItemId: project,
            targetItemId: area,
          });
          throw new Error("rolled back by the test");
        }),
      ),
    ).rejects.toThrow("rolled back by the test");
    expect(await queuedFanOuts()).toEqual([]);
  });

  it("changing a project's company queues the job; its run announces the project's events and its other items", async () => {
    const c = await catalog(tenantA);
    const firstCompany = await createItem(tenantA, c.companiesId);
    const secondCompany = await createItem(tenantA, c.companiesId);
    const project = await createItem(tenantA, c.projectsId);
    await link(tenantA, c.projectCompany, project, firstCompany);
    const event = await createItem(tenantA, c.eventsId, { name: "Event", date: "2026-10-16" });
    const task = await createItem(tenantA, c.tasksId);
    await link(tenantA, c.eventProject, event, project);
    await link(tenantA, c.taskProject, task, project);
    await discardQueuedJobs();

    await setTarget(tenantA, c.projectCompany, project, secondCompany);
    expect(await queuedFanOuts()).toEqual([fanOutJob(tenantA, project)]);

    const announced = await runFanOuts();
    const owed = [await announcementOf(tenantA, c.eventsId, event), await announcementOf(tenantA, c.tasksId, task)];
    expect(announced.sort(byItemId)).toEqual(owed.sort(byItemId));
  });

  it("several changes before the job runs collapse into one job and one fan-out", async () => {
    const c = await catalog(tenantA);
    const areas = [await createItem(tenantA, c.areasId), await createItem(tenantA, c.areasId)];
    const company = await createItem(tenantA, c.companiesId);
    const project = await createItem(tenantA, c.projectsId);
    const task = await createItem(tenantA, c.tasksId);
    const event = await createItem(tenantA, c.eventsId, { name: "Event", date: "2026-10-16" });
    await link(tenantA, c.taskProject, task, project);
    await link(tenantA, c.eventProject, event, project);
    await discardQueuedJobs();

    for (const area of areas) await setTarget(tenantA, c.projectArea, project, area);
    await setTarget(tenantA, c.projectCompany, project, company);
    expect(await queuedFanOuts()).toEqual([fanOutJob(tenantA, project)]);

    const announced = await runFanOuts();
    const owed = [await announcementOf(tenantA, c.tasksId, task), await announcementOf(tenantA, c.eventsId, event)];
    expect(announced.sort(byItemId)).toEqual(owed.sort(byItemId));
    expect(await queuedFanOuts()).toEqual([]);
  });

  it("a project with more items than one batch holds is announced completely, each item once, each batch after its own commit", async () => {
    const c = await catalog(tenantA);
    const area = await createItem(tenantA, c.areasId);
    const project = await createItem(tenantA, c.projectsId);
    // 230 items against a batch of 100: three batches, the last one short. Tasks are side B and Files side A of
    // their project relations; their ids are random, so the two kinds interleave in id order.
    const ids = [
      ...(await createLinkedItems(tenantA, c.tasksId, c.taskProject, project, 130)),
      ...(await createLinkedItems(tenantA, c.filesId, c.fileProjects, project, 100)),
    ];
    await discardQueuedJobs();
    await link(tenantA, c.projectArea, project, area);

    // A dedicated pool for the handler, so the statements its connections are asked to run can be recorded
    // without touching a connection another test will use. Vitest numbers the calls of every mock on one
    // counter, which orders the handler's transaction statements and the announcements among each other.
    const tracedPool = await createRuntimeRolePool(admin, "semprec_data");
    const querySpies: Array<{ mock: { calls: unknown[][]; invocationCallOrder: number[] }; mockRestore(): void }> = [];
    tracedPool.on("connect", (client) => querySpies.push(vi.spyOn(client, "query")));
    const onAnnouncement = vi.fn<() => void>();
    let announced: Announcement[];
    let steps: Array<{ order: number; step: string }>;
    try {
      announced = await runFanOuts(fanOutTaskListOver(tracedPool), onAnnouncement);
      // Read before the spies are restored, which also clears what they recorded.
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
    const area = await createItem(tenantA, c.areasId);
    const project = await createItem(tenantA, c.projectsId);
    // 150 items against a batch of 100: the first batch holds the 100 lowest ids, the second the other 50.
    const ids = (await createLinkedItems(tenantA, c.tasksId, c.taskProject, project, 150)).sort();
    await discardQueuedJobs();
    await link(tenantA, c.projectArea, project, area);

    // A dedicated pool for the failing attempt, ended by the first announcement, which the handler makes only
    // after the first batch committed: the second batch then cannot open its transaction.
    const failingPool = await createRuntimeRolePool(admin, "semprec_data");
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
    const area = await createItem(tenantA, c.areasId);
    const project = await createItem(tenantA, c.projectsId);
    const task = await createItem(tenantA, c.tasksId);
    await link(tenantA, c.taskProject, task, project);
    await discardQueuedJobs();
    await link(tenantA, c.projectArea, project, area);
    await runInTenant(tenantA, () => chokePoint.softDeleteItem(c.projectsId, project));

    // Read from the stored edges: the choke point's relation reads leave a trashed target out.
    const edges = await runInTenant(tenantA, () =>
      withTransaction(pool, (client) => listAllRelationsForItem(client, task)),
    );
    expect(edges.map((edge) => [edge.itemA, edge.itemB])).toEqual([[project, task]]);
    expect((await runInTenant(tenantA, () => chokePoint.getItem(c.tasksId, task)))?.deletedAt).toBeNull();
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
    const taskA = await createItem(tenantA, a.tasksId);
    await link(tenantA, a.taskProject, taskA, projectA);
    const projectB = await createItem(tenantB, b.projectsId);
    const taskB = await createItem(tenantB, b.tasksId);
    await link(tenantB, b.taskProject, taskB, projectB);
    await discardQueuedJobs();

    await link(tenantA, a.projectArea, projectA, await createItem(tenantA, a.areasId));
    await link(tenantB, b.projectArea, projectB, await createItem(tenantB, b.areasId));
    const byKey = (left: QueuedJob, right: QueuedJob) => (left.key ?? "").localeCompare(right.key ?? "");
    expect((await queuedFanOuts()).sort(byKey)).toEqual(
      [fanOutJob(tenantA, projectA), fanOutJob(tenantB, projectB)].sort(byKey),
    );

    const announced = await runFanOuts();
    const owed = [await announcementOf(tenantA, a.tasksId, taskA), await announcementOf(tenantB, b.tasksId, taskB)];
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
