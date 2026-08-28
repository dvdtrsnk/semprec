import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";

let pool: Pool;

describe("smoke: choke-point end to end", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("seeds the system records", async () => {
    await seedSystem(pool);
    const { rows } = await pool.query("SELECT name, system, schema_locked FROM databases ORDER BY name");
    expect(rows).toEqual(
      [
        "Areas",
        "Companies",
        "Events",
        "Files",
        "Health records",
        "Journal",
        "People",
        "Projects",
        "System settings",
        "Tasks",
        "Transcripts",
      ].map((name) => ({ name, system: true, schema_locked: true })),
    );
  });

  it("creates a database, a property, and an item through the choke-point", async () => {
    const chokePoint = createChokePoint(pool);
    const db = await chokePoint.createDatabase({ name: "Movies" });
    await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });

    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Sicario" } });
    expect(item.properties).toEqual({ title: "Sicario" });

    const fetched = await chokePoint.getItem(db.id, item.id);
    expect(fetched?.id).toBe(item.id);
  });
});
