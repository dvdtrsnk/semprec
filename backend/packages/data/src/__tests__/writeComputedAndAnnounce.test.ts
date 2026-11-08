import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createItemWithClient, writeComputedAndAnnounce } from "../chokePoint/itemWrites.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";

let pool: Pool;

describe("writeComputedAndAnnounce", () => {
  let databaseId: string;
  let itemId: string;
  let events: InvalidationEvent[];

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'transcripts'");
    if (!rows[0]) throw new Error("Transcripts database was not seeded");
    databaseId = rows[0].id;
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId, properties: { name: "Call" } }),
    );
    itemId = item.id;
    events = [];
    setInvalidationHook((event) => events.push(event));
  });

  afterEach(() => {
    setInvalidationHook(() => {});
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("writes the key and announces it after the commit with the row's updatedAt", async () => {
    await withTransaction(pool, async (client) => {
      await writeComputedAndAnnounce(client, databaseId, itemId, "language", "cs");
      expect(events).toEqual([]);
    });

    const item = await withTransaction(pool, (client) => getItemById(client, databaseId, itemId));
    expect(item?.computed.language).toBe("cs");
    expect(events).toEqual([{ scope: "item", databaseId, itemId, op: "update", updatedAt: item?.updatedAt }]);
  });

  it("announces nothing and writes nothing when the transaction rolls back", async () => {
    await expect(
      withTransaction(pool, async (client) => {
        await writeComputedAndAnnounce(client, databaseId, itemId, "language", "cs");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const item = await withTransaction(pool, (client) => getItemById(client, databaseId, itemId));
    expect(Object.hasOwn(item?.computed ?? {}, "language")).toBe(false);
    expect(events).toEqual([]);
  });

  it("throws and announces nothing when the item does not exist", async () => {
    await expect(
      withTransaction(pool, (client) =>
        writeComputedAndAnnounce(client, databaseId, "00000000-0000-0000-0000-000000000000", "language", "cs"),
      ),
    ).rejects.toThrow(/affect at least one row/);
    expect(events).toEqual([]);
  });
});
