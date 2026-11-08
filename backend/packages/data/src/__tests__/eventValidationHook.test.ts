import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
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
let tasksId: string;

const storedRow = z.object({ properties: z.record(z.string(), z.unknown()), updated_at: z.string() });

/** The stored row of an Event, read in the tenant's own scope. */
async function stored(itemId: string) {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT properties, updated_at::text FROM items WHERE database_id = $1 AND id = $2",
      [eventsId, itemId],
    );
    return storedRow.parse(rows[0]);
  });
}

async function eventCount(): Promise<number> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM items WHERE database_id = $1",
      [eventsId],
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

/** The `ValidationError` a write fails with, so a case can assert its field and that nothing else threw. */
async function rejection(write: Promise<unknown>): Promise<ValidationError> {
  const error: unknown = await write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ValidationError)) throw new Error(`Expected a ValidationError, got ${String(error)}`);
  return error;
}

describe("Events date and time validation at the choke point (issue #1663)", () => {
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
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    cp = createChokePoint(pool);
    const ids = await runInTenant(tenant, async () => {
      const { rows } = await pool.query<{ id: string; owner_module_id: string }>(
        "SELECT id, owner_module_id FROM databases WHERE system AND owner_module_id = ANY($1::text[])",
        [["events", "tasks"]],
      );
      return new Map(rows.map((row) => [row.owner_module_id, row.id]));
    });
    eventsId = ids.get("events") ?? "";
    tasksId = ids.get("tasks") ?? "";
    if (!eventsId || !tasksId) throw new Error("Events or Tasks database not seeded");
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  describe("create", () => {
    it.each([
      ["timeTo not after timeFrom", { timeFrom: "10:00", timeTo: "09:30" }, "timeTo"],
      ["timeFrom and timeTo both 23:55", { timeFrom: "23:55", timeTo: "23:55" }, "timeTo"],
      ["endDate before date", { endDate: "2026-10-15" }, "endDate"],
      ["timeTo without timeFrom", { timeTo: "11:00" }, "timeTo"],
      ["timeTo 24:30", { timeFrom: "23:00", timeTo: "24:30" }, "timeTo"],
      ["timeFrom 24:00", { timeFrom: "24:00", timeTo: "24:00" }, "timeFrom"],
      ["a timeFrom that is no time", { timeFrom: "noon" }, "timeFrom"],
      ["an endDate that is no calendar date", { endDate: "2026-13-01" }, "endDate"],
      ["a multi-day timed Event without timeTo", { endDate: "2026-10-17", timeFrom: "22:00" }, "timeTo"],
    ])("refuses %s with a ValidationError on the field and writes no Event", async (_label, values, field) => {
      const before = await eventCount();
      const error = await rejection(create({ name: "Invalid", date: "2026-10-16", ...values }));
      expect(error.code).toBe("validation_failed");
      expect(error.status).toBe(400);
      expect(error.details).toEqual({ field });
      expect(await eventCount()).toBe(before);
    });

    it.each([
      ["no date", { name: "No date" }],
      ["a null date", { name: "Null date", date: null }],
      ["an impossible calendar date", { name: "February", date: "2026-02-30" }],
      ["a date with a time the time transform could not convert", { name: "Unread", date: "2026-10-16T25:00" }],
    ])("refuses an Event with %s on the field date", async (_label, properties) => {
      const before = await eventCount();
      const error = await rejection(create(properties));
      expect(error.details).toEqual({ field: "date" });
      expect(await eventCount()).toBe(before);
    });

    it("accepts timeTo 24:00", async () => {
      const item = await create({ name: "Late", date: "2026-10-16", timeFrom: "23:00", timeTo: "24:00" });
      expect((await stored(item.id)).properties).toMatchObject({ timeFrom: "23:00", timeTo: "24:00" });
    });

    it("stores 23:30 with no end as 23:30 to 24:00", async () => {
      const item = await create({ name: "Last slot", date: "2026-10-16", timeFrom: "23:30" });
      expect((await stored(item.id)).properties).toMatchObject({ timeFrom: "23:30", timeTo: "24:00" });
    });

    it("accepts an all-day Event spanning 24 and 25 October", async () => {
      const item = await create({ name: "Weekend", date: "2026-10-24", endDate: "2026-10-25" });
      expect((await stored(item.id)).properties).toMatchObject({ date: "2026-10-24", endDate: "2026-10-25" });
    });

    it("accepts an overnight Event from 22:00 on 16 October to 02:00 on 17 October", async () => {
      const item = await create({
        name: "Night shift",
        date: "2026-10-16",
        endDate: "2026-10-17",
        timeFrom: "22:00",
        timeTo: "02:00",
      });
      expect((await stored(item.id)).properties).toMatchObject({
        date: "2026-10-16",
        endDate: "2026-10-17",
        timeFrom: "22:00",
        timeTo: "02:00",
      });
    });

    it("accepts a date with a time that the time transform converted", async () => {
      const item = await create({ name: "Converted", date: "2026-10-16T08:00" });
      expect((await stored(item.id)).properties).toMatchObject({
        date: "2026-10-16",
        timeFrom: "08:00",
        timeTo: "09:00",
      });
    });

    it("does not apply the Events rules to another database", async () => {
      const task = await runInTenant(tenant, () =>
        cp.createItem({ databaseId: tasksId, properties: { name: "No date needed" } }),
      );
      expect(task.properties.name).toBe("No date needed");
    });
  });

  describe("update", () => {
    it("refuses a patch of only timeFrom 11:45 on an Event from 10:00 to 11:30 and keeps the row", async () => {
      const item = await create({ name: "Meeting", date: "2026-10-16", timeFrom: "10:00", timeTo: "11:30" });
      const before = await stored(item.id);
      const error = await rejection(patch(item.id, { timeFrom: "11:45" }));
      expect(error.details).toEqual({ field: "timeTo" });
      expect(await stored(item.id)).toEqual(before);
    });

    it("refuses a patch of only date 2026-10-26 on an Event spanning 24 and 25 October, naming endDate", async () => {
      const item = await create({ name: "Weekend", date: "2026-10-24", endDate: "2026-10-25" });
      const before = await stored(item.id);
      const error = await rejection(patch(item.id, { date: "2026-10-26" }));
      expect(error.details).toEqual({ field: "endDate" });
      expect(await stored(item.id)).toEqual(before);
    });

    it("refuses a patched timeTo of 24:30 by its format", async () => {
      const item = await create({ name: "Meeting", date: "2026-10-16", timeFrom: "10:00", timeTo: "11:00" });
      const error = await rejection(patch(item.id, { timeTo: "24:30" }));
      expect(error.details).toEqual({ field: "timeTo" });
    });

    it("refuses clearing the date of an Event", async () => {
      const item = await create({ name: "Meeting", date: "2026-10-16" });
      const error = await rejection(patch(item.id, { date: null }));
      expect(error.details).toEqual({ field: "date" });
    });

    describe("an Event stored with a legacy date-time (synthetic: the time transform converts every new write)", () => {
      async function legacyEvent(properties: Record<string, unknown>): Promise<string> {
        const item = await create({ name: "Legacy", date: "2026-10-16" });
        // Synthetic legacy state: the Events time transform converts a date-time on every write, so only a row
        // stored before issue #1598 can hold one; the choke point cannot produce it.
        await runInTenant(tenant, () =>
          withTransaction(pool, async (client) => {
            const result = await client.query(
              "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = $2",
              [eventsId, item.id, JSON.stringify(properties)],
            );
            expect(result.rowCount).toBe(1);
          }),
        );
        return item.id;
      }

      it("accepts a patch of only name", async () => {
        const id = await legacyEvent({ date: "2026-10-16T08:00:00Z" });
        const updated = await patch(id, { name: "Renamed" });
        expect(updated.properties).toMatchObject({ name: "Renamed", date: "2026-10-16T08:00:00Z" });
      });

      it("treats the unreadable stored date as no value when a patch changes a time", async () => {
        const id = await legacyEvent({ date: "2026-10-16T08:00:00Z", endDate: "someday" });
        const updated = await patch(id, { timeFrom: "09:00", timeTo: "10:00" });
        expect(updated.properties).toMatchObject({ date: "2026-10-16T08:00:00Z", timeFrom: "09:00", timeTo: "10:00" });
      });

      it("still checks the times of a patch against each other", async () => {
        const id = await legacyEvent({ date: "2026-10-16T08:00:00Z" });
        const error = await rejection(patch(id, { timeFrom: "10:00", timeTo: "09:00" }));
        expect(error.details).toEqual({ field: "timeTo" });
      });
    });
  });
});
