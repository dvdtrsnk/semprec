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
      "Emails",
      "Folders",
      "Inbox",
      "Inbox item types",
      "MCP servers",
      "Mailboxes",
      "Processing proposals",
      "System settings",
      "Threads",
    ]);
    // The ten hardcoded databases (issue #24) carry a stable key and a null name
    // (issue #235) instead of a hardcoded English label.
    expect(keyed).toEqual(
      [
        "areas",
        "books",
        // The Calendars system database (issue #1600).
        "calendars",
        "companies",
        "events",
        "files",
        "healthRecords",
        // The Invitations system database of the calendar module (issue gh-1901).
        "invitations",
        "journal",
        "movies",
        "people",
        "projects",
        // The Recipes system database (issue #1707).
        "recipes",
        // The three system databases of the sleep module (issue #1776).
        "sleepNights",
        "sleepPlans",
        "sleepSettings",
        // The subscribed events system database of the calendar module (issue gh-1962).
        "subscribedEvents",
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
