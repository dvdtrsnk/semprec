import "../../domainWriteHooks.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { CORE_TASK_NAMES } from "@semprec/queue";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { lockItemById } from "../../chokePoint/itemsStore.js";
import { lockValueLink } from "../../chokePoint/valueLinksStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import type { WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { ValueLinkBusyError } from "../../errors.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { setSelfPersonId } from "../../selfPerson.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { handleLinkPropagation } from "../../valueLinks/linkPropagation.js";
import { createTaskHostEventPutRouteHandler } from "../taskHostEventRouteHandlers.js";

// Lock order of an Event trash against propagation of the Event's project: the source detach takes the sourced
// tasks' rows in item id order before any link, so the hosted-tasks hook finds those rows already locked. See
// docs/architecture/domain-calendar-tasks-and-media.md#event-trash-lock-order. One runtime-role pool per participant,
// so `pg_blocking_pids` tells them apart by `application_name`.

const USER: WriterIdentity = { writerKind: "user" };
const IDENTITY = { user: { id: "00000000-0000-4000-8000-0000000000a1" } };
const PROJECT_RULE = "taskProjectFromEvent";
/** The server clock of every case, as in `eventHostedTasksHooks.test.ts`: the Event of the cases is still ahead. */
const START = "2026-10-10T08:00:00.000Z";
const EVENT_DATE = "2026-10-22";
const OWN_DATE = "2026-10-12";

interface Participant {
  name: string;
  pool: Pool;
  cp: ChokePoint;
}

let admin: Pool;
let fixture: Participant;
let holder: Participant;
let propagation: Participant;
let trasher: Participant;

async function participant(name: string): Promise<Participant> {
  const pool = await createRuntimeRolePool(admin, "semprec_data");
  // Set before the pool opens its first connection, so every backend of this participant carries the name.
  pool.options.application_name = name;
  return { name, pool, cp: createChokePoint(pool) };
}

interface World {
  tenant: string;
  tasksDatabase: string;
  eventsDatabase: string;
  eventProjectProperty: string;
  eventActionItemsProperty: string;
  web: string;
  bathroom: string;
  event: string;
}

async function buildWorld(): Promise<World> {
  const tenant = await createTestTenant(admin);
  return runInTenant(tenant, async () => {
    await seedSystem(fixture.pool, createViewTypeRegistry());
    const databases = await fixture.cp.listDatabases();
    const database = (moduleId: string): string => {
      const found = databases.find((entry) => entry.ownerModuleId === moduleId);
      if (!found) throw new Error(`Missing database ${moduleId}`);
      return found.id;
    };
    const property = async (databaseId: string, key: string): Promise<string> => {
      const found = (await fixture.cp.listProperties(databaseId)).find((entry) => entry.key === key);
      if (!found) throw new Error(`Missing property ${key}`);
      return found.id;
    };
    const [events, people, projects, tasks] = [
      database("events"),
      database("people"),
      database("projects"),
      database("tasks"),
    ];
    const item = async (databaseId: string, properties: Record<string, unknown>): Promise<string> =>
      (await fixture.cp.createItem({ databaseId, properties })).id;
    const eventProjectProperty = await property(events, "project");
    // Without a chosen own person the people rule copies nothing, so the tenant has one.
    const me = await item(people, { name: "Me Myself" });
    await withTransaction(fixture.pool, (client) => setSelfPersonId(client, me));
    const alice = await item(people, { name: "Alice Novak" });
    const web = await item(projects, { name: "Web for client" });
    const bathroom = await item(projects, { name: "Bathroom renovation" });
    const event = await item(events, { name: "client meeting", type: "meeting", date: EVENT_DATE });
    await fixture.cp.createRelation(
      { relationPropertyId: eventProjectProperty, callerItemId: event, targetItemId: web },
      USER,
    );
    await fixture.cp.createRelation(
      { relationPropertyId: await property(events, "people"), callerItemId: event, targetItemId: alice },
      USER,
    );
    return {
      tenant,
      tasksDatabase: tasks,
      eventsDatabase: events,
      eventProjectProperty,
      eventActionItemsProperty: await property(events, "actionItems"),
      web,
      bathroom,
      event,
    };
  });
}

/** An action item linked as a user does: it gets the Event's project and participants. */
async function actionItemOf(world: World): Promise<string> {
  return runInTenant(world.tenant, async () => {
    const task = (
      await fixture.cp.createItem({
        databaseId: world.tasksDatabase,
        properties: { name: "Send the offer", date: OWN_DATE },
      })
    ).id;
    await fixture.cp.createRelation(
      { relationPropertyId: world.eventActionItemsProperty, callerItemId: world.event, targetItemId: task },
      USER,
    );
    return task;
  });
}

function host(world: World, taskId: string): Promise<unknown> {
  return runInTenant(world.tenant, () =>
    createTaskHostEventPutRouteHandler(fixture.pool)({
      params: { id: taskId, eventId: world.event },
      body: {},
      identity: IDENTITY,
    }),
  );
}

