import "../../domainWriteHooks.js";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { ValidationError } from "../../errors.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { runModuleDataMigration } from "../../migrationJob/moduleDataMigration.js";
import { logger as migrationLogger } from "../../migrationJob/logger.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let prague: string;
let newYork: string;

const rowSchema = z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()), updated_at: z.string() });
type Row = z.infer<typeof rowSchema>;

/** The Events stored before the calendar time model, by name, for the Europe/Prague tenant. */
const PRAGUE_EVENTS: Record<string, Record<string, unknown>> = {
  utc: { name: "Utc", date: "2026-10-16T08:00:00Z" },
  offset: { name: "Offset", date: "2026-10-16T08:00:00+02:00" },
  wallClock: { name: "Wall clock", date: "2026-10-16T10:00" },
  allDay: { name: "All day", date: "2026-10-24" },
  lateEvening: { name: "Late evening", date: "2026-10-16T21:30:00Z" },
  pastMidnight: { name: "Past midnight", date: "2026-10-16T22:30:00Z" },
  summerTimeEnds: { name: "Summer time ends", date: "2026-10-25T00:30:00Z" },
  summerTimeEndsAgain: { name: "Summer time ends again", date: "2026-10-25T01:30:00Z" },
  summerTimeStarts: { name: "Summer time starts", date: "2026-03-29T01:30:00Z" },
  withEnd: { name: "With end", date: "2026-10-16T08:00:00Z", endDate: "2026-10-17" },
  withTimes: {
    name: "With times",
    date: "2026-10-16T08:00:00Z",
    timeFrom: "08:30",
    timeTo: "09:30",
    time: "08:30–09:30",
  },
  withStartOnly: { name: "With start only", date: "2026-10-16T08:00:00Z", timeFrom: "08:30" },
  text: { name: "Text", date: "abc" },
  impossible: { name: "Impossible", date: "2026-02-30" },
  current: { name: "Current", date: "2026-10-16", timeFrom: "09:00", timeTo: "10:00", time: "09:00–10:00" },
};

/** The same instants for the America/New_York tenant, with the changes of its own summer time. */
const NEW_YORK_EVENTS: Record<string, Record<string, unknown>> = {
  utc: { name: "Utc", date: "2026-10-16T14:00:00Z" },
  summerTimeEnds: { name: "Summer time ends", date: "2026-11-01T05:30:00Z" },
  summerTimeEndsAgain: { name: "Summer time ends again", date: "2026-11-01T06:30:00Z" },
};

async function eventsDatabaseOf(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM databases WHERE system AND owner_module_id = 'events'",
    );
    if (!rows[0]) throw new Error("Events not seeded");
    return rows[0].id;
  });
}

/**
 * Synthetic historical rows: the Events rules of issue #1663 refuse a `date` that carries a time and an unreadable
 * one, so only a row stored before them can hold one; the choke point cannot produce them.
 */
async function insertEvents(tenantId: string, events: Record<string, Record<string, unknown>>): Promise<void> {
  const databaseId = await eventsDatabaseOf(tenantId);
  await runInTenant(tenantId, async () => {
    for (const properties of Object.values(events)) {
      const inserted = await pool.query("INSERT INTO items (database_id, properties) VALUES ($1, $2::jsonb)", [
        databaseId,
        JSON.stringify(properties),
      ]);
      expect(inserted.rowCount).toBe(1);
    }
  });
}

/** Sets the time zone of the tenant's system settings; the settings screen is not part of this migration. */
async function setTimezone(tenantId: string, timezone: string): Promise<void> {
  await runInTenant(tenantId, async () => {
    const updated = await pool.query(
      `UPDATE items SET properties = jsonb_set(properties, '{timezone}', to_jsonb($1::text))
       WHERE database_id = (SELECT id FROM databases WHERE system AND owner_module_id = 'systemSettings')`,
      [timezone],
    );
    expect(updated.rowCount).toBe(1);
  });
}

