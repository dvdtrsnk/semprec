import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAreaOverviewRouteHandler } from "../areas/areaOverviewRouteHandler.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, NotFoundError, ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../systemSettings.js";
import type { TaskRecurrenceRule } from "../tasks/taskRecurrenceRule.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  startTaskSeries,
  withTenantTransaction,
} from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;

const USER = { writerKind: "user" } as const;

/** 11:00 on Thursday 12 November 2026 in Europe/Prague, the zone of a seeded tenant. */
const NOW = new Date("2026-11-12T10:00:00Z");
const YESTERDAY = "2026-11-11";
const TODAY = "2026-11-12";
const TOMORROW = "2026-11-13";
/** The 14th day counting `TODAY`, and the day after it. */
const LAST_DAY = "2026-11-25";
const DAY_AFTER = "2026-11-26";

const entrySchema = z
  .object({
    kind: z.enum(["task", "event"]),
    itemId: z.string(),
    title: z.string(),
    date: z.string(),
    timeFrom: z.string().nullable(),
    timeTo: z.string().nullable(),
    status: z.string().nullable(),
    recurrence: z
      .object({ mode: z.string(), rule: z.record(z.string(), z.unknown()) })
      .strict()
      .nullable(),
    project: z.object({ id: z.string(), title: z.string(), color: z.string().nullable() }).strict(),
  })
  .strict();

const overviewSchema = z
  .object({
    activeProjectCount: z.number(),
    todayTaskCount: z.number(),
    openTaskCount: z.number(),
    upcomingEventCount: z.number(),
    upcoming: z.array(entrySchema),
  })
  .strict();

type Overview = z.infer<typeof overviewSchema>;

async function newTenant(): Promise<string> {
  const tenantId = await createTestTenant(admin);
  await runInTenant(tenantId, () => seedSystem(runtime));
  return tenantId;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to be rejected");
}

/** What the REST adapter answers a `ChokePointError` with: its status, code, message and details. */
function refusalOf(error: unknown): { status: number; code: string; message: string; details: unknown } {
  if (!(error instanceof ChokePointError)) throw error;
  return { status: error.status, code: error.code, message: error.message, details: error.details };
}

const ids = (overview: Overview): string[] => overview.upcoming.map((entry) => entry.itemId);