/** Queues the propagation job the schedules run the handler for. */
async function changeEventProject(world: World): Promise<void> {
  await runInTenant(world.tenant, async () => {
    const edge = { relationPropertyId: world.eventProjectProperty, callerItemId: world.event };
    await fixture.cp.deleteRelation({ ...edge, targetItemId: world.web }, USER);
    await fixture.cp.createRelation({ ...edge, targetItemId: world.bathroom }, USER);
  });
  const { rows } = await admin.query<{ key: string | null }>(
    "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1",
    [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE],
  );
  expect(rows.map((row) => row.key)).toContain(`valueLinksPropagate:${world.tenant}:${PROJECT_RULE}:${world.event}:1`);
}

type Outcome = "committed" | "deadlock" | "busy";

async function outcomeOf(operation: Promise<unknown>): Promise<Outcome> {
  try {
    await operation;
    return "committed";
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "40P01") return "deadlock";
    if (error instanceof ValueLinkBusyError) return "busy";
    throw error;
  }
}

interface Step {
  participant: Participant;
  call: (participant: Participant) => Promise<unknown>;
}

interface Running {
  participant: Participant;
  outcome: Promise<Outcome>;
  settled: () => boolean;
}

function start(world: World, step: Step): Running {
  let done = false;
  const outcome = outcomeOf(runInTenant(world.tenant, () => step.call(step.participant))).finally(() => {
    done = true;
  });
  return { participant: step.participant, outcome, settled: () => done };
}

/**
 * Waits until the call has either ended or one of its participant's backends waits for a lock. Returns the
 * participants whose backends block it, by `application_name`, or `null` when the call ended without waiting.
 */
async function blockersOrEnd(running: Running): Promise<string[] | null> {
  let blockers: string[] | null = null;
  await vi.waitFor(
    async () => {
      if (running.settled()) {
        blockers = null;
        return;
      }
      const { rows } = await admin.query<{ blocker: string }>(
        `SELECT DISTINCT blocker.application_name AS blocker
         FROM pg_stat_activity waiter
         JOIN pg_stat_activity blocker ON blocker.pid = ANY(pg_blocking_pids(waiter.pid))
         WHERE waiter.datname = current_database() AND waiter.application_name = $1
         ORDER BY blocker`,
        [running.participant.name],
      );
      expect(rows.length).toBeGreaterThan(0);
      blockers = rows.map((row) => row.blocker);
    },
    { timeout: 10_000, interval: 25 },
  );
  return blockers;
}

interface ScheduleResult {
  /** What blocked each call when it was started, in the order the calls were started; `null` for a call that ended at once. */
  blockedBy: Array<string[] | null>;
  outcomes: Outcome[];
}

/**
 * While a third transaction holds the row `lock` locks, starts each step once the previous one waits or ended,
 * runs `whileWaiting`, then releases the row and lets every call end.
 */
async function behindHeldRow(
  world: World,
  lock: (client: PoolClient) => Promise<unknown>,
  steps: Step[],
  whileWaiting?: () => Promise<void>,
): Promise<ScheduleResult> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal!: () => void;
  const locked = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const held = runInTenant(world.tenant, () =>
    withTransaction(holder.pool, async (client: PoolClient) => {
      if (!(await lock(client))) throw new Error("The row to hold does not exist");
      signal();
      await gate;
    }),
  );
  const running: Running[] = [];
  const blockedBy: Array<string[] | null> = [];
  try {
    await Promise.race([
      locked,
      held.then(() => {
        throw new Error("The holding transaction ended before it locked the row");
      }),
    ]);
    for (const step of steps) {
      const call = start(world, step);
      running.push(call);
      blockedBy.push(await blockersOrEnd(call));
    }
    await whileWaiting?.();
  } finally {
    release();
    await Promise.allSettled([held, ...running.map((call) => call.outcome)]);
  }
  await held;
  return { blockedBy, outcomes: await Promise.all(running.map((call) => call.outcome)) };
}

const propagates = (world: World): Step => ({
  participant: propagation,
  call: ({ pool }) => handleLinkPropagation(pool, { ruleKey: PROJECT_RULE, sourceItemId: world.event, hop: 1 }),
});

const trashesEvent = (world: World): Step => ({
  participant: trasher,
  call: ({ cp }) => cp.softDeleteItem(world.eventsDatabase, world.event, undefined, USER),
});

const taskRow = (world: World, taskId: string) => (client: PoolClient) =>
  lockItemById(client, world.tasksDatabase, taskId);

const projectLink = (taskId: string) => (client: PoolClient) => lockValueLink(client, taskId, "project");