async function rows(tenantId: string): Promise<Row[]> {
  const databaseId = await eventsDatabaseOf(tenantId);
  return runInTenant(tenantId, async () => {
    const result = await pool.query<Record<string, unknown>>(
      "SELECT id, properties, updated_at::text FROM items WHERE database_id = $1 ORDER BY id",
      [databaseId],
    );
    return result.rows.map((row) => rowSchema.parse(row));
  });
}

async function byName(tenantId: string): Promise<Map<string, Row>> {
  return new Map((await rows(tenantId)).map((row) => [String(row.properties.name), row]));
}

async function definition() {
  const registry = await loadFullModuleRegistry();
  const found = (await registry.getDataMigrationDefinitions()).find(
    (entry) => entry.databaseKey === "events" && entry.fromVersion === "1.0.0" && entry.toVersion === "1.1.0",
  );
  if (!found) throw new Error("Events 1.0.0 -> 1.1.0 data migration is not registered");
  return found;
}

async function runMigration(tenantId: string, pageSize?: number): Promise<void> {
  const { moduleId, databaseKey, fromVersion, toVersion, converter } = await definition();
  await runInTenant(tenantId, () =>
    runModuleDataMigration(pool, { moduleId, databaseKey, fromVersion, toVersion, converter, pageSize }),
  );
}

/**
 * Forgets that the tenant ran the transition. Synthetic deploy state: seeding a fresh tenant already records it, so
 * only a tenant migrated before this release has rows that still carry a time inside `date`, and no record.
 */
async function forgetTransition(tenantId: string): Promise<void> {
  await runInTenant(tenantId, async () => {
    await pool.query(
      `DELETE FROM module_migrations
       WHERE module_id = 'systemDatabases' AND database_key = 'events' AND from_version = '1.0.0' AND to_version = '1.1.0'`,
    );
  });
}

async function transitionRecorded(tenantId: string): Promise<boolean> {
  return runInTenant(tenantId, async () => {
    const { rows: recorded } = await pool.query(
      `SELECT 1 FROM module_migrations
       WHERE module_id = 'systemDatabases' AND database_key = 'events' AND from_version = '1.0.0' AND to_version = '1.1.0'`,
    );
    return recorded.length > 0;
  });
}

