import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@alldots/shared";
import { EVENT_ALERT_MINUTES, EVENT_TRAVEL_MINUTES } from "../calendar/eventReminderValuesHook.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let cp: ChokePoint;
let eventsId: string;

const storedRow = z.object({ properties: z.record(z.string(), z.unknown()), updated_at: z.string() });

const ALERT_VALUES = [0, 5, 7, 10, 15, 30, 60, 120, 1440, 2880, 10_080, 40_320];
const TRAVEL_VALUES = [1, 5, 15, 20, 30, 45, 60, 90, 120, 1440];

const ALERT_REFUSALS: Array<[string, unknown]> = [
  ["-5", -5],
  ["15.5", 15.5],
  ["40321, beyond four weeks", 40_321],
  ["the string 15", "15"],
  ["an empty string", ""],
  ["true", true],
  ["false", false],
];

const TRAVEL_REFUSALS: Array<[string, unknown]> = [
  ["0, which only alertMinutes allows", 0],
  ["-15", -15],
  ["30.5", 30.5],
  ["1441, beyond a day", 1441],
  ["the string 30", "30"],
  ["an empty string", ""],
  ["true", true],
  ["false", false],
];

async function stored(itemId: string, databaseId = eventsId) {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT properties, updated_at::text FROM items WHERE database_id = $1 AND id = $2",
      [databaseId, itemId],
    );
    return storedRow.parse(rows[0]);
  });
}

async function eventsNamed(name: string): Promise<number> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM items WHERE database_id = $1 AND properties->>'name' = $2",
      [eventsId, name],
    );
    return rows[0]?.count ?? -1;
  });
}

function create(properties: Record<string, unknown>) {
  return runInTenant(tenant, () => cp.createItem({ databaseId: eventsId, properties }));
}

function patch(itemId: string, propertiesPatch: Record<string, unknown>) {
  return runInTenant(tenant, () => cp.updateItem({ databaseId: eventsId, itemId, propertiesPatch }));
}

async function rejection(write: Promise<unknown>): Promise<ValidationError> {
  const error: unknown = await write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ValidationError)) throw new Error(`Expected a ValidationError, got ${String(error)}`);
  return error;
}

/**
 * An Event holding values outside the allowed ranges. Synthetic legacy state: the reminder-values hooks
 * refuse such a value on every write, so the choke point cannot produce it.
 */
async function legacyEvent(values: Record<string, unknown>): Promise<string> {
  const item = await create({ name: "Legacy", date: "2026-10-16" });
  await runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const result = await client.query(
        "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = $2",
        [eventsId, item.id, JSON.stringify(values)],
      );
      expect(result.rowCount).toBe(1);
    }),
  );
  return item.id;
}

