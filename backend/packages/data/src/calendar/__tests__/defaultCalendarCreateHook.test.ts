import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { registerRelationEdgeWriteHook } from "../../chokePoint/hooks.js";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import type { WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { ChokePointError } from "../../errors.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { CALENDAR_MODULE_ID } from "../calendarModuleId.js";
import { createEventInCalendar, withChosenCalendar } from "../defaultCalendarCreateHook.js";
import { logger } from "../logger.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: randomUUID() };
const EVENT = { name: "Client meeting", date: "2026-11-16" };

const calendarRow = z.object({ id: z.string(), properties: z.object({ name: z.string() }).passthrough() });

/** The writer kind of every Events.calendar edge write the choke point ran in this file, in order. */
const calendarEdgeWriters: string[] = [];
registerRelationEdgeWriteHook(async ({ edgeContext, writer }) => {
  if (edgeContext.property.key === "calendar") calendarEdgeWriters.push(writer.writerKind);
});

/** A tenant with one English-speaking user, so its seeded calendars are named `Personal`, `Work` and so on. */
async function seededTenant(): Promise<string> {
  const tenantId = await createTestTenant(admin);
  await createUser(admin, { tenantId, email: `${randomUUID()}@example.com`, passwordHash: "unused", locale: "en" });
  await runInTenant(tenantId, () => seedSystem(runtime));
  return tenantId;
}

/** Resolves once a backend of this database waits for a row lock in a `FOR SHARE` read; read through `pg_stat_activity`. */
async function waitForShareLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const { rows } = await admin.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR SHARE%'`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("No read waited for a calendar row lock");
}