/** One tenant's fixture writes and overview reads, each in that tenant's scope on the runtime-role pool. */
function world(tenantId: string) {
  const chokePoint = createChokePoint(runtime);
  const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenantId, fn);

  async function databaseId(moduleId: string): Promise<string> {
    const database = await inTenant(() =>
      withTransaction(runtime, (client) => databasesStore.getDatabaseByModuleId(client, moduleId)),
    );
    if (!database) throw new Error(`No ${moduleId} database`);
    return database.id;
  }

  /**
   * Creates an item as the user, or with `asSystem` under the system writer kind, as a module writes its own
   * rows: a task with status `missed` can only be written that way.
   */
  async function create(moduleId: string, properties: Record<string, unknown>, asSystem = false): Promise<string> {
    const id = await databaseId(moduleId);
    const item = await inTenant(() =>
      chokePoint.createItem({ databaseId: id, properties }, undefined, undefined, asSystem ? undefined : USER),
    );
    return item.id;
  }

  async function trash(moduleId: string, itemId: string): Promise<void> {
    const id = await databaseId(moduleId);
    const trashed = await inTenant(() => chokePoint.softDeleteItem(id, itemId));
    expect(trashed?.deletedAt).not.toBeNull();
  }

  async function propertyId(moduleId: string, key: string): Promise<string> {
    const id = await databaseId(moduleId);
    const property = (await inTenant(() => chokePoint.listProperties(id))).find((entry) => entry.key === key);
    if (!property) throw new Error(`No ${moduleId}.${key}`);
    return property.id;
  }

  /** Sets the single-valued relation `key` of an item, as the user's edit of that field does. */
  async function setRelation(moduleId: string, key: string, itemId: string, targetItemId: string): Promise<void> {
    const relationPropertyId = await propertyId(moduleId, key);
    await inTenant(() => chokePoint.setRelation({ relationPropertyId, callerItemId: itemId, targetItemId }, USER));
  }

  const area = (name: string): Promise<string> => create("areas", { name });

  async function project(areaId: string | null, properties: Record<string, unknown>, asSystem = false) {
    const id = await create("projects", properties, asSystem);
    if (areaId !== null) await setRelation("projects", "area", id, areaId);
    return id;
  }

  async function task(projectId: string | null, properties: Record<string, unknown>, asSystem = false) {
    const id = await create("tasks", properties, asSystem);
    if (projectId !== null) await setRelation("tasks", "project", id, projectId);
    return id;
  }

  async function event(projectId: string | null, properties: Record<string, unknown>): Promise<string> {
    const id = await create("events", properties);
    if (projectId !== null) await setRelation("events", "project", id, projectId);
    return id;
  }

  /**
   * Overwrites stored properties with values the write rules refuse or no longer produce, so raw SQL is the
   * only way to store them. Runs on the admin pool inside the tenant.
   */
  async function storeRaw(moduleId: string, itemId: string, patch: Record<string, unknown>): Promise<void> {
    const id = await databaseId(moduleId);
    await withTenantTransaction(admin, tenantId, async (client) => {
      const result = await client.query(
        "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = $2",
        [id, itemId, JSON.stringify(patch)],
      );
      expect(result.rowCount).toBe(1);
    });
  }

  async function setZone(timezone: string): Promise<void> {
    await inTenant(async () => {
      const settingsDatabaseId = await withTransaction(runtime, (client) => getSystemSettingsDatabaseId(client));
      const itemId = await withTransaction(runtime, (client) => getSystemSettingsItemId(client));
      await chokePoint.updateItem({ databaseId: settingsDatabaseId, itemId, propertiesPatch: { timezone } });
    });
  }

  /** The handler's raw answer for `id`, as a caller whose `users.locale` is `locale` gets it. */
  const request = (id: string, locale = "cs"): Promise<{ status: number; body: unknown }> =>
    inTenant(() => createAreaOverviewRouteHandler(runtime)({ params: { id }, identity: { user: { locale } } }));

  /** The overview of an area, checked to be a 200 that carries exactly the documented fields. */
  async function overview(id: string, locale = "cs"): Promise<Overview> {
    const result = await request(id, locale);
    expect(result.status).toBe(200);
    return overviewSchema.parse(JSON.parse(JSON.stringify(result.body)));
  }

  return {
    tenantId,
    inTenant,
    databaseId,
    trash,
    setRelation,
    area,
    project,
    task,
    event,
    storeRaw,
    setZone,
    request,
    overview,
  };
}

/** Resolves once a statement waits for a lock on `item_relations`; throws after about ten seconds without one. */
async function waitForQueuedRelationsLock(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await admin.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_locks l
        WHERE l.relation = 'public.item_relations'::regclass AND NOT l.granted
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    if ((rows[0]?.waiting ?? 0) >= 1) return;
    await delay(50);
  }
  throw new Error("No statement queued for a lock on item_relations");
}