describe("Events alertMinutes and travelMinutes validation at the choke point", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "alldots_data");
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
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    cp = createChokePoint(pool);
    eventsId = await runInTenant(tenant, async () => {
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM databases WHERE system AND owner_module_id = $1",
        ["events"],
      );
      return rows[0]?.id ?? "";
    });
    if (!eventsId) throw new Error("Events database not seeded");
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("declares the allowed ranges", () => {
    expect(EVENT_ALERT_MINUTES).toEqual({ min: 0, max: 40_320 });
    expect(EVENT_TRAVEL_MINUTES).toEqual({ min: 1, max: 1440 });
  });

  describe("create", () => {
    it.each(ALERT_VALUES)("stores alertMinutes %d", async (alertMinutes) => {
      const item = await create({ name: "Alert", date: "2026-10-16", alertMinutes });
      expect((await stored(item.id)).properties.alertMinutes).toBe(alertMinutes);
    });

    it.each(TRAVEL_VALUES)("stores travelMinutes %d", async (travelMinutes) => {
      const item = await create({ name: "Travel", date: "2026-10-16", travelMinutes });
      expect((await stored(item.id)).properties.travelMinutes).toBe(travelMinutes);
    });

    it("stores alertMinutes 0 together with travelMinutes 30", async () => {
      const item = await create({ name: "At event time", date: "2026-10-16", alertMinutes: 0, travelMinutes: 30 });
      expect((await stored(item.id)).properties).toMatchObject({ alertMinutes: 0, travelMinutes: 30 });
    });

    it("stores an Event that names neither key", async () => {
      const item = await create({ name: "No reminder", date: "2026-10-16" });
      const { properties } = await stored(item.id);
      expect(properties).not.toHaveProperty("alertMinutes");
      expect(properties).not.toHaveProperty("travelMinutes");
    });

    it("stores null for both keys", async () => {
      const item = await create({
        name: "Explicitly none",
        date: "2026-10-16",
        alertMinutes: null,
        travelMinutes: null,
      });
      expect((await stored(item.id)).properties).toMatchObject({ alertMinutes: null, travelMinutes: null });
    });

    it.each(ALERT_REFUSALS)("refuses alertMinutes %s on the field and writes no Event", async (label, alertMinutes) => {
      const name = `Refused alert ${label}`;
      const error = await rejection(create({ name, date: "2026-10-16", alertMinutes }));
      expect(error.code).toBe("validation_failed");
      expect(error.status).toBe(400);
      expect(error.details).toEqual({ field: "alertMinutes" });
      expect(await eventsNamed(name)).toBe(0);
    });

    it.each(TRAVEL_REFUSALS)(
      "refuses travelMinutes %s on the field and writes no Event",
      async (label, travelMinutes) => {
        const name = `Refused travel ${label}`;
        const error = await rejection(create({ name, date: "2026-10-16", travelMinutes }));
        expect(error.code).toBe("validation_failed");
        expect(error.status).toBe(400);
        expect(error.details).toEqual({ field: "travelMinutes" });
        expect(await eventsNamed(name)).toBe(0);
      },
    );
  });

  describe("update", () => {
    it.each(ALERT_VALUES)("stores a patched alertMinutes %d", async (alertMinutes) => {
      const item = await create({ name: "Alert", date: "2026-10-16" });
      await patch(item.id, { alertMinutes });
      expect((await stored(item.id)).properties.alertMinutes).toBe(alertMinutes);
    });

    it.each(TRAVEL_VALUES)("stores a patched travelMinutes %d", async (travelMinutes) => {
      const item = await create({ name: "Travel", date: "2026-10-16" });
      await patch(item.id, { travelMinutes });
      expect((await stored(item.id)).properties.travelMinutes).toBe(travelMinutes);
    });

    it("clears alertMinutes with a null patch and keeps travelMinutes", async () => {
      const item = await create({ name: "Meeting", date: "2026-10-16", alertMinutes: 15, travelMinutes: 30 });
      const updated = await patch(item.id, { alertMinutes: null });
      expect(updated.properties).toMatchObject({ alertMinutes: null, travelMinutes: 30 });
      expect((await stored(item.id)).properties).toMatchObject({ alertMinutes: null, travelMinutes: 30 });
    });

    it("clears travelMinutes with a null patch and keeps alertMinutes", async () => {
      const item = await create({ name: "Meeting", date: "2026-10-16", alertMinutes: 15, travelMinutes: 30 });
      await patch(item.id, { travelMinutes: null });
      expect((await stored(item.id)).properties).toMatchObject({ alertMinutes: 15, travelMinutes: null });
    });

    it.each(ALERT_REFUSALS)("refuses a patched alertMinutes %s and keeps the row", async (_label, alertMinutes) => {
      const item = await create({ name: "Meeting", date: "2026-10-16", alertMinutes: 15 });
      const before = await stored(item.id);
      const error = await rejection(patch(item.id, { alertMinutes }));
      expect(error.code).toBe("validation_failed");
      expect(error.details).toEqual({ field: "alertMinutes" });
      expect(await stored(item.id)).toEqual(before);
    });

    it.each(TRAVEL_REFUSALS)("refuses a patched travelMinutes %s and keeps the row", async (_label, travelMinutes) => {
      const item = await create({ name: "Meeting", date: "2026-10-16", travelMinutes: 30 });
      const before = await stored(item.id);
      const error = await rejection(patch(item.id, { travelMinutes }));
      expect(error.code).toBe("validation_failed");
      expect(error.details).toEqual({ field: "travelMinutes" });
      expect(await stored(item.id)).toEqual(before);
    });

    describe("an Event stored with values outside the allowed ranges (synthetic: every new write is judged)", () => {
      it("accepts a patch of only name and keeps the stored values", async () => {
        const id = await legacyEvent({ alertMinutes: -7, travelMinutes: 0 });
        const updated = await patch(id, { name: "Renamed" });
        expect(updated.properties).toMatchObject({ name: "Renamed", alertMinutes: -7, travelMinutes: 0 });
      });

      it("judges only the key a patch names", async () => {
        const id = await legacyEvent({ alertMinutes: -7, travelMinutes: 0 });
        const updated = await patch(id, { travelMinutes: 30 });
        expect(updated.properties).toMatchObject({ alertMinutes: -7, travelMinutes: 30 });
      });

      it("refuses a patch that names the key with the stored value", async () => {
        const id = await legacyEvent({ alertMinutes: -7 });
        const before = await stored(id);
        const error = await rejection(patch(id, { alertMinutes: -7 }));
        expect(error.details).toEqual({ field: "alertMinutes" });
        expect(await stored(id)).toEqual(before);
      });
    });
  });

  describe("a database other than Events", () => {
    /**
     * A database with a `name` and number properties named like the Events ones, optionally owned by a module
     * and with further properties.
     */
    async function databaseWithReminderKeys(
      ownerModuleId?: string,
      further: Array<[string, "text" | "number"]> = [],
    ): Promise<string> {
      return runInTenant(tenant, async () => {
        const database = await cp.createDatabase({ name: "Other", ownerModuleId });
        const properties: Array<[string, "text" | "number"]> = [
          ["name", "text"],
          ["alertMinutes", "number"],
          ["travelMinutes", "number"],
          ...further,
        ];
        for (const [key, type] of properties) {
          await cp.createProperty({ databaseId: database.id, key, name: key, type });
        }
        return database.id;
      });
    }

    it("stores any value in a database of the user's own, on create and on update", async () => {
      const databaseId = await databaseWithReminderKeys();
      const item = await runInTenant(tenant, () =>
        cp.createItem({ databaseId, properties: { name: "Other", alertMinutes: 7, travelMinutes: 20 } }),
      );
      expect((await stored(item.id, databaseId)).properties).toMatchObject({ alertMinutes: 7, travelMinutes: 20 });
      await runInTenant(tenant, () =>
        cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { alertMinutes: -5, travelMinutes: 0 } }),
      );
      expect((await stored(item.id, databaseId)).properties).toMatchObject({ alertMinutes: -5, travelMinutes: 0 });
    });

    it("stores any value in a non-system database the events module owns, on create and on update", async () => {
      // The Events transforms run for every database of the module and add these keys, so the database needs them.
      const databaseId = await databaseWithReminderKeys("events", [
        ["time", "text"],
        ["icalUid", "text"],
        ["icalSequence", "number"],
      ]);
      const item = await runInTenant(tenant, () =>
        cp.createItem({ databaseId, properties: { name: "Inline", alertMinutes: 7, travelMinutes: 20 } }),
      );
      expect((await stored(item.id, databaseId)).properties).toMatchObject({ alertMinutes: 7, travelMinutes: 20 });
      await runInTenant(tenant, () =>
        cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { alertMinutes: -5, travelMinutes: 0 } }),
      );
      expect((await stored(item.id, databaseId)).properties).toMatchObject({ alertMinutes: -5, travelMinutes: 0 });
    });
  });
});
