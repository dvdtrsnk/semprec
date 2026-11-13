import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import * as viewsStore from "../../chokePoint/viewsStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { withTransaction } from "../../db/pool.js";
import { ConflictError } from "../../errors.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { startTaskSeries } from "../../testSupport/taskSeriesFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import type { ViewRow } from "../../types.js";
import { createTaskHostEventPutRouteHandler } from "../taskHostEventRouteHandlers.js";
import { countTasksToday, TASKS_TODAY_VIEW_KEY, tasksTodayFilter } from "../todayView.js";
import { runTasksTodayViewCutoverMigration } from "../todayViewCutoverMigration.js";

interface SeededTenant {
  id: string;
  tasksId: string;
  eventsId: string;
}

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: SeededTenant;

const identity = { user: { id: randomUUID() } };

/** Friday 16 October 2026, 12:00 in the seeded zone (Europe/Prague is UTC+2 that day). */
const TODAY_NOON = "2026-10-16T10:00:00.000Z";

async function seededTenant(): Promise<SeededTenant> {
  const id = await createTestTenant(admin);
  await runInTenant(id, () => seedSystem(pool, createViewTypeRegistry()));
  return runInTenant(id, () =>
    withTransaction(pool, async (client) => {
      const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
      const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
      if (!tasks || !events) throw new Error("Tasks or Events not seeded");
      return { id, tasksId: tasks.id, eventsId: events.id };
    }),
  );
}

function setClock(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

async function task(properties: Record<string, unknown>, owner: SeededTenant = tenant): Promise<string> {
  const item = await runInTenant(owner.id, () =>
    cp.createItem({ databaseId: owner.tasksId, properties: { name: "Task", ...properties } }),
  );
  return item.id;
}

async function event(properties: Record<string, unknown>): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    cp.createItem({ databaseId: tenant.eventsId, properties: { name: "Event", ...properties } }),
  );
  return item.id;
}

const updateTask = (taskId: string, propertiesPatch: Record<string, unknown>) =>
  runInTenant(tenant.id, () => cp.updateItem({ databaseId: tenant.tasksId, itemId: taskId, propertiesPatch }));

/** Puts the task into the event through the route of issue #1764, which stamps the edge's `addedAt` from the clock. */
const putInEvent = (taskId: string, eventId: string) =>
  runInTenant(tenant.id, () =>
    createTaskHostEventPutRouteHandler(pool)({ params: { id: taskId, eventId }, body: {}, identity }),
  );

/** The Today views of the Tasks database of `owner`, found by their `systemKey` as a client finds them. */
async function todayViews(owner: SeededTenant = tenant): Promise<ViewRow[]> {
  const views = await runInTenant(owner.id, () => cp.listViewsByDatabase(owner.tasksId));
  return views.filter((view) => view.config.systemKey === TASKS_TODAY_VIEW_KEY);
}

/** The ids the Today view lists at the current (faked) clock. */
async function todayList(owner: SeededTenant = tenant): Promise<string[]> {
  const [view] = await todayViews(owner);
  if (!view) throw new Error("The Today view is missing");
  const page = await runInTenant(owner.id, () => cp.queryView(view.id));
  return page.items.map((item) => item.id);
}

function openCount(owner: SeededTenant = tenant, now?: Date): Promise<number> {
  return runInTenant(owner.id, () => withTransaction(pool, (client) => countTasksToday(client, now)));
}

/** All views of the tenant that carry any `systemKey`, as the unique index sees them. */
async function systemKeyViewCount(owner: SeededTenant = tenant): Promise<number> {
  return runInTenant(owner.id, async () => {
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM views WHERE config ? 'systemKey'",
    );
    return z.object({ count: z.number() }).parse(rows[0]).count;
  });
}

beforeAll(async () => {
  admin = getTestPool();
  await resetDatabase(admin);
  pool = await createRuntimeRolePool(admin, "semprec_data");
  const role = await runAsSystem("test:role", () =>
    pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    ),
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  cp = createChokePoint(pool);
}, 120_000);

