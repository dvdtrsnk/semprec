import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import {
  clearHooksForTests,
  registerRelationEdgeChangedHook,
  type RelationEdgeChangedHookContext,
} from "../chokePoint/hooks.js";
import {
  assertRelationCreatableWithClient,
  createRelationWithClient,
  deleteRelationWithClient,
} from "../chokePoint/relationOps.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let input: { relationPropertyId: string; callerItemId: string; targetItemId: string };
let inversePropertyId: string;
let calls: RelationEdgeChangedHookContext[];
let behavior: (context: RelationEdgeChangedHookContext) => Promise<void>;

describe("relation edge changed hooks", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(pool);
    registerRelationEdgeChangedHook(async (context) => {
      calls.push(context);
      await behavior(context);
    });
  });
  beforeEach(async () => {
    calls = [];
    behavior = async () => {};
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "Source" });
      const target = await cp.createDatabase({ name: "Target" });
      const { property, inverseProperty } = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        targetDatabaseId: target.id,
        key: "link",
        name: "Link",
        inverse: { key: "backlink", name: "Backlink" },
      });
      if (!inverseProperty) throw new Error("Inverse relation missing");
      inversePropertyId = inverseProperty.id;
      const a = await cp.createItem({ databaseId: source.id });
      const b = await cp.createItem({ databaseId: target.id });
      input = { relationPropertyId: property.id, callerItemId: a.id, targetItemId: b.id };
    });
  });
  afterAll(async () => {
    clearHooksForTests();
    await pool.end();
    await admin.end();
  });
  it("reports create, update and internal delete, but not dry-run or missing delete", async () =>
    runInTenant(tenant, async () => {
      await withTransaction(pool, (client) => assertRelationCreatableWithClient(client, input));
      expect(calls).toHaveLength(0);
      const writer = {
        writerKind: "agent" as const,
        agentRunId: "run",
        agentProjectItemId: "project",
        onBehalfOfUserId: "user",
      };
      const edge = await cp.createRelation({ ...input, metadata: { value: 1 } }, writer);
      await cp.createRelation({ ...input, metadata: { value: 3 } }, writer);
      await cp.updateRelation({ ...input, metadata: { value: 2 } }, writer);
      await withTransaction(pool, (client) => deleteRelationWithClient(client, input, undefined, writer));
      await withTransaction(pool, (client) => deleteRelationWithClient(client, input, undefined, writer));
      expect(
        calls.map(({ op, relationDefinitionId, propertyId, itemA, itemB, metadata, writer: actor }) => ({
          op,
          relationDefinitionId,
          propertyId,
          itemA,
          itemB,
          metadata,
          actor,
        })),
      ).toEqual([
        {
          op: "create",
          relationDefinitionId: edge.relationDefinitionId,
          propertyId: input.relationPropertyId,
          itemA: edge.itemA,
          itemB: edge.itemB,
          metadata: { value: 1 },
          actor: writer,
        },
        {
          op: "create",
          relationDefinitionId: edge.relationDefinitionId,
          propertyId: input.relationPropertyId,
          itemA: edge.itemA,
          itemB: edge.itemB,
          metadata: { value: 3 },
          actor: writer,
        },
        {
          op: "update",
          relationDefinitionId: edge.relationDefinitionId,
          propertyId: input.relationPropertyId,
          itemA: edge.itemA,
          itemB: edge.itemB,
          metadata: { value: 2 },
          actor: writer,
        },
        {
          op: "delete",
          relationDefinitionId: edge.relationDefinitionId,
          propertyId: input.relationPropertyId,
          itemA: edge.itemA,
          itemB: edge.itemB,
          metadata: { value: 2 },
          actor: writer,
        },
      ]);
    }));
  it("rolls back create, update and delete when a hook throws", async () =>
    runInTenant(tenant, async () => {
      behavior = async () => {
        throw new Error("hook failed");
      };
      await expect(cp.createRelation(input)).rejects.toThrow("hook failed");
      expect(
        (
          await pool.query("SELECT id FROM item_relations WHERE item_a=$1 AND item_b=$2", [
            input.callerItemId,
            input.targetItemId,
          ])
        ).rows,
      ).toEqual([]);
      behavior = async () => {};
      const edge = await cp.createRelation({ ...input, metadata: { value: 1 } });
      behavior = async () => {
        throw new Error("hook failed");
      };
      await expect(cp.updateRelation({ ...input, metadata: { value: 2 } })).rejects.toThrow("hook failed");
      await expect(cp.deleteRelation(input)).rejects.toThrow("hook failed");
      expect(
        (
          await pool.query<{ id: string; metadata: unknown }>("SELECT id, metadata FROM item_relations WHERE id=$1", [
            edge.id,
          ])
        ).rows,
      ).toEqual([{ id: edge.id, metadata: { value: 1 } }]);
    }));
  it("rejects a recursive write to the same edge", async () =>
    runInTenant(tenant, async () => {
      behavior = async ({ client }) => {
        await createRelationWithClient(client, input);
      };
      await expect(cp.createRelation(input)).rejects.toThrow("Recursive relation edge change");
    }));
  it("reports stored side ordering for a write through the inverse property", async () =>
    runInTenant(tenant, async () => {
      const edge = await cp.createRelation({
        relationPropertyId: inversePropertyId,
        callerItemId: input.targetItemId,
        targetItemId: input.callerItemId,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ propertyId: inversePropertyId, itemA: edge.itemA, itemB: edge.itemB });
      expect(edge).toMatchObject({ itemA: input.callerItemId, itemB: input.targetItemId });
    }));
});
