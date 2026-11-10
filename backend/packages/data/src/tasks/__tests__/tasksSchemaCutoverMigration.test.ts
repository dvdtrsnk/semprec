import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { generateSchemaProjection } from "../../manifest/schemaProjection.js";
import { withTransaction } from "../../db/pool.js";
import { createDriftCheckAction, findOrphanedOwnerProcessProperties } from "../../manifest/driftCheck.js";
import { createModuleRegistryDriftCheckAction } from "../../manifest/moduleRegistryDriftCheck.js";
import { KNOWN_HEARTBEAT_ACTION_IDS, KNOWN_OWNER_PROCESS_IDS } from "../../manifest/knownActionIds.js";
import { z } from "zod";
import { runTasksSchemaCutoverMigration } from "../tasksSchemaCutoverMigration.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
const keys = [
  "flagged",
  "description",
  "since",
  "sinceTime",
  "completedOn",
  "completedAt",
  "hiddenUntil",
  "effectiveDate",
  "seriesId",
  "occurrenceDate",
  "recurrence",
  "people",
  "files",
  "hostEvents",
  "completedInEvent",
];
interface Shape {
  module: string;
  key: string;
  type: string;
  owner: string;
  owner_process: string | null;
  config: unknown;
  cardinality: string | null;
  target: string | null;
}
async function shape(tenant: string): Promise<Shape[]> {
  return runInTenant(
    tenant,
    async () =>
      (
        await pool.query<Shape>(
          `SELECT d.owner_module_id AS module, p.key, p.type, p.owner, p.owner_process,
       CASE WHEN p.type = 'relation' THEN '{}'::jsonb ELSE p.config END AS config,
       r.cardinality, target.owner_module_id AS target
     FROM properties p JOIN databases d ON d.id = p.database_id
     LEFT JOIN relation_definitions r ON r.id::text = p.config->>'relationDefinitionId'
     LEFT JOIN databases target ON target.id::text = p.config->>'targetDatabaseId'
     WHERE (d.owner_module_id = 'tasks' AND (p.key = ANY($1::text[]) OR p.key IN ('time', 'status')))
        OR (d.owner_module_id = ANY($2::text[]) AND p.key = ANY($3::text[]))
     ORDER BY module, p.key`,
          [keys, ["people", "files", "events"], ["tasks", "hostedTasks", "completedTasks"]],
        )
      ).rows,
  );
}

