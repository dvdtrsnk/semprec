import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { runTasksSourceEventsCutoverMigration } from "../tasksSourceEventsCutoverMigration.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createDriftCheckAction } from "../../manifest/driftCheck.js";
import { createModuleRegistryDriftCheckAction } from "../../manifest/moduleRegistryDriftCheck.js";
import { KNOWN_HEARTBEAT_ACTION_IDS, KNOWN_OWNER_PROCESS_IDS } from "../../manifest/knownActionIds.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
async function shape(tenant: string) {
  return runInTenant(
    tenant,
    async () =>
      (
        await pool.query<{ type: string; owner: string; name: string | null; cardinality: string; target: string }>(
          `SELECT p.type, p.owner, p.name, r.cardinality, d.owner_module_id AS target
     FROM properties p JOIN databases t ON t.id = p.database_id
     JOIN relation_definitions r ON r.property_id_b = p.id AND p.config->>'relationDefinitionId' = r.id::text
     JOIN databases d ON d.id::text = p.config->>'targetDatabaseId'
     WHERE t.owner_module_id = 'tasks' AND p.key = 'sourceEvents'`,
        )
      ).rows,
  );
}
describe("Tasks source events cutover", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => resetDatabase(admin));
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  it("does nothing for an unseeded tenant", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => runTasksSourceEventsCutoverMigration(pool));
    expect((await runInTenant(tenant, () => pool.query("SELECT id FROM properties"))).rowCount).toBe(0);
  });
  it("does nothing when the historical actionItems property is absent", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
    await runInTenant(tenant, async () => {
      // Synthetic incomplete old schema: locked built-ins cannot be removed through the public API.
      const inverse = await pool.query<{ id: string }>(
        "SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.owner_module_id = 'tasks' AND p.key = 'sourceEvents'",
      );
      if (!inverse.rows[0]) throw new Error("Missing inverse");
      expect(
        (
          await pool.query("UPDATE relation_definitions SET property_id_b = NULL WHERE property_id_b = $1", [
            inverse.rows[0].id,
          ])
        ).rowCount,
      ).toBe(1);
      expect((await pool.query("DELETE FROM properties WHERE id = $1", [inverse.rows[0].id])).rowCount).toBe(1);
      const removed = await pool.query(
        "DELETE FROM properties p USING databases d WHERE p.database_id = d.id AND d.owner_module_id = 'events' AND p.key = 'actionItems'",
      );
      expect(removed.rowCount).toBe(1);
      await runTasksSourceEventsCutoverMigration(pool);
      expect((await pool.query("SELECT id FROM properties WHERE id = $1", [inverse.rows[0].id])).rowCount).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.owner_module_id = 'tasks' AND p.key = 'sourceEvents'",
          )
        ).rowCount,
      ).toBe(0);
    });
  });
  it("fails closed when an existing actionItems property has lost its definition", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
    await runInTenant(tenant, async () => {
      const rows = await pool.query<{ id: string; inverse_id: string }>(
        `SELECT r.id, r.property_id_b AS inverse_id FROM relation_definitions r
         JOIN properties p ON p.id = r.property_id_a JOIN databases d ON d.id = p.database_id
         WHERE d.owner_module_id = 'events' AND p.key = 'actionItems'`,
      );
      if (!rows.rows[0]) throw new Error("Missing relation");
      // Synthetic damaged catalog: no production writer creates this broken historical state.
      expect((await pool.query("DELETE FROM relation_definitions WHERE id = $1", [rows.rows[0].id])).rowCount).toBe(1);
      expect((await pool.query("DELETE FROM properties WHERE id = $1", [rows.rows[0].inverse_id])).rowCount).toBe(1);
      await expect(runTasksSourceEventsCutoverMigration(pool)).rejects.toThrow(
        "Incompatible actionItems relation definition",
      );
      expect(
        (
          await pool.query(
            "SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.owner_module_id = 'tasks' AND p.key = 'sourceEvents'",
          )
        ).rowCount,
      ).toBe(0);
    });
  });
  it("preserves old action-item edges and makes them queryable from Tasks after replay", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
    const freshShape = await shape(tenant);
    expect(freshShape).toEqual([
      { type: "relation", owner: "user", name: null, cardinality: "many_to_many", target: "events" },
    ]);
    const fixture = await runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const rows = await pool.query<{ id: string; owner_module_id: string }>(
        "SELECT id, owner_module_id FROM databases WHERE owner_module_id = ANY($1::text[])",
        [["tasks", "events"]],
      );
      const tasks = rows.rows.find((r) => r.owner_module_id === "tasks")?.id;
      const events = rows.rows.find((r) => r.owner_module_id === "events")?.id;
      if (!tasks || !events) throw new Error("Missing Tasks or Events");
      const action = (await cp.listProperties(events)).find((p) => p.key === "actionItems");
      const inverse = (await cp.listProperties(tasks)).find((p) => p.key === "sourceEvents");
      if (!action || !inverse) throw new Error("Missing seeded relation");
      const event = await cp.createItem({ databaseId: events, properties: { name: "Meeting", date: "2026-10-16" } });
      const task = await cp.createItem({ databaseId: tasks, properties: { name: "Action" } });
      await cp.createRelation({ relationPropertyId: action.id, callerItemId: event.id, targetItemId: task.id });
      // Synthetic pre-change schema: the locked production catalog cannot remove this inverse through its public API.
      const unlinked = await pool.query(
        "UPDATE relation_definitions SET property_id_b = NULL WHERE property_id_b = $1",
        [inverse.id],
      );
      expect(unlinked.rowCount).toBe(1);
      const removed = await pool.query("DELETE FROM properties WHERE id = $1 AND database_id = $2", [
        inverse.id,
        tasks,
      ]);
      expect(removed.rowCount).toBe(1);
      return { tasks, events, action: action.id, event: event.id, task: task.id };
    });
    await runAsSystem("test:source-events", () => runTenantCutoverMigrations(pool));
    expect(await shape(tenant)).toEqual(freshShape);
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const projects = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'projects'");
      if (!projects.rows[0]) throw new Error("Projects missing");
      const project = await cp.createItem({ databaseId: projects.rows[0].id, properties: { name: "Drift check" } });
      const context = { heartbeatId: "test", projectItemId: project.id };
      const relationOwners = await pool.query<{ key: string; owner: string; owner_process: string | null }>(
        "SELECT key, owner, owner_process FROM properties WHERE (database_id = $1 AND key = 'actionItems') OR (database_id = $2 AND key = 'sourceEvents') ORDER BY key",
        [fixture.events, fixture.tasks],
      );
      expect(relationOwners.rows).toEqual([
        { key: "actionItems", owner: "user", owner_process: null },
        { key: "sourceEvents", owner: "user", owner_process: null },
      ]);
      await createDriftCheckAction(pool, { activeProcessIds: KNOWN_OWNER_PROCESS_IDS })({}, context);
      await createModuleRegistryDriftCheckAction(pool, {
        activeProcessIds: KNOWN_OWNER_PROCESS_IDS,
        activeHeartbeatActionIds: KNOWN_HEARTBEAT_ACTION_IDS,
      })({}, context);
      const findings = await pool.query<{ kind: string; payload: unknown }>(
        "SELECT kind, payload FROM manifest_drift_findings",
      );
      const core = findings.rows.filter((row) => row.kind === "agent_manifest_drift");
      expect(core).toHaveLength(1);
      const payload = z
        .object({ orphanedOwnerProcess: z.array(z.object({ databaseId: z.string(), key: z.string() })) })
        .parse(core[0]?.payload);
      expect(payload.orphanedOwnerProcess).toContainEqual(
        expect.objectContaining({ databaseId: fixture.events, key: "time" }),
      );
      expect(payload.orphanedOwnerProcess).not.toContainEqual(
        expect.objectContaining({ databaseId: fixture.events, key: "actionItems" }),
      );
      expect(payload.orphanedOwnerProcess).not.toContainEqual(
        expect.objectContaining({ databaseId: fixture.tasks, key: "sourceEvents" }),
      );
      const registry = findings.rows.filter((row) => row.kind === "module_registry_orphaned_owner_process");
      expect(
        registry.map((row) => z.object({ ownerProcess: z.string() }).parse(row.payload).ownerProcess),
      ).not.toContain("tasks");
    });
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const inverse = (await cp.listProperties(fixture.tasks)).find((p) => p.key === "sourceEvents");
      if (!inverse) throw new Error("Missing cutover inverse");
      const result = await cp.queryDatabaseItems(fixture.tasks, {
        filter: { type: "relation_contains", property: "sourceEvents", value: fixture.event },
      });
      expect(result.items.map((item) => item.id)).toContain(fixture.task);
      const next = await cp.createItem({ databaseId: fixture.tasks, properties: { name: "Another" } });
      await cp.createRelation({ relationPropertyId: inverse.id, callerItemId: next.id, targetItemId: fixture.event });
      const query = await cp.queryDatabaseItems(fixture.tasks, {
        filter: { type: "relation_contains", property: "sourceEvents", value: fixture.event },
      });
      expect(query.items.map((item) => item.id)).toEqual(expect.arrayContaining([fixture.task, next.id]));
      for (const taskId of [fixture.task, next.id]) {
        const reverse = await cp.queryDatabaseItems(fixture.events, {
          filter: { type: "relation_contains", property: "actionItems", value: taskId },
        });
        expect(reverse.items.map((item) => item.id)).toContain(fixture.event);
      }
    });
    const before = await runInTenant(tenant, () =>
      pool.query("SELECT id, xmin::text FROM properties WHERE database_id = $1 AND key = 'sourceEvents'", [
        fixture.tasks,
      ]),
    );
    await runAsSystem("test:source-events-replay", () => runTenantCutoverMigrations(pool));
    const after = await runInTenant(tenant, () =>
      pool.query("SELECT id, xmin::text FROM properties WHERE database_id = $1 AND key = 'sourceEvents'", [
        fixture.tasks,
      ]),
    );
    expect(after.rows).toEqual(before.rows);
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const tasks = await cp.queryDatabaseItems(fixture.tasks, {
        filter: { type: "relation_contains", property: "sourceEvents", value: fixture.event },
      });
      const events = await cp.queryDatabaseItems(fixture.events, {
        filter: { type: "relation_contains", property: "actionItems", value: fixture.task },
      });
      expect(tasks.items.map((item) => item.id)).toContain(fixture.task);
      expect(events.items.map((item) => item.id)).toContain(fixture.event);
    });
  });
});