describe("default calendar create hook (issue #1761)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await seededTenant();
    foreign = await seededTenant();
    calendarEdgeWriters.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /** The ids and reads of the tenant in scope; every write of a test goes through the choke point. */
  async function setup() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const row = databases.find((d) => d.ownerModuleId === key);
      if (!row) throw new Error(`Missing ${key}`);
      return row.id;
    };
    const eventCalendar = (await cp.listProperties(db("events"))).find((p) => p.key === "calendar");
    if (!eventCalendar) throw new Error("Missing Events.calendar");
    const calendars = z.array(calendarRow).parse((await cp.listItems(db(CALENDARS_MODULE_ID), { limit: 50 })).items);
    const calendar = (name: string) => {
      const row = calendars.find((candidate) => candidate.properties.name === name);
      if (!row) throw new Error(`Missing calendar ${name}`);
      return row.id;
    };
    /** The calendars the Event is linked to: exactly one id for an Event that belongs to one calendar. */
    const calendarsOf = async (eventId: string) =>
      ((await cp.listItemRelations(eventId, eventCalendar.id)) ?? []).map((entry) => entry.targetItemId);
    /** The Events a calendar holds, read from the calendar's side. */
    const eventsIn = async (calendarId: string) =>
      ((await cp.listItemRelations(calendarId)) ?? []).map((entry) => entry.targetItemId);
    const eventIds = async () => (await cp.listItems(db("events"), { limit: 50 })).items.map((item) => item.id);
    const create = (writer: WriterIdentity | undefined = USER) =>
      cp.createItem({ databaseId: db("events"), properties: EVENT }, undefined, undefined, writer);
    const createIn = (calendarId: string, input: { properties?: Record<string, unknown>; idempotencyKey?: string }) =>
      withTransaction(runtime, (client) => createEventInCalendar(client, input, calendarId, { writer: USER }));
    return { cp, db, calendar, calendarsOf, eventsIn, eventIds, create, createIn };
  }

  /**
   * Runs `change` in a transaction that stays open until the returned `commit` is called, and resolves
   * once `change` has run, so the caller starts its own write while the change is uncommitted.
   */
  async function heldOpen(change: (client: PoolClient) => Promise<void>): Promise<{ commit: () => Promise<void> }> {
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

  it.each([
    ["a user", USER],
    ["an agent", AGENT],
    ["the system writer", undefined],
  ])("links an Event created by %s to the default calendar and to no other", (_label, writer) =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const event = await f.cp.createItem(
        { databaseId: f.db("events"), properties: EVENT },
        undefined,
        undefined,
        writer,
      );
      expect(await f.calendarsOf(event.id)).toEqual([f.calendar("Personal")]);
      expect(await f.eventsIn(f.calendar("Personal"))).toEqual([event.id]);
      // The server assigns the calendar: the edge is a system write whoever created the Event.
      expect(calendarEdgeWriters).toEqual(["system"]);
    }),
  );

  it("links an Event created with createEventInCalendar for Work to Work only", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const event = await f.createIn(f.calendar("Work"), { properties: EVENT });
      expect(await f.calendarsOf(event.id)).toEqual([f.calendar("Work")]);
      expect(await f.eventsIn(f.calendar("Work"))).toEqual([event.id]);
      expect(await f.eventsIn(f.calendar("Personal"))).toEqual([]);
      expect(event.properties).toMatchObject(EVENT);
    }));

  it("accepts a chosen calendar that has no kind", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      // A calendar the user adds has no `kind`: the key is system-owned and a user write cannot set it.
      const mine = await f.cp.createItem(
        { databaseId: f.db(CALENDARS_MODULE_ID), properties: { name: "Club" } },
        undefined,
        undefined,
        USER,
      );
      expect(mine.properties.kind).toBeUndefined();
      const event = await f.createIn(mine.id, { properties: EVENT });
      expect(await f.calendarsOf(event.id)).toEqual([mine.id]);
    }));

  it.each([null, ""])("accepts a chosen calendar whose stored kind is %j", (kind) =>
    runInTenant(tenant, async () => {
      const f = await setup();
      // `kind` is written by the calendar module only, so the fixture writes it as that owner process.
      const calendar = await withTransaction(runtime, (client) =>
        createItemWithClient(
          client,
          { databaseId: f.db(CALENDARS_MODULE_ID), properties: { name: "Club", kind } },
          { allowedSystemKeys: ["kind"], systemOwnerProcess: CALENDAR_MODULE_ID },
        ),
      );
      expect(calendar.properties.kind).toBe(kind);
      const event = await f.createIn(calendar.id, { properties: EVENT });
      expect(await f.calendarsOf(event.id)).toEqual([calendar.id]);
    }),
  );

  describe("a chosen calendar that is refused", () => {
    const refusal = { status: 400, code: "validation_failed", details: { field: "calendarId" } };

    it.each(["system", "subscription", "trashed", "unknown", "foreign", "malformed"] as const)(
      "refuses a %s calendar with validation_failed on calendarId and stores no Event",
      async (kind) => {
        const foreignWork = await runInTenant(foreign, async () => (await setup()).calendar("Work"));
        await runInTenant(tenant, async () => {
          const f = await setup();
          const chosen = async (): Promise<string> => {
            switch (kind) {
              case "system":
                return f.calendar("Birthdays");
              case "subscription": {
                // `kind` is written by the calendar module only, so the fixture writes it as that owner process.
                const item = await withTransaction(runtime, (client) =>
                  createItemWithClient(
                    client,
                    { databaseId: f.db(CALENDARS_MODULE_ID), properties: { name: "Feed", kind: "subscription" } },
                    { allowedSystemKeys: ["kind"], systemOwnerProcess: CALENDAR_MODULE_ID },
                  ),
                );
                return item.id;
              }
              case "trashed": {
                await f.cp.softDeleteItem(f.db(CALENDARS_MODULE_ID), f.calendar("Family"));
                return f.calendar("Family");
              }
              case "unknown":
                return randomUUID();
              case "foreign":
                return foreignWork;
              case "malformed":
                return "not-a-uuid";
            }
          };
          const calendarId = await chosen();
          const error: unknown = await f.createIn(calendarId, { properties: EVENT }).then(
            () => undefined,
            (thrown: unknown) => thrown,
          );
          expect(error).toMatchObject(refusal);
          // Every refusal reads alike, so another tenant's calendar cannot be told from an unknown id.
          expect(error).toMatchObject({
            message: "The chosen calendar must be one of the tenant's own live calendars",
          });
          expect(await f.eventIds()).toEqual([]);
          expect(await f.eventsIn(f.calendar("Personal"))).toEqual([]);
          expect(calendarEdgeWriters).toEqual([]);
        });
        // The other tenant's calendar holds nothing either.
        await runInTenant(foreign, async () => expect(await (await setup()).eventsIn(foreignWork)).toEqual([]));
      },
    );

    it("waits for an uncommitted trash of the chosen calendar and then refuses it", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const trash = await heldOpen(async (client) => {
          await itemDeleteWithClient(client, f.db(CALENDARS_MODULE_ID), f.calendar("Work"), {
            queueAffinity: createActionQueueAffinity(),
          });
        });
        // Starts while the trash is uncommitted: a read without the row lock would see a live calendar.
        const create = f.createIn(f.calendar("Work"), { properties: EVENT }).then(
          () => "stored",
          (thrown: unknown) => thrown,
        );
        try {
          await waitForShareLockWaiter();
        } finally {
          await trash.commit();
        }
        expect(await create).toMatchObject(refusal);
        expect(await f.eventIds()).toEqual([]);
        expect(await f.eventsIn(f.calendar("Work"))).toEqual([]);
      }));
  });

  describe("an idempotent replay", () => {
    it("adds no second edge when a create is replayed with the same idempotency key", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const input = { databaseId: f.db("events"), properties: EVENT, idempotencyKey: randomUUID() };
        const first = await f.cp.createItem(input, undefined, undefined, USER);
        const replayed = await f.cp.createItem(input, undefined, undefined, USER);
        expect(replayed.id).toBe(first.id);
        expect(await f.eventIds()).toEqual([first.id]);
        expect(await f.calendarsOf(first.id)).toEqual([f.calendar("Personal")]);
        expect(calendarEdgeWriters).toEqual(["system"]);
      }));

    it("returns the Event with the calendar it has when createEventInCalendar is replayed, whatever calendar the replay names", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const idempotencyKey = randomUUID();
        const first = await f.createIn(f.calendar("Work"), { properties: EVENT, idempotencyKey });
        for (const calendarId of [f.calendar("Work"), f.calendar("Family"), randomUUID()]) {
          const replayed = await f.createIn(calendarId, { properties: EVENT, idempotencyKey });
          expect(replayed.id).toBe(first.id);
        }
        expect(await f.eventIds()).toEqual([first.id]);
        expect(await f.calendarsOf(first.id)).toEqual([f.calendar("Work")]);
        expect(await f.eventsIn(f.calendar("Family"))).toEqual([]);
        expect(calendarEdgeWriters).toEqual(["system"]);
      }));
  });

  describe("the chosen-calendar scope", () => {
    it("applies to the Events inserted inside it, an inner scope before the outer one, and not outside", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const [outer, inner, after] = await withChosenCalendar(f.calendar("Work"), async () => {
          const first = await f.create();
          const second = await withChosenCalendar(f.calendar("Family"), () => f.create());
          return [first, second, await f.create()];
        });
        const outside = await f.create();
        expect(await f.calendarsOf(outer.id)).toEqual([f.calendar("Work")]);
        expect(await f.calendarsOf(inner.id)).toEqual([f.calendar("Family")]);
        expect(await f.calendarsOf(after.id)).toEqual([f.calendar("Work")]);
        expect(await f.calendarsOf(outside.id)).toEqual([f.calendar("Personal")]);
      }));

    it("leaves an item of another database alone, also inside a scope", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const person = await withChosenCalendar(randomUUID(), () =>
          f.cp.createItem({ databaseId: f.db("people"), properties: { name: "Petr" } }, undefined, undefined, USER),
        );
        expect(await f.cp.listItemRelations(person.id)).toEqual([]);
        expect(calendarEdgeWriters).toEqual([]);
      }));
  });

  describe("a create that fails", () => {
    it("leaves no Event and no edge when a later step of the same transaction fails", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const failure = new Error("a later step failed");
        let linkedInside: string[] = [];
        await expect(
          withTransaction(runtime, async (client) => {
            const event = await createItemWithClient(client, { databaseId: f.db("events"), properties: EVENT });
            const { rows } = await client.query<{ item_a: string }>(
              "SELECT item_a FROM item_relations WHERE item_b = $1",
              [event.id],
            );
            linkedInside = rows.map((row) => row.item_a);
            throw failure;
          }),
        ).rejects.toBe(failure);
        // The hook had written the edge inside the transaction, so its absence afterwards is the rollback.
        expect(linkedInside).toEqual([f.calendar("Personal")]);
        expect(await f.eventIds()).toEqual([]);
        expect(await f.eventsIn(f.calendar("Personal"))).toEqual([]);
      }));

    it("leaves no Event and no edge when the Events rules refuse the Event", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await expect(
          f.cp.createItem({ databaseId: f.db("events"), properties: { name: "No date" } }, undefined, undefined, USER),
        ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "date" } });
        expect(await f.eventIds()).toEqual([]);
        expect(await f.eventsIn(f.calendar("Personal"))).toEqual([]);
        expect(calendarEdgeWriters).toEqual([]);
      }));
  });

  describe("the default calendar", () => {
    it("fails the create with a server error and one log line of ids when no live calendar is the default", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
        await f.cp.softDeleteItem(f.db(CALENDARS_MODULE_ID), f.calendar("Personal"));

        const error: unknown = await f.create().then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ChokePointError);
        expect(error).toMatchObject({ message: "The tenant has no live default calendar" });
        expect(await f.eventIds()).toEqual([]);
        expect(errorLog).toHaveBeenCalledTimes(1);
        expect(errorLog).toHaveBeenCalledWith(
          { calendarsDatabaseId: f.db(CALENDARS_MODULE_ID), eventId: expect.any(String) },
          "default_calendar_missing",
        );
        expect(JSON.stringify(errorLog.mock.calls)).not.toContain(EVENT.name);

        // A chosen calendar does not need the default.
        const event = await f.createIn(f.calendar("Work"), { properties: EVENT });
        expect(await f.calendarsOf(event.id)).toEqual([f.calendar("Work")]);
      }));

    it("takes the lowest id when two live calendars are marked default", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const second = await f.cp.createItem(
          { databaseId: f.db(CALENDARS_MODULE_ID), properties: { name: "Second default", isDefault: true } },
          undefined,
          undefined,
          USER,
        );
        const [lowest] = [f.calendar("Personal"), second.id].sort();
        const event = await f.create();
        expect(await f.calendarsOf(event.id)).toEqual([lowest]);
      }));

    it("waits for an uncommitted move of the default mark and links the calendar that holds it afterwards", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const calendarsId = f.db(CALENDARS_MODULE_ID);
        const move = await heldOpen(async (client) => {
          for (const [name, isDefault] of [
            ["Personal", false],
            ["Work", true],
          ] as const) {
            await updateItemWithClient(
              client,
              { databaseId: calendarsId, itemId: f.calendar(name), propertiesPatch: { isDefault } },
              { writer: USER },
            );
          }
        });
        // Starts while the move is uncommitted: its first read finds Personal marked and waits for that row.
        const create = f.create();
        try {
          await waitForShareLockWaiter();
        } finally {
          await move.commit();
        }
        const event = await create;
        expect(await f.calendarsOf(event.id)).toEqual([f.calendar("Work")]);
        expect(await f.eventsIn(f.calendar("Personal"))).toEqual([]);
      }));
  });

  describe("a tenant whose calendars are incomplete", () => {
    /**
     * Removes the `Calendars.events` / `Events.calendar` relation of the tenant, and with `dropCalendars` the
     * calendars database, its rows and its system project too: the state of a tenant seeded before issue #1600.
     * The schema is locked and system-owned and no public path removes it, so this runs in the tenant's scope
     * on the admin pool; that pool bypasses row-level security, so every statement names the tenant's own ids.
     */
    async function removeCalendars(tenantId: string, dropCalendars: boolean): Promise<void> {
      const calendarsId = await runInTenant(tenantId, async () => {
        const database = await withTransaction(runtime, (client) =>
          databasesStore.getDatabaseByModuleId(client, CALENDARS_MODULE_ID),
        );
        return database?.id;
      });
      if (!calendarsId) throw new Error("Calendars database missing");
      await withTenantTransaction(admin, tenantId, async (client) => {
        const calendars = await databasesStore.getDatabase(client, calendarsId);
        if (!calendars) throw new Error("Calendars database missing");
        const { rows } = await client.query<{ id: string; definition: string }>(
          `SELECT p.id, p.config->>'relationDefinitionId' AS definition FROM properties p
             JOIN databases d ON d.id = p.database_id
            WHERE d.tenant_id = $1 AND d.owner_module_id = 'events' AND p.key = 'calendar'`,
          [tenantId],
        );
        const relation = rows[0];
        if (!relation) throw new Error("Events.calendar missing");
        await client.query("DELETE FROM item_relations WHERE relation_definition_id = $1", [relation.definition]);
        await client.query("DELETE FROM relation_definitions WHERE id = $1", [relation.definition]);
        await client.query("DELETE FROM properties WHERE id = $1", [relation.id]);
        await client.query("DELETE FROM properties WHERE database_id = $1 AND key = 'events'", [calendars.id]);
        if (!dropCalendars) return;
        await client.query("DELETE FROM items WHERE database_id = $1", [calendars.id]);
        await client.query("DELETE FROM properties WHERE database_id = $1", [calendars.id]);
        await client.query("DELETE FROM views WHERE database_id = $1", [calendars.id]);
        await databasesStore.dropDatabaseWithPartition(client, calendars.id);
        await client.query("DELETE FROM items WHERE id = $1", [calendars.ownerProjectItemId]);
      });
    }

    it("creates Events normally, without a calendar, in a tenant that has no calendars database", async () => {
      const ids = await runInTenant(tenant, async () => {
        const f = await setup();
        return { events: f.db("events"), work: f.calendar("Work") };
      });
      await removeCalendars(tenant, true);
      await runInTenant(tenant, async () => {
        const cp = createChokePoint(runtime);
        const event = await cp.createItem({ databaseId: ids.events, properties: EVENT }, undefined, undefined, USER);
        // With no calendars database the hook writes nothing, so a chosen calendar is not looked at either.
        const chosen = await withTransaction(runtime, (client) =>
          createEventInCalendar(client, { properties: EVENT }, ids.work, { writer: USER }),
        );
        for (const created of [event, chosen]) {
          expect(created.properties).toMatchObject(EVENT);
          expect(await cp.listItemRelations(created.id)).toEqual([]);
        }
        expect(calendarEdgeWriters).toEqual([]);
      });
      // The other tenant keeps its calendars and its default.
      await runInTenant(foreign, async () => {
        const f = await setup();
        const event = await f.create();
        expect(await f.calendarsOf(event.id)).toEqual([f.calendar("Personal")]);
      });
    });

    it("fails the create when the calendars database exists without the Events calendar relation", async () => {
      const events = await runInTenant(tenant, async () => (await setup()).db("events"));
      await removeCalendars(tenant, false);
      await runInTenant(tenant, async () => {
        const cp = createChokePoint(runtime);
        const error: unknown = await cp
          .createItem({ databaseId: events, properties: EVENT }, undefined, undefined, USER)
          .then(
            () => undefined,
            (thrown: unknown) => thrown,
          );
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ChokePointError);
        expect(error).toMatchObject({ message: "Events 'calendar' relation not found" });
        expect((await cp.listItems(events, { limit: 50 })).items).toEqual([]);
      });
    });

    it("answers not_found for createEventInCalendar in a tenant without an Events database", async () => {
      const unseeded = await createTestTenant(admin);
      await runInTenant(unseeded, async () => {
        await expect(
          withTransaction(runtime, (client) => createEventInCalendar(client, { properties: EVENT }, randomUUID())),
        ).rejects.toMatchObject({ status: 404, code: "not_found" });
      });
    });
  });
});
