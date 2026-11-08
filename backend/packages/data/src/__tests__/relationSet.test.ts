import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { runOnce } from "@semprec/queue";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { setRelationWithClient } from "../chokePoint/relationOps.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { rollupRecomputeJobKey } from "../rollup/recompute.js";
import { createRelationPropertyWithClient } from "../chokePoint/relationPropertyOps.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

describe("relation.set", () => {
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
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  async function fixture() {
    const databases = await cp.listDatabases();
    const projects = databases.find((db) => db.ownerModuleId === "projects");
    const areas = databases.find((db) => db.ownerModuleId === "areas");
    if (!projects || !areas) throw new Error("Missing seeded databases");
    const property = (await cp.listProperties(projects.id)).find((entry) => entry.key === "area");
    if (!property) throw new Error("Missing project area property");
    const project = await cp.createItem({ databaseId: projects.id, properties: { name: "Project" } });
    const first = await cp.createItem({ databaseId: areas.id, properties: { name: "First" } });
    const second = await cp.createItem({ databaseId: areas.id, properties: { name: "Second" } });
    return { property, project, first, second };
  }

  it("replaces, preserves an unchanged edge and clears idempotently", async () =>
    runInTenant(tenant, async () => {
      const { property, project, first, second } = await fixture();
      const input = { relationPropertyId: property.id, callerItemId: project.id };
      const original = await cp.setRelation({ ...input, targetItemId: first.id });
      const version = await pool.query<{ xmin: string }>(
        "SELECT xmin::text AS xmin FROM item_relations WHERE id = $1",
        [original?.id],
      );
      expect(await cp.setRelation({ ...input, targetItemId: first.id })).toEqual(original);
      const afterRepeat = await pool.query<{ xmin: string }>(
        "SELECT xmin::text AS xmin FROM item_relations WHERE id = $1",
        [original?.id],
      );
      expect(version.rows).toHaveLength(1);
      expect(afterRepeat.rows).toEqual(version.rows);
      expect(
        await cp.setRelation({
          relationPropertyId: property.id.toUpperCase(),
          callerItemId: project.id.toUpperCase(),
          targetItemId: first.id.toUpperCase(),
        }),
      ).toEqual(original);
      const moved = await cp.setRelation({ ...input, targetItemId: second.id });
      expect(moved?.id).not.toBe(original?.id);
      const edges = await cp.listItemRelations(project.id, property.id);
      expect(edges).toHaveLength(1);
      expect(edges?.[0]?.targetItemId).toBe(second.id);
      expect(await cp.setRelation({ ...input, targetItemId: null })).toBeNull();
      expect(await cp.setRelation({ ...input, targetItemId: null })).toBeNull();
      expect(await cp.listItemRelations(project.id, property.id)).toEqual([]);
    }));

  it("preserves an existing edge when the target database is archived", async () =>
    runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "Source" });
      const target = await cp.createDatabase({ name: "Target" });
      const { property } = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        targetDatabaseId: target.id,
        key: "target",
        name: "Target",
        cardinality: "one_to_one",
      });
      const caller = await cp.createItem({ databaseId: source.id, properties: {} });
      const first = await cp.createItem({ databaseId: target.id, properties: {} });
      const second = await cp.createItem({ databaseId: target.id, properties: {} });
      const input = { relationPropertyId: property.id, callerItemId: caller.id };
      const original = await cp.setRelation({ ...input, targetItemId: first.id });
      await cp.archiveDatabase(first.databaseId);
      await expect(cp.setRelation({ ...input, targetItemId: second.id })).rejects.toMatchObject({
        status: 403,
        code: "database_archived",
      });
      await cp.restoreDatabase(first.databaseId);
      expect(await cp.listItemRelations(caller.id, property.id)).toMatchObject([{ targetItemId: first.id }]);
      const stored = await pool.query<{ id: string }>("SELECT id FROM item_relations WHERE id = $1", [original?.id]);
      expect(stored.rows).toEqual([{ id: original?.id }]);
    }));

  it("refuses a system-owned single-valued property", async () =>
    runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "Protected source" });
      const target = await cp.createDatabase({ name: "Protected target" });
      const { property } = await withTransaction(pool, (client) =>
        createRelationPropertyWithClient(
          client,
          {
            sourceDatabaseId: source.id,
            targetDatabaseId: target.id,
            key: "protected",
            name: "Protected",
            cardinality: "one_to_one",
            owner: "system",
            ownerProcess: "testOwner",
          },
          { ownerProcess: "testOwner" },
        ),
      );
      const caller = await cp.createItem({ databaseId: source.id, properties: {} });
      const other = await cp.createItem({ databaseId: target.id, properties: {} });
      await expect(
        cp.setRelation({ relationPropertyId: property.id, callerItemId: caller.id, targetItemId: other.id }),
      ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
      expect(await cp.listItemRelations(caller.id, property.id)).toEqual([]);
    }));

  it("rejects setting the many-valued side of a one-to-many relation", async () =>
    runInTenant(tenant, async () => {
      const parents = await cp.createDatabase({ name: "Parents" });
      const children = await cp.createDatabase({ name: "Children" });
      const { property } = await cp.createRelationProperty({
        sourceDatabaseId: parents.id,
        targetDatabaseId: children.id,
        key: "children",
        name: "Children",
        cardinality: "one_to_many",
        inverse: { key: "parent", name: "Parent" },
      });
      const parent = await cp.createItem({ databaseId: parents.id, properties: {} });
      const child = await cp.createItem({ databaseId: children.id, properties: {} });
      await expect(
        cp.setRelation({ relationPropertyId: property.id, callerItemId: parent.id, targetItemId: child.id }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "relationPropertyId" } });
      expect(await cp.listItemRelations(parent.id, property.id)).toEqual([]);
    }));

  it("preserves the old edge when the new endpoint is invalid", async () =>
    runInTenant(tenant, async () => {
      const { property, project, first } = await fixture();
      const input = { relationPropertyId: property.id, callerItemId: project.id };
      const original = await cp.setRelation({ ...input, targetItemId: first.id });
      await expect(
        cp.setRelation({ ...input, targetItemId: "00000000-0000-4000-8000-000000000001" }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await cp.setRelation({ ...input, targetItemId: first.id })).toEqual(original);
    }));

  it("queues recomputes for both old and new rollup owners when moving an edge", async () => {
    const fixture = await runInTenant(tenant, async () => {
      const parents = await cp.createDatabase({ name: "Rollup parents" });
      const children = await cp.createDatabase({ name: "Rollup children" });
      await cp.createRelationProperty({
        sourceDatabaseId: parents.id,
        targetDatabaseId: children.id,
        key: "children",
        name: "Children",
        cardinality: "one_to_many",
        inverse: { key: "parent", name: "Parent" },
      });
      const parentProperty = (await cp.listProperties(children.id)).find((entry) => entry.key === "parent");
      if (!parentProperty) throw new Error("Missing parent property");
      const count = await cp.createProperty({
        databaseId: parents.id,
        key: "childCount",
        name: "Child count",
        type: "rollup",
        config: { relationPropertyKey: "children", aggregation: "count" },
      });
      const first = await cp.createItem({ databaseId: parents.id, properties: {} });
      const second = await cp.createItem({ databaseId: parents.id, properties: {} });
      const child = await cp.createItem({ databaseId: children.id, properties: {} });
      await cp.setRelation({ relationPropertyId: parentProperty.id, callerItemId: child.id, targetItemId: first.id });
      return { parents, parentProperty, count, first, second, child };
    });
    const taskList = createCoreTaskList(pool, createActionRegistry());
    let remaining = 1;
    for (let pass = 0; pass < 10 && remaining > 0; pass += 1) {
      await runOnce({ pgPool: admin, taskList });
      const jobs = await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM graphile_worker.jobs");
      remaining = jobs.rows[0]?.count ?? -1;
    }
    expect(remaining).toBe(0);
    await runInTenant(tenant, async () => {
      expect((await cp.getItem(fixture.parents.id, fixture.first.id))?.computed.childCount).toBe(1);
      await cp.setRelation({
        relationPropertyId: fixture.parentProperty.id,
        callerItemId: fixture.child.id,
        targetItemId: fixture.second.id,
      });
    });
    const keys = [
      rollupRecomputeJobKey(fixture.count.id, fixture.first.id),
      rollupRecomputeJobKey(fixture.count.id, fixture.second.id),
    ];
    const queued = await admin.query<{ key: string }>(
      "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[])",
      [keys],
    );
    expect(queued.rows.map((row) => row.key).sort()).toEqual(keys.sort());
  });

  it("rolls back the deletion when a one-to-one target belongs to another item", async () =>
    runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "Rollback source" });
      const target = await cp.createDatabase({ name: "Rollback target" });
      const { property } = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        targetDatabaseId: target.id,
        key: "target",
        name: "Target",
        cardinality: "one_to_one",
      });
      const a = await cp.createItem({ databaseId: source.id, properties: {} });
      const b = await cp.createItem({ databaseId: source.id, properties: {} });
      const first = await cp.createItem({ databaseId: target.id, properties: {} });
      const second = await cp.createItem({ databaseId: target.id, properties: {} });
      const firstEdge = await cp.setRelation({
        relationPropertyId: property.id,
        callerItemId: a.id,
        targetItemId: first.id,
      });
      const secondEdge = await cp.setRelation({
        relationPropertyId: property.id,
        callerItemId: b.id,
        targetItemId: second.id,
      });
      await expect(
        cp.setRelation({ relationPropertyId: property.id, callerItemId: a.id, targetItemId: second.id }),
      ).rejects.toMatchObject({ status: 409, code: "cardinality_violation" });
      expect(
        await cp.setRelation({ relationPropertyId: property.id, callerItemId: a.id, targetItemId: first.id }),
      ).toEqual(firstEdge);
      expect(
        await cp.setRelation({ relationPropertyId: property.id, callerItemId: b.id, targetItemId: second.id }),
      ).toEqual(secondEdge);
    }));

  it("serializes concurrent sets through the caller row", async () =>
    runInTenant(tenant, async () => {
      const { property, project, first, second } = await fixture();
      const input = { relationPropertyId: property.id, callerItemId: project.id };
      let release!: () => void;
      let locked!: (pid: number) => void;
      let waiting!: (pid: number) => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const acquired = new Promise<number>((resolve) => {
        locked = resolve;
      });
      const secondStarted = new Promise<number>((resolve) => {
        waiting = resolve;
      });
      const firstWrite = withTransaction(pool, async (client) => {
        await setRelationWithClient(client, { ...input, targetItemId: first.id });
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        locked(rows[0]!.pid);
        await held;
      });
      const firstPid = await acquired;
      const secondWrite = withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        waiting(rows[0]!.pid);
        return setRelationWithClient(client, { ...input, targetItemId: second.id });
      });
      const secondPid = await secondStarted;
      try {
        await vi.waitFor(async () => {
          const { rows } = await admin.query<{ blocked: boolean }>(
            "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
            [firstPid, secondPid],
          );
          expect(rows[0]?.blocked).toBe(true);
        });
        release();
        await Promise.all([firstWrite, secondWrite]);
      } finally {
        release();
        await Promise.allSettled([firstWrite, secondWrite]);
      }
      const edges = await cp.listItemRelations(project.id, property.id);
      expect(edges).toHaveLength(1);
      expect(edges?.[0]?.targetItemId).toBe(second.id);
    }));
});