beforeEach(async () => {
  // Every seeded tenant adds one items partition per database; wiping them keeps the lock table of the shared Postgres bounded.
  await resetDatabase(admin);
  tenant = await seededTenant();
  vi.useFakeTimers({ toFake: ["Date"] });
  setClock(TODAY_NOON);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await resetDatabase(admin);
  await pool?.end();
  await admin?.end();
});

describe("the Today list of the Tasks database (issue #1798)", () => {
  it("lists a weekly task due on 12 October that is notDone as overdue, and not a task of a later day or without a day", async () => {
    const weekly = await task({ date: "2026-10-12" });
    await runInTenant(tenant.id, () =>
      startTaskSeries(pool, {
        databaseId: tenant.tasksId,
        itemId: weekly,
        mode: "fixed",
        rule: { kind: "weekdays", days: ["mon"] },
      }),
    );
    const later = await task({ date: "2026-10-20" });
    const undated = await task({});
    const list = await todayList();
    expect(list).toContain(weekly);
    expect(list).not.toContain(later);
    expect(list).not.toContain(undated);
  });

  it("lists an overdue task only while it is notDone", async () => {
    const [open, wontDo, missed] = [
      await task({ date: "2026-10-14" }),
      await task({ date: "2026-10-14", status: "wontDo" }),
      await task({ date: "2026-10-14", status: "missed" }),
    ];
    const list = await todayList();
    expect(list).toContain(open);
    expect(list).not.toContain(wontDo);
    expect(list).not.toContain(missed);
  });

  it("lists a task of today under any status but done, and a done task of an earlier day not at all", async () => {
    const [open, wontDo, doneBefore] = [
      await task({ date: "2026-10-16" }),
      await task({ date: "2026-10-16", status: "wontDo" }),
      await task({ date: "2026-10-14" }),
    ];
    setClock("2026-10-14T10:00:00.000Z");
    await updateTask(doneBefore, { status: "done" });
    setClock(TODAY_NOON);
    const list = await todayList();
    expect(list).toContain(open);
    expect(list).toContain(wontDo);
    expect(list).not.toContain(doneBefore);
  });

  it("lists a moved task under its effective day and not under the day it left", async () => {
    const moved = await task({ date: "2026-10-20" });
    expect(await todayList()).not.toContain(moved);
    await updateTask(moved, { date: "2026-10-16" });
    expect(await todayList()).toContain(moved);
    await updateTask(moved, { date: "2026-10-20" });
    expect(await todayList()).not.toContain(moved);
  });

  it("hides a task inside a running event and lists it once the event has ended", async () => {
    const taskId = await task({ date: "2026-10-16" });
    // 14:00 to 15:00 in Prague on 16 October.
    const eventId = await event({ date: "2026-10-16", timeFrom: "14:00", timeTo: "15:00" });
    await putInEvent(taskId, eventId);
    expect(await todayList()).not.toContain(taskId);
    setClock("2026-10-16T13:01:00.000Z");
    expect(await todayList()).toContain(taskId);
  });

  it("hides a task completed inside an event and lists the same completion made outside one", async () => {
    const inside = await task({ date: "2026-10-16" });
    const outside = await task({ date: "2026-10-16" });
    const eventId = await event({ date: "2026-10-16", timeFrom: "14:00", timeTo: "15:00" });
    await putInEvent(inside, eventId);
    // 14:30 in Prague: before the end of the event.
    setClock("2026-10-16T12:30:00.000Z");
    await updateTask(inside, { status: "done" });
    await updateTask(outside, { status: "done" });
    // 15:30 in Prague: the event has ended, so only the completedInEvent edge still keeps the task out.
    setClock("2026-10-16T13:30:00.000Z");
    const list = await todayList();
    expect(list).not.toContain(inside);
    expect(list).toContain(outside);
  });

  it("lists a task planned for 22 October that was completed on 16 October", async () => {
    const taskId = await task({ date: "2026-10-22" });
    expect(await todayList()).not.toContain(taskId);
    await updateTask(taskId, { status: "done" });
    expect(await todayList()).toContain(taskId);
  });

  it("does not list a task planned for 16 October that was completed on 14 October", async () => {
    setClock("2026-10-14T10:00:00.000Z");
    const taskId = await task({ date: "2026-10-16" });
    await updateTask(taskId, { status: "done" });
    setClock(TODAY_NOON);
    expect(await todayList()).not.toContain(taskId);
  });

  it("falls back to the effective day for a done task without a completedOn", async () => {
    const [dueToday, dueBefore] = [await task({ date: "2026-10-16" }), await task({ date: "2026-10-14" })];
    for (const id of [dueToday, dueBefore]) await updateTask(id, { status: "done" });
    // Synthetic state: a task completed before issue #1544 stores no completedOn, and the Tasks transform always writes one.
    await runInTenant(tenant.id, () =>
      pool.query("UPDATE items SET properties = properties - 'completedOn' WHERE id = ANY($1::uuid[])", [
        [dueToday, dueBefore],
      ]),
    );
    const list = await todayList();
    expect(list).toContain(dueToday);
    expect(list).not.toContain(dueBefore);
  });
});