describe("the Events 1.0.0 to 1.1.0 data migration (issue gh-1797)", () => {
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
    prague = await createTestTenant(admin);
    newYork = await createTestTenant(admin);
    for (const id of [prague, newYork]) await runInTenant(id, () => seedSystem(pool, createViewTypeRegistry()));
    await setTimezone(prague, "Europe/Prague");
    await setTimezone(newYork, "America/New_York");
    await insertEvents(prague, PRAGUE_EVENTS);
    await insertEvents(newYork, NEW_YORK_EVENTS);
    await forgetTransition(prague);
    await forgetTransition(newYork);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("is registered for the Events database after the three Tasks migrations", async () => {
    const registry = await loadFullModuleRegistry();
    const all = (await registry.getDataMigrations()).filter((entry) => entry.moduleId === "systemDatabases");

    expect(all.map((entry) => [entry.databaseKey, entry.fromVersion, entry.toVersion, entry.converterExport])).toEqual([
      ["tasks", "1.0.0", "1.1.0", "backfillTaskTimeProperties"],
      ["tasks", "1.1.0", "1.2.0", "normalizeTaskDatesAndTimes"],
      ["tasks", "1.2.0", "1.3.0", "backfillTaskEffectiveDate"],
      ["events", "1.0.0", "1.1.0", "convertEventDateToWallClock"],
    ]);
  });

  it("converts the dates of a Europe/Prague tenant to wall-clock date, times and time", async () => {
    await runMigration(prague);

    const stored = await byName(prague);
    expect(stored.get("Utc")?.properties).toEqual({
      name: "Utc",
      date: "2026-10-16",
      timeFrom: "10:00",
      timeTo: "11:00",
      time: "10:00–11:00",
    });
    expect(stored.get("Offset")?.properties).toMatchObject({ date: "2026-10-16", timeFrom: "08:00", timeTo: "09:00" });
    expect(stored.get("Wall clock")?.properties).toEqual({
      name: "Wall clock",
      date: "2026-10-16",
      timeFrom: "10:00",
      timeTo: "11:00",
      time: "10:00–11:00",
    });
    expect(stored.get("All day")?.properties).toEqual({ name: "All day", date: "2026-10-24" });
    expect(stored.get("Late evening")?.properties).toMatchObject({
      date: "2026-10-16",
      timeFrom: "23:30",
      timeTo: "24:00",
      time: "23:30–24:00",
    });
    expect(stored.get("Past midnight")?.properties).toMatchObject({
      date: "2026-10-17",
      timeFrom: "00:30",
      timeTo: "01:30",
    });
  });

  it("converts an Event on the day summer time changes, both 02:30 of the autumn night and the spring jump", async () => {
    await runMigration(prague);

    const stored = await byName(prague);
    expect(stored.get("Summer time ends")?.properties).toMatchObject({
      date: "2026-10-25",
      timeFrom: "02:30",
      timeTo: "03:30",
      time: "02:30–03:30",
    });
    expect(stored.get("Summer time ends again")?.properties).toMatchObject({
      date: "2026-10-25",
      timeFrom: "02:30",
      timeTo: "03:30",
    });
    expect(stored.get("Summer time starts")?.properties).toMatchObject({
      date: "2026-03-29",
      timeFrom: "03:30",
      timeTo: "04:30",
    });
  });

  it("converts the dates of an America/New_York tenant in its own zone, and the tenants do not mix", async () => {
    await runMigration(newYork);

    const stored = await byName(newYork);
    expect(stored.get("Utc")?.properties).toEqual({
      name: "Utc",
      date: "2026-10-16",
      timeFrom: "10:00",
      timeTo: "11:00",
      time: "10:00–11:00",
    });
    expect(stored.get("Summer time ends")?.properties).toMatchObject({ date: "2026-11-01", timeFrom: "01:30" });
    expect(stored.get("Summer time ends again")?.properties).toMatchObject({ date: "2026-11-01", timeFrom: "01:30" });
    // Europe/Prague's Events were not converted by the run for the other tenant.
    expect((await byName(prague)).get("Utc")?.properties).toEqual(PRAGUE_EVENTS.utc);
  });

  it("never overwrites an endDate, a timeFrom or a timeTo that is already set", async () => {
    await runMigration(prague);

    const stored = await byName(prague);
    expect(stored.get("With end")?.properties).toEqual({
      name: "With end",
      date: "2026-10-16",
      endDate: "2026-10-17",
      timeFrom: "10:00",
      timeTo: "11:00",
      time: "10:00–11:00",
    });
    expect(stored.get("With times")?.properties).toEqual({
      name: "With times",
      date: "2026-10-16",
      timeFrom: "08:30",
      timeTo: "09:30",
      time: "08:30–09:30",
    });
    expect(stored.get("With start only")?.properties).toEqual({
      name: "With start only",
      date: "2026-10-16",
      timeFrom: "08:30",
      timeTo: "09:30",
      time: "08:30–09:30",
    });
  });

  it("stores nothing and records nothing for a tenant whose time zone is not valid, and converts after it is fixed", async () => {
    await setTimezone(prague, "Europe/Prag");
    const before = await rows(prague);

    await expect(runMigration(prague)).rejects.toBeInstanceOf(ValidationError);

    // The batch was rolled back: no row holds "Invalid DateTime" or any other change, and the transition is open.
    expect(await rows(prague)).toEqual(before);
    expect(JSON.stringify(await rows(prague))).not.toContain("Invalid DateTime");
    expect(await transitionRecorded(prague)).toBe(false);

    await setTimezone(prague, "Europe/Prague");
    await runMigration(prague);

    expect((await byName(prague)).get("Utc")?.properties).toEqual({
      name: "Utc",
      date: "2026-10-16",
      timeFrom: "10:00",
      timeTo: "11:00",
      time: "10:00–11:00",
    });
    expect(await transitionRecorded(prague)).toBe(true);
  });

  it("leaves an unreadable date and a row that needs no conversion as they are, and logs the id and nothing else", async () => {
    const info = vi.spyOn(migrationLogger, "info").mockImplementation(() => undefined);
    const before = await byName(prague);

    await runMigration(prague);

    const after = await byName(prague);
    for (const name of ["Text", "Impossible", "All day", "Current"]) {
      expect(after.get(name), name).toEqual(before.get(name));
    }
    const logged = info.mock.calls.filter(
      ([, message]) => message === "Module data migration converter logged a reason",
    );
    const ids = [before.get("Text")?.id, before.get("Impossible")?.id];
    // Every unreadable row is logged by each of the two passes, with its id as the item and as the whole reason.
    expect(logged.map(([fields]) => fields).sort(byItemId)).toEqual(
      [...ids, ...ids].map((id) => ({ itemId: id, reason: id })).sort(byItemId),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("abc");
    expect(JSON.stringify(info.mock.calls)).not.toContain("2026-02-30");
  });

  it("changes no row on a second run, recorded or not, and leaves updated_at as it is", async () => {
    await runMigration(prague);
    const once = await rows(prague);
    expect(once.length).toBe(Object.keys(PRAGUE_EVENTS).length);

    // A second call is a no-op for the recorded transition.
    await runMigration(prague);
    expect(await rows(prague)).toEqual(once);

    // The converter itself changes no converted row either, so no `updated_at` moves.
    await forgetTransition(prague);
    await runMigration(prague);
    expect(await rows(prague)).toEqual(once);
  });

  it("rewrites only the rows it converts", async () => {
    const before = await byName(prague);

    await runMigration(prague);

    const after = await byName(prague);
    for (const name of ["All day", "Text", "Impossible", "Current"]) {
      expect(after.get(name)?.updated_at, name).toBe(before.get(name)?.updated_at);
    }
    for (const name of ["Utc", "Offset", "Wall clock", "With end", "With times", "With start only"]) {
      expect(after.get(name)?.updated_at, name).not.toBe(before.get(name)?.updated_at);
    }
  });

  it("keeps an edit committed on a row that is locked while the second pass waits for it", async () => {
    const before = await byName(prague);
    const lockedId = before.get("Utc")?.id;
    if (lockedId === undefined) throw new Error("fixture row is missing");
    const databaseId = await eventsDatabaseOf(prague);

    let run: Promise<void> | undefined;
    // A managed transaction taken inside the tenant's scope: the choke point's edit below needs one, and the lock and
    // the edit see the tenant's rows.
    await runInTenant(prague, () =>
      withTransaction(pool, async (lockClient) => {
        await lockClient.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE", [
          databaseId,
          lockedId,
        ]);
        const { rows: pids } = await lockClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const lockPid = pids[0]!.pid;

        // The first pass skips the locked row; the second starts from the lowest id and waits for it.
        run = runMigration(prague, 1);
        await vi.waitFor(
          async () => {
            const { rows: waiters } = await pool.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
              [lockPid],
            );
            expect(Number(waiters[0]!.count)).toBe(1);
          },
          { timeout: 10_000, interval: 20 },
        );
        expect((await byName(prague)).get("Utc")?.properties.date).toBe("2026-10-16T08:00:00Z");

        // The edit goes through the choke point and commits together with the lock.
        await updateItemWithClient(lockClient, {
          databaseId,
          itemId: lockedId,
          propertiesPatch: { name: "Utc edited" },
        });
      }),
    );
    await run;

    const stored = await byName(prague);
    expect(stored.get("Utc edited")?.properties).toEqual({
      name: "Utc edited",
      date: "2026-10-16",
      timeFrom: "10:00",
      timeTo: "11:00",
      time: "10:00–11:00",
    });
    expect(stored.has("Utc")).toBe(false);
    // Every other row was converted by the first pass or the second, and none is left with a time inside `date`.
    expect((await byName(prague)).get("Wall clock")?.properties.date).toBe("2026-10-16");
  });
});

function byItemId(left: unknown, right: unknown): number {
  const id = (value: unknown): string => z.object({ itemId: z.string() }).parse(value).itemId;
  return id(left).localeCompare(id(right));
}
