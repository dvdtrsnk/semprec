import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { runEventsCalendarPropertiesCutoverMigration } from "../eventsCalendarPropertiesCutoverMigration.js";

let pool: Pool;

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
    await pool.query(
      `DELETE FROM properties p USING databases d
       WHERE d.id = p.database_id AND d.owner_module_id = 'events' AND p.key = ANY($1::text[])`,
      [NEW_KEYS],
    );
    const before = await eventProperties();
    expect(before.map((p) => p.key)).toEqual(fresh.map((p) => p.key).filter((key) => !NEW_KEYS.includes(key)));

    await runEventsCalendarPropertiesCutoverMigration(pool);
    expect(await eventProperties()).toEqual(fresh);

    await runEventsCalendarPropertiesCutoverMigration(pool);
    expect(await eventProperties()).toEqual(fresh);
  });

  it("is a no-op when there is no Events database", async () => {
    await resetDatabase(pool);
    await expect(runEventsCalendarPropertiesCutoverMigration(pool)).resolves.toBeUndefined();
  });
});
