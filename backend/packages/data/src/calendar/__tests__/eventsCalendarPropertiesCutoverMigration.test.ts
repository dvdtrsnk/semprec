import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { createRuntimeRolePool, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { runEventsCalendarPropertiesCutoverMigration } from "../eventsCalendarPropertiesCutoverMigration.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";

let pool: Pool;
let runtimePool: Pool | undefined;

const NEW_KEYS = [
  "endDate",
  "timeFrom",
  "timeTo",
  "time",
  "place",
  "url",
  "description",
  "alertMinutes",
  "travelMinutes",
];

interface PropertyShape {
  key: string;
  name: string | null;
  type: string;
  config: unknown;
  locked: boolean;
  owner: string;
  owner_process: string | null;
}

async function eventProperties(): Promise<PropertyShape[]> {
  const { rows } = await pool.query<PropertyShape>(
    `SELECT p.key, p.name, p.type, p.config, p.locked, p.owner, p.owner_process
     FROM properties p JOIN databases d ON d.id = p.database_id
     WHERE d.owner_module_id = 'events' ORDER BY p.key`,
  );
  return rows;
}

describe("runEventsCalendarPropertiesCutoverMigration (issue #1416)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  afterEach(async () => {
    await runtimePool?.end();
    runtimePool = undefined;
  });

  it("seeds the nine calendar properties with the stated types and owners", async () => {
    const byKey = new Map((await eventProperties()).map((p) => [p.key, p]));
    const expected: Record<string, [string, string, boolean]> = {
      endDate: ["date", "user", false],
      timeFrom: ["time", "user", false],
      timeTo: ["time", "user", false],
      time: ["time", "system", true],
      place: ["text", "user", false],
      url: ["url", "user", false],
      description: ["longText", "user", false],
      alertMinutes: ["number", "user", false],
      travelMinutes: ["number", "user", false],
    };
    for (const [key, [type, owner, locked]] of Object.entries(expected)) {
      expect(byKey.get(key), key).toMatchObject({ type, owner, locked });
    }
    expect(byKey.get("date")?.config).toEqual({ includeTime: true });
  });

  it("adds exactly the missing properties to a previously seeded database, identical to a fresh seed, once", async () => {
    const fresh = await eventProperties();
    const database = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'events'");
    if (!database.rows[0]) throw new Error("Events database was not seeded");
    const event = await createChokePoint(pool).createItem({
      databaseId: database.rows[0].id,
      properties: { name: "Existing event", date: "2026-10-16" },
    });
    // Reconstruct the previous Events seed's property list; public APIs cannot alter its locked schema.
    await withTransaction(pool, (client) =>
      client.query(
        `DELETE FROM properties p USING databases d
         WHERE d.id = p.database_id AND d.owner_module_id = 'events' AND p.key = ANY($1::text[])`,
        [NEW_KEYS],
      ),
    );
    const original = await createChokePoint(pool).getItem(database.rows[0].id, event.id);
    const before = await eventProperties();
    expect(before.map((p) => p.key)).toEqual(fresh.map((p) => p.key).filter((key) => !NEW_KEYS.includes(key)));

    await runEventsCalendarPropertiesCutoverMigration(pool);
    expect(await eventProperties()).toEqual(fresh);
    expect(await createChokePoint(pool).getItem(database.rows[0].id, event.id)).toEqual(original);

    await runEventsCalendarPropertiesCutoverMigration(pool);
    expect(await eventProperties()).toEqual(fresh);
    expect(await createChokePoint(pool).getItem(database.rows[0].id, event.id)).toEqual(original);
  });

  it("is a no-op when there is no Events database", async () => {
    await resetDatabase(pool);
    await expect(runEventsCalendarPropertiesCutoverMigration(pool)).resolves.toBeUndefined();
    const { rows } = await pool.query<{ databases: number; properties: number }>(
      "SELECT (SELECT count(*)::int FROM databases) AS databases, (SELECT count(*)::int FROM properties) AS properties",
    );
    expect(rows).toEqual([{ databases: 0, properties: 0 }]);
  });

  it("runs the Events cutover through the registered tenant maintenance entry point", async () => {
    const fresh = await eventProperties();
    // Reconstruct the previous Events property list; its locked schema has no public delete path.
    await withTransaction(pool, (client) =>
      client.query(
        `DELETE FROM properties p USING databases d
       WHERE d.id = p.database_id AND d.owner_module_id = 'events' AND p.key = ANY($1::text[])`,
        [NEW_KEYS],
      ),
    );
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    runtimePool = runtime;
    const run = () => runAsSystem("test Events cutover", () => runTenantCutoverMigrations(runtime));
    await run();
    expect(await eventProperties()).toEqual(fresh);
    await run();
    expect(await eventProperties()).toEqual(fresh);
  });

  it.each(["cs", "en"])("contains names for all nine Events properties in the %s catalog", async (locale) => {
    const catalog: unknown = JSON.parse(
      await readFile(new URL(`../../seed/i18n/${locale}.json`, import.meta.url), "utf8"),
    );
    if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) throw new Error("Invalid catalog");
    for (const key of NEW_KEYS) {
      const name = Object.getOwnPropertyDescriptor(catalog, `property.events.${key}.name`)?.value;
      expect(typeof name).toBe("string");
      expect(name).not.toBe("");
    }
  });
});
