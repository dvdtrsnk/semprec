import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { registerItemUpdateHook } from "../../chokePoint/hooks.js";
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
import { calendarItemCreateHook, calendarItemUpdateHook } from "../calendarRowHooks.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: randomUUID() };

const calendarRow = z.object({
  id: z.string(),
  updatedAt: z.string(),
  properties: z
    .object({
      name: z.string(),
      color: z.string().optional(),
      notify: z.boolean().optional(),
      hidden: z.boolean().optional(),
      isDefault: z.boolean().nullable().optional(),
      kind: z.string().optional(),
      systemKey: z.string().optional(),
    })
    .passthrough(),
});

const FORBIDDEN_NAME = { status: 403, code: "forbidden", details: { field: "name" } };
const INVALID_COLOR = { status: 400, code: "validation_failed", details: { field: "color" } };
const INVALID_DEFAULT = { status: 400, code: "validation_failed", details: { field: "isDefault" } };
/** The refusal of a mark on a system or subscription calendar, as distinct from the refusal to leave no default. */
const NOT_AN_OWN_CALENDAR = {
  ...INVALID_DEFAULT,
  message: "A system or subscription calendar cannot be the default calendar",
};
const NO_DEFAULT_LEFT = {
  ...INVALID_DEFAULT,
  message: "One of the user's own calendars must stay the default calendar",
};

/** Every item update the choke point ran its hooks for in this file, in the order the hooks finished. */
const updates: Array<{ itemId: string; writerKind: string; patch: Record<string, unknown> }> = [];
/** The item whose update the recording hook below fails, standing for a later step of a write that fails. */
let failUpdateOf: string | undefined;
registerItemUpdateHook(async ({ item, writer, propertiesPatch }) => {
  updates.push({ itemId: item.id, writerKind: writer.writerKind, patch: propertiesPatch });
  if (item.id === failUpdateOf) throw new Error("injected update failure");
});

/** A tenant with one English-speaking user, so its seeded calendars are named `Personal`, `Work` and so on. */
async function seededTenant(): Promise<string> {
  const tenantId = await createTestTenant(admin);
  await createUser(admin, { tenantId, email: `${randomUUID()}@example.com`, passwordHash: "unused", locale: "en" });
  await runInTenant(tenantId, () => seedSystem(runtime));
  return tenantId;
}

/** The statement of the hooks that takes the advisory lock of the default mark, as `pg_stat_activity` shows it. */
const DEFAULT_MARK_LOCK = "%pg_advisory_xact_lock(hashtextextended('calendars-default:'%";
/** The statement of the hooks that reads and locks the other calendars marked default. */
const OTHER_DEFAULTS_READ = "%AS kind FROM items%FOR UPDATE%";

/**
 * Resolves once a backend of this database waits for a lock in a statement like one of `statements`, with the
 * kind of lock it waits for (`advisory` for an advisory lock); read through `pg_stat_activity`.
 */
