import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getSystemTimezone } from "../systemSettings.js";
import { createTasksDayRolloverAction, TASKS_DAY_ROLLOVER_ACTION_ID } from "../tasks/tasksDayRolloverAction.js";
import { createTaskRecurrenceSetRouteHandler } from "../tasks/taskRecurrenceRoutes.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const WAIT_MS = 10_000;

let admin: Pool;
let pool: Pool;
let tenant: string;
let cp: ChokePoint;
let tasksId: string;
let eventsId: string;
/** The tenant's own today in its system time zone; dates are relative to it (no clock is faked). */
let today: DateTime;
let heartbeat: { id: string; projectItemId: string; config: Record<string, unknown> };

const day = (offset: number): string => today.plus({ days: offset }).toFormat("yyyy-MM-dd");

const itemRow = z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()), updated_at: z.string() });

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenant, fn);
}

async function task(properties: Record<string, unknown>): Promise<string> {
  return (await inTenant(() => cp.createItem({ databaseId: tasksId, properties: { name: "Task", ...properties } }))).id;
}

async function row(id: string): Promise<z.infer<typeof itemRow>> {
  return inTenant(async () => {
    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT id, properties, updated_at::text FROM items WHERE id = $1",
      [id],
    );
    return itemRow.parse(rows[0]);
  });
}

function run(): Promise<void> {
  return inTenant(() =>
    createTasksDayRolloverAction(pool)(heartbeat.config, {
      heartbeatId: heartbeat.id,
      projectItemId: heartbeat.projectItemId,
    }),
  );
}

/** Synthetic state for a property no production writer sets yet (#1780 and #1798 will): written directly as Tasks. */
async function setSystemProperties(id: string, properties: Record<string, unknown>): Promise<void> {
  await inTenant(async () => {
    const result = await pool.query(
      "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = $2",
      [tasksId, id, JSON.stringify(properties)],
    );
    expect(result.rowCount).toBe(1);
  });
}

