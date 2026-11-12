import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { registerItemCreateHook, type ItemCreateHookContext } from "../chokePoint/hooks.js";
import { createItemWithRelationsWithClient, type InitialItemRelation } from "../index.js";
import { createRelationPropertyWithClient } from "../chokePoint/relationPropertyOps.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

/**
 * What the create hooks were given for each item inserted into `databaseId`: the initial relations and the
 * number of edges the item had at that point. The hook stays registered for the whole file and records
 * nothing for any other database.
 */
const watched: {
  databaseId: string | null;
  calls: Array<{ initialRelations: ItemCreateHookContext["initialRelations"]; edges: number | undefined }>;
} = { databaseId: null, calls: [] };
registerItemCreateHook(async ({ client, database, item, initialRelations }) => {
  if (database.id !== watched.databaseId) return;
  const { rows } = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM item_relations WHERE item_a = $1 OR item_b = $1",
    [item.id],
  );
  watched.calls.push({ initialRelations, edges: rows[0]?.n });
});

describe("item.create with relations", () => {
  let admin: Pool;
  let pool: Pool;
  let cp: ChokePoint;
  let tenant: string;
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:verify-runtime-role", () =>
      pool.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ role_name: "semprec_data", rolsuper: false, rolbypassrls: false }]);
    cp = createChokePoint(pool);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
    watched.databaseId = null;
    watched.calls = [];
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  async function fixture() {
    const source = await cp.createDatabase({ name: "Source" });
    const target = await cp.createDatabase({ name: "Target" });
    const { property } = await cp.createRelationProperty({
      sourceDatabaseId: source.id,
      targetDatabaseId: target.id,
      key: "target",
      name: "Target",
      cardinality: "one_to_one",
    });
    const first = await cp.createItem({ databaseId: target.id, properties: {} });
    const second = await cp.createItem({ databaseId: target.id, properties: {} });
    return { source, target, property, first, second };
  }
  it("creates item and edge atomically, then replays without a second edge", async () =>
    runInTenant(tenant, async () => {
      const { source, property, first, second } = await fixture();
      const input = {
        databaseId: source.id,
        properties: {},
        idempotencyKey: "same-request",
        relations: [
          { kind: "resolved", relationPropertyId: property.id, targetItemIds: [first.id] },
        ] satisfies InitialItemRelation[],
      };
      const item = await cp.createItemWithRelations(input);
      expect(await cp.listItemRelations(item.id, property.id)).toMatchObject([{ targetItemId: first.id }]);
      const replay = await cp.createItemWithRelations({
        ...input,
        relations: [{ kind: "resolved", relationPropertyId: property.id, targetItemIds: [second.id] }],
      });
      expect(replay).toEqual(item);
      expect(
        await cp.createItemWithRelations({
          ...input,
          relations: [
            {
              kind: "resolved",
              relationPropertyId: property.id,
              targetItemIds: ["00000000-0000-4000-8000-000000000001"],
            },
          ],
        }),
      ).toEqual(item);
      expect(await cp.listItemRelations(item.id, property.id)).toMatchObject([{ targetItemId: first.id }]);
    }));
  it("gives the create hooks the resolved relations before any of their edges is written", async () =>
    runInTenant(tenant, async () => {
      const { source, property, first } = await fixture();
      watched.databaseId = source.id;
      const resolved = {
        kind: "resolved",
        relationPropertyId: property.id,
        targetItemIds: [first.id],
      } satisfies InitialItemRelation;

      const item = await cp.createItemWithRelations({ databaseId: source.id, properties: {}, relations: [resolved] });
      expect(watched.calls).toEqual([{ initialRelations: [resolved], edges: 0 }]);
      expect(await cp.listItemRelations(item.id, property.id)).toMatchObject([{ targetItemId: first.id }]);

      // A relation whose key was not resolved is not among them; the create is refused after the hooks ran.
      watched.calls = [];
      await expect(
        cp.createItemWithRelations({
          databaseId: source.id,
          properties: {},
          relations: [{ kind: "unresolved" }, resolved],
        }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed" });
      expect(watched.calls).toEqual([{ initialRelations: [resolved], edges: 0 }]);
    }));

  it("gives the create hooks an empty list for no relations and nothing for a create without relations", async () =>
    runInTenant(tenant, async () => {
      const { source } = await fixture();
      watched.databaseId = source.id;
      await cp.createItemWithRelations({ databaseId: source.id, properties: {}, relations: [] });
      await cp.createItem({ databaseId: source.id, properties: {} });
      expect(watched.calls).toEqual([
        { initialRelations: [], edges: 0 },
        { initialRelations: undefined, edges: 0 },
      ]);
    }));

  it("commits, replays and rolls back the public supplied-client command", async () =>
    runInTenant(tenant, async () => {
      const { source, property, first, second } = await fixture();
      const input = {
        databaseId: source.id,
        properties: {},
        idempotencyKey: "supplied-client",
        relations: [
          { kind: "resolved", relationPropertyId: property.id, targetItemIds: [first.id] },
        ] satisfies InitialItemRelation[],
      };
      const created = await withTransaction(pool, (client) => createItemWithRelationsWithClient(client, input));
      expect(await cp.listItemRelations(created.id, property.id)).toMatchObject([{ targetItemId: first.id }]);
      const snapshot = async () => ({
        items: (
          await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [source.id])
        ).rows,
        edges: (
          await pool.query<{ id: string; item_a: string; item_b: string }>(
            "SELECT id, item_a, item_b FROM item_relations ORDER BY id",
          )
        ).rows,
      });
      const committed = await snapshot();
      const replay = await withTransaction(pool, (client) =>
        createItemWithRelationsWithClient(client, { ...input, relations: [{ kind: "unresolved" }] }),
      );
      expect(replay).toEqual(created);
      expect(await snapshot()).toEqual(committed);
      const rollback = new Error("supplied-client rollback");
      await expect(
        withTransaction(pool, async (client) => {
          const item = await createItemWithRelationsWithClient(client, {
            ...input,
            idempotencyKey: "supplied-client-rollback",
            relations: [{ kind: "resolved", relationPropertyId: property.id, targetItemIds: [second.id] }],
          });
          const edges = await client.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM item_relations WHERE item_a = $1 OR item_b = $1",
            [item.id],
          );
          expect(edges.rows).toEqual([{ n: 1 }]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await snapshot()).toEqual(committed);
    }));
  it("leaves no source item when a target is missing or the single-valued relation lacks exactly one target", async () =>
    runInTenant(tenant, async () => {
      const { source, property, first, second } = await fixture();
      const count = async () =>
        (
          await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM items WHERE database_id = $1", [
            source.id,
          ])
        ).rows[0]!.count;
      const before = await count();
      for (const targetItemIds of [[], [first.id, second.id], ["00000000-0000-4000-8000-000000000001"]]) {
        await expect(
          cp.createItemWithRelations({
            databaseId: source.id,
            properties: {},
            relations: [{ kind: "resolved", relationPropertyId: property.id, targetItemIds }],
          }),
        ).rejects.toMatchObject({ status: 400 });
        expect(await count()).toBe(before);
      }
    }));

  it("rejects a system-owned relation even with no targets and rolls back the item", async () =>
    runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "System relation source" });
      const target = await cp.createDatabase({ name: "System relation target" });
      const { property } = await withTransaction(pool, (client) =>
        createRelationPropertyWithClient(
          client,
          {
            sourceDatabaseId: source.id,
            targetDatabaseId: target.id,
            key: "protected",
            name: "Protected",
            owner: "system",
            ownerProcess: "testOwner",
          },
          { ownerProcess: "testOwner" },
        ),
      );
      for (const targetItemIds of [[], ["00000000-0000-4000-8000-000000000001"]]) {
        await expect(
          cp.createItemWithRelations({
            databaseId: source.id,
            properties: {},
            relations: [{ kind: "resolved", relationPropertyId: property.id, targetItemIds }],
          }),
        ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
        const { rows } = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM items WHERE database_id = $1",
          [source.id],
        );
        expect(rows[0]?.count).toBe(0);
      }
    }));

  it("rolls back a prior edge when a later target is deleted or already has a one-to-one edge", async () =>
    runInTenant(tenant, async () => {
      const { source, target, property, first, second } = await fixture();
      const { property: additional } = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        targetDatabaseId: target.id,
        key: "additional",
        name: "Additional",
        cardinality: "one_to_one",
      });
      const existing = await cp.createItem({ databaseId: source.id, properties: {} });
      await cp.setRelation({ relationPropertyId: additional.id, callerItemId: existing.id, targetItemId: second.id });
      const deleted = await cp.createItem({ databaseId: target.id, properties: {} });
      await cp.softDeleteItem(target.id, deleted.id);
      const counts = async () => {
        const items = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
          source.id,
        ]);
        const edges = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM item_relations");
        return { items: items.rows[0]?.n, edges: edges.rows[0]?.n };
      };
      const before = await counts();
      for (const [targetItemId, code, status] of [
        [deleted.id, "validation_failed", 400],
        [second.id, "cardinality_violation", 409],
      ] as const) {
        await expect(
          cp.createItemWithRelations({
            databaseId: source.id,
            properties: {},
            relations: [
              { kind: "resolved", relationPropertyId: property.id, targetItemIds: [first.id] },
              { kind: "resolved", relationPropertyId: additional.id, targetItemIds: [targetItemId] },
            ],
          }),
        ).rejects.toMatchObject({ code, status });
        expect(await counts()).toEqual(before);
      }
    }));

  it("rejects an archived target database without leaving an item or edge", async () =>
    runInTenant(tenant, async () => {
      const { source, target, property, first } = await fixture();
      await cp.archiveDatabase(target.id);
      await expect(
        cp.createItemWithRelations({
          databaseId: source.id,
          properties: {},
          relations: [{ kind: "resolved", relationPropertyId: property.id, targetItemIds: [first.id] }],
        }),
      ).rejects.toMatchObject({ status: 403, code: "database_archived" });
      expect(
        (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [source.id]))
          .rows[0]?.n,
      ).toBe(0);
      expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM item_relations")).rows[0]?.n).toBe(0);
    }));
});
