import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { buildResourceSnapshot, computeDestructiveResourceProjection } from "../chokePoint/destructiveProjection.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { withTransaction } from "../db/pool.js";
import { ApprovalResourceBusyError, NotFoundError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

afterAll(async () => {
  await pool?.end();
});

/**
 * `computeDestructiveResourceProjection`'s sha256 is persisted at approval and recomputed at execution to
 * detect a changed resource, so for each destructive kind it must be deterministic for an unchanged
 * resource and change when a projected field changes.
 */
describe("computeDestructiveResourceProjection snapshot hashing (issue #89)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
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

/**
 * The check of a `relation.delete` locks both endpoint rows without waiting before it reserves the edge's
 * value links, as `relation.put` and `relation.set` do. Lock-order schedules are in
 * `relationDeleteApprovalLockOrder.test.ts`.
 */
describe("computeDestructiveResourceProjection of relation.delete locks the endpoint rows (docs/adr/2026-11-15-the-approval-check-of-a-relation-delete-locks-the-edges-endpoint-rows-before-it-reserves-its-value-links.md)", () => {
  interface EdgeFixture {
    check: {
      operation: "relation.delete";
      input: { relationPropertyId: string; callerItemId: string; targetItemId: string };
    };
    sourceDatabaseId: string;
    targetDatabaseId: string;
    callerItemId: string;
    targetItemId: string;
  }

  async function edgeFixture(): Promise<EdgeFixture> {
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
    return {
      check: {
        operation: "relation.delete",
        input: { relationPropertyId: property.id, callerItemId: callerItem.id, targetItemId: targetItem.id },
      },
      sourceDatabaseId: source.id,
      targetDatabaseId: target.id,
      callerItemId: callerItem.id,
      targetItemId: targetItem.id,
    };
  }

  async function holdingRow<T>(itemId: string, body: () => Promise<T>): Promise<T> {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      const locked = await holder.query<{ id: string }>("SELECT id FROM items WHERE id = $1 FOR UPDATE", [itemId]);
      expect(locked.rows).toHaveLength(1);
      return await body();
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  it.each([["the caller's row", "callerItemId"] as const, ["the target's row", "targetItemId"] as const])(
    "is refused as busy at once and marks the transaction rollback-only while another transaction holds %s",
    async (_name, held) => {
      const fixture = await edgeFixture();
      await holdingRow(fixture[held], async () => {
        let thrown: unknown;
        // A check that waited for the row would never end: the holder releases it only after this body returns.
        await expect(
          withTransaction(pool, async (client) => {
            try {
              await computeDestructiveResourceProjection(client, fixture.check);
            } catch (error) {
              thrown = error;
            }
            // The body returns normally, so the refusal below is the rollback-only mark and not the thrown error.
          }),
        ).rejects.toBeInstanceOf(ApprovalResourceBusyError);
        expect(thrown).toBeInstanceOf(ApprovalResourceBusyError);
      });
    },
  );

  it("is not refused while another transaction holds the row of an item that is no endpoint of the edge", async () => {
    const fixture = await edgeFixture();
    const bystander = await chokePoint.createItem({ databaseId: fixture.sourceDatabaseId, properties: {} });
    const projection = await holdingRow(bystander.id, () =>
      withTransaction(pool, (client) => computeDestructiveResourceProjection(client, fixture.check)),
    );
    expect(projection.snapshot.kind).toBe("relation_delete");
  });

  it("keeps the snapshot hash of the edge when no endpoint row is held", async () => {
    const fixture = await edgeFixture();
    // The hash a projection without the endpoint locks had: the edge row and four fields of the relation property.
    const expected = await withTransaction(pool, async (client) => {
      const property = await propertiesStore.getProperty(client, fixture.check.input.relationPropertyId);
      const reldef = await relationsStore.getRelationDefinitionByPropertyId(
        client,
        fixture.check.input.relationPropertyId,
      );
      if (!property || !reldef) throw new Error("The relation property is missing");
      const [edge, ...others] = await relationsStore.listRelationsForItem(client, reldef.id, fixture.callerItemId);
      if (!edge || others.length > 0) throw new Error("Expected exactly one edge");
      return buildResourceSnapshot("relation_delete", edge.id, {
        ...edge,
        property: {
          id: property.id,
          owner: property.owner,
          ownerProcess: property.ownerProcess,
          locked: property.locked,
        },
      });
    });

    const projection = await withTransaction(pool, (client) =>
      computeDestructiveResourceProjection(client, fixture.check),
    );

    expect(projection.snapshot).toEqual(expected);
    expect(projection.valueLinks).toBeUndefined();
  });

  it("still projects an edge whose other endpoint row no longer exists", async () => {
    const fixture = await edgeFixture();
    // The edge table keeps no foreign key to the items of its two ends, so an edge to a purged item can still exist; only raw SQL leaves that state.
    await pool.query("DELETE FROM items WHERE id = $1", [fixture.targetItemId]);

    const projection = await withTransaction(pool, (client) =>
      computeDestructiveResourceProjection(client, fixture.check),
    );

    expect(projection.snapshot.kind).toBe("relation_delete");
    expect(projection.currentResource).toMatchObject({
      itemA: expect.any(String),
      itemB: expect.any(String),
    });
  });
});