describe("the open count of the Today list (issue #1798)", () => {
  it("equals the number of notDone tasks of the list; a done task of today is listed and not counted", async () => {
    const [open, overdue, done, wontDo] = [
      await task({ date: "2026-10-16" }),
      await task({ date: "2026-10-12" }),
      await task({ date: "2026-10-16" }),
      await task({ date: "2026-10-16", status: "wontDo" }),
    ];
    await task({ date: "2026-10-20" });
    await updateTask(done, { status: "done" });
    const list = await todayList();
    expect(list.sort()).toEqual([open, overdue, done, wontDo].sort());
    const view = (await todayViews())[0];
    const page = await runInTenant(tenant.id, () => cp.queryView(view!.id));
    const openIds = page.items.filter((item) => item.properties.status === "notDone").map((item) => item.id);
    expect(openIds.sort()).toEqual([open, overdue].sort());
    expect(await openCount()).toBe(2);
  });

  it("excludes a hidden task and a task completed inside an event, as the list does", async () => {
    const [hidden, completedInside, visible] = [
      await task({ date: "2026-10-16" }),
      await task({ date: "2026-10-16" }),
      await task({ date: "2026-10-16" }),
    ];
    const running = await event({ date: "2026-10-16", timeFrom: "14:00", timeTo: "15:00" });
    await putInEvent(hidden, running);
    await putInEvent(completedInside, running);
    setClock("2026-10-16T12:30:00.000Z");
    await updateTask(completedInside, { status: "done" });
    expect(await openCount()).toBe(1);
    expect(await todayList()).toEqual([visible]);
  });

  it("is evaluated at the clock passed in, and at the current time without one", async () => {
    await task({ date: "2026-10-16" });
    await task({ date: "2026-10-18" });
    expect(await openCount()).toBe(1);
    expect(await openCount(tenant, new Date("2026-10-18T10:00:00.000Z"))).toBe(2);
    expect(await openCount(tenant, new Date("2026-10-15T10:00:00.000Z"))).toBe(0);
  });

  it("counts only the tasks of the tenant it runs in", async () => {
    const other = await seededTenant();
    await task({ date: "2026-10-16" });
    await task({ date: "2026-10-16" }, other);
    await task({ date: "2026-10-12" }, other);
    expect(await openCount()).toBe(1);
    expect(await openCount(other)).toBe(2);
  });

  it("fails for a tenant without a Tasks database", async () => {
    const unseeded: SeededTenant = { id: await createTestTenant(admin), tasksId: "", eventsId: "" };
    await expect(openCount(unseeded)).rejects.toThrow("The Tasks database is missing");
  });
});