describe("the midnight Tasks rollover (issue #1674)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await inTenant(() => seedSystem(pool, createViewTypeRegistry()));
    cp = createChokePoint(pool);
    const databases = await inTenant(() => cp.listDatabases());
    tasksId = databases.find((database) => database.ownerModuleId === "tasks")?.id ?? "";
    eventsId = databases.find((database) => database.ownerModuleId === "events")?.id ?? "";
    const zone = await inTenant(() => withTransaction(pool, (client) => getSystemTimezone(client)));
    today = DateTime.now().setZone(zone).startOf("day");
    const { rows } = await inTenant(() =>
      pool.query<{ id: string; project_item_id: string; action_config: Record<string, unknown> }>(
        "SELECT id, project_item_id, action_config FROM project_heartbeats WHERE action_id = $1",
        [TASKS_DAY_ROLLOVER_ACTION_ID],
      ),
    );
    if (!rows[0]) throw new Error("The rollover heartbeat was not seeded");
    heartbeat = { id: rows[0].id, projectItemId: rows[0].project_item_id, config: rows[0].action_config };
  });

  afterAll(async () => {
    setInvalidationHook(() => {});
    await pool?.end();
    await admin?.end();
  });

  it("moves a notDone task of yesterday 10:00-11:00 to today without times, with since yesterday", async () => {
    const id = await task({ date: day(-1), timeFrom: "10:00", timeTo: "11:00" });
    await run();
    expect((await row(id)).properties).toMatchObject({
      date: day(0),
      timeFrom: null,
      timeTo: null,
      time: null,
      since: day(-1),
      sinceTime: { from: "10:00", to: "11:00" },
    });
  });

  it("keeps the first planned day when a task that already moved is moved again (relative days, not a clock advance)", async () => {
    const id = await task({ date: day(-3), timeFrom: "10:00", timeTo: "11:00" });
    // A user moving it to yesterday records the first planned day, as an earlier night's move would have.
    await inTenant(() =>
      cp.updateItem({ databaseId: tasksId, itemId: id, propertiesPatch: { date: day(-1) } }, undefined, undefined, {
        writerKind: "user",
      }),
    );
    expect((await row(id)).properties.since).toBe(day(-3));
    await run();
    expect((await row(id)).properties).toMatchObject({ date: day(0), since: day(-3) });
  });

  it("changes nothing on a second run the same day, and after a three-day outage writes today once", async () => {
    const id = await task({ date: day(-3) });
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      await run();
      const moved = await row(id);
      expect(moved.properties).toMatchObject({ date: day(0), since: day(-3) });
      await run();
      expect(await row(id)).toEqual(moved);
    } finally {
      setInvalidationHook(() => {});
    }
    expect(events.filter((event) => event.scope === "item" && event.itemId === id)).toHaveLength(1);
  });

  it("does not move a done, wontDo, deleted, recurring, undated, current or hidden task, nor one completed in an event", async () => {
    const done = await task({ date: day(-2), status: "done" });
    const wontDo = await task({ date: day(-2), status: "wontDo" });
    const deleted = await task({ date: day(-2) });
    await inTenant(() => cp.softDeleteItem(tasksId, deleted));
    const recurring = await task({ date: day(-2) });
    await inTenant(() =>
      createTaskRecurrenceSetRouteHandler(pool)({
        params: { id: recurring },
        body: { preset: "daily" },
        identity: { user: { id: randomUUID() } },
      }),
    );
    const undated = await task({});
    const current = await task({ date: day(0) });
    const hidden = await task({ date: day(-2) });
    await setSystemProperties(hidden, { hiddenUntil: today.plus({ days: 1 }).toISO() });
    const completedInEvent = await task({ date: day(-2) });
    await inTenant(() =>
      withTransaction(pool, async (client: PoolClient) => {
        const event = await createRelationTarget(client);
        const property = await client.query<{ id: string }>(
          "SELECT id FROM properties WHERE database_id = $1 AND key = 'completedInEvent'",
          [tasksId],
        );
        // Synthetic edge: the Tasks module's process writes it; its producer is not built yet.
        await createRelationWithClient(
          client,
          { relationPropertyId: property.rows[0]!.id, callerItemId: completedInEvent, targetItemId: event },
          { ownerProcess: "tasks" },
        );
      }),
    );
    const ids = [done, wontDo, deleted, recurring, undated, current, hidden, completedInEvent];
    const before = await Promise.all(ids.map(row));
    await run();
    expect(await Promise.all(ids.map(row))).toEqual(before);
  });

  it("moves a task whose event ended yesterday, with since yesterday", async () => {
    const id = await task({ date: day(-3) });
    // The event-derived day and the end of its event (#1780, #1798 write them later): synthetic Tasks values.
    await setSystemProperties(id, {
      effectiveDate: day(-1),
      hiddenUntil: today.minus({ hours: 1 }).toISO(),
    });
    await run();
    expect((await row(id)).properties).toMatchObject({ date: day(0), since: day(-1) });
  });

  it("sends one invalidation without an acting user for every moved task and none for an unmoved one", async () => {
    const moved = [await task({ date: day(-1) }), await task({ date: day(-2) })];
    const kept = await task({ date: day(0) });
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      await run();
    } finally {
      setInvalidationHook(() => {});
    }
    const items = events.filter((event) => event.scope === "item");
    for (const id of moved) {
      expect(items.filter((event) => event.itemId === id)).toEqual([
        expect.objectContaining({ scope: "item", op: "update", databaseId: tasksId, itemId: id, userId: undefined }),
      ]);
    }
    expect(items.filter((event) => event.itemId === kept)).toEqual([]);
  });

  it("moves a row another transaction holds during the first pass by the end of the same run", async () => {
    const locked = await task({ date: day(-1) });
    const free = await task({ date: day(-1) });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holderPid: (pid: number) => void = () => undefined;
    const holding = new Promise<number>((resolve) => {
      holderPid = resolve;
    });
    const asError = (error: unknown): Error =>
      error instanceof Error ? error : new Error("A transaction failed with a non-Error value", { cause: error });
    const holder: Promise<Error | null> = inTenant(() =>
      withTransaction(pool, async (client) => {
        await client.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [locked]);
        holderPid((await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
        await held;
      }),
    ).then(
      () => null,
      (error: unknown) => asError(error),
    );
    let rollover: Promise<Error | null> | undefined;
    let waitFailure: Error | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const pid = await Promise.race([
        holding,
        holder.then((error) => Promise.reject(error ?? new Error("The holder ended before locking"))),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The holder did not lock the row")), WAIT_MS);
        }),
      ]);
      rollover = run().then(
        () => null,
        (error: unknown) => asError(error),
      );
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const { rows } = await admin.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
          [pid],
        );
        if (rows[0]?.waiting === true) break;
        if (Date.now() > deadline) throw new Error("The rollover never waited for the held row");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The first pass skipped the held row and committed the free one before the second pass started waiting.
      expect((await row(free)).properties.date).toBe(day(0));
      expect((await row(locked)).properties.date).toBe(day(-1));
    } catch (error) {
      waitFailure = asError(error);
    } finally {
      clearTimeout(timer);
      release();
    }
    const holderError = await holder;
    const rolloverError = rollover === undefined ? null : await rollover;
    if (holderError !== null) throw holderError;
    if (waitFailure !== null) throw waitFailure;
    if (rolloverError !== null) throw rolloverError;
    expect((await row(locked)).properties).toMatchObject({ date: day(0), since: day(-1) });
  });
});

/** An Event to be the target of a fixture edge, created through the choke point in the caller's transaction. */
async function createRelationTarget(client: PoolClient): Promise<string> {
  return (await createItemWithClient(client, { databaseId: eventsId, properties: { name: "Workshop", date: day(-2) } }))
    .id;
}