async function settledState(world: World, taskId: string) {
  return runInTenant(world.tenant, async () => {
    const links = await fixture.pool.query<{ property_key: string }>(
      "SELECT property_key FROM value_links WHERE item_id = $1 ORDER BY property_key",
      [taskId],
    );
    const stored = await fixture.cp.getItem(world.tasksDatabase, taskId);
    const event = await fixture.pool.query<{ trashed: boolean }>(
      "SELECT deleted_at IS NOT NULL AS trashed FROM items WHERE id = $1",
      [world.event],
    );
    return {
      linkKeys: links.rows.map((row) => row.property_key),
      hiddenUntil: stored?.properties.hiddenUntil ?? null,
      effectiveDate: stored?.properties.effectiveDate ?? null,
      eventTrashed: event.rows[0]?.trashed,
    };
  });
}

/** What a hosted task shows once its Event is trashed: it is back on its own day, with no value link left. */
const RETURNED = { linkKeys: [], hiddenUntil: null, effectiveDate: OWN_DATE, eventTrashed: true };

describe("the trash of an Event that hosts a task which it also sources", () => {
  beforeAll(async () => {
    admin = getTestPool();
    fixture = await participant("hostedTaskLockOrder:fixture");
    holder = await participant("hostedTaskLockOrder:holder");
    propagation = await participant("hostedTaskLockOrder:propagation");
    trasher = await participant("hostedTaskLockOrder:eventTrash");
    for (const { pool } of [fixture, holder, propagation, trasher]) {
      const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    }
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(START));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    for (const entry of [fixture, holder, propagation, trasher]) await entry?.pool.end();
    await admin?.end();
  });

  // Propagation takes the task row, then its `project` link. A trash taking the link in the source detach before the
  // task row in the hosted-tasks hook would hold the link while waiting for the row the propagation holds.
  describe("against the propagation of the Event's project, with the task row held", () => {
    it("commits both when the propagation starts first", async () => {
      const world = await buildWorld();
      const task = await actionItemOf(world);
      await host(world, task);
      await changeEventProject(world);

      const result = await behindHeldRow(world, taskRow(world, task), [propagates(world), trashesEvent(world)]);

      expect(result.outcomes).toEqual(["committed", "committed"]);
      expect(result.blockedBy[0]).toEqual([holder.name]);
      expect(result.blockedBy[1]).not.toBeNull();
      expect(await settledState(world, task)).toEqual(RETURNED);
    });

    it("commits both when the trash starts first", async () => {
      const world = await buildWorld();
      const task = await actionItemOf(world);
      await host(world, task);
      await changeEventProject(world);

      const result = await behindHeldRow(world, taskRow(world, task), [trashesEvent(world), propagates(world)]);

      expect(result.outcomes).toEqual(["committed", "committed"]);
      expect(result.blockedBy[0]).toEqual([holder.name]);
      expect(result.blockedBy[1]).not.toBeNull();
      expect(await settledState(world, task)).toEqual(RETURNED);
    });
  });

  // The Event sources two tasks and hosts only the larger id. Taking the hosted task's row first would wait on the
  // smaller task's link while holding the larger row, deadlocking with the propagation. The source detach takes both
  // rows in item order instead.
  describe("when the Event also sources a task it does not host, whose id is the smaller", () => {
    it("commits both when the smaller task's project link is held and the propagation starts first", async () => {
      const world = await buildWorld();
      const [smaller, larger] = [await actionItemOf(world), await actionItemOf(world)].sort();
      if (!smaller || !larger) throw new Error("Two tasks are expected");
      await host(world, larger);
      await changeEventProject(world);

      const result = await behindHeldRow(world, projectLink(smaller), [propagates(world), trashesEvent(world)]);

      expect(result.outcomes).toEqual(["committed", "committed"]);
      expect(result.blockedBy[0]).toEqual([holder.name]);
      expect(result.blockedBy[1]).toEqual([propagation.name]);
      expect(await settledState(world, larger)).toEqual(RETURNED);
      expect((await settledState(world, smaller)).linkKeys).toEqual([]);
    });
  });

  // The trash holds the task row before waiting on a link row the propagation needs the task row for. Checked by a
  // nonblocking row lock from another connection while the trash waits.
  describe("when the task's project link is held", () => {
    it("holds the task row while the trash waits for the link, and returns the task to its day", async () => {
      const world = await buildWorld();
      const task = await actionItemOf(world);
      await host(world, task);
      expect((await settledState(world, task)).linkKeys).toEqual(["people", "project"]);

      let rowLockedWhileWaiting = false;
      const result = await behindHeldRow(world, projectLink(task), [trashesEvent(world)], async () => {
        const client = await admin.connect();
        try {
          await client.query("BEGIN");
          await expect(
            client.query("SELECT id FROM items WHERE id = $1 FOR NO KEY UPDATE NOWAIT", [task]),
          ).rejects.toMatchObject({ code: "55P03" });
          rowLockedWhileWaiting = true;
        } finally {
          // A connection whose transaction failed is not returned to the pool.
          client.release(true);
        }
      });

      expect(result).toEqual({ blockedBy: [[holder.name]], outcomes: ["committed"] });
      expect(rowLockedWhileWaiting).toBe(true);
      expect(await settledState(world, task)).toEqual(RETURNED);
    });
  });
});