async function waitForLockWaiter(statements: string[]): Promise<string | null> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const { rows } = await admin.query<{ wait_event: string | null }>(
      `SELECT wait_event FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ANY($1::text[])
       ORDER BY pid`,
      [statements],
    );
    if (rows[0]) return rows[0].wait_event;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No statement like ${statements.join(" or ")} waited for a lock`);
}

/** The error a write was refused with, or `undefined` when it was stored. */
function refusal(write: Promise<unknown>): Promise<unknown> {
  return write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

/** The value `settled` resolves with, or `"waited"` when it has not resolved after five seconds. */
function withinFiveSeconds<T>(settled: Promise<T>): Promise<T | "waited"> {
  return Promise.race([settled, new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 5000))]);
}

describe("calendar row hooks (issue #1778)", () => {
  const invalidations: InvalidationEvent[] = [];

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await seededTenant();
    foreign = await seededTenant();
    updates.length = 0;
    failUpdateOf = undefined;
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

  /** The calendars of the tenant in scope and its writes; every write of a test goes through the choke point. */
  async function setup() {
    const cp = createChokePoint(runtime);
    const calendars = (await cp.listDatabases()).find((database) => database.ownerModuleId === CALENDARS_MODULE_ID);
    if (!calendars) throw new Error("Missing the calendars database");
    const calendarsId = calendars.id;
    /** The live calendars, read again on every call. */
    const rows = async () => z.array(calendarRow).parse((await cp.listItems(calendarsId, { limit: 50 })).items);
    const seeded = await rows();
    const id = (name: string) => {
      const row = seeded.find((candidate) => candidate.properties.name === name);
      if (!row) throw new Error(`Missing calendar ${name}`);
      return row.id;
    };
    const row = async (calendarId: string) => {
      const found = (await rows()).find((candidate) => candidate.id === calendarId);
      if (!found) throw new Error(`Calendar ${calendarId} is not live`);
      return found;
    };
    /** The ids of the live calendars whose `isDefault` is true, sorted. */
    const defaults = async () =>
      (await rows())
        .filter((candidate) => candidate.properties.isDefault === true)
        .map((candidate) => candidate.id)
        .sort();
    const patch = (calendarId: string, propertiesPatch: Record<string, unknown>, writer: WriterIdentity = USER) =>
      cp.updateItem({ databaseId: calendarsId, itemId: calendarId, propertiesPatch }, undefined, undefined, writer);
    const create = (properties: Record<string, unknown>, writer: WriterIdentity = USER) =>
      cp.createItem({ databaseId: calendarsId, properties }, undefined, undefined, writer);
    /** A calendar of another `kind`. The key is written by the calendar module only, so the fixture writes it as that owner process. */
    const createOfKind = (kind: string, properties: Record<string, unknown>) =>
      withTransaction(runtime, (client) =>
        createItemWithClient(
          client,
          { databaseId: calendarsId, properties: { ...properties, kind } },
          { allowedSystemKeys: ["kind"], systemOwnerProcess: CALENDAR_MODULE_ID },
        ),
      );
    /**
     * Marks a calendar default without the hooks. Several defaults, or a default system calendar, are states the
     * choke point no longer produces; a tenant can hold them from before these rules.
     */
    const markDefaultWithoutHooks = async (calendarId: string) => {
      const result = await withTransaction(runtime, (client) =>
        client.query(
          `UPDATE items SET properties = properties || '{"isDefault": true}'::jsonb WHERE database_id = $1 AND id = $2`,
          [calendarsId, calendarId],
        ),
      );
      expect(result.rowCount).toBe(1);
    };
    return { cp, calendarsId, rows, row, id, defaults, patch, create, createOfKind, markDefaultWithoutHooks };
  }

  /**
   * Runs `change` in a transaction that stays open until the returned `commit` is called, and resolves
   * once `change` has run, so the caller starts its own write while the change is uncommitted.
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

  describe("the name", () => {
    it.each(["Birthdays", "Public holidays - Czechia"])("refuses to rename the system calendar %s", (name) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.row(f.id(name));
        expect(before.properties.kind).toBe("system");

        expect(await refusal(f.patch(before.id, { name: "Mine" }))).toMatchObject(FORBIDDEN_NAME);
        expect(await f.row(before.id)).toEqual(before);
      }),
    );

    it("refuses to rename a subscription calendar", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const feed = await f.createOfKind("subscription", { name: "Feed", color: "#8E8E93" });
        const before = await f.row(feed.id);

        expect(await refusal(f.patch(feed.id, { name: "Renamed feed" }))).toMatchObject(FORBIDDEN_NAME);
        expect(await f.row(feed.id)).toEqual(before);
      }));

    it.each([
      ["a user", USER],
      ["an agent", AGENT],
      ["the system writer", undefined],
    ])("refuses the rename of a system calendar by %s", (_label, writer) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const error = await refusal(
          f.cp.updateItem(
            { databaseId: f.calendarsId, itemId: f.id("Sleep"), propertiesPatch: { name: "Rest" } },
            undefined,
            undefined,
            writer,
          ),
        );
        expect(error).toMatchObject(FORBIDDEN_NAME);
        expect((await f.row(f.id("Sleep"))).properties.name).toBe("Sleep");
      }),
    );

    it("refuses a patch that sends the stored name of a system calendar again", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.row(f.id("Tasks"));

        expect(await refusal(f.patch(before.id, { name: "Tasks", hidden: true }))).toMatchObject(FORBIDDEN_NAME);
        expect(await f.row(before.id)).toEqual(before);
      }));

    it("renames the own calendar Work", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.patch(f.id("Work"), { name: "Office" });
        expect((await f.row(f.id("Work"))).properties.name).toBe("Office");
      }));

    it("renames a calendar the user created, which has no kind", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const club = await f.create({ name: "Club", color: "#FF9500" });
        expect(club.properties.kind).toBeUndefined();

        await f.patch(club.id, { name: "Chess club" });
        expect((await f.row(club.id)).properties.name).toBe("Chess club");
      }));

    it("changes color, hidden and notify of a system and of a subscription calendar", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const feed = await f.createOfKind("subscription", { name: "Feed", color: "#8E8E93" });
        for (const calendarId of [f.id("Birthdays"), feed.id]) {
          await f.patch(calendarId, { color: "#FF9500", hidden: true, notify: false });
          expect((await f.row(calendarId)).properties).toMatchObject({
            color: "#FF9500",
            hidden: true,
            notify: false,
          });
        }
        expect((await f.row(f.id("Birthdays"))).properties.name).toBe("Birthdays");
      }));
  });

  describe("the colour", () => {
    it.each(["#FF9500", "#ff9500"])("stores the colour %s on update and on create", (color) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.patch(f.id("Work"), { color });
        expect((await f.row(f.id("Work"))).properties.color).toBe(color);

        const created = await f.create({ name: "Club", color });
        expect((await f.row(created.id)).properties.color).toBe(color);
      }),
    );

    it.each(["blue", "#FFF"])("answers the colour %j with validation_failed on color and stores nothing", (color) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.rows();

        expect(await refusal(f.patch(f.id("Work"), { color }))).toMatchObject(INVALID_COLOR);
        expect(await refusal(f.create({ name: "Club", color }))).toMatchObject(INVALID_COLOR);
        expect(await f.rows()).toEqual(before);
      }),
    );

    it("refuses to remove a calendar's colour, which the generic colour check allows", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.rows();
        const message = "Property 'color' of a calendar must be a color in #RRGGBB format";

        expect(await refusal(f.patch(f.id("Work"), { color: null }))).toMatchObject({ ...INVALID_COLOR, message });
        expect(await refusal(f.create({ name: "Club", color: null }))).toMatchObject({ ...INVALID_COLOR, message });
        expect(await f.rows()).toEqual(before);
      }));

    it("creates a calendar without a colour", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const created = await f.create({ name: "Club" });
        expect((await f.row(created.id)).properties.color).toBeUndefined();
      }));

    // The choke point's generic colour check answers a malformed string before the hooks run; these cases call
    // the hooks themselves, so the rule they hold is judged on its own.
    it.each(["blue", "#FFF", "#GGGGGG", "#FF95001", "FF9500", 16750848, null])(
      "refuses the colour %j in the update hook and in the create hook themselves",
      (color) =>
        runInTenant(tenant, async () => {
          const f = await setup();
          const item = await f.cp.getItem(f.calendarsId, f.id("Work"));
          if (!item) throw new Error("Missing Work");
          await withTransaction(runtime, async (client) => {
            const database = await databasesStore.getDatabase(client, f.calendarsId);
            if (!database) throw new Error("Missing the calendars database");
            await expect(
              calendarItemUpdateHook({ client, database, item, propertiesPatch: { color }, writer: USER }),
            ).rejects.toMatchObject(INVALID_COLOR);
            await expect(
              calendarItemCreateHook({ client, database, item, properties: { name: "Club", color }, writer: USER }),
            ).rejects.toMatchObject(INVALID_COLOR);
          });
        }),
    );

    it.each(["#FF9500", "#ff9500", "#0a1B2c"])("accepts the colour %s in both hooks themselves", (color) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const item = await f.cp.getItem(f.calendarsId, f.id("Work"));
        if (!item) throw new Error("Missing Work");
        await withTransaction(runtime, async (client) => {
          const database = await databasesStore.getDatabase(client, f.calendarsId);
          if (!database) throw new Error("Missing the calendars database");
          await calendarItemUpdateHook({ client, database, item, propertiesPatch: { color }, writer: USER });
          await calendarItemCreateHook({ client, database, item, properties: { name: "Club", color }, writer: USER });
        });
      }),
    );
  });

  describe("the default calendar", () => {
    it("starts with Personal as the only default", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        expect(await f.defaults()).toEqual([f.id("Personal")]);
      }));

    it.each([
      ["a user", USER],
      ["an agent", AGENT],
    ])("makes Work the default for %s and clears Personal as the same writer", (_label, writer) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.patch(f.id("Work"), { isDefault: true }, writer);

        expect(await f.defaults()).toEqual([f.id("Work")]);
        expect((await f.row(f.id("Personal"))).properties.isDefault).toBe(false);
        // The hook wrote Personal through the choke point: its update ran the update hooks, as the outer writer.
        expect(updates).toHaveLength(2);
        expect(updates).toEqual(
          expect.arrayContaining([
            { itemId: f.id("Work"), writerKind: writer.writerKind, patch: { isDefault: true } },
            { itemId: f.id("Personal"), writerKind: writer.writerKind, patch: { isDefault: false } },
          ]),
        );
        // Both rows are announced, so a client that holds Personal learns that it lost the mark.
        const announced = invalidations.flatMap((event) =>
          event.scope === "item" && event.op === "update" ? [event.itemId] : [],
        );
        expect(announced.sort()).toEqual([f.id("Work"), f.id("Personal")].sort());
      }),
    );

    it("clears Personal in the transaction that marks Work, so a later failure undoes both", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const marked = withTransaction(runtime, async (client) => {
          await updateItemWithClient(
            client,
            { databaseId: f.calendarsId, itemId: f.id("Work"), propertiesPatch: { isDefault: true } },
            { writer: USER },
          );
          const { rows } = await client.query<{ id: string }>(
            `SELECT id FROM items WHERE database_id = $1 AND properties->'isDefault' = 'true'::jsonb`,
            [f.calendarsId],
          );
          expect(rows.map((row) => row.id)).toEqual([f.id("Work")]);
          throw new Error("a later step failed");
        });
        await expect(marked).rejects.toThrow("a later step failed");

        expect(await f.defaults()).toEqual([f.id("Personal")]);
        expect((await f.row(f.id("Work"))).properties.isDefault).toBe(false);
        expect(invalidations).toEqual([]);
      }));

    it("stores neither change when the clearing of the previous default fails", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.rows();
        failUpdateOf = f.id("Personal");

        expect(await refusal(f.patch(f.id("Work"), { isDefault: true }))).toMatchObject({
          message: "injected update failure",
        });
        expect(await f.rows()).toEqual(before);
        expect(invalidations).toEqual([]);
      }));

    it("keeps the default when it is marked again", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.patch(f.id("Personal"), { isDefault: true });

        expect(await f.defaults()).toEqual([f.id("Personal")]);
        expect(updates.map((update) => update.itemId)).toEqual([f.id("Personal")]);
      }));

    it.each(["system", "subscription"])("refuses to mark a %s calendar and changes nothing", (kind) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const calendarId =
          kind === "system"
            ? f.id("Birthdays")
            : (await f.createOfKind("subscription", { name: "Feed", color: "#8E8E93" })).id;
        const before = await f.rows();

        expect(await refusal(f.patch(calendarId, { isDefault: true }))).toMatchObject(NOT_AN_OWN_CALENDAR);
        expect(await f.rows()).toEqual(before);
        expect(await f.defaults()).toEqual([f.id("Personal")]);
      }),
    );

    it.each(["system", "subscription"])("refuses to mark a %s calendar also when no calendar holds the mark", (kind) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const calendarId =
          kind === "system"
            ? f.id("Birthdays")
            : (await f.createOfKind("subscription", { name: "Feed", color: "#8E8E93" })).id;
        await f.cp.softDeleteItem(f.calendarsId, f.id("Personal"));
        const before = await f.rows();

        expect(await refusal(f.patch(calendarId, { isDefault: true }))).toMatchObject(NOT_AN_OWN_CALENDAR);
        expect(await refusal(f.createOfKind(kind, { name: "Second feed", isDefault: true }))).toMatchObject(
          NOT_AN_OWN_CALENDAR,
        );
        expect(await f.rows()).toEqual(before);
        expect(await f.defaults()).toEqual([]);
      }),
    );

    it.each([false, null])("refuses to clear the mark with %j on Work while Work is the only default", (value) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.patch(f.id("Work"), { isDefault: true });
        const before = await f.rows();

        expect(await refusal(f.patch(f.id("Work"), { isDefault: value }))).toMatchObject(NO_DEFAULT_LEFT);
        expect(await f.rows()).toEqual(before);
        expect(await f.defaults()).toEqual([f.id("Work")]);
      }),
    );

    it("lets a calendar that is not the default write isDefault false", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.patch(f.id("Work"), { isDefault: false, notify: false });

        expect((await f.row(f.id("Work"))).properties).toMatchObject({ isDefault: false, notify: false });
        expect(await f.defaults()).toEqual([f.id("Personal")]);
      }));

    it("leaves the default alone on a patch that does not name isDefault", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.patch(f.id("Personal"), { hidden: true });
        await f.patch(f.id("Work"), { notify: false });

        expect(await f.defaults()).toEqual([f.id("Personal")]);
        expect(updates.map((update) => update.itemId)).toEqual([f.id("Personal"), f.id("Work")]);
      }));

    it.each([
      ["a user", USER],
      ["an agent", AGENT],
    ])("makes a calendar that %s creates with isDefault true the only default", (_label, writer) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const created = await f.create({ name: "Club", color: "#FF9500", isDefault: true }, writer);

        expect(await f.defaults()).toEqual([created.id]);
        expect((await f.row(f.id("Personal"))).properties.isDefault).toBe(false);
        expect(updates).toEqual([
          { itemId: f.id("Personal"), writerKind: writer.writerKind, patch: { isDefault: false } },
        ]);
      }),
    );

    it.each([{}, { isDefault: false }])("keeps the default when a calendar is created with %j", (mark) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const created = await f.create({ name: "Club", ...mark });

        expect(await f.defaults()).toEqual([f.id("Personal")]);
        expect((await f.rows()).map((row) => row.id)).toContain(created.id);
        expect(updates).toEqual([]);
      }),
    );

    it.each(["system", "subscription"])("refuses to create a %s calendar that is marked default", (kind) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.rows();

        expect(await refusal(f.createOfKind(kind, { name: "Feed", isDefault: true }))).toMatchObject(
          NOT_AN_OWN_CALENDAR,
        );
        expect(await f.rows()).toEqual(before);
      }),
    );

    it("stores no calendar when the clearing of the previous default fails on create", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.rows();
        failUpdateOf = f.id("Personal");

        expect(await refusal(f.create({ name: "Club", isDefault: true }))).toMatchObject({
          message: "injected update failure",
        });
        expect(await f.rows()).toEqual(before);
      }));

    describe("a tenant that held several defaults before these rules", () => {
      it("clears every other mark when a calendar becomes the default", () =>
        runInTenant(tenant, async () => {
          const f = await setup();
          await f.markDefaultWithoutHooks(f.id("Work"));
          await f.markDefaultWithoutHooks(f.id("Birthdays"));
          expect(await f.defaults()).toHaveLength(3);

          await f.patch(f.id("Family"), { isDefault: true });
          expect(await f.defaults()).toEqual([f.id("Family")]);
        }));

      it("lets one of two own defaults be cleared", () =>
        runInTenant(tenant, async () => {
          const f = await setup();
          await f.markDefaultWithoutHooks(f.id("Work"));

          await f.patch(f.id("Personal"), { isDefault: false });
          expect(await f.defaults()).toEqual([f.id("Work")]);
        }));

      it("does not count a marked system calendar as the default that stays", () =>
        runInTenant(tenant, async () => {
          const f = await setup();
          await f.markDefaultWithoutHooks(f.id("Birthdays"));
          const before = await f.rows();

          expect(await refusal(f.patch(f.id("Personal"), { isDefault: false }))).toMatchObject(NO_DEFAULT_LEFT);
          expect(await f.rows()).toEqual(before);
        }));
    });

    describe("a default calendar in the trash", () => {
      it("is not the default that stays", () =>
        runInTenant(tenant, async () => {
          const f = await setup();
          await f.cp.softDeleteItem(f.calendarsId, f.id("Personal"));
          const before = await f.rows();

          expect(await refusal(f.patch(f.id("Work"), { isDefault: false }))).toMatchObject(NO_DEFAULT_LEFT);
          expect(await f.rows()).toEqual(before);
        }));

      it("is not written when another calendar becomes the default", () =>
        runInTenant(tenant, async () => {
          const f = await setup();
          await f.cp.softDeleteItem(f.calendarsId, f.id("Personal"));
          const trashed = await f.cp.findItemIncludingDeleted(f.id("Personal"));

          await f.patch(f.id("Work"), { isDefault: true });
          expect(await f.defaults()).toEqual([f.id("Work")]);
          expect(await f.cp.findItemIncludingDeleted(f.id("Personal"))).toEqual(trashed);
          expect(trashed?.properties.isDefault).toBe(true);
          expect(updates.map((update) => update.itemId)).toEqual([f.id("Work")]);
        }));
    });
  });

  describe("concurrent switches", () => {
    it("makes a second switch wait for the first and leaves its calendar the only default", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const first = await heldOpen((client) =>
          updateItemWithClient(
            client,
            { databaseId: f.calendarsId, itemId: f.id("Work"), propertiesPatch: { isDefault: true } },
            { writer: USER },
          ),
        );
        // Starts while the first switch is uncommitted: without the advisory lock it would wait for the row of
        // Personal instead, find Personal cleared once the first commits, and leave Work and Family both marked.
        const second = refusal(f.patch(f.id("Family"), { isDefault: true }));
        let waitedFor: string | null;
        try {
          waitedFor = await waitForLockWaiter([DEFAULT_MARK_LOCK, OTHER_DEFAULTS_READ]);
          // Neither change of the first switch is visible before its commit.
          expect(await f.defaults()).toEqual([f.id("Personal")]);
        } finally {
          await first.commit();
          await second;
        }
        expect(await second).toBeUndefined();
        expect(await f.defaults()).toEqual([f.id("Family")]);
        expect(waitedFor).toBe("advisory");
      }));

    describe("the order of the locks", () => {
      /** Holds the advisory lock of the default mark in a transaction that stays open. */
      const holdDefaultMark = (f: Awaited<ReturnType<typeof setup>>) =>
        heldOpen((client) =>
          client.query("SELECT pg_advisory_xact_lock(hashtextextended('calendars-default:' || $1::text, 0))", [
            f.calendarsId,
          ]),
        );

      /** Whether another backend can lock the row at once; a row that a transaction holds fails `NOWAIT`. */
      async function rowIsFree(calendarId: string): Promise<boolean> {
        const client = await admin.connect();
        try {
          await client.query("BEGIN");
          try {
            await client.query("SELECT id FROM items WHERE id = $1 FOR UPDATE NOWAIT", [calendarId]);
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

      it.each([
        ["true", true],
        ["false", false],
      ])(
        "makes a write of isDefault %s on the default wait for the advisory lock before it locks the row",
        (_label, isDefault) =>
          runInTenant(tenant, async () => {
            const f = await setup();
            const holder = await holdDefaultMark(f);
            const write = refusal(f.patch(f.id("Personal"), { isDefault }));
            let waitedFor: string | null;
            let rowFreeWhileWaiting: boolean;
            try {
              waitedFor = await waitForLockWaiter([DEFAULT_MARK_LOCK]);
              // A write that locked the row first would hold it here, while it waits for the lock below, and
              // the switch that holds the lock and has to clear Personal would wait for it: a deadlock.
              rowFreeWhileWaiting = await rowIsFree(f.id("Personal"));
            } finally {
              await holder.commit();
              await write;
            }
            expect(waitedFor).toBe("advisory");
            expect(rowFreeWhileWaiting).toBe(true);
            if (isDefault) expect(await write).toBeUndefined();
            else expect(await write).toMatchObject(NO_DEFAULT_LEFT);
            expect(await f.defaults()).toEqual([f.id("Personal")]);
          }),
      );

      it("makes a write of isDefault on the calendar a switch clears wait for the advisory lock, not for the row", () =>
        runInTenant(tenant, async () => {
          const f = await setup();
          // Holds the lock, the row of Work and, after clearing it, the row of Personal.
          const switched = await heldOpen((client) =>
            updateItemWithClient(
              client,
              { databaseId: f.calendarsId, itemId: f.id("Work"), propertiesPatch: { isDefault: true } },
              { writer: USER },
            ),
          );
          const write = refusal(f.patch(f.id("Personal"), { isDefault: true }));
          let waitedFor: string | null;
          try {
            waitedFor = await waitForLockWaiter([DEFAULT_MARK_LOCK, OTHER_DEFAULTS_READ]);
          } finally {
            await switched.commit();
            await write;
          }
          expect(waitedFor).toBe("advisory");
          expect(await write).toBeUndefined();
          // The write that took the lock last owns the mark.
          expect(await f.defaults()).toEqual([f.id("Personal")]);
        }));

      it("ends no write of two that mark a calendar and the calendar it clears with a deadlock", () =>
        runInTenant(tenant, async () => {
          const f = await setup();
          for (let round = 0; round < 4; round += 1) {
            const outcomes = await Promise.all([
              refusal(f.patch(f.id("Work"), { isDefault: true })),
              refusal(f.patch(f.id("Personal"), { isDefault: true })),
              refusal(f.patch(f.id("Family"), { isDefault: false })),
            ]);
            // Family never holds the mark; its write of false is refused or stored depending on the order of
            // the three, and only a deadlock error would be a failure of the lock order.
            for (const outcome of outcomes) {
              if (outcome !== undefined) expect(outcome).toMatchObject(NO_DEFAULT_LEFT);
            }
            expect(await f.defaults()).toHaveLength(1);
          }
        }));
    });

    it("leaves exactly one default when two switches and a create with the mark run at the same time", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const outcomes = await Promise.all([
          refusal(f.patch(f.id("Work"), { isDefault: true })),
          refusal(f.patch(f.id("Family"), { isDefault: true })),
          refusal(f.create({ name: "Club", isDefault: true })),
        ]);
        expect(outcomes).toEqual([undefined, undefined, undefined]);

        const marked = (await f.rows()).filter((row) => row.properties.isDefault === true);
        expect(marked).toHaveLength(1);
        expect(["Work", "Family", "Club"]).toContain(marked[0]?.properties.name);
      }));

    it("does not make a write that leaves isDefault alone wait for a switch", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const held = await heldOpen((client) =>
          updateItemWithClient(
            client,
            { databaseId: f.calendarsId, itemId: f.id("Work"), propertiesPatch: { isDefault: true } },
            { writer: USER },
          ),
        );
        // Family and the new calendar are rows the held switch did not touch; only the lock could make them wait.
        const writes = refusal(
          f.patch(f.id("Family"), { color: "#FF9500" }).then(() => f.create({ name: "Club", isDefault: false })),
        );
        let outcome: unknown;
        try {
          outcome = await withinFiveSeconds(writes);
        } finally {
          await held.commit();
          await writes;
        }
        expect(outcome).toBeUndefined();
        expect(await f.defaults()).toEqual([f.id("Work")]);
      }));
  });

  describe("a trash of the default calendar that is uncommitted", () => {
    /** Trashes Personal, the default, in a transaction that stays open. */
    const trashPersonal = (f: Awaited<ReturnType<typeof setup>>) =>
      heldOpen((client) =>
        itemDeleteWithClient(client, f.calendarsId, f.id("Personal"), { queueAffinity: createActionQueueAffinity() }),
      );

    it("makes a switch wait and then leave the trashed calendar unwritten", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const trash = await trashPersonal(f);
        // Starts while the trash is uncommitted: a read without the row lock would return Personal as a
        // calendar to clear, and the clearing would fail once the trash commits.
        const switched = refusal(f.patch(f.id("Work"), { isDefault: true }));
        try {
          await waitForLockWaiter([OTHER_DEFAULTS_READ]);
        } finally {
          await trash.commit();
          await switched;
        }
        expect(await switched).toBeUndefined();
        expect(await f.defaults()).toEqual([f.id("Work")]);
        expect(updates.map((update) => update.itemId)).toEqual([f.id("Work")]);
      }));

    it("makes a write of isDefault false wait and then refuses it, because no default stays", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const trash = await trashPersonal(f);
        // Starts while the trash is uncommitted: a read without the row lock would count Personal as the default that stays.
        const cleared = refusal(f.patch(f.id("Work"), { isDefault: false, hidden: true }));
        try {
          await waitForLockWaiter([OTHER_DEFAULTS_READ]);
        } finally {
          await trash.commit();
          await cleared;
        }
        expect(await cleared).toMatchObject(NO_DEFAULT_LEFT);
        expect((await f.row(f.id("Work"))).properties.hidden).toBe(false);
      }));
  });

  describe("another tenant", () => {
    it("keeps its default and its rows when this tenant switches", async () => {
      const foreignBefore = await runInTenant(foreign, async () => (await setup()).rows());
      await runInTenant(tenant, async () => {
        const f = await setup();
        await f.patch(f.id("Work"), { isDefault: true });
        await f.create({ name: "Club", isDefault: true });
      });
      await runInTenant(foreign, async () => {
        const g = await setup();
        expect(await g.rows()).toEqual(foreignBefore);
        expect(await g.defaults()).toEqual([g.id("Personal")]);
      });
    });

    it("answers a write to its calendar like a write to an unknown id and keeps its default", async () => {
      const foreignWork = await runInTenant(foreign, async () => (await setup()).id("Work"));
      await runInTenant(tenant, async () => {
        const f = await setup();
        const unknown = await refusal(f.patch(randomUUID(), { isDefault: true }));
        const other = await refusal(f.patch(foreignWork, { isDefault: true }));
        expect(unknown).toMatchObject({ status: 404, code: "not_found" });
        expect(other).toMatchObject({ status: 404, code: "not_found" });
        expect(await f.defaults()).toEqual([f.id("Personal")]);
      });
      await runInTenant(foreign, async () => {
        const g = await setup();
        expect(await g.defaults()).toEqual([g.id("Personal")]);
      });
    });

    it("switches its own default while a switch of this tenant is uncommitted", async () => {
      const held = await runInTenant(tenant, async () => {
        const f = await setup();
        return heldOpen((client) =>
          updateItemWithClient(
            client,
            { databaseId: f.calendarsId, itemId: f.id("Work"), propertiesPatch: { isDefault: true } },
            { writer: USER },
          ),
        );
      });
      // The lock is keyed by the tenant's calendars database: a lock shared by all tenants would make this wait.
      const switched = refusal(
        runInTenant(foreign, async () => {
          const g = await setup();
          await g.patch(g.id("Family"), { isDefault: true });
        }),
      );
      let outcome: unknown;
      try {
        outcome = await withinFiveSeconds(switched);
      } finally {
        await held.commit();
        await switched;
      }
      expect(outcome).toBeUndefined();
      await runInTenant(foreign, async () => {
        const g = await setup();
        expect(await g.defaults()).toEqual([g.id("Family")]);
      });
    });
  });

  describe("the system-owned keys", () => {
    it.each(["kind", "systemKey"])("still answers a generic write of %s with 403 and stores nothing", (key) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.rows();

        expect(await refusal(f.patch(f.id("Work"), { [key]: "system" }))).toMatchObject({
          status: 403,
          code: "owner_violation",
          details: { field: key },
        });
        expect(await refusal(f.create({ name: "Mine", [key]: "system" }))).toMatchObject({
          status: 403,
          code: "owner_violation",
          details: { field: key },
        });
        expect(await f.rows()).toEqual(before);
      }),
    );
  });

  describe("another database", () => {
    it.each([
      ["a user's database", undefined],
      ["a database that carries the calendars module id without being the system database", CALENDARS_MODULE_ID],
    ])("does not judge %s: name, color and isDefault are written freely and no calendar changes", (_label, moduleId) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.rows();
        const lists = await f.cp.createDatabase({ name: "Lists", ownerModuleId: moduleId });
        expect(lists).toMatchObject({ system: false, ownerModuleId: moduleId ?? null });
        await f.cp.createProperty({ databaseId: lists.id, key: "name", name: "Name", type: "title" });
        await f.cp.createProperty({ databaseId: lists.id, key: "color", name: "Color", type: "text" });
        await f.cp.createProperty({ databaseId: lists.id, key: "isDefault", name: "Default", type: "checkbox" });
        await f.cp.createProperty({ databaseId: lists.id, key: "kind", name: "Kind", type: "text" });
        const write = (properties: Record<string, unknown>) =>
          f.cp.createItem({ databaseId: lists.id, properties }, undefined, undefined, USER);
        const first = await write({ name: "First", color: "blue", isDefault: true, kind: "system" });
        const second = await write({ name: "Second", color: null, isDefault: true, kind: "subscription" });

        for (const item of [first, second]) {
          const patched = await f.cp.updateItem(
            { databaseId: lists.id, itemId: item.id, propertiesPatch: { name: "Renamed", color: null } },
            undefined,
            undefined,
            USER,
          );
          expect(patched.properties).toMatchObject({ name: "Renamed", color: null, isDefault: true });
        }
        for (const item of [first, second]) {
          const cleared = await f.cp.updateItem(
            { databaseId: lists.id, itemId: item.id, propertiesPatch: { isDefault: false } },
            undefined,
            undefined,
            USER,
          );
          expect(cleared.properties.isDefault).toBe(false);
        }
        expect(await f.rows()).toEqual(before);
      }),
    );
  });
});
