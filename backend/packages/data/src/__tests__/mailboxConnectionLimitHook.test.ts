import "../domainWriteHooks.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
let pool: Pool;
let cp: ChokePoint;
let databaseId: string;
describe("mailbox connection limit registration", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    cp = createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
    const db = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "mailboxes"));
    if (!db) throw new Error("Mailboxes not seeded");
    databaseId = db.id;
  });
  afterAll(async () => {
    await pool.end();
  });
  it.each([0, 16, 2.5, "2"])("refuses create and update of %s without writing", async (value) => {
    const before = await cp.listItems(databaseId);
    await expect(cp.createItem({ databaseId, properties: { connectionLimit: value } })).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field: "connectionLimit" },
    });
    expect(await cp.listItems(databaseId)).toEqual(before);
    const item = await cp.createItem({ databaseId, properties: { connectionLimit: 1 } });
    await expect(
      cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { connectionLimit: value } }),
    ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "connectionLimit" } });
    expect((await cp.getItem(databaseId, item.id))?.properties.connectionLimit).toBe(1);
  });
  it.each([1, 15, null])("accepts create and update of %s", async (value) => {
    const item = await cp.createItem({ databaseId, properties: { connectionLimit: value } });
    expect(item.properties.connectionLimit).toBe(value);
    expect(
      (await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { connectionLimit: value } })).properties
        .connectionLimit,
    ).toBe(value);
  });
  it("permits an unrelated patch over a legacy out-of-range value", async () => {
    const item = await cp.createItem({ databaseId, properties: { connectionLimit: 1 } });
    // Legacy invalid data cannot be created through the validated choke point.
    const seeded = await pool.query<{ id: string }>(
      "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = $2 RETURNING id",
      [databaseId, item.id, JSON.stringify({ connectionLimit: 100 })],
    );
    expect(seeded.rows).toEqual([{ id: item.id }]);
    const updated = await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { name: "Renamed" } });
    expect(updated.properties).toMatchObject({ connectionLimit: 100, name: "Renamed" });
  });
  it("does not validate another database", async () => {
    const db = await cp.createDatabase({ name: "Other" });
    await cp.createProperty({ databaseId: db.id, key: "connectionLimit", name: "Connection limit", type: "number" });
    const item = await cp.createItem({ databaseId: db.id, properties: { connectionLimit: 0 } });
    expect(
      (await cp.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { connectionLimit: 16 } })).properties
        .connectionLimit,
    ).toBe(16);
  });
});
