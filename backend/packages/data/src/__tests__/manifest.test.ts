import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { generatePermissionManifest } from "../manifest/permissionManifest.js";
import { createDriftCheckAction, findOrphanedOwnerProcessProperties } from "../manifest/driftCheck.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { upsertMcpToolRegistration } from "../mcp/mcpToolRegistrationsStore.js";
import { setProjectMcpGrant } from "../mcp/mcpGrantsAdminStore.js";

const SYSTEM_DATABASES_MANIFEST_PATH = new URL("../seed/systemDatabasesModuleManifest.js", import.meta.url).href;

async function systemDatabasesRegistry(): Promise<ModuleRegistry> {
  const registry = new ModuleRegistry(() => new Set(["systemDatabases"]));
  await registry.loadModule(SYSTEM_DATABASES_MANIFEST_PATH);
  return registry;
}

let pool: Pool;
let chokePoint: ChokePoint;

describe("permission manifest and drift check", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("generates a manifest scoped to one project's owned databases", async () => {
    const project = await chokePoint.createDatabase({ name: "Projects" });
    const projectItem = await chokePoint.createItem({ databaseId: project.id, properties: {} });

    const owned = await chokePoint.createDatabase({ name: "Owned", ownerProjectItemId: projectItem.id });
    await chokePoint.createProperty({ databaseId: owned.id, key: "note", name: "Note", type: "text" });
    await chokePoint.createProperty({
      databaseId: owned.id,
      key: "rating",
      name: "Rating",
      type: "number",
      owner: "system",
      ownerProcess: "critics.rate",
    });

    await chokePoint.createDatabase({ name: "NotOwned" }); // should not appear

    const manifest = await withTransaction(pool, (client) => generatePermissionManifest(client, projectItem.id));
    expect(manifest.databases).toHaveLength(1);
    expect(manifest.databases[0]!.databaseId).toBe(owned.id);
    expect(manifest.databases[0]!.writable).toBe(true);
    expect(manifest.databases[0]!.properties.map((p) => p.key).sort()).toEqual(["note", "rating"]);
  });

  it("scopes Semprec's own grant to Processing proposals only, per issue #105's grant separation", async () => {
    const viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry();
    await seedSystem(pool, viewTypeRegistry);

    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM items WHERE properties ->> 'name' = 'Semprec'`);
    const semprecProjectItemId = rows[0]!.id;

    const manifest = await withTransaction(pool, (client) => generatePermissionManifest(client, semprecProjectItemId));

    const byName = new Map(manifest.databases.map((db) => [db.name, db]));
    expect(byName.get("Processing proposals")?.writable).toBe(true);
    expect(byName.get("Inbox")?.writable).toBe(false);
    expect(byName.get("Inbox item types")?.writable).toBe(false);
    // No target database (Tasks, Journal, ...) is ever part of this project's grant at all —
    // they carry no owner_project_item_id, so they never appear here regardless of `writable`.
    expect(manifest.databases.map((db) => db.name).sort()).not.toContain("Tasks");
    expect(manifest.databases.map((db) => db.name).sort()).not.toContain("Journal");
  });

  it("includes a project's granted MCP tools as the manifest's fourth source", async () => {
    const viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry();
    await seedSystem(pool, viewTypeRegistry);

    const mcpServersId = (
      await pool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = 'mcpServers'`)
    ).rows[0]!.id;
    const server = await withTransaction(pool, (client) =>
      itemsStore.insertItem(client, { databaseId: mcpServersId, properties: { name: "Server", active: true } }),
    );
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "search_web",
      toolSchema: { type: "object" },
      description: "Search the web",
    });

    const project = await chokePoint.createDatabase({ name: "Projects" });
    const projectItem = await chokePoint.createItem({ databaseId: project.id, properties: {} });
    await setProjectMcpGrant(pool, {
      projectItemId: projectItem.id,
      mcpToolRegistrationId: registration.id,
      granted: true,
    });

    const manifest = await withTransaction(pool, (client) => generatePermissionManifest(client, projectItem.id));
    expect(manifest.agentTools).toEqual([
      {
        source: "mcp",
        mcpServerItemId: server.id,
        mcpToolRegistrationId: registration.id,
        name: "search_web",
        description: "Search the web",
        schema: { type: "object" },
        requiresApproval: true,
        riskClass: "unclassified",
      },
    ]);
  });

  it("finds owner:'system' properties with no owner_process as orphaned", async () => {
    const db = await chokePoint.createDatabase({ name: "D" });
    await chokePoint.createProperty({ databaseId: db.id, key: "userField", name: "User field", type: "text" });
    await chokePoint.createProperty({
      databaseId: db.id,
      key: "orphan",
      name: "Orphan",
      type: "text",
      owner: "system",
    });
    await chokePoint.createProperty({
      databaseId: db.id,
      key: "owned",
      name: "Owned",
      type: "text",
      owner: "system",
      ownerProcess: "library.processLibraryMetadata",
    });

    const orphaned = await withTransaction(pool, (client) => findOrphanedOwnerProcessProperties(client));
    expect(orphaned.map((o) => o.key)).toEqual(["orphan"]);

    const orphanedWithActiveList = await withTransaction(pool, (client) =>
      findOrphanedOwnerProcessProperties(client, new Set(["some.otherModule"])),
    );
    expect(orphanedWithActiveList.map((o) => o.key).sort()).toEqual(["orphan", "owned"]);
  });

  it("resolves a system database's name, property name and select options via the cs/en catalog (issue #147)", async () => {
    const project = await chokePoint.createDatabase({ name: "Projects" });
    const projectItem = await chokePoint.createItem({ databaseId: project.id, properties: {} });

    const tasksDb = await chokePoint.createDatabase({
      name: null,
      key: "tasks",
      system: true,
      ownerProjectItemId: projectItem.id,
    });
    await chokePoint.createProperty({
      databaseId: tasksDb.id,
      key: "status",
      name: null,
      type: "select",
      config: { options: [{ key: "notDone" }, { key: "done" }, { key: "wontDo" }] },
    });

    const moduleRegistry = await systemDatabasesRegistry();

    const csManifest = await withTransaction(pool, (client) =>
      generatePermissionManifest(client, projectItem.id, { moduleRegistry, locale: "cs" }),
    );
    const csDb = csManifest.databases.find((db) => db.databaseId === tasksDb.id)!;
    expect(csDb.name).toBe("Úkoly");
    const csStatus = csDb.properties.find((p) => p.key === "status")!;
    expect(csStatus.name).toBe("Stav");
    expect(csStatus.options).toEqual([
      { key: "notDone", label: "Nesplněno" },
      { key: "done", label: "Splněno" },
      { key: "wontDo", label: "Nebude splněno" },
    ]);

    const enManifest = await withTransaction(pool, (client) =>
      generatePermissionManifest(client, projectItem.id, { moduleRegistry, locale: "en" }),
    );
    const enDb = enManifest.databases.find((db) => db.databaseId === tasksDb.id)!;
    expect(enDb.name).toBe("Tasks");
    const enStatus = enDb.properties.find((p) => p.key === "status")!;
    expect(enStatus.name).toBe("Status");
    expect(enStatus.options).toEqual([
      { key: "notDone", label: "Not done" },
      { key: "done", label: "Done" },
      { key: "wontDo", label: "Won't do" },
    ]);
  });

  it("resolves multi_select options identically to select (issue #147, same option-resolution branch)", async () => {
    const project = await chokePoint.createDatabase({ name: "Projects" });
    const projectItem = await chokePoint.createItem({ databaseId: project.id, properties: {} });

    const tasksDb = await chokePoint.createDatabase({
      name: null,
      key: "tasks",
      system: true,
      ownerProjectItemId: projectItem.id,
    });
    await chokePoint.createProperty({
      databaseId: tasksDb.id,
      key: "status",
      name: null,
      type: "multi_select",
      config: { options: [{ key: "notDone" }, { key: "done" }, { key: "wontDo" }] },
    });

    const moduleRegistry = await systemDatabasesRegistry();

    const csManifest = await withTransaction(pool, (client) =>
      generatePermissionManifest(client, projectItem.id, { moduleRegistry, locale: "cs" }),
    );
    const csStatus = csManifest.databases
      .find((db) => db.databaseId === tasksDb.id)!
      .properties.find((p) => p.key === "status")!;
    expect(csStatus.options).toEqual([
      { key: "notDone", label: "Nesplněno" },
      { key: "done", label: "Splněno" },
      { key: "wontDo", label: "Nebude splněno" },
    ]);
  });

  it("falls back to the raw key when no moduleRegistry is given, and lets a stored override win over the catalog", async () => {
    const project = await chokePoint.createDatabase({ name: "Projects" });
    const projectItem = await chokePoint.createItem({ databaseId: project.id, properties: {} });

    const tasksDb = await chokePoint.createDatabase({
      name: null,
      key: "tasks",
      system: true,
      ownerProjectItemId: projectItem.id,
    });
    await chokePoint.createProperty({
      databaseId: tasksDb.id,
      key: "status",
      name: null,
      type: "select",
      config: { options: [{ key: "notDone" }] },
    });

    // No moduleRegistry: pre-#147 raw-key placeholder behavior, unchanged.
    const noRegistryManifest = await withTransaction(pool, (client) =>
      generatePermissionManifest(client, projectItem.id),
    );
    const noRegistryDb = noRegistryManifest.databases.find((db) => db.databaseId === tasksDb.id)!;
    expect(noRegistryDb.name).toBe("tasks");
    const noRegistryStatus = noRegistryDb.properties.find((p) => p.key === "status")!;
    expect(noRegistryStatus.name).toBe("status");
    expect(noRegistryStatus.options).toEqual([{ key: "notDone", label: "notDone" }]);

    // A stored override on the database, property, and option all win over the catalog,
    // in every locale.
    await pool.query(`UPDATE databases SET name = $1 WHERE id = $2`, ["My Tasks", tasksDb.id]);
    await pool.query(`UPDATE properties SET name = $1 WHERE database_id = $2 AND key = 'status'`, [
      "My Status",
      tasksDb.id,
    ]);
    await pool.query(`UPDATE properties SET config = $1::jsonb WHERE database_id = $2 AND key = 'status'`, [
      JSON.stringify({ options: [{ key: "notDone", label: "Not started yet" }] }),
      tasksDb.id,
    ]);

    const moduleRegistry = await systemDatabasesRegistry();
    for (const locale of ["cs", "en"] as const) {
      const manifest = await withTransaction(pool, (client) =>
        generatePermissionManifest(client, projectItem.id, { moduleRegistry, locale }),
      );
      const db = manifest.databases.find((d) => d.databaseId === tasksDb.id)!;
      expect(db.name).toBe("My Tasks");
      const status = db.properties.find((p) => p.key === "status")!;
      expect(status.name).toBe("My Status");
      expect(status.options).toEqual([{ key: "notDone", label: "Not started yet" }]);
    }
  });

  it("drops an option with a non-string key or a non-string label instead of resolving a bogus label (issue #147 review)", async () => {
    const project = await chokePoint.createDatabase({ name: "Projects" });
    const projectItem = await chokePoint.createItem({ databaseId: project.id, properties: {} });

    const tasksDb = await chokePoint.createDatabase({
      name: null,
      key: "tasks",
      system: true,
      ownerProjectItemId: projectItem.id,
    });
    await chokePoint.createProperty({
      databaseId: tasksDb.id,
      key: "status",
      name: null,
      type: "select",
      config: { options: [{ key: "notDone" }] },
    });

    // Bypasses the choke point's write-side `assertValidSelectOptions` to simulate a legacy or
    // directly written row: one option with no string key, one with a numeric label.
    await pool.query(`UPDATE properties SET config = $1::jsonb WHERE database_id = $2 AND key = 'status'`, [
      JSON.stringify({ options: [{ key: 42 }, { key: "done", label: 99 }, { key: "wontDo" }] }),
      tasksDb.id,
    ]);

    const moduleRegistry = await systemDatabasesRegistry();
    const manifest = await withTransaction(pool, (client) =>
      generatePermissionManifest(client, projectItem.id, { moduleRegistry, locale: "en" }),
    );
    const status = manifest.databases
      .find((db) => db.databaseId === tasksDb.id)!
      .properties.find((p) => p.key === "status")!;
    expect(status.options).toEqual([{ key: "wontDo", label: "Won't do" }]);
  });

  it("leaves a user-authored (non-system) database's name byte-for-byte unchanged regardless of locale", async () => {
    const project = await chokePoint.createDatabase({ name: "Projects" });
    const projectItem = await chokePoint.createItem({ databaseId: project.id, properties: {} });
    const owned = await chokePoint.createDatabase({ name: "Můj vlastní deník", ownerProjectItemId: projectItem.id });

    const moduleRegistry = await systemDatabasesRegistry();
    const manifest = await withTransaction(pool, (client) =>
      generatePermissionManifest(client, projectItem.id, { moduleRegistry, locale: "en" }),
    );
    expect(manifest.databases.find((db) => db.databaseId === owned.id)?.name).toBe("Můj vlastní deník");
  });

  it("the drift check action writes a notification when an orphan is found, and nothing when clean", async () => {
    const project = await chokePoint.createDatabase({ name: "Projects2" });
    const projectItem = await chokePoint.createItem({ databaseId: project.id, properties: {} });
    const db = await chokePoint.createDatabase({ name: "Owned2", ownerProjectItemId: projectItem.id });
    await chokePoint.createProperty({
      databaseId: db.id,
      key: "orphan",
      name: "Orphan",
      type: "text",
      owner: "system",
    });

    const action = createDriftCheckAction(pool);
    await action({}, { heartbeatId: "hb", projectItemId: projectItem.id });

    const { rows } = await pool.query("SELECT kind, payload FROM notifications WHERE kind = 'agent_manifest_drift'");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.orphanedOwnerProcess).toHaveLength(1);
  });
});
