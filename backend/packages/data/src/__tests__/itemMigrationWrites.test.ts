import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { migrateItemPropertyWithClient, type MigrateItemPropertyInput } from "../chokePoint/itemMigrationWrites.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import type { ItemRow } from "../types.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function migrate(input: MigrateItemPropertyInput): Promise<void> {
  await withTransaction(pool, (client) => migrateItemPropertyWithClient(client, input));
}

/** Reads the row whether or not it is soft-deleted, which `chokePoint.getItem` does not. */
async function readItem(databaseId: string, itemId: string): Promise<ItemRow> {
  const item = await getItemById(pool, databaseId, itemId);
  if (!item) throw new Error(`item ${itemId} not found`);
  return item;
}

describe("migrateItemPropertyWithClient", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeItem(): Promise<{ databaseId: string; itemId: string; before: ItemRow }> {
    const db = await chokePoint.createDatabase({ name: "Scores" });
    await chokePoint.createProperty({ databaseId: db.id, key: "score", name: "Score", type: "text" });
    await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { score: "7", title: "Dune" } });
    return { databaseId: db.id, itemId: item.id, before: await readItem(db.id, item.id) };
  }

  it("set replaces only the key, keeps the other keys and advances updated_at", async () => {
    const { databaseId, itemId, before } = await makeItem();

    await migrate({ databaseId, itemId, key: "score", change: { kind: "set", value: 7 } });

    const after = await readItem(databaseId, itemId);
    expect(after.properties).toEqual({ score: 7, title: "Dune" });
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
  });

  it("remove deletes only the key and advances updated_at", async () => {
    const { databaseId, itemId, before } = await makeItem();

    await migrate({ databaseId, itemId, key: "score", change: { kind: "remove" } });

    const after = await readItem(databaseId, itemId);
    expect(after.properties).toEqual({ title: "Dune" });
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
  });

  it("set writes a soft-deleted item", async () => {
    const { databaseId, itemId } = await makeItem();
    await chokePoint.softDeleteItem(databaseId, itemId);
    const before = await readItem(databaseId, itemId);
    expect(before.deletedAt).not.toBeNull();

    await migrate({ databaseId, itemId, key: "score", change: { kind: "set", value: 7 } });

    const after = await readItem(databaseId, itemId);
    expect(after.properties).toEqual({ score: 7, title: "Dune" });
    expect(after.deletedAt).toBe(before.deletedAt);
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
  });

  it("remove writes a soft-deleted item", async () => {
    const { databaseId, itemId } = await makeItem();
    await chokePoint.softDeleteItem(databaseId, itemId);
    const before = await readItem(databaseId, itemId);
    expect(before.deletedAt).not.toBeNull();

    await migrate({ databaseId, itemId, key: "score", change: { kind: "remove" } });

    const after = await readItem(databaseId, itemId);
    expect(after.properties).toEqual({ title: "Dune" });
    expect(after.deletedAt).toBe(before.deletedAt);
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
  });

  it("set throws with the conversion label when no row matches and writes nothing", async () => {
    const { databaseId, itemId, before } = await makeItem();

    await expect(
      migrate({ databaseId, itemId: randomUUID(), key: "score", change: { kind: "set", value: 7 } }),
    ).rejects.toThrow(/property type migration value conversion update to affect at least one row, got 0/);

    expect(await readItem(databaseId, itemId)).toEqual(before);
  });

  it("remove throws with the dropped-value label when no row matches and writes nothing", async () => {
    const { databaseId, itemId, before } = await makeItem();

    await expect(
      migrate({ databaseId, itemId: randomUUID(), key: "score", change: { kind: "remove" } }),
    ).rejects.toThrow(/property type migration dropped value update to affect at least one row, got 0/);

    expect(await readItem(databaseId, itemId)).toEqual(before);
  });
});
