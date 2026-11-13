import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { registerItemDeleteHook, registerItemRestoreHook } from "../../chokePoint/hooks.js";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import type { WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { CALENDAR_MODULE_ID } from "../calendarModuleId.js";
import { createEventInCalendar } from "../defaultCalendarCreateHook.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent", agentRunId: randomUUID(), onBehalfOfUserId: randomUUID() };
const ACTING_USER_ID = randomUUID();

const calendarRow = z.object({
  id: z.string(),
  properties: z.object({ name: z.string(), isDefault: z.boolean().nullable().optional() }).passthrough(),
});
const eventRow = z.object({ id: z.string(), properties: z.object({ name: z.string() }).passthrough() });

const FORBIDDEN = { status: 403, code: "forbidden", details: { field: "kind" } };
const LAST_OWN = { status: 409, code: "last_own_calendar" };

/** Every delete and restore the choke point ran its hooks for in this file, with who made it. */
const trashes: Array<{
  op: "delete" | "restore";
  itemId: string;
  writerKind: string;
  agentRunId?: string;
  actingUserId?: string;
}> = [];
/** The item whose trash the recording hook fails, standing for a later step of a cascade that fails. */
let failDeleteOf: string | undefined;
/** The item whose restore the recording hook fails. */
let failRestoreOf: string | undefined;
registerItemDeleteHook(async ({ item, writerKind, agentRunId, actingUserId }) => {
  trashes.push({ op: "delete", itemId: item.id, writerKind, agentRunId, actingUserId });
  if (item.id === failDeleteOf) throw new Error("injected delete failure");
});
registerItemRestoreHook(async ({ item, writerKind, agentRunId, actingUserId }) => {
  trashes.push({ op: "restore", itemId: item.id, writerKind, agentRunId, actingUserId });
  if (item.id === failRestoreOf) throw new Error("injected restore failure");
});

/** A tenant with one English-speaking user, so its seeded calendars are named `Personal`, `Work` and so on. */
async function seededTenant(): Promise<string> {
  const tenantId = await createTestTenant(admin);
  await createUser(admin, { tenantId, email: `${randomUUID()}@example.com`, passwordHash: "unused", locale: "en" });
  await runInTenant(tenantId, () => seedSystem(runtime));
  return tenantId;
}

