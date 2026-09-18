import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, computeDestructiveResourceProjection, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

/**
 * Snapshot hash correctness (issue #89): `computeDestructiveResourceProjection`'s sha256 is what
 * `DestructiveApprovalPreflight` persists and `ApprovedOperationExecutor` later recomputes to
 * detect a resource that changed between approval and execution — so for every one of the five
 * destructive kinds, the hash must be deterministic for an unchanged resource and must change
 * when the exact field its own projection includes changes.
 */
describe("computeDestructiveResourceProjection snapshot hashing (issue #89)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("database.archive: is deterministic for an unchanged database, and changes when the name changes", async () => {
    const database = await chokePoint.createDatabase({ name: "Movies" });

    const first = await withTransaction(pool, (client) =>
      computeDestructiveResourceProjection(client, {
        operation: "database.archive",
        input: { databaseId: database.id },
      }),
    );
    const second = await withTransaction(pool, (client) =>
      computeDestructiveResourceProjection(client, {
        operation: "database.archive",
        input: { databaseId: database.id },
      }),
    );
    expect(first.snapshot).toEqual(second.snapshot);
    expect(first.snapshot.kind).toBe("database_archive");
    expect(first.snapshot.resourceId).toBe(database.id);

    await chokePoint.renameDatabase(database.id, "Renamed Movies");
    const third = await withTransaction(pool, (client) =>
      computeDestructiveResourceProjection(client, {
        operation: "database.archive",
        input: { databaseId: database.id },
      }),
    );
    expect(third.snapshot.sha256).not.toBe(first.snapshot.sha256);
  });

  it("property.delete: is deterministic for an unchanged property, and changes when the schema's lock state changes", async () => {
    const database = await chokePoint.createDatabase({ name: "Movies" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });

    const first = await withTransaction(pool, (client) =>
      computeDestructiveResourceProjection(client, {
        operation: "property.delete",
        input: { propertyId: property.id },
      }),
    );
    const second = await withTransaction(pool, (client) =>
      computeDestructiveResourceProjection(client, {
        operation: "property.delete",
        input: { propertyId: property.id },
      }),
    );
    expect(first.snapshot).toEqual(second.snapshot);
    expect(first.snapshot.kind).toBe("property_delete");

    await pool.query(`UPDATE databases SET schema_locked = true WHERE id = $1`, [database.id]);
    const third = await withTransaction(pool, (client) =>
      computeDestructiveResourceProjection(client, {
        operation: "property.delete",
        input: { propertyId: property.id },
      }),
    );
    expect(third.snapshot.sha256).not.toBe(first.snapshot.sha256);
  });

  it("item.delete: is deterministic for an unchanged item, and changes when the item is updated", async () => {
    const database = await chokePoint.createDatabase({ name: "Movies" });
    const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });

    const first = await withTransaction(pool, (client) =>
      computeDestructiveResourceProjection(client, { operation: "item.delete", input: { itemId: item.id } }),
    );
    const second = await withTransaction(pool, (client) =>
      computeDestructiveResourceProjection(client, { operation: "item.delete", input: { itemId: item.id } }),
    );
    expect(first.snapshot).toEqual(second.snapshot);
    expect(first.snapshot.kind).toBe("item_delete");

    await pool.query(`UPDATE items SET updated_at = now() WHERE id = $1`, [item.id]);
    const third = await withTransaction(pool, (client) =>
      computeDestructiveResourceProjection(client, { operation: "item.delete", input: { itemId: item.id } }),
    );
    expect(third.snapshot.sha256).not.toBe(first.snapshot.sha256);
  });

  it("item.delete: rejects an already-deleted item instead of letting it be approved and replayed", async () => {
    const database = await chokePoint.createDatabase({ name: "Movies" });
    const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
    await chokePoint.softDeleteItem(database.id, item.id);

    await expect(
      withTransaction(pool, (client) =>
        computeDestructiveResourceProjection(client, { operation: "item.delete", input: { itemId: item.id } }),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it("view.delete: is deterministic for an unchanged view, and changes when its config changes", async () => {
    const database = await chokePoint.createDatabase({ name: "Movies" });
    const view = await chokePoint.createView(
      { databaseId: database.id, type: "table", name: "All", config: {}, isDefault: false },
      { type: "user" },
    );

    const first = await withTransaction(pool, (client) =>
      computeDestructiveResourceProjection(client, {
        operation: "view.delete",
        input: { viewId: view.id },
        actor: { type: "user" },
      }),
    );
    const second = await withTransaction(pool, (client) =>
      computeDestructiveResourceProjection(client, {
        operation: "view.delete",
        input: { viewId: view.id },
        actor: { type: "user" },
      }),
    );
    expect(first.snapshot).toEqual(second.snapshot);
    expect(first.snapshot.kind).toBe("view_delete");

    await chokePoint.patchView({ id: view.id, actor: { type: "user" }, name: "Renamed view" });
    const third = await withTransaction(pool, (client) =>
      computeDestructiveResourceProjection(client, {
        operation: "view.delete",
        input: { viewId: view.id },
        actor: { type: "user" },
      }),
    );
    expect(third.snapshot.sha256).not.toBe(first.snapshot.sha256);
  });

  it("relation.delete: is deterministic for an unchanged edge, and changes when the property's lock state changes", async () => {
    const source = await chokePoint.createDatabase({ name: "Source" });
    const target = await chokePoint.createDatabase({ name: "Target" });
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: source.id,
      key: "linked",
      name: "Linked",
      targetDatabaseId: target.id,
      cardinality: "many_to_many",
      owner: "user",
      locked: false,
    });
    const callerItem = await chokePoint.createItem({ databaseId: source.id, properties: {} });
    const targetItem = await chokePoint.createItem({ databaseId: target.id, properties: {} });
    await chokePoint.createRelation({
      relationPropertyId: property.id,
      callerItemId: callerItem.id,
      targetItemId: targetItem.id,
    });

    const check = {
      operation: "relation.delete" as const,
      input: { relationPropertyId: property.id, callerItemId: callerItem.id, targetItemId: targetItem.id },
    };
    const first = await withTransaction(pool, (client) => computeDestructiveResourceProjection(client, check));
    const second = await withTransaction(pool, (client) => computeDestructiveResourceProjection(client, check));
    expect(first.snapshot).toEqual(second.snapshot);
    expect(first.snapshot.kind).toBe("relation_delete");

    await pool.query(`UPDATE properties SET locked = true WHERE id = $1`, [property.id]);
    const third = await withTransaction(pool, (client) => computeDestructiveResourceProjection(client, check));
    expect(third.snapshot.sha256).not.toBe(first.snapshot.sha256);
  });
});