describe("GET /api/areas/:id/overview (issue #1760)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify area overview role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("counts the open tasks and those due today or earlier, and lists the upcoming ones by date and time with their project's color", async () => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const red = await w.project(area, { name: "Red", color: "#FF3B30" });
    const plain = await w.project(area, { name: "Plain", status: "longTerm" });
    const overdue = await w.task(red, { name: "Overdue", date: "2026-11-10" });
    const todayTimed = await w.task(plain, { name: "Today", date: TODAY, timeFrom: "09:00", timeTo: "09:30" });
    const tomorrowTimed = await w.task(plain, { name: "Tomorrow at two", date: TOMORROW, timeFrom: "14:00" });
    const tomorrowUntimed = await w.task(red, { name: "Tomorrow", date: TOMORROW });
    const nextWeek = await w.task(red, { name: "Next week", date: "2026-11-20" });
    const beyond = await w.task(plain, { name: "Beyond the horizon", date: DAY_AFTER });
    const undated = await w.task(red, { name: "Some day" });
    const todayEvent = await w.event(plain, { name: "Lunch", date: TODAY, timeFrom: "12:00", timeTo: "13:00" });
    const tomorrowEvent = await w.event(red, { name: "Review", date: TOMORROW, timeFrom: "10:00" });
    const openTasks = [overdue, todayTimed, tomorrowTimed, tomorrowUntimed, nextWeek, beyond, undated];

    const overview = await w.overview(area);

    expect(overview.openTaskCount).toBe(openTasks.length);
    expect(overview.openTaskCount).toBe(7);
    expect(overview.todayTaskCount).toBe([overdue, todayTimed].length);
    expect(overview.todayTaskCount).toBe(2);
    expect(overview.upcomingEventCount).toBe([todayEvent, tomorrowEvent].length);
    expect(overview.activeProjectCount).toBe([red, plain].length);
    const redProject = { id: red, title: "Red", color: "#FF3B30" };
    const plainProject = { id: plain, title: "Plain", color: null };
    const taskEntry = { kind: "task", status: "notDone", recurrence: null, timeFrom: null, timeTo: null };
    const eventEntry = { kind: "event", status: null, recurrence: null };
    expect(overview.upcoming).toEqual([
      { ...taskEntry, itemId: overdue, title: "Overdue", date: "2026-11-10", project: redProject },
      {
        ...taskEntry,
        itemId: todayTimed,
        title: "Today",
        date: TODAY,
        timeFrom: "09:00",
        timeTo: "09:30",
        project: plainProject,
      },
      {
        ...eventEntry,
        itemId: todayEvent,
        title: "Lunch",
        date: TODAY,
        timeFrom: "12:00",
        timeTo: "13:00",
        project: plainProject,
      },
      { ...taskEntry, itemId: tomorrowUntimed, title: "Tomorrow", date: TOMORROW, project: redProject },
      {
        ...eventEntry,
        itemId: tomorrowEvent,
        title: "Review",
        date: TOMORROW,
        timeFrom: "10:00",
        // An Event of one day with a start and no end gets an end one hour later from the Events time rules.
        timeTo: "11:00",
        project: redProject,
      },
      {
        ...taskEntry,
        itemId: tomorrowTimed,
        title: "Tomorrow at two",
        date: TOMORROW,
        timeFrom: "14:00",
        project: plainProject,
      },
      { ...taskEntry, itemId: nextWeek, title: "Next week", date: "2026-11-20", project: redProject },
    ]);
  });

  it("counts and lists the open task of a done project, and nothing of an archived project", async () => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const done = await w.project(area, { name: "Done", status: "done" });
    const archived = await w.project(area, { name: "Archived", status: "archived" });
    const doneTask = await w.task(done, { name: "Left over", date: TOMORROW });
    const doneEvent = await w.event(done, { name: "Wrap-up", date: TOMORROW });
    const archivedTask = await w.task(archived, { name: "Shelved", date: TOMORROW });
    const archivedEvent = await w.event(archived, { name: "Shelved meeting", date: TOMORROW });

    const overview = await w.overview(area);

    expect(overview.openTaskCount).toBe(1);
    expect(overview.upcomingEventCount).toBe(1);
    expect(ids(overview)).toEqual([doneTask, doneEvent]);
    expect(ids(overview)).not.toContain(archivedTask);
    expect(ids(overview)).not.toContain(archivedEvent);
    expect(overview.activeProjectCount).toBe(0);
  });

  it("counts inProgress and longTerm projects as active, and no done, archived, trashed or system project and no project of another area", async () => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const other = await w.area("Home");
    const empty = await w.area("Empty");
    await w.project(area, { name: "In progress", status: "inProgress" });
    await w.project(area, { name: "Long term", status: "longTerm" });
    await w.project(area, { name: "Done", status: "done" });
    await w.project(area, { name: "Archived", status: "archived" });
    const trashed = await w.project(area, { name: "Trashed", status: "inProgress" });
    await w.trash("projects", trashed);
    await w.project(area, { name: "System", status: "inProgress", systemActive: true }, true);
    await w.project(area, { name: "Deactivated system", status: "inProgress", systemActive: false }, true);
    await w.project(other, { name: "Elsewhere", status: "inProgress" });
    await w.project(null, { name: "Nowhere", status: "inProgress" });

    expect((await w.overview(area)).activeProjectCount).toBe(2);
    expect((await w.overview(other)).activeProjectCount).toBe(1);
    expect((await w.overview(empty)).activeProjectCount).toBe(0);
  });

  it("leaves out the tasks and events of a system project, active or deactivated", async () => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const own = await w.project(area, { name: "Own" });
    const system = await w.project(area, { name: "System", systemActive: true }, true);
    const deactivated = await w.project(area, { name: "Deactivated system", systemActive: false }, true);
    const ownTask = await w.task(own, { name: "Mine", date: TOMORROW });
    for (const systemProject of [system, deactivated]) {
      await w.task(systemProject, { name: "System task", date: TOMORROW });
      await w.event(systemProject, { name: "System event", date: TOMORROW });
    }

    const overview = await w.overview(area);

    expect(overview).toMatchObject({ openTaskCount: 1, todayTaskCount: 0, upcomingEventCount: 0 });
    expect(ids(overview)).toEqual([ownTask]);
  });

  it("no longer lists or counts a task and an event after they move to a project of another area", async () => {
    const w = world(await newTenant());
    const work = await w.area("Work");
    const home = await w.area("Home");
    const workProject = await w.project(work, { name: "Work project" });
    const homeProject = await w.project(home, { name: "Home project" });
    const task = await w.task(workProject, { name: "Movable", date: YESTERDAY });
    const event = await w.event(workProject, { name: "Movable meeting", date: TOMORROW });

    const before = await w.overview(work);
    expect(before).toMatchObject({ openTaskCount: 1, todayTaskCount: 1, upcomingEventCount: 1 });
    expect(ids(before)).toEqual([task, event]);
    expect(ids(await w.overview(home))).toEqual([]);

    await w.setRelation("tasks", "project", task, homeProject);
    await w.setRelation("events", "project", event, homeProject);

    const after = await w.overview(work);
    expect(after).toMatchObject({ openTaskCount: 0, todayTaskCount: 0, upcomingEventCount: 0, upcoming: [] });
    const moved = await w.overview(home);
    expect(moved).toMatchObject({ openTaskCount: 1, todayTaskCount: 1, upcomingEventCount: 1 });
    expect(moved.upcoming.map((entry) => [entry.itemId, entry.project.id])).toEqual([
      [task, homeProject],
      [event, homeProject],
    ]);
  });

  it("lists an overdue open task, and no wontDo, done or missed task and no task or event without a project", async () => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const project = await w.project(area, { name: "Project" });
    const overdue = await w.task(project, { name: "Overdue", date: "2026-10-01" });
    await w.task(project, { name: "Dropped", date: YESTERDAY, status: "wontDo" });
    await w.task(project, { name: "Finished", date: YESTERDAY, status: "done" });
    await w.task(project, { name: "Missed", date: YESTERDAY, status: "missed" }, true);
    await w.task(null, { name: "Loose", date: YESTERDAY });
    // An Event of the area itself, without a project: the area's `events` relation is not what the overview reads.
    const loose = await w.event(null, { name: "Loose meeting", date: TOMORROW });
    await w.setRelation("events", "area", loose, area);

    const overview = await w.overview(area);

    expect(overview).toMatchObject({ openTaskCount: 1, todayTaskCount: 1, upcomingEventCount: 0 });
    expect(overview.upcoming.map((entry) => [entry.itemId, entry.status])).toEqual([[overdue, "notDone"]]);
  });

  it("takes today and now from the tenant's time zone: 00:30 on 13 November in Europe/Prague is 23:30 on the 12th in UTC", async () => {
    const w = world(await newTenant());
    vi.setSystemTime(new Date("2026-11-12T23:30:00Z"));
    const area = await w.area("Work");
    const project = await w.project(area, { name: "Project" });
    const localToday = await w.task(project, { name: "Due on the 13th", date: "2026-11-13" });
    // The 14th day counting 13 November; counting from the UTC date it would be one day past the horizon.
    const localLastDay = await w.task(project, { name: "Due on the 26th", date: "2026-11-26" });
    const started = await w.event(project, { name: "Started at 00:15", date: "2026-11-13", timeFrom: "00:15" });
    const ahead = await w.event(project, { name: "Starts at 00:45", date: "2026-11-13", timeFrom: "00:45" });

    const prague = await w.overview(area);
    expect(prague).toMatchObject({ todayTaskCount: 1, openTaskCount: 2, upcomingEventCount: 1 });
    expect(ids(prague)).toEqual([localToday, ahead, localLastDay]);

    // The same instant is 18:30 on 12 November in New York: the 13th is tomorrow and the 26th is past the horizon.
    await w.setZone("America/New_York");
    const newYork = await w.overview(area);
    expect(newYork).toMatchObject({ todayTaskCount: 0, openTaskCount: 2, upcomingEventCount: 2 });
    expect(ids(newYork)).toEqual([localToday, started, ahead]);
  });

  it("lists the events that start from now to the end of the 14th day, an all-day event from 00:00 of its day", async () => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const project = await w.project(area, { name: "Project" });
    await w.event(project, { name: "Yesterday", date: YESTERDAY, timeFrom: "18:00" });
    await w.event(project, { name: "Started a minute ago", date: TODAY, timeFrom: "10:59" });
    await w.event(project, { name: "All day today", date: TODAY });
    const startsNow = await w.event(project, { name: "Starts this minute", date: TODAY, timeFrom: "11:00" });
    const allDayTomorrow = await w.event(project, { name: "All day tomorrow", date: TOMORROW });
    const lastEvening = await w.event(project, { name: "Last evening", date: LAST_DAY, timeFrom: "23:00" });
    await w.event(project, { name: "A day too late", date: DAY_AFTER });

    const overview = await w.overview(area);

    expect(overview.upcomingEventCount).toBe(3);
    expect(overview.upcoming.map((entry) => [entry.itemId, entry.kind, entry.status])).toEqual([
      [startsNow, "event", null],
      [allDayTomorrow, "event", null],
      [lastEvening, "event", null],
    ]);
  });

  it("lists a task dated on the 14th day and counts, without listing it, one dated the day after", async () => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const project = await w.project(area, { name: "Project" });
    const lastDay = await w.task(project, { name: "Last day", date: LAST_DAY });
    await w.task(project, { name: "Day after", date: DAY_AFTER });

    const overview = await w.overview(area);

    expect(overview).toMatchObject({ openTaskCount: 2, todayTaskCount: 0 });
    expect(ids(overview)).toEqual([lastDay]);
  });

  it("cuts the list to its first 20 entries and still counts every open task and every upcoming event", async () => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const project = await w.project(area, { name: "Project" });
    const overdue: string[] = [];
    for (let day = 1; day <= 21; day += 1) {
      overdue.push(await w.task(project, { name: `Task ${day}`, date: `2026-10-${String(day).padStart(2, "0")}` }));
    }
    await w.event(project, { name: "First meeting", date: TOMORROW, timeFrom: "09:00" });
    await w.event(project, { name: "Second meeting", date: TOMORROW, timeFrom: "10:00" });

    const overview = await w.overview(area);

    expect(overview).toMatchObject({ openTaskCount: 21, todayTaskCount: 21, upcomingEventCount: 2 });
    expect(ids(overview)).toEqual(overdue.slice(0, 20));
  });

  it("orders the entries of one day by time with the untimed ones first, then by title in the caller's language, then by id", async () => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const project = await w.project(area, { name: "Project" });
    const titles = ["Dort", "Čaj", "Cibule"];
    const untimed = new Map<string, string>();
    for (const title of titles) untimed.set(title, await w.task(project, { name: title, date: TOMORROW }));
    // Entries that agree in day, time and title. The read puts tasks before events, so events are created until
    // one has an id below the task's: the id then decides against the order the entries were read in.
    const twinTask = await w.task(project, { name: "Stejný", date: TOMORROW });
    const twinEvents: string[] = [];
    while (!twinEvents.some((id) => id < twinTask)) {
      if (twinEvents.length === 16) throw new Error("No event got an id below the task's in 16 tries");
      twinEvents.push(await w.event(project, { name: "Stejný", date: TOMORROW }));
    }
    const twins = [twinTask, ...twinEvents].sort();
    const morningEvent = await w.event(project, { name: "Zítra ráno", date: TOMORROW, timeFrom: "08:00" });
    const morningTask = await w.task(project, { name: "Až potom", date: TOMORROW, timeFrom: "09:00" });
    const earlier = await w.task(project, { name: "Žádný čas", date: TODAY });

    const expected = (locale: string): string[] => {
      const collator = new Intl.Collator(locale);
      const byTitle = [...titles].sort((a, b) => collator.compare(a, b)).map((title) => untimed.get(title));
      return [earlier, ...byTitle, ...twins, morningEvent, morningTask].flatMap((id) => (id === undefined ? [] : [id]));
    };
    // The two languages order "Čaj" and "Cibule" differently, so the order shows which collation was used.
    expect(expected("cs")).not.toEqual(expected("en"));

    expect(ids(await w.overview(area, "cs"))).toEqual(expected("cs"));
    expect(ids(await w.overview(area, "en"))).toEqual(expected("en"));
    // A locale that is not Czech is read in English.
    expect(ids(await w.overview(area, "de"))).toEqual(expected("en"));
  });

  it("gives a task the mode and rule of its active series, and null once the series is off and for a task without one", async () => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const project = await w.project(area, { name: "Project" });
    const tasksDatabaseId = await w.databaseId("tasks");
    const recurring = await w.task(project, { name: "Weekly", date: "2026-11-16" });
    const stopped = await w.task(project, { name: "Stopped", date: "2026-11-17" });
    const single = await w.task(project, { name: "Single", date: "2026-11-18" });
    const rule: TaskRecurrenceRule = { kind: "weekdays", days: ["mon"] };
    await w.inTenant(() =>
      startTaskSeries(runtime, { databaseId: tasksDatabaseId, itemId: recurring, mode: "fixed", rule }),
    );
    await w.inTenant(() =>
      startTaskSeries(runtime, {
        databaseId: tasksDatabaseId,
        itemId: stopped,
        mode: "floating",
        rule: { unit: "days", n: 3 },
        active: false,
      }),
    );

    const overview = await w.overview(area);

    expect(overview.upcoming.map((entry) => [entry.itemId, entry.recurrence])).toEqual([
      [recurring, { mode: "fixed", rule }],
      [stopped, null],
      [single, null],
    ]);
  });

  it("never returns a task, an event or a project that is in the trash", async () => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const kept = await w.project(area, { name: "Kept" });
    const trashedProject = await w.project(area, { name: "Trashed project" });
    const keptTask = await w.task(kept, { name: "Kept task", date: TOMORROW });
    const trashedTask = await w.task(kept, { name: "Trashed task", date: TOMORROW });
    const trashedEvent = await w.event(kept, { name: "Trashed event", date: TOMORROW });
    const orphanTask = await w.task(trashedProject, { name: "Task of the trashed project", date: TOMORROW });
    const orphanEvent = await w.event(trashedProject, { name: "Event of the trashed project", date: TOMORROW });
    expect(ids(await w.overview(area)).sort()).toEqual(
      [keptTask, trashedTask, trashedEvent, orphanTask, orphanEvent].sort(),
    );

    await w.trash("tasks", trashedTask);
    await w.trash("events", trashedEvent);
    await w.trash("projects", trashedProject);

    const overview = await w.overview(area);
    expect(overview).toMatchObject({
      activeProjectCount: 1,
      openTaskCount: 1,
      todayTaskCount: 0,
      upcomingEventCount: 0,
    });
    expect(ids(overview)).toEqual([keptTask]);
    expect(JSON.stringify(overview)).not.toContain(trashedProject);
  });

  it("gives no place to an item whose stored date is not a calendar date, reads an unreadable time as none and a missing name as an empty title", async () => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const project = await w.project(area, { name: "Project" });
    const legacyEvent = await w.event(project, { name: "Legacy date-time", date: TOMORROW });
    const legacyTask = await w.task(project, { name: "Legacy date-time", date: YESTERDAY });
    const brokenTimes = await w.task(project, {
      name: "Broken times",
      date: TOMORROW,
      timeFrom: "10:00",
      timeTo: "11:00",
    });
    const unnamed = await w.event(project, { name: "Unnamed", date: TOMORROW, timeFrom: "15:00" });
    // An Event `date` with a time, as it was stored before the Events time rules, and the same shape on a task.
    await w.storeRaw("events", legacyEvent, { date: `${TOMORROW}T09:00:00+01:00` });
    await w.storeRaw("tasks", legacyTask, { date: `${YESTERDAY}T09:00:00+01:00` });
    await w.storeRaw("tasks", brokenTimes, { timeFrom: "noon", timeTo: "late" });
    await w.storeRaw("events", unnamed, { name: null });
    await w.storeRaw("projects", project, { name: null });

    const overview = await w.overview(area);

    expect(overview).toMatchObject({ openTaskCount: 2, todayTaskCount: 0, upcomingEventCount: 1 });
    expect(overview.upcoming.map((entry) => [entry.itemId, entry.title, entry.timeFrom, entry.timeTo])).toEqual([
      [brokenTimes, "Broken times", null, null],
      [unnamed, "", "15:00", "16:00"],
    ]);
    expect(overview.upcoming.map((entry) => entry.project)).toEqual([
      { id: project, title: "", color: null },
      { id: project, title: "", color: null },
    ]);
  });

  it("answers an id written in upper case like the same id in lower case", async () => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const project = await w.project(area, { name: "Project" });
    await w.task(project, { name: "Task", date: TOMORROW });

    const lower = await w.overview(area);
    expect(lower).toMatchObject({ activeProjectCount: 1, openTaskCount: 1 });
    expect(await w.overview(area.toUpperCase())).toEqual(lower);
  });

  it("refuses an id that is not a UUID with validation_failed on id", async () => {
    const w = world(await newTenant());

    const error = await rejectionOf(w.request("not-a-uuid"));

    expect(error).toBeInstanceOf(ValidationError);
    expect(refusalOf(error)).toEqual({
      status: 400,
      code: "validation_failed",
      message: "'id' must be a UUID string",
      details: { field: "id" },
    });
  });

  it("answers the same not_found for an unknown id, a project's id, an area in the trash and another tenant's area", async () => {
    const w = world(await newTenant());
    const foreign = world(await newTenant());
    const area = await w.area("Work");
    const project = await w.project(area, { name: "Project" });
    const trashedArea = await w.area("Trashed");
    await w.trash("areas", trashedArea);
    const foreignArea = await foreign.area("Foreign");
    const foreignProject = await foreign.project(foreignArea, { name: "Foreign project" });
    const foreignTask = await foreign.task(foreignProject, { name: "Foreign task", date: YESTERDAY });

    // The foreign area is a live area with a task for its own tenant, so the refusal below is not an empty fixture.
    expect(ids(await foreign.overview(foreignArea))).toEqual([foreignTask]);
    const refusals: ReturnType<typeof refusalOf>[] = [];
    for (const id of [randomUUID(), project, trashedArea, foreignArea]) {
      const error = await rejectionOf(w.request(id));
      expect(error).toBeInstanceOf(NotFoundError);
      refusals.push(refusalOf(error));
    }

    const notFound = { status: 404, code: "not_found", message: "Area not found", details: undefined };
    expect(refusals).toEqual([notFound, notFound, notFound, notFound]);
  });

  it("answers not_found in a tenant that has no Areas database", async () => {
    const unseeded = world(await createTestTenant(admin));

    const error = await rejectionOf(unseeded.request(randomUUID()));

    expect(error).toBeInstanceOf(NotFoundError);
    expect(refusalOf(error)).toMatchObject({ status: 404, code: "not_found", message: "Area not found" });
  });

  it("reads only the caller's tenant: each of two tenants gets its own projects, tasks and events and none of the other's", async () => {
    const a = world(await newTenant());
    const b = world(await newTenant());
    const seed = async (w: ReturnType<typeof world>) => {
      const area = await w.area("Work");
      const project = await w.project(area, { name: "Project", color: "#007AFF" });
      const task = await w.task(project, { name: "Task", date: YESTERDAY });
      const event = await w.event(project, { name: "Event", date: TOMORROW });
      return { area, project, task, event };
    };
    const [ofA, ofB] = [await seed(a), await seed(b)];

    for (const [w, own, other] of [
      [a, ofA, ofB],
      [b, ofB, ofA],
    ] as const) {
      const overview = await w.overview(own.area);
      expect(overview).toMatchObject({
        activeProjectCount: 1,
        openTaskCount: 1,
        todayTaskCount: 1,
        upcomingEventCount: 1,
      });
      expect(overview.upcoming.map((entry) => [entry.itemId, entry.project.id])).toEqual([
        [own.task, own.project],
        [own.event, own.project],
      ]);
      const text = JSON.stringify(overview);
      expect(Object.values(other).filter((id) => text.includes(id))).toEqual([]);
    }
  });

  it.each([
    ["the Projects database is missing", "database", "The Projects database is missing"],
    ["its area relation cannot be resolved", "area", "The Projects relation 'area' has no resolvable definition"],
    ["its tasks relation cannot be resolved", "tasks", "The Projects relation 'tasks' has no resolvable definition"],
    ["its events relation cannot be resolved", "events", "The Projects relation 'events' has no resolvable definition"],
  ] as const)("fails with an error that is no client error when %s", async (_case, broken, message) => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const projectsDatabaseId = await w.databaseId("projects");
    // A schema the seed never leaves behind and no write can produce: the system schema is locked.
    await withTenantTransaction(admin, w.tenantId, async (client) => {
      const result =
        broken === "database"
          ? await client.query("UPDATE databases SET owner_module_id = $2 WHERE id = $1", [
              projectsDatabaseId,
              "projectsRenamed",
            ])
          : await client.query(
              "UPDATE properties SET config = config - 'targetDatabaseId' WHERE database_id = $1 AND key = $2",
              [projectsDatabaseId, broken],
            );
      expect(result.rowCount).toBe(1);
    });

    const error = await rejectionOf(w.request(area));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChokePointError);
    expect(error).toHaveProperty("message", message);
  });

  it("answers from the state at its start when a write commits while it waits between two of its statements", async () => {
    const w = world(await newTenant());
    const area = await w.area("Work");
    const project = await w.project(area, { name: "Project" });
    const task = await w.task(project, { name: "Task", date: YESTERDAY });
    const projectsDatabaseId = await w.databaseId("projects");
    const before = { activeProjectCount: 1, openTaskCount: 1, todayTaskCount: 1 };
    expect(await w.overview(area)).toMatchObject(before);

    let lockTaken: () => void = () => {};
    let letWriterWrite: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const readerQueued = new Promise<void>((resolve) => {
      letWriterWrite = resolve;
    });
    // The writer holds `item_relations` so the read, which has read the area and the schema by then, waits at
    // its first statement on that table; the writer then archives the project and commits.
    const writer = w
      .inTenant(() =>
        withTransaction(runtime, async (client) => {
          await client.query("LOCK TABLE item_relations IN ACCESS EXCLUSIVE MODE");
          lockTaken();
          await readerQueued;
          await updateItemWithClient(
            client,
            { databaseId: projectsDatabaseId, itemId: project, propertiesPatch: { status: "archived" } },
            { writer: USER },
          );
        }),
      )
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    // Either the writer holds the lock, or it failed before it took it and the failure is reported below.
    await Promise.race([locked, writer]);
    const reader = w.request(area).then(
      (value) => ({ value }),
      (failure: unknown) => ({ failure }),
    );
    const waitFailure = await waitForQueuedRelationsLock().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    letWriterWrite();
    const [writeFailure, read] = [await writer, await reader];
    const failures = [waitFailure, writeFailure, "failure" in read ? read.failure : undefined].filter(
      (failure) => failure !== undefined,
    );
    if (!("value" in read) || failures.length > 0) {
      throw new AggregateError(failures, "The overlapped read and write did not both finish");
    }

    const old = overviewSchema.parse(JSON.parse(JSON.stringify(read.value.body)));
    expect(old).toMatchObject(before);
    expect(ids(old)).toEqual([task]);
    expect(await w.overview(area)).toMatchObject({
      activeProjectCount: 0,
      openTaskCount: 0,
      todayTaskCount: 0,
      upcoming: [],
    });
  });
});