/** The error a write was refused with, or `undefined` when it was stored. */
function refusal(write: Promise<unknown>): Promise<unknown> {
  return write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

/** Resolves once a backend of this database waits for an advisory lock in a statement like the default-mark lock. */
async function waitForDefaultMarkLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const { rows } = await admin.query<{ wait_event: string | null }>(
      `SELECT wait_event FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'
         AND query LIKE '%pg_advisory_xact_lock(hashtextextended(''calendars-default:''%'`,
    );
    if (rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("No statement waited for the advisory lock of the default mark");
}

describe("calendar trash hooks (issue gh-1803)", () => {
  const invalidations: InvalidationEvent[] = [];

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await seededTenant();
    foreign = await seededTenant();
    trashes.length = 0;
    failDeleteOf = undefined;
    failRestoreOf = undefined;
    invalidations.length = 0;
    setInvalidationHook((event) => invalidations.push(event));
  });

  afterEach(() => {
    setInvalidationHook(() => {});
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /** The calendars and Events of the tenant in scope; every write of a test goes through the choke point. */
  async function setup() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const database = (moduleId: string) => {
      const row = databases.find((candidate) => candidate.ownerModuleId === moduleId);
      if (!row) throw new Error(`Missing the ${moduleId} database`);
      return row.id;
    };
    const calendarsId = database(CALENDARS_MODULE_ID);
    const eventsId = database("events");
    const calendars = async () => z.array(calendarRow).parse((await cp.listItems(calendarsId, { limit: 50 })).items);
    const liveEvents = async () => z.array(eventRow).parse((await cp.listItems(eventsId, { limit: 50 })).items);
    const calendarId = async (name: string) => {
      const row = (await calendars()).find((candidate) => candidate.properties.name === name);
      if (!row) throw new Error(`Calendar ${name} is not live`);
      return row.id;
    };
    /** The ids of the live calendars whose `isDefault` is true, sorted. */
    const defaults = async () =>
      (await calendars())
        .filter((candidate) => candidate.properties.isDefault === true)
        .map((candidate) => candidate.id)
        .sort();
    const eventIn = async (name: string, inCalendarId: string) => {
      const event = await withTransaction(runtime, (client) =>
        createEventInCalendar(client, { properties: { name, date: "2026-11-16" } }, inCalendarId, { writer: USER }),
      );
      return event.id;
    };
    const trash = (itemId: string, writer: WriterIdentity | undefined = USER, actingUserId?: string) =>
      cp.softDeleteItem(calendarsId, itemId, actingUserId, writer);
    const restore = (itemId: string, writer: WriterIdentity | undefined = USER, actingUserId?: string) =>
      cp.restoreItem(calendarsId, itemId, actingUserId, writer);
    const trashEvent = (itemId: string) => cp.softDeleteItem(eventsId, itemId, undefined, USER);
    /** The deletion epoch of each item as Postgres renders it with all six fraction digits; `null` for a live item. */
    const epochs = async (ids: string[]) => {
      const { rows } = await withTransaction(runtime, (client) =>
        client.query<{ id: string; epoch: string | null }>(
          `SELECT id, to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS epoch
             FROM items WHERE id = ANY($1::uuid[])`,
          [ids],
        ),
      );
      return Object.fromEntries(rows.map((row) => [row.id, row.epoch]));
    };
    /**
     * Sets the creation time of calendars. The choke point stamps `created_at` itself, and the seeded calendars
     * share one transaction's time, so the order the successor is chosen by has no other way to be set.
     */
    const setCreatedAt = async (names: string[], createdAt: string) => {
      for (const name of names) {
        const id = await calendarId(name);
        const result = await withTransaction(runtime, (client) =>
          client.query("UPDATE items SET created_at = $3::timestamptz WHERE database_id = $1 AND id = $2", [
            calendarsId,
            id,
            createdAt,
          ]),
        );
        expect(result.rowCount).toBe(1);
      }
    };
    /** A calendar of another `kind`. The key is written by the calendar module only, so the fixture writes it as that owner process. */
    const createOfKind = (kind: string, properties: Record<string, unknown>) =>
      withTransaction(runtime, (client) =>
        createItemWithClient(
          client,
          { databaseId: calendarsId, properties: { ...properties, kind } },
          { allowedSystemKeys: ["kind"], systemOwnerProcess: CALENDAR_MODULE_ID },
        ),
      );
    return {
      cp,
      calendarsId,
      eventsId,
      calendars,
      liveEvents,
      calendarId,
      defaults,
      eventIn,
      trash,
      restore,
      trashEvent,
      epochs,
      setCreatedAt,
      createOfKind,
    };
  }

  /**
   * Runs `change` in a transaction that stays open until the returned `commit` is called, and resolves once
   * `change` has run, so the caller starts its own write while the change is uncommitted.
   */
  async function heldOpen(change: (client: PoolClient) => Promise<unknown>): Promise<{ commit: () => Promise<void> }> {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let changed: () => void = () => {};
    const ran = new Promise<void>((resolve) => {
      changed = resolve;
    });
    const transaction = withTransaction(runtime, async (client) => {
      await change(client);
      changed();
      await released;
    });
    // A change that fails rejects `transaction` before `ran` resolves; the race surfaces that failure here.
    await Promise.race([ran, transaction]);
    return {
      commit: async () => {
        release();
        await transaction;
      },
    };
  }

  describe("what cannot be deleted", () => {
    it.each(["Sleep", "Birthdays"])("refuses to delete the system calendar %s with 403 forbidden", (name) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const id = await f.calendarId(name);
        const before = await f.calendars();

        expect(await refusal(f.trash(id))).toMatchObject(FORBIDDEN);
        expect(await f.calendars()).toEqual(before);
        expect(invalidations).toEqual([]);
      }),
    );

    it("refuses to delete a subscription calendar with 403 forbidden", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const feed = await f.createOfKind("subscription", { name: "Feed", color: "#8E8E93" });
        const before = await f.calendars();

        expect(await refusal(f.trash(feed.id))).toMatchObject(FORBIDDEN);
        expect(await f.calendars()).toEqual(before);
      }));

    it("refuses a system calendar for an agent and for the system writer as well", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const id = await f.calendarId("Sleep");

        expect(await refusal(f.trash(id, AGENT))).toMatchObject(FORBIDDEN);
        expect(await refusal(f.cp.softDeleteItem(f.calendarsId, id))).toMatchObject(FORBIDDEN);
        expect(await f.calendarId("Sleep")).toBe(id);
      }));

    it("refuses the last own calendar with 409 last_own_calendar and trashes neither it nor its Events", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        for (const name of ["Work", "Family", "Health"]) await f.trash(await f.calendarId(name));
        const personal = await f.calendarId("Personal");
        const event = await f.eventIn("Standup", personal);
        invalidations.length = 0;
        trashes.length = 0;
        const before = await f.calendars();

        const error = await refusal(f.trash(personal));
        expect(error).toMatchObject(LAST_OWN);
        expect(error).toMatchObject({ message: "The last own calendar cannot be deleted" });
        expect(await f.calendars()).toEqual(before);
        expect((await f.liveEvents()).map((row) => row.id)).toEqual([event]);
        expect(await f.defaults()).toEqual([personal]);
        expect(invalidations).toEqual([]);
      }));

    it("does not count a system or a subscription calendar as an own calendar left", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.createOfKind("subscription", { name: "Feed", color: "#8E8E93" });
        for (const name of ["Work", "Family", "Health"]) await f.trash(await f.calendarId(name));

        expect(await refusal(f.trash(await f.calendarId("Personal")))).toMatchObject(LAST_OWN);
      }));

    it("lets an own calendar go while another own calendar is left", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        for (const name of ["Work", "Family"]) await f.trash(await f.calendarId(name));

        await f.trash(await f.calendarId("Health"));
        expect((await f.calendars()).map((row) => row.properties.name)).not.toContain("Health");
        expect((await f.calendars()).map((row) => row.properties.name)).toContain("Personal");
      }));
  });

  describe("the default mark", () => {
    it("hands the mark of the deleted default calendar to the oldest remaining own calendar in the same transaction", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const personal = await f.calendarId("Personal");
        // The oldest of all is a system calendar, which cannot be a default; Health is the oldest own one.
        await f.setCreatedAt(["Birthdays"], "2026-01-01T00:00:00Z");
        await f.setCreatedAt(["Health"], "2026-01-02T00:00:00Z");
        await f.setCreatedAt(["Work", "Family"], "2026-01-03T00:00:00Z");
        const health = await f.calendarId("Health");

        const held = await heldOpen((client) =>
          itemDeleteWithClient(client, f.calendarsId, personal, {
            queueAffinity: createActionQueueAffinity(),
            writer: USER,
          }),
        );
        // Before the commit no other transaction sees the move.
        expect(await f.defaults()).toEqual([personal]);
        await held.commit();

        expect(await f.defaults()).toEqual([health]);
        expect((await f.calendars()).map((row) => row.id)).not.toContain(personal);
      }));

    it("breaks a tie of the creation time by the lowest id", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const personal = await f.calendarId("Personal");
        const sameTime = "2026-01-02T00:00:00Z";
        await f.setCreatedAt(["Work", "Family", "Health"], sameTime);
        const lowestId = [
          await f.calendarId("Work"),
          await f.calendarId("Family"),
          await f.calendarId("Health"),
        ].sort()[0];

        await f.trash(personal);

        expect(await f.defaults()).toEqual([lowestId]);
      }));

    it("leaves the default alone when another own calendar is deleted", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const personal = await f.calendarId("Personal");

        await f.trash(await f.calendarId("Family"));

        expect(await f.defaults()).toEqual([personal]);
      }));

    it("hands the mark over for an agent writer too, and the successor write is announced after the commit", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const personal = await f.calendarId("Personal");
        await f.setCreatedAt(["Family"], "2026-01-02T00:00:00Z");
        const family = await f.calendarId("Family");
        invalidations.length = 0;

        await f.trash(personal, AGENT);

        expect(await f.defaults()).toEqual([family]);
        expect(invalidations.filter((event) => event.scope === "item" && event.op === "update").length).toBeGreaterThan(
          0,
        );
        expect(invalidations).toContainEqual(
          expect.objectContaining({ scope: "item", op: "update", itemId: family, databaseId: f.calendarsId }),
        );
      }));

    it("brings the calendar back as a calendar that is not the default", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const personal = await f.calendarId("Personal");
        await f.setCreatedAt(["Work"], "2026-01-02T00:00:00Z");
        const work = await f.calendarId("Work");
        await f.trash(personal);

        await f.restore(personal);

        const restored = (await f.calendars()).find((row) => row.id === personal);
        expect(restored?.properties.isDefault).toBe(false);
        expect(await f.defaults()).toEqual([work]);
      }));

    it("does not touch a restored calendar that never held the mark", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const family = await f.calendarId("Family");
        const personal = await f.calendarId("Personal");
        await f.trash(family);
        trashes.length = 0;

        await f.restore(family);

        expect(await f.defaults()).toEqual([personal]);
        expect(trashes.filter((entry) => entry.op === "restore").map((entry) => entry.itemId)).toEqual([family]);
      }));

    it("clears the stale mark of a default calendar trashed without the hook when another calendar is the default", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const personal = await f.calendarId("Personal");
        const work = await f.calendarId("Work");
        // A default calendar in the Trash is a state of before these hooks: only a raw write reaches it now.
        await withTransaction(runtime, (client) =>
          client.query("UPDATE items SET deleted_at = now() WHERE database_id = $1 AND id = $2", [
            f.calendarsId,
            personal,
          ]),
        );
        await f.cp.updateItem(
          { databaseId: f.calendarsId, itemId: work, propertiesPatch: { isDefault: true } },
          undefined,
          undefined,
          USER,
        );

        await f.restore(personal);

        const restored = (await f.calendars()).find((row) => row.id === personal);
        expect(restored?.properties.isDefault).toBe(false);
        expect(await f.defaults()).toEqual([work]);
      }));

    it("refuses to restore a default calendar trashed without the hook while no other calendar is the default", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const personal = await f.calendarId("Personal");
        const event = await f.eventIn("Standup", personal);
        // The same state of before these hooks: the only default is in the Trash, and so is its Event.
        await withTransaction(runtime, (client) =>
          client.query("UPDATE items SET deleted_at = now() WHERE id = ANY($1::uuid[])", [[personal, event]]),
        );
        const before = await f.epochs([personal, event]);

        expect(await refusal(f.restore(personal))).toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "isDefault" },
        });
        expect(await f.epochs([personal, event])).toEqual(before);
      }));
  });

  describe("the Events of the calendar", () => {
    it("trashes the calendar and its live Events with one deletion time and restores both", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const family = await f.calendarId("Family");
        const work = await f.calendarId("Work");
        const dinner = await f.eventIn("Dinner", family);
        const trip = await f.eventIn("Trip", family);
        const standup = await f.eventIn("Standup", work);

        await f.trash(family);

        const trashed = await f.epochs([family, dinner, trip, standup]);
        expect(trashed[family]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
        expect(trashed[dinner]).toBe(trashed[family]);
        expect(trashed[trip]).toBe(trashed[family]);
        expect(trashed[standup]).toBeNull();
        expect((await f.liveEvents()).map((row) => row.id)).toEqual([standup]);

        await f.restore(family);

        expect(await f.epochs([family, dinner, trip, standup])).toEqual({
          [family]: null,
          [dinner]: null,
          [trip]: null,
          [standup]: null,
        });
        expect((await f.liveEvents()).map((row) => row.id).sort()).toEqual([dinner, trip, standup].sort());
      }));

    it("leaves an Event that was trashed earlier in the Trash with its own deletion time", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const family = await f.calendarId("Family");
        const dinner = await f.eventIn("Dinner", family);
        const trip = await f.eventIn("Trip", family);
        await f.trashEvent(trip);
        const tripEpoch = (await f.epochs([trip]))[trip];
        expect(tripEpoch).not.toBeNull();

        await f.trash(family);
        const trashed = await f.epochs([family, dinner, trip]);
        expect(trashed[trip]).toBe(tripEpoch);
        expect(trashed[dinner]).toBe(trashed[family]);

        await f.restore(family);

        expect(await f.epochs([family, dinner, trip])).toEqual({ [family]: null, [dinner]: null, [trip]: tripEpoch });
        expect((await f.liveEvents()).map((row) => row.id)).toEqual([dinner]);
      }));

    it("leaves an Event that was restored on its own and trashed again at another instant in the Trash", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const family = await f.calendarId("Family");
        const dinner = await f.eventIn("Dinner", family);
        const trip = await f.eventIn("Trip", family);
        await f.trash(family);
        // An Event of the calendar can only be restored on its own, then trashed again at another instant.
        await f.cp.restoreItem(f.eventsId, trip, undefined, USER);
        await f.trashEvent(trip);
        const tripEpoch = (await f.epochs([trip]))[trip];

        await f.restore(family);

        expect(await f.epochs([family, dinner, trip])).toEqual({ [family]: null, [dinner]: null, [trip]: tripEpoch });
      }));

    it("trashes and restores a calendar that has no Events", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const health = await f.calendarId("Health");

        await f.trash(health);
        expect((await f.epochs([health]))[health]).not.toBeNull();
        await f.restore(health);

        expect((await f.epochs([health]))[health]).toBeNull();
      }));

    it("runs the delete and restore hooks of every Event with the writer and acting user of the request", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const family = await f.calendarId("Family");
        const dinner = await f.eventIn("Dinner", family);
        const trip = await f.eventIn("Trip", family);
        trashes.length = 0;

        await f.trash(family, AGENT, ACTING_USER_ID);
        await f.restore(family, USER, ACTING_USER_ID);

        const fields = (op: "delete" | "restore") =>
          trashes
            .filter((entry) => entry.op === op)
            .map((entry) => ({
              itemId: entry.itemId,
              writerKind: entry.writerKind,
              agentRunId: entry.agentRunId,
              actingUserId: entry.actingUserId,
            }));
        expect(fields("delete").sort((a, b) => a.itemId.localeCompare(b.itemId))).toEqual(
          [family, dinner, trip]
            .map((itemId) => ({
              itemId,
              writerKind: "agent",
              agentRunId: AGENT.agentRunId,
              actingUserId: ACTING_USER_ID,
            }))
            .sort((a, b) => a.itemId.localeCompare(b.itemId)),
        );
        expect(fields("restore").sort((a, b) => a.itemId.localeCompare(b.itemId))).toEqual(
          [family, dinner, trip]
            .map((itemId) => ({ itemId, writerKind: "user", agentRunId: undefined, actingUserId: ACTING_USER_ID }))
            .sort((a, b) => a.itemId.localeCompare(b.itemId)),
        );
      }));

    it("rolls the whole delete back when the trash of an Event fails", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const personal = await f.calendarId("Personal");
        const standup = await f.eventIn("Standup", personal);
        const review = await f.eventIn("Review", personal);
        failDeleteOf = review;
        invalidations.length = 0;
        const calendarsBefore = await f.calendars();

        expect(await refusal(f.trash(personal))).toMatchObject({ message: "injected delete failure" });

        expect(await f.epochs([personal, standup, review])).toEqual({
          [personal]: null,
          [standup]: null,
          [review]: null,
        });
        expect(await f.calendars()).toEqual(calendarsBefore);
        expect(await f.defaults()).toEqual([personal]);
        expect(invalidations).toEqual([]);
      }));

    it("rolls the whole restore back when the restore of an Event fails", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const family = await f.calendarId("Family");
        const dinner = await f.eventIn("Dinner", family);
        const trip = await f.eventIn("Trip", family);
        await f.trash(family);
        const before = await f.epochs([family, dinner, trip]);
        failRestoreOf = trip;

        expect(await refusal(f.restore(family))).toMatchObject({ message: "injected restore failure" });

        expect(await f.epochs([family, dinner, trip])).toEqual(before);
      }));

    it("announces the Events after the commit only", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const family = await f.calendarId("Family");
        const dinner = await f.eventIn("Dinner", family);
        const trip = await f.eventIn("Trip", family);
        invalidations.length = 0;

        const held = await heldOpen((client) =>
          itemDeleteWithClient(client, f.calendarsId, family, {
            queueAffinity: createActionQueueAffinity(),
            writer: USER,
          }),
        );
        expect(invalidations).toEqual([]);
        await held.commit();

        const deleted = invalidations.flatMap((event) =>
          event.scope === "item" && event.op === "delete" ? [event] : [],
        );
        expect(deleted.map((event) => event.itemId).sort()).toEqual([family, dinner, trip].sort());
        expect(deleted.find((event) => event.itemId === dinner)?.databaseId).toBe(f.eventsId);
        expect(deleted.find((event) => event.itemId === family)?.databaseId).toBe(f.calendarsId);

        invalidations.length = 0;
        await f.restore(family);
        const restored = invalidations.flatMap((event) =>
          event.scope === "item" && event.op === "update" ? [event.itemId] : [],
        );
        expect(restored).toEqual(expect.arrayContaining([family, dinner, trip]));
      }));
  });

  describe("tenants", () => {
    it("answers another tenant's calendar as it answers an unknown one and trashes nothing", async () => {
      const own = await runInTenant(tenant, async () => {
        const f = await setup();
        const family = await f.calendarId("Family");
        const dinner = await f.eventIn("Dinner", family);
        return { calendarsId: f.calendarsId, family, dinner };
      });

      const answer = await runInTenant(foreign, async () => {
        const f = await setup();
        return {
          foreignCalendar: await refusal(f.cp.softDeleteItem(own.calendarsId, own.family, undefined, USER)),
          unknownCalendar: await refusal(f.cp.softDeleteItem(own.calendarsId, randomUUID(), undefined, USER)),
          defaults: await f.defaults(),
        };
      });
      expect(answer.foreignCalendar).toMatchObject({ status: 404, code: "not_found" });
      expect(answer.unknownCalendar).toMatchObject({ status: 404, code: "not_found" });
      expect(answer.defaults).toHaveLength(1);

      await runInTenant(tenant, async () => {
        const f = await setup();
        expect(await f.epochs([own.family, own.dinner])).toEqual({ [own.family]: null, [own.dinner]: null });
        expect(await f.defaults()).toHaveLength(1);
      });
    });
  });

  describe("the order of the locks", () => {
    /** Holds the advisory lock of the default mark in a transaction that stays open. */
    const holdDefaultMark = (f: Awaited<ReturnType<typeof setup>>) =>
      heldOpen((client) =>
        client.query("SELECT pg_advisory_xact_lock(hashtextextended('calendars-default:' || $1::text, 0))", [
          f.calendarsId,
        ]),
      );

    /** Whether another backend can lock the row at once; a row that a transaction holds fails `NOWAIT`. */
    async function rowIsFree(itemId: string): Promise<boolean> {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        try {
          await client.query("SELECT id FROM items WHERE id = $1 FOR UPDATE NOWAIT", [itemId]);
          return true;
        } catch (thrown) {
          if (z.object({ code: z.literal("55P03") }).safeParse(thrown).success) return false;
          throw thrown;
        } finally {
          await client.query("ROLLBACK");
        }
      } finally {
        client.release();
      }
    }

    it("makes a delete of a calendar wait for the advisory lock of the default mark before it locks the row", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const personal = await f.calendarId("Personal");
        const holder = await holdDefaultMark(f);
        const deleting = refusal(f.trash(personal));
        let rowFreeWhileWaiting: boolean;
        try {
          await waitForDefaultMarkLockWaiter();
          // A delete that locked the row first would hold it here, while it waits for the lock, and a switch of
          // the default that holds the lock and has to clear Personal would wait for it: a deadlock.
          rowFreeWhileWaiting = await rowIsFree(personal);
        } finally {
          await holder.commit();
          await deleting;
        }
        expect(rowFreeWhileWaiting).toBe(true);
        expect(await deleting).toBeUndefined();
        expect(await f.defaults()).toHaveLength(1);
        expect((await f.calendars()).map((row) => row.id)).not.toContain(personal);
      }));

    it("makes a restore of a calendar wait for the advisory lock of the default mark before it locks the row", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const family = await f.calendarId("Family");
        await f.trash(family);
        const holder = await holdDefaultMark(f);
        const restoring = refusal(f.restore(family));
        let rowFreeWhileWaiting: boolean;
        try {
          await waitForDefaultMarkLockWaiter();
          rowFreeWhileWaiting = await rowIsFree(family);
        } finally {
          await holder.commit();
          await restoring;
        }
        expect(rowFreeWhileWaiting).toBe(true);
        expect(await restoring).toBeUndefined();
        expect((await f.calendars()).map((row) => row.id)).toContain(family);
      }));

    it("makes a delete of the calendar a switch clears wait for the advisory lock, not for the row", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const personal = await f.calendarId("Personal");
        const work = await f.calendarId("Work");
        // Holds the lock, the row of Work and, after clearing it, the row of Personal.
        const switched = await heldOpen((client) =>
          updateItemWithClient(
            client,
            { databaseId: f.calendarsId, itemId: work, propertiesPatch: { isDefault: true } },
            { writer: USER },
          ),
        );
        const deleting = refusal(f.trash(personal));
        try {
          await waitForDefaultMarkLockWaiter();
        } finally {
          await switched.commit();
          await deleting;
        }
        expect(await deleting).toBeUndefined();
        // The delete took the lock last, found Personal no longer the default and left Work the one default.
        expect(await f.defaults()).toEqual([work]);
        expect((await f.calendars()).map((row) => row.id)).not.toContain(personal);
      }));

    it("ends no delete or restore of a calendar and no write of isDefault with a deadlock", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const family = await f.calendarId("Family");
        const work = await f.calendarId("Work");
        for (let round = 0; round < 4; round += 1) {
          const personal = await f.calendarId("Personal");
          const outcomes = await Promise.all([
            refusal(f.trash(personal)),
            refusal(
              withTransaction(runtime, (client) =>
                updateItemWithClient(
                  client,
                  { databaseId: f.calendarsId, itemId: work, propertiesPatch: { isDefault: true } },
                  { writer: USER },
                ),
              ),
            ),
            refusal(f.trash(family)),
          ]);
          for (const outcome of outcomes) {
            // A refusal by a domain rule is not a failure of the lock order; a deadlock error is.
            if (outcome !== undefined) expect(outcome).not.toMatchObject({ code: "40P01" });
          }
          await f.restore(personal);
          await f.restore(family);
          expect(await f.defaults()).toHaveLength(1);
        }
      }));
  });

  describe("concurrent deletes", () => {
    it("lets only one of two concurrent deletes of the last two own calendars succeed", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        for (const name of ["Work", "Health"]) await f.trash(await f.calendarId(name));
        const personal = await f.calendarId("Personal");
        const family = await f.calendarId("Family");

        // Family's delete has trashed its row and holds the lock of the default mark, uncommitted.
        const first = await heldOpen((client) =>
          itemDeleteWithClient(client, f.calendarsId, family, {
            queueAffinity: createActionQueueAffinity(),
            writer: USER,
          }),
        );
        const second = refusal(f.trash(personal));
        await waitForDefaultMarkLockWaiter();
        await first.commit();

        expect(await second).toMatchObject(LAST_OWN);
        expect((await f.calendars()).map((row) => row.id)).toContain(personal);
        expect((await f.calendars()).map((row) => row.id)).not.toContain(family);
      }));
  });
});