describe("Tasks schema cutover", () => {
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
  it("brings a synthetic old tenant to the fresh shape without changing item values, and replays without changes", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    const fresh = await shape(tenant);
    expect(fresh).toHaveLength(21);
    for (const [key, type, owner, ownerProcess, config] of [
      ["flagged", "checkbox", "user", null, {}],
      ["description", "longText", "user", null, {}],
      ["since", "date", "system", "tasks", {}],
      ["sinceTime", "json", "system", "tasks", {}],
      ["completedOn", "date", "user", null, {}],
      ["completedAt", "date", "system", "tasks", { includeTime: true }],
      ["hiddenUntil", "date", "system", "tasks", { includeTime: true }],
      ["effectiveDate", "date", "system", "tasks", {}],
      ["seriesId", "text", "system", "tasks", {}],
      ["occurrenceDate", "date", "system", "tasks", {}],
      ["recurrence", "json", "system", "tasks", {}],
      ["time", "time", "system", "tasks", {}],
    ] as const) {
      expect(fresh.find((row) => row.module === "tasks" && row.key === key)).toMatchObject({
        type,
        owner,
        owner_process: ownerProcess,
        config,
      });
    }
    const status = z
      .object({ options: z.array(z.object({ key: z.string() })), default: z.string() })
      .parse(fresh.find((row) => row.module === "tasks" && row.key === "status")?.config);
    expect(status.default).toBe("notDone");
    expect(status.options.map((option) => option.key)).toEqual(["notDone", "done", "wontDo", "missed"]);
    for (const key of ["sinceTime", "recurrence"]) {
      expect(fresh.find((row) => row.module === "tasks" && row.key === key)?.config).toEqual({});
    }
    const item = await runInTenant(tenant, async () => {
      const db = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'tasks'");
      const id = db.rows[0]?.id;
      if (!id) throw new Error("Missing Tasks database");
      return createChokePoint(pool).createItem({ databaseId: id, properties: { name: "Existing", status: "notDone" } });
    });
    // Synthetic historical schema: production writers cannot remove built-in properties from a locked schema.
    await runInTenant(tenant, async () => {
      const removed = await pool.query(
        `DELETE FROM properties p USING databases d WHERE p.database_id = d.id AND
         ((d.owner_module_id = 'tasks' AND p.key = ANY($1::text[])) OR
          (d.owner_module_id = ANY($2::text[]) AND p.key = ANY($3::text[])))`,
        [keys, ["people", "files", "events"], ["tasks", "hostedTasks", "completedTasks"]],
      );
      expect(removed.rowCount).toBe(19);
      const time = await pool.query(
        "UPDATE properties SET owner_process = NULL WHERE database_id = $1 AND key = 'time'",
        [item.databaseId],
      );
      expect(time.rowCount).toBe(1);
      const status = await pool.query(
        `UPDATE properties SET config = jsonb_set(config, '{options}', (SELECT jsonb_agg(o) FROM jsonb_array_elements(config->'options') o WHERE o->>'key' <> 'missed')) WHERE database_id = $1 AND key = 'status'`,
        [item.databaseId],
      );
      expect(status.rowCount).toBe(1);
    });
    await runAsSystem("test:tasks-cutover", () => runTenantCutoverMigrations(pool));
    expect(await shape(tenant)).toEqual(fresh);
    const orphans = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => findOrphanedOwnerProcessProperties(client)),
    );
    expect(orphans.filter((row) => row.databaseId === item.databaseId)).toEqual([]);
    const eventId = await runInTenant(
      tenant,
      async () =>
        (await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'events'")).rows[0]?.id,
    );
    expect(orphans.filter((row) => row.databaseId === eventId).map((row) => row.key)).toContain("time");
    expect(orphans.filter((row) => row.databaseId === eventId).map((row) => row.key)).not.toContain("hostedTasks");
    expect(orphans.filter((row) => row.databaseId === eventId).map((row) => row.key)).not.toContain("completedTasks");
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const projects = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'projects'");
      if (!projects.rows[0]) throw new Error("Projects missing");
      const project = await cp.createItem({ databaseId: projects.rows[0].id, properties: { name: "Drift check" } });
      const context = { heartbeatId: "test", projectItemId: project.id };
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
      expect(payload.orphanedOwnerProcess.filter((row) => row.databaseId === item.databaseId)).toEqual([]);
      expect(payload.orphanedOwnerProcess).toContainEqual(
        expect.objectContaining({ databaseId: eventId, key: "time" }),
      );
      const registry = findings.rows.filter((row) => row.kind === "module_registry_orphaned_owner_process");
      expect(
        registry.map((row) => z.object({ ownerProcess: z.string() }).parse(row.payload).ownerProcess),
      ).not.toContain("tasks");
    });
    const after = await runInTenant(tenant, () => createChokePoint(pool).getItem(item.databaseId, item.id));
    expect(after?.properties).toEqual(item.properties);
    const once = await shape(tenant);
    const versions = () =>
      runInTenant(
        tenant,
        async () =>
          (
            await pool.query<{ id: string; xmin: string }>(
              "SELECT p.id, p.xmin::text AS xmin FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.owner_module_id = ANY($1::text[]) ORDER BY p.id",
              [["tasks", "events", "people", "files"]],
            )
          ).rows,
      );
    const beforeReplay = await versions();
    const relationVersions = () =>
      runInTenant(
        tenant,
        async () =>
          (
            await pool.query<{ id: string; xmin: string }>(
              `SELECT DISTINCT r.id, r.xmin::text AS xmin FROM relation_definitions r
               JOIN properties p ON p.id = r.property_id_a OR p.id = r.property_id_b
               JOIN databases d ON d.id = p.database_id
               WHERE d.owner_module_id = ANY($1::text[]) ORDER BY r.id`,
              [["tasks", "events", "people", "files"]],
            )
          ).rows,
      );
    const relationsBeforeReplay = await relationVersions();
    await runAsSystem("test:tasks-cutover-replay", () => runTenantCutoverMigrations(pool));
    expect(await shape(tenant)).toEqual(once);
    expect(await versions()).toEqual(beforeReplay);
    expect(await relationVersions()).toEqual(relationsBeforeReplay);
    expect(await runInTenant(tenant, () => createChokePoint(pool).getItem(item.databaseId, item.id))).toEqual(after);
  });
  it("resolves every new property in both catalogs on a fresh seed", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    const registry = await loadFullModuleRegistry();
    for (const locale of ["en", "cs"] as const) {
      const schema = await runInTenant(tenant, () =>
        withTransaction(pool, (client) => generateSchemaProjection(client, registry, { locale })),
      );
      for (const [module, propertyKeys] of [
        ["tasks", keys],
        ["people", ["tasks"]],
        ["files", ["tasks"]],
        ["events", ["hostedTasks", "completedTasks"]],
      ] as const) {
        const database = schema.databases.find((db) => db.key === module);
        for (const key of propertyKeys) {
          const property = database?.properties.find((candidate) => candidate.key === key);
          expect(property?.name).toBeTruthy();
          expect(property?.name).not.toBe(key);
        }
      }
    }
  });
  it("retains an existing compatible side while creating its missing inverse", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    const before = await runInTenant(tenant, async () => {
      const rows = await pool.query<{ id: string; key: string }>(
        "SELECT p.id, p.key FROM properties p JOIN databases d ON d.id = p.database_id WHERE (d.owner_module_id = 'tasks' AND p.key = 'people') OR (d.owner_module_id = 'people' AND p.key = 'tasks')",
      );
      const taskSide = rows.rows.find((row) => row.key === "people");
      const inverse = rows.rows.find((row) => row.key === "tasks");
      if (!taskSide || !inverse) throw new Error("Missing seeded relation");
      // Synthetic partial historical catalog; schema-locked properties cannot be removed through the public API.
      expect((await pool.query("DELETE FROM properties WHERE id = $1", [inverse.id])).rowCount).toBe(1);
      return taskSide.id;
    });
    await runAsSystem("test:partial-tasks-cutover", () => runTenantCutoverMigrations(pool));
    const after = await runInTenant(tenant, () =>
      pool.query<{ id: string; target: string; relation_id: string }>(
        `SELECT p.id, p.config->>'targetDatabaseId' AS target, p.config->>'relationDefinitionId' AS relation_id
       FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.owner_module_id = 'tasks' AND p.key = 'people'`,
      ),
    );
    expect(after.rows[0]?.id).toBe(before);
    expect(after.rows[0]?.target).toBeTruthy();
    expect(after.rows[0]?.relation_id).toBeTruthy();
  });
  it("offers missed exactly once after the cutover and a second run changes nothing (issue #1668)", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    const statusConfig = async (): Promise<unknown> =>
      runInTenant(tenant, async () => {
        const { rows } = await pool.query<{ config: unknown }>(
          `SELECT p.config FROM properties p JOIN databases d ON d.id = p.database_id
           WHERE d.owner_module_id = 'tasks' AND p.key = 'status'`,
        );
        return rows[0]?.config;
      });
    // Synthetic historical schema: a tenant seeded before `missed` existed; no production writer removes an option.
    await runInTenant(tenant, async () => {
      const reverted = await pool.query(
        `UPDATE properties p SET config = jsonb_set(p.config, '{options}', (SELECT jsonb_agg(o) FROM jsonb_array_elements(p.config->'options') o WHERE o->>'key' <> 'missed'))
         FROM databases d WHERE d.id = p.database_id AND d.owner_module_id = 'tasks' AND p.key = 'status'`,
      );
      expect(reverted.rowCount).toBe(1);
    });
    const keys = (config: unknown): string[] =>
      z
        .object({ options: z.array(z.object({ key: z.string() })) })
        .parse(config)
        .options.map((option) => option.key);
    expect(keys(await statusConfig())).toEqual(["notDone", "done", "wontDo"]);

    await runAsSystem("test:tasks-cutover", () => runTenantCutoverMigrations(pool));
    const once = await statusConfig();
    expect(keys(once)).toEqual(["notDone", "done", "wontDo", "missed"]);
    await runAsSystem("test:tasks-cutover", () => runTenantCutoverMigrations(pool));
    expect(await statusConfig()).toEqual(once);
  });

  it.each(["tasks", "events", "people", "files"])("does nothing when %s is missing", async (moduleId) => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    await runInTenant(tenant, async () => {
      // A synthetic incomplete seed models an absent module without deleting tenant data.
      expect(
        (await pool.query("UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = $1", [moduleId]))
          .rowCount,
      ).toBe(1);
      const before = await pool.query<{ id: string; version: string }>(
        "SELECT id, xmin::text AS version FROM properties ORDER BY id",
      );
      await runTasksSchemaCutoverMigration(pool);
      expect(
        (
          await pool.query<{ id: string; version: string }>(
            "SELECT id, xmin::text AS version FROM properties ORDER BY id",
          )
        ).rows,
      ).toEqual(before.rows);
    });
  });
  it("only repairs the tenant in scope with the runtime role", async () => {
    const a = await createTestTenant(admin);
    const b = await createTestTenant(admin);
    for (const tenant of [a, b]) {
      await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
      await runInTenant(tenant, async () => {
        // Synthetic old schema, scoped to the tenant; locked built-ins have no public removal path.
        const removed = await pool.query(
          "DELETE FROM properties p USING databases d WHERE p.database_id = d.id AND d.owner_module_id = 'tasks' AND p.key = 'flagged'",
        );
        expect(removed.rowCount).toBe(1);
      });
    }
    await runInTenant(a, () => runTasksSchemaCutoverMigration(pool));
    for (const [tenant, expected] of [
      [a, 1],
      [b, 0],
    ] as const) {
      const result = await runInTenant(tenant, () =>
        pool.query(
          "SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.owner_module_id = 'tasks' AND p.key = 'flagged'",
        ),
      );
      expect(result.rowCount).toBe(expected);
    }
    await runInTenant(b, () => runTasksSchemaCutoverMigration(pool));
    expect(
      (
        await runInTenant(b, () =>
          pool.query(
            "SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.owner_module_id = 'tasks' AND p.key = 'flagged'",
          ),
        )
      ).rowCount,
    ).toBe(1);
  });
});