describe("the Today system view (issue #1798)", () => {
  it("is seeded once on Tasks as a non-default system table view with the Today filter", async () => {
    const views = await todayViews();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      databaseId: tenant.tasksId,
      type: "table",
      createdBy: "system",
      isDefault: false,
      creatorProjectItemId: null,
      config: { systemKey: TASKS_TODAY_VIEW_KEY, filter: tasksTodayFilter({ openOnly: false }) },
    });
    expect(await systemKeyViewCount()).toBe(1);
    const all = await runInTenant(tenant.id, () => cp.listViewsByDatabase(tenant.tasksId));
    expect(all.filter((view) => view.isDefault)).toHaveLength(1);
  });

  describe("cutover for a tenant seeded before it", () => {
    async function removeTodayView(): Promise<void> {
      // Synthetic state: the write path refuses to delete a system view, and a tenant seeded before this issue has none.
      await runInTenant(tenant.id, () => pool.query("DELETE FROM views WHERE config ? 'systemKey'"));
      expect(await todayViews()).toHaveLength(0);
    }

    it("creates the view on the first run and nothing on the second", async () => {
      await removeTodayView();
      await runInTenant(tenant.id, () => runTasksTodayViewCutoverMigration(pool));
      const [created] = await todayViews();
      expect(created).toMatchObject({
        databaseId: tenant.tasksId,
        type: "table",
        createdBy: "system",
        isDefault: false,
        config: { systemKey: TASKS_TODAY_VIEW_KEY, filter: tasksTodayFilter({ openOnly: false }) },
      });
      await runInTenant(tenant.id, () => runTasksTodayViewCutoverMigration(pool));
      const after = await todayViews();
      expect(after.map((view) => view.id)).toEqual([created?.id]);
      expect(await systemKeyViewCount()).toBe(1);
    });

    it("leaves a view that exists untouched", async () => {
      const [before] = await todayViews();
      await runInTenant(tenant.id, () => runTasksTodayViewCutoverMigration(pool));
      expect(await todayViews()).toEqual([before]);
    });

    it("skips a tenant that has no Tasks database", async () => {
      const unseeded = await createTestTenant(admin);
      await runInTenant(unseeded, () => runTasksTodayViewCutoverMigration(pool));
      expect(await systemKeyViewCount({ id: unseeded, tasksId: "", eventsId: "" })).toBe(0);
    });

    it("runs as a step of runTenantCutoverMigrations", async () => {
      await removeTodayView();
      await runTenantCutoverMigrations(pool);
      expect(await todayViews()).toHaveLength(1);
    }, 120_000);

    it("serves the list through the view it created", async () => {
      await removeTodayView();
      await runInTenant(tenant.id, () => runTasksTodayViewCutoverMigration(pool));
      const taskId = await task({ date: "2026-10-16" });
      expect(await todayList()).toContain(taskId);
    });
  });

  describe("unique key index", () => {
    const create = (databaseId: string, config: Record<string, unknown>) =>
      runInTenant(tenant.id, () =>
        withTransaction(pool, (client) =>
          viewsStore.createView(
            client,
            { databaseId, type: "table", name: "Second", config },
            createViewTypeRegistry(),
          ),
        ),
      );

    it("rejects a second view with systemKey today on the same database", async () => {
      await expect(create(tenant.tasksId, { systemKey: TASKS_TODAY_VIEW_KEY })).rejects.toBeInstanceOf(ConflictError);
      expect(await todayViews()).toHaveLength(1);
    });

    it("rejects a patch that gives another view of the database the same key", async () => {
      const other = await create(tenant.tasksId, {});
      await expect(
        runInTenant(tenant.id, () =>
          withTransaction(pool, (client) =>
            viewsStore.patchView(
              client,
              other.id,
              { config: { systemKey: TASKS_TODAY_VIEW_KEY } },
              createViewTypeRegistry(),
            ),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("accepts the same key on another database and another key on the same database", async () => {
      await create(tenant.eventsId, { systemKey: TASKS_TODAY_VIEW_KEY });
      await create(tenant.tasksId, { systemKey: "upcoming" });
      expect(await systemKeyViewCount()).toBe(3);
    });

    it("rejects an empty or non-string systemKey before it reaches the index", async () => {
      await expect(create(tenant.tasksId, { systemKey: "" })).rejects.toMatchObject({ code: "validation_failed" });
      await expect(create(tenant.tasksId, { systemKey: 7 })).rejects.toMatchObject({ code: "validation_failed" });
    });
  });
});
