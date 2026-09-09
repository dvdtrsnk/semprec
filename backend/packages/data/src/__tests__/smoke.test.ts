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
    const { rows } = await pool.query<{
      name: string | null;
      key: string | null;
      system: boolean;
      schema_locked: boolean;
    }>("SELECT name, key, system, schema_locked FROM databases");

    const named = rows.filter((r) => r.name !== null).map((r) => r.name);
    const keyed = rows.filter((r) => r.name === null).map((r) => r.key);
    named.sort();
    keyed.sort();

    expect(named).toEqual([
      "Books",
      "Emails",
      "Folders",
      "Inbox",
      "Inbox item types",
      "MCP servers",
      "Mailboxes",
      "Movies/TV",
      "Processing proposals",
      "System settings",
    ]);
    // The ten hardcoded databases (issue #24) carry a stable key and a null name
    // (issue #235) instead of a hardcoded English label.
    expect(keyed).toEqual(
      [
        "areas",
        "companies",
        "events",
        "files",
        "healthRecords",
        "journal",
        "people",
        "projects",
        "tasks",
        "transcripts",
      ].sort(),
    );
    expect(rows.every((r) => r.system === true && r.schema_locked === true)).toBe(true);
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
