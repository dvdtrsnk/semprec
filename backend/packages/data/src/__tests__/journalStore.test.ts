import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";

let pool: Pool;
let chokePoint: ChokePoint;
let viewTypeRegistry: ViewTypeRegistry;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function reservationItemId(key: string): Promise<string | null> {
  const { rows } = await pool.query<{ item_id: string }>("SELECT item_id FROM idempotency_keys WHERE key = $1", [key]);
  return rows[0]?.item_id ?? null;
}

describe("journalStore: releasing a stale idempotency reservation", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    chokePoint = createChokePoint(pool, undefined, viewTypeRegistry);
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("a soft-deleted period item is replaced by a fresh live one, and the trashed row is left alone", async () => {
    const journalId = await databaseIdFor("journal");
    const first = await withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journalId, "day", new Date("2026-08-28T10:00:00Z"), "Europe/Prague"),
    );
    const key = `journal:${journalId}:day:2026-08-28`;
    expect(await reservationItemId(key)).toBe(first.id);

    await chokePoint.softDeleteItem(journalId, first.id);

    const second = await withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journalId, "day", new Date("2026-08-28T18:00:00Z"), "Europe/Prague"),
    );
    expect(second.id).not.toBe(first.id);
    expect(second.deletedAt).toBeNull();

    const trashed = await chokePoint.getItem(journalId, first.id);
    expect(trashed?.deletedAt).not.toBeNull();

    expect(await reservationItemId(key)).toBe(second.id);
  });

  it("a purged period item (row gone, reservation left behind) is replaced by a fresh one, with no throw", async () => {
    const journalId = await databaseIdFor("journal");
    const first = await withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journalId, "day", new Date("2026-08-28T10:00:00Z"), "Europe/Prague"),
    );
    const key = `journal:${journalId}:day:2026-08-28`;

    // Simulate a pre-C2 purge: the items row is gone but the reservation was left behind.
    await pool.query("DELETE FROM items WHERE id = $1", [first.id]);

    const second = await withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journalId, "day", new Date("2026-08-28T18:00:00Z"), "Europe/Prague"),
    );
    expect(second.id).not.toBe(first.id);
    expect(second.deletedAt).toBeNull();
    expect(await reservationItemId(key)).toBe(second.id);
  });

  it("two concurrent calls for a never-created period converge on exactly one item", async () => {
    const journalId = await databaseIdFor("journal");
    const [a, b] = await Promise.all([
      withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, journalId, "day", new Date("2026-08-28T10:00:00Z"), "Europe/Prague"),
      ),
      withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, journalId, "day", new Date("2026-08-28T10:05:00Z"), "Europe/Prague"),
      ),
    ]);
    expect(a.id).toBe(b.id);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [journalId]);
    expect(rows[0].n).toBe(1);
  });
});
