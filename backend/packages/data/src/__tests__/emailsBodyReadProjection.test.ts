import "../domainWriteHooks.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import type { ItemRow } from "../types.js";

const raw = '<p onclick="evil()">safe</p><script>evil()</script><img src="https://tracker.example/pixel">';
let pool: Pool;
let cp: ChokePoint;
let item: ItemRow;

describe("Emails body read projection", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    cp = createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    item = await withTransaction(pool, async (client) => {
      const db = await getDatabaseByModuleId(client, "emails");
      if (!db) throw new Error("Emails not seeded");
      return createItemWithClient(
        client,
        { databaseId: db.id, properties: { body: raw } },
        { allowedSystemKeys: ["body"] },
      );
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  it.each(["get", "find", "deleted", "list", "path", "view", "database", "viewItems"])(
    "projects the %s read",
    async (path) => {
      const view = await cp.createView({ databaseId: item.databaseId, type: "list", name: "Projection", config: {} });
      const rows =
        path === "get"
          ? [await cp.getItem(item.databaseId, item.id)]
          : path === "find"
            ? [await cp.findItem(item.id)]
            : path === "deleted"
              ? [await cp.findItemIncludingDeleted(item.id)]
              : path === "list"
                ? (await cp.listItems(item.databaseId)).items
                : path === "path"
                  ? await cp.getItemPath(item.id)
                  : path === "view"
                    ? (await cp.queryView(view.id)).items
                    : path === "database"
                      ? (await cp.queryDatabaseItems(item.databaseId, {})).items
                      : (await cp.queryViewItems(view.id, {})).items;
      const found = rows.find((row) => row?.id === item.id);
      expect(found?.properties.body).toContain("safe");
      expect(found?.properties.body).not.toMatch(/<script|onclick|https:\/\/tracker/i);
    },
  );
  it("strips a protocol-relative remote image from a generic read (R1 F1)", async () => {
    const body = '<p>safe</p><img src="//tracker.example/pixel.gif" alt="pixel"><img src="cid:logo">';
    const stored = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: item.databaseId, properties: { body } },
        { allowedSystemKeys: ["body"] },
      ),
    );
    const read = await cp.findItem(stored.id);
    expect(read?.properties.body).toContain("safe");
    expect(read?.properties.body).toContain('src="cid:logo"');
    expect(read?.properties.body).not.toContain("tracker.example");
    await withTransaction(pool, async (client) => {
      expect((await getItemById(client, item.databaseId, stored.id))?.properties.body).toBe(body);
    });
  });
  it("projects the public create response on an idempotent replay", async () => {
    await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: item.databaseId, properties: { body: raw }, idempotencyKey: "projection-replay" },
        { allowedSystemKeys: ["body"] },
      ),
    );
    const replay = await cp.createItem({
      databaseId: item.databaseId,
      properties: {},
      idempotencyKey: "projection-replay",
    });
    expect(replay.properties.body).toContain("safe");
    expect(replay.properties.body).not.toMatch(/<script|onclick|https:\/\/tracker/i);
  });
  it("keeps internal store and transaction-scoped write responses raw", async () => {
    expect(item.properties.body).toBe(raw);
    await withTransaction(pool, async (client) => {
      expect((await getItemById(client, item.databaseId, item.id))?.properties.body).toBe(raw);
      const updated = await updateItemWithClient(client, {
        databaseId: item.databaseId,
        itemId: item.id,
        propertiesPatch: { read: true },
      });
      expect(updated.properties.body).toBe(raw);
    });
  });
  it("keeps Emails without a body unchanged and projects an empty page", async () => {
    const empty = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: item.databaseId, properties: {} }),
    );
    expect((await cp.findItem(empty.id))?.properties).toEqual(empty.properties);
    const db = await cp.createDatabase({ name: "Empty" });
    expect((await cp.listItems(db.id)).items).toEqual([]);
  });
  it("preserves the body in other databases", async () => {
    const db = await cp.createDatabase({ name: "Other" });
    await cp.createProperty({ databaseId: db.id, key: "body", name: "Body", type: "longText" });
    const other = await cp.createItem({ databaseId: db.id, properties: { body: raw } });
    expect(other.properties.body).toBe(raw);
    expect((await cp.findItem(other.id))?.properties.body).toBe(raw);
  });
});
