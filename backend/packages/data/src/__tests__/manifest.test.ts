import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry, type ModuleDatabaseProjection } from "@semprec/module-registry";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import * as permissionManifest from "../manifest/permissionManifest.js";
import { generatePermissionManifest } from "../manifest/permissionManifest.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { createDriftCheckAction, findOrphanedOwnerProcessProperties } from "../manifest/driftCheck.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { upsertMcpToolRegistration } from "../mcp/mcpToolRegistrationsStore.js";
import { setProjectMcpGrant } from "../mcp/mcpGrantsAdminStore.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../systemSettings.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { parseFilterNode, type FilterNode } from "../views/filterTree.js";
import type { PropertyRow } from "../types.js";

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

  it("excludes page capabilities from project grants even when an owned module declares them", async () => {
    const projectDb = await chokePoint.createDatabase({ name: "Projects" });
    const project = await chokePoint.createItem({ databaseId: projectDb.id, properties: {} });
    await chokePoint.createDatabase({
      name: "Owned",
      key: "pageGrantProbe",
      system: true,
      ownerProjectItemId: project.id,
    });
    const fixtureDir = await mkdtemp(join(tmpdir(), "page-grant-module-"));
    const fixturePath = join(fixtureDir, "manifest.mjs");
    await writeFile(
      fixturePath,
      `export const manifest = ${JSON.stringify({ id: "pageGrantProbe", version: "1.0.0", name: "Page grant probe", removable: true, systemProject: false, databases: [{ key: "pageGrantProbe", name: "Probe" }], capabilities: ["core.page.read", "core.page.write", "probe.read"], agentTools: [] })};`,
    );
    const registry = new ModuleRegistry(() => new Set(["schemaCore", "pageGrantProbe"]));
    await registry.loadModule(new URL("../chokePoint/schemaCoreModuleManifest.js", import.meta.url).href);
    await registry.loadModule(pathToFileURL(fixturePath).href);
    const result = await withTransaction(pool, (client) =>
      generatePermissionManifest(client, project.id, { moduleRegistry: registry }),
    );
    expect(result.grantedCapabilities).toContain("core.item.read");
    expect(result.grantedCapabilities).toContain("core.item.write");
    expect(result.grantedCapabilities).toContain("probe.read");
    expect(result.grantedCapabilities).not.toContain("core.page.read");
    expect(result.grantedCapabilities).not.toContain("core.page.write");
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

  it("projects the tenant zone and its current day, which differs from the UTC day around local midnight", async () => {
    const instant = new Date("2026-03-10T23:30:00Z");
    await seedSystem(pool, createViewTypeRegistry());
    const settings = await withTransaction(pool, async (client) => ({
      databaseId: await getSystemSettingsDatabaseId(client),
      itemId: await getSystemSettingsItemId(client),
    }));
    const projectTenant = async (zone: string) => {
      await chokePoint.updateItem({ ...settings, propertiesPatch: { timezone: zone } });
      return withTransaction(
        pool,
        async (client) =>
          (await generateSchemaProjection(client, new ModuleRegistry(() => new Set()), { now: instant })).tenant,
      );
    };

    expect(await projectTenant("Europe/Prague")).toEqual({ timezone: "Europe/Prague", today: "2026-03-11" });
    expect(await projectTenant("UTC")).toEqual({ timezone: "UTC", today: "2026-03-10" });
    expect(await projectTenant("America/New_York")).toEqual({ timezone: "America/New_York", today: "2026-03-10" });
  });

  it("projects each runtime tenant's own timezone after a settings change", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let primary: { value: unknown } | undefined;
    try {
      for (const tenant of [tenantA, tenantB]) {
        await runInTenant(tenant, () => seedSystem(runtime, createViewTypeRegistry()));
      }
      const clock = new Date("2026-03-10T23:30:00Z");
      const projection = (tenant: string) =>
        runInTenant(tenant, () =>
          withTransaction(
            runtime,
            async (client) =>
              (await generateSchemaProjection(client, new ModuleRegistry(() => new Set()), { now: clock })).tenant,
          ),
        );
      const settings = await runInTenant(tenantA, () =>
        withTransaction(runtime, async (client) => ({
          databaseId: await getSystemSettingsDatabaseId(client),
          itemId: await getSystemSettingsItemId(client),
        })),
      );
      await runInTenant(tenantA, () =>
        createChokePoint(runtime).updateItem({
          ...settings,
          propertiesPatch: { timezone: "America/New_York" },
        }),
      );
      expect(await projection(tenantA)).toEqual({ timezone: "America/New_York", today: "2026-03-10" });
      expect(await projection(tenantB)).toEqual({ timezone: "Europe/Prague", today: "2026-03-11" });
    } catch (error) {
      primary = { value: error };
    }
    try {
      await runtime.end();
    } catch (error) {
      throw new AggregateError(primary ? [primary.value, error] : [error], "Runtime pool cleanup failed", {
        cause: error,
      });
    }
    if (primary) throw primary.value;
  });

  it("projects id, type, typed config and filterable per property in the schema (issue #1360)", async () => {
    const projects = await chokePoint.createDatabase({ name: "Projects" });
    const tasks = await chokePoint.createDatabase({ name: "Tasks" });
    const base = { databaseId: projects.id };
    await chokePoint.createProperty({
      ...base,
      key: "status",
      name: "Status",
      type: "select",
      config: { options: [{ key: "open", label: "Open" }] },
    });
    await chokePoint.createProperty({ ...base, key: "due", name: "Due", type: "date", config: { includeTime: true } });
    await chokePoint.createProperty({ ...base, key: "start", name: "Start", type: "date" });
    await chokePoint.createProperty({ ...base, key: "budget", name: "Budget", type: "number" });
    await chokePoint.createProperty({
      ...base,
      key: "score",
      name: "Score",
      type: "number",
      config: {
        filterPresets: [{ value: 8, op: "gte", labelKey: "property.custom.score.preset.high", label: "High" }],
      },
    });
    await chokePoint.createProperty({ ...base, key: "note", name: "Note", type: "text" });
    for (const key of ["a", "b", "c"]) {
      await chokePoint.createRelationProperty({
        sourceDatabaseId: projects.id,
        key: `tasks${key}`,
        name: `Tasks ${key}`,
        targetDatabaseId: tasks.id,
        cardinality: "one_to_many",
        inverse: { key: `project${key}`, name: `Project ${key}` },
      });
    }

    let relationQueries = 0;
    const schema = await withTransaction(pool, (client) => {
      const counting = new Proxy(client, {
        get(target, prop, receiver) {
          if (prop !== "query") return Reflect.get(target, prop, receiver) as unknown;
          return (...args: unknown[]) => {
            const text = typeof args[0] === "string" ? args[0] : "";
            if (text.includes("FROM relation_definitions")) relationQueries += 1;
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        },
      });
      return generateSchemaProjection(counting, new ModuleRegistry(() => new Set()));
    });

    const byKey = new Map(
      schema.databases.find((d) => d.databaseId === projects.id)!.properties.map((p) => [p.key, p]),
    );
    expect(byKey.get("status")).toMatchObject({
      type: "select",
      filterable: true,
      config: {},
      options: [{ key: "open", label: "Open" }],
    });
    expect(byKey.get("status")!.id).toEqual(expect.any(String));
    expect(byKey.get("tasksa")).toMatchObject({
      type: "relation",
      filterable: true,
      config: { targetDatabaseId: tasks.id, cardinality: "one_to_many" },
    });
    expect(byKey.get("due")).toMatchObject({ type: "date", filterable: true, config: { includeTime: true } });
    expect(byKey.get("start")!.config).toEqual({ includeTime: false });
    expect(byKey.get("budget")).toMatchObject({ type: "number", filterable: false, config: {} });
    expect(byKey.get("score")).toMatchObject({
      type: "number",
      filterable: true,
      config: { filterPresets: [{ value: 8, op: "gte", label: "High" }] },
    });
    expect(byKey.get("note")).toMatchObject({ type: "text", filterable: false, config: {} });
    for (const key of ["tasksa", "due", "start", "budget", "score", "note"]) {
      expect(byKey.get(key)?.id).toEqual(expect.stringMatching(/.+/));
    }
    expect(relationQueries).toBe(1);
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
      { key: "notDone", label: "Otevřeno" },
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
      { key: "notDone", label: "Open" },
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
      { key: "notDone", label: "Otevřeno" },
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

    const { rows } = await pool.query(
      "SELECT kind, payload FROM manifest_drift_findings WHERE kind = 'agent_manifest_drift'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.orphanedOwnerProcess).toHaveLength(1);
  });

  it("the drift check action runs cleanly against a real user's locale, live, with no throw across a locale change (issue #147 AC #9/#10)", async () => {
    const project = await chokePoint.createDatabase({ name: "Projects3" });
    const projectItem = await chokePoint.createItem({ databaseId: project.id, properties: {} });
    await chokePoint.createDatabase({ name: null, key: "tasks", system: true, ownerProjectItemId: projectItem.id });

    const passwordHash = await hashPassword("s3cret-password");
    const user = await createUser(pool, {
      email: "owner@example.test",
      passwordHash,
      locale: "cs",
      tenantId: getTenantZeroId(),
    });

    const moduleRegistry = await systemDatabasesRegistry();
    const action = createDriftCheckAction(pool, { moduleRegistry });

    // Exercises the cs catalog: the action resolves the tenant user's locale live and must not
    // throw while doing so.
    await expect(action({}, { heartbeatId: "hb", projectItemId: projectItem.id })).resolves.toBeUndefined();

    // A locale change (no persisted manifest to go stale) takes effect on the very next run.
    await pool.query(`UPDATE users SET locale = 'en' WHERE id = $1`, [user.id]);
    await expect(action({}, { heartbeatId: "hb", projectItemId: projectItem.id })).resolves.toBeUndefined();
  });
});

describe("drift check locale in a tenant (issue #1018)", () => {
  let runtimePool: Pool;

  // The first describe's `afterAll` ended the shared pool, so this block opens and closes its own.
  beforeAll(async () => {
    pool = getTestPool();
    runtimePool = await runInTenant(getTenantZeroId(), () => createRuntimeRolePool(pool, "semprec_data"));
  });

  beforeEach(async () => {
    await runInTenant(getTenantZeroId(), () => resetDatabase(pool));
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
  });

  async function runDriftCheckIn(tenantId: string, expectedLocale: "en" | "cs"): Promise<void> {
    const moduleRegistry = await systemDatabasesRegistry();
    await runInTenant(tenantId, async () => {
      const chokePointB = createChokePoint(runtimePool);
      const project = await chokePointB.createDatabase({ name: "Projects" });
      const projectItem = await chokePointB.createItem({ databaseId: project.id, properties: {} });
      await chokePointB.createDatabase({ name: null, key: "tasks", system: true, ownerProjectItemId: projectItem.id });
      const action = createDriftCheckAction(runtimePool, { moduleRegistry });
      const generateManifest = vi.spyOn(permissionManifest, "generatePermissionManifest");
      try {
        await expect(action({}, { heartbeatId: "hb", projectItemId: projectItem.id })).resolves.toBeUndefined();
        expect(generateManifest).toHaveBeenCalledExactlyOnceWith(expect.anything(), projectItem.id, {
          moduleRegistry,
          locale: expectedLocale,
        });
      } finally {
        generateManifest.mockRestore();
      }
    });
  }

  it("completes in a tenant whose user's locale differs from the earlier-created account's", async () => {
    const tenantB = await runInTenant(getTenantZeroId(), () => createTestTenant(pool));
    await runInTenant(getTenantZeroId(), () =>
      createUser(pool, { email: "a@example.test", passwordHash: "x", locale: "en", tenantId: getTenantZeroId() }),
    );
    await runInTenant(tenantB, () =>
      createUser(pool, { email: "b@example.test", passwordHash: "x", locale: "cs", tenantId: tenantB }),
    );

    await runDriftCheckIn(tenantB, "cs");
  });

  it("falls back to en and completes in a tenant with no user", async () => {
    const tenantB = await runInTenant(getTenantZeroId(), () => createTestTenant(pool));
    await runInTenant(getTenantZeroId(), () =>
      createUser(pool, { email: "a@example.test", passwordHash: "x", locale: "cs", tenantId: getTenantZeroId() }),
    );

    await runDriftCheckIn(tenantB, "en");
  });
});

describe("number filter presets in the schema projection (issue #1622)", () => {
  let runtimePool: Pool;
  let tenant: string;

  beforeAll(async () => {
    pool = getTestPool();
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    tenant = await createTestTenant(pool);
    await runInTenant(tenant, () => seedSystem(runtimePool));
  });
  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
  });

  async function schemaProperty(locale: "cs" | "en", databaseKey: string, propertyKey: string) {
    const registry = await loadFullModuleRegistry();
    const schema = await runInTenant(tenant, () =>
      withTransaction(runtimePool, (client) => generateSchemaProjection(client, registry, { locale })),
    );
    return schema.databases.find((db) => db.key === databaseKey)?.properties.find((p) => p.key === propertyKey);
  }

  it.each([
    ["en", ["5 stars", "4 and up", "3 and up"], "No rating"],
    ["cs", ["5 hvězd", "4 a víc", "3 a víc"], "Bez hodnocení"],
  ] as const)("localizes the Books and Movies rating presets for %s", async (locale, labels, none) => {
    for (const databaseKey of ["books", "movies"]) {
      expect(await schemaProperty(locale, databaseKey, "rating")).toMatchObject({
        type: "number",
        filterable: true,
        config: {
          filterPresets: [5, 4, 3].map((value, index) => ({ value, op: "gte", label: labels[index] })),
          emptyPreset: { label: none, matchZero: true },
        },
      });
    }
  });

  it("prefers a literal label, falls back to the labelKey text, and drops a stored preset that fails the shape", async () => {
    await runInTenant(tenant, async () => {
      // A legacy or direct write the validated property writer refuses; the Library schema is locked anyway.
      await runtimePool.query(
        `UPDATE properties SET config = jsonb_set(config, '{filterPresets}', $1::jsonb)
         WHERE key = 'rating' AND database_id = (SELECT id FROM databases WHERE owner_module_id = 'books')`,
        [
          JSON.stringify([
            { value: 5, op: "gte", labelKey: "property.books.rating.preset.5", label: "Top" },
            { value: 4, op: "gte", labelKey: "unknown.catalog.key" },
            { value: 1, op: "eq", labelKey: "property.books.rating.preset.4" },
          ]),
        ],
      );
    });
    expect((await schemaProperty("cs", "books", "rating"))?.config.filterPresets).toEqual([
      { value: 5, op: "gte", label: "Top" },
      { value: 4, op: "gte", label: "unknown.catalog.key" },
    ]);
  });

  it("keeps a number property without presets unfilterable", async () => {
    expect(await schemaProperty("en", "books", "year")).toMatchObject({
      type: "number",
      filterable: false,
      config: {},
    });
  });

  it("refuses property.create and property.patch with an eq preset, presets on text and emptyPreset alone", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(runtimePool);
      const database = await cp.createDatabase({ name: "Recipes" });
      const rejected = { status: 400, code: "validation_failed", details: { field: "config" } };
      const eq = { filterPresets: [{ value: 15, op: "eq", labelKey: "k" }] };
      await expect(
        cp.createProperty({ databaseId: database.id, key: "prep", name: "Prep", type: "number", config: eq }),
      ).rejects.toMatchObject(rejected);
      await expect(
        cp.createProperty({
          databaseId: database.id,
          key: "label",
          name: "Label",
          type: "text",
          config: { filterPresets: [{ value: 15, op: "lte", labelKey: "k" }] },
        }),
      ).rejects.toMatchObject(rejected);
      const prep = await cp.createProperty({
        databaseId: database.id,
        key: "prep",
        name: "Prep",
        type: "number",
        config: { default: 10 },
      });
      for (const config of [
        { ...eq, default: 10 },
        { emptyPreset: { labelKey: "k", matchZero: true }, default: 10 },
      ]) {
        await expect(cp.updatePropertyWithDatabase(prep.id, { config })).rejects.toMatchObject(rejected);
      }
      expect((await cp.getProperty(prep.id))?.config).toEqual({ default: 10 });
      const valid = { filterPresets: [{ value: 15, op: "lte", labelKey: "k", label: "Up to 15 min" }], default: 10 };
      const { property } = await cp.updatePropertyWithDatabase(prep.id, { config: valid });
      expect(property.config).toEqual(valid);
    });
  });
});

/** The property keys a filter tree names, each with the hop path that leads to its database. */
function filterKeys(node: FilterNode): string[][] {
  if (node.type === "and" || node.type === "or") return node.nodes.flatMap(filterKeys);
  if (node.type === "not") return filterKeys(node.node);
  if (node.type === "relation_path_contains") return [[node.path[0]], [node.path[0], node.path[1]]];
  if (node.type === "date_relative" && node.endProperty !== undefined) return [[node.property], [node.endProperty]];
  return [[node.property]];
}

/**
 * Every property key a manifest's view hints name (issue #1647) that the seeded database of the same key
 * does not have, as `<database>.<where>: <key path>`. Filters are parsed with the data package's own
 * filter schema first, so a tree that does not parse is reported too.
 */
async function unknownReferencedKeys(
  client: Parameters<typeof listPropertiesByDatabase>[0],
  databases: ModuleDatabaseProjection[],
): Promise<string[]> {
  const unknown: string[] = [];
  const propertiesOf = async (moduleId: string): Promise<PropertyRow[] | null> => {
    const database = await getDatabaseByModuleId(client, moduleId);
    return database ? listPropertiesByDatabase(client, database.id) : null;
  };
  const hasKeyPath = async (properties: PropertyRow[], path: string[]): Promise<boolean> => {
    const [head, ...rest] = path;
    const property = properties.find((candidate) => candidate.key === head);
    if (!property) return false;
    if (rest.length === 0) return true;
    const target = property.config.targetDatabaseId;
    if (typeof target !== "string") return false;
    return hasKeyPath(await listPropertiesByDatabase(client, target), rest);
  };
  for (const db of databases) {
    const properties = await propertiesOf(db.key);
    if (!properties) {
      unknown.push(`${db.key}: no seeded database`);
      continue;
    }
    const trees: [string, unknown][] = [
      ...(db.quickFilters ?? []).flatMap((chip): [string, unknown][] =>
        chip.filter === undefined ? [] : [[`quickFilters.${chip.key}`, chip.filter]],
      ),
      ...(db.collectionFilter === undefined ? [] : [["collectionFilter", db.collectionFilter] as [string, unknown]]),
      ...(db.pickerFilter === undefined ? [] : [["pickerFilter", db.pickerFilter] as [string, unknown]]),
    ];
    for (const [where, tree] of trees) {
      for (const path of filterKeys(parseFilterNode(tree))) {
        if (!(await hasKeyPath(properties, path))) unknown.push(`${db.key}.${where}: ${path.join(".")}`);
      }
    }
    const sorts: [string, string][] = [
      ...(db.quickFilters ?? []).flatMap((chip) =>
        (chip.sort ?? []).map((spec): [string, string] => [`quickFilters.${chip.key}.sort`, spec.property]),
      ),
      ...(db.defaultSort === undefined ? [] : [["defaultSort", db.defaultSort.property] as [string, string]]),
    ];
    for (const [where, key] of sorts) {
      if (!(await hasKeyPath(properties, [key]))) unknown.push(`${db.key}.${where}: ${key}`);
    }
  }
  return unknown;
}

describe("quick filters, default sorts and collection and picker filters (issue #1647)", () => {
  let runtimePool: Pool;
  let tenant: string;
  let registry: ModuleRegistry;

  beforeAll(async () => {
    pool = getTestPool();
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    registry = await loadFullModuleRegistry();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    tenant = await createTestTenant(pool);
    await runInTenant(tenant, () => seedSystem(runtimePool));
  });
  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
  });

  async function schema(locale: "cs" | "en") {
    return runInTenant(tenant, () =>
      withTransaction(runtimePool, (client) => generateSchemaProjection(client, registry, { locale })),
    );
  }

  it("names only property keys the seeded databases have, and reports one they do not", async () => {
    const declared = await registry.getDatabases();
    const withHints = declared.filter((db) => db.quickFilters !== undefined || db.defaultSort !== undefined);
    expect(withHints.length).toBe(8);
    expect(
      await runInTenant(tenant, () =>
        withTransaction(runtimePool, (client) => unknownReferencedKeys(client, declared)),
      ),
    ).toEqual([]);

    const projects = declared.find((db) => db.key === "projects");
    if (!projects) throw new Error("Projects is not declared");
    const misspelled: ModuleDatabaseProjection = {
      ...projects,
      quickFilters: [{ key: "typo", labelKey: "x", filter: { type: "in", property: "stauts", value: ["done"] } }],
      defaultSort: { property: "deadline", direction: "asc" },
      pickerFilter: { type: "not", node: { type: "is_empty", property: "systemActiv" } },
    };
    expect(
      await runInTenant(tenant, () =>
        withTransaction(runtimePool, (client) => unknownReferencedKeys(client, [misspelled])),
      ),
    ).toEqual([
      "projects.quickFilters.typo: stauts",
      "projects.pickerFilter: systemActiv",
      "projects.defaultSort: deadline",
    ]);
  });

  it.each([
    ["en", { active: "Active", toRead: "To read", past: "Overdue", noDate: "No due date", recent: "Recent" }],
    ["cs", { active: "Aktivní", toRead: "Chci číst", past: "Po termínu", noDate: "Bez termínu", recent: "Nedávné" }],
  ] as const)("projects localized chips and date labels for %s", async (locale, labels) => {
    const { databases } = await schema(locale);
    const byKey = new Map(databases.map((db) => [db.key, db]));
    expect(byKey.get("projects")?.quickFilters[0]).toEqual({
      key: "active",
      label: labels.active,
      filter: { type: "in", property: "status", value: ["inProgress", "longTerm"] },
      isDefault: true,
    });
    expect(byKey.get("projects")?.dateLabels).toEqual({ past: labels.past, noDate: labels.noDate });
    const books = byKey.get("books")?.quickFilters ?? [];
    expect(books.find((chip) => chip.key === "toRead")).toEqual({
      key: "toRead",
      label: labels.toRead,
      filter: { type: "in", property: "status", value: ["toRead"] },
      isDefault: false,
    });
    expect(books.filter((chip) => chip.isDefault)).toEqual([]);
    expect(byKey.get("files")?.quickFilters.find((chip) => chip.key === "recent")).toEqual({
      key: "recent",
      label: labels.recent,
      filter: { type: "date_relative", property: "date", preset: "last30" },
      isDefault: false,
    });
    for (const key of ["events", "tasks"]) {
      expect(byKey.get(key)?.defaultSort, key).toEqual({ property: "date", direction: "asc" });
    }
    // Every chip label is resolved text, never its catalog key.
    for (const db of databases) {
      for (const chip of db.quickFilters) expect(chip.label, `${db.key}.${chip.key}`).not.toMatch(/^quickFilter\./);
    }
  });

  it("gives a database without declarations, and a user-created one, empty quick filters and nothing else", async () => {
    const userDatabase = await runInTenant(tenant, () =>
      createChokePoint(runtimePool).createDatabase({ name: "Recipes" }),
    );
    const { databases } = await schema("en");
    for (const db of databases.filter(
      (candidate) => candidate.key === "companies" || candidate.databaseId === userDatabase.id,
    )) {
      expect(db.quickFilters, db.name).toEqual([]);
      for (const field of ["dateLabels", "collectionFilter", "pickerFilter"]) {
        expect(Object.hasOwn(db, field), `${db.name}.${field}`).toBe(false);
      }
    }
    expect(databases.some((db) => db.databaseId === userDatabase.id)).toBe(true);
  });

  it("queries Projects with the projected collection and picker filters, and links a task to a done project", async () => {
    const { databases } = await schema("en");
    const projectsSchema = databases.find((db) => db.key === "projects");
    if (!projectsSchema?.collectionFilter || !projectsSchema.pickerFilter) throw new Error("Projects filters missing");
    const { collectionFilter, pickerFilter } = projectsSchema;
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(runtimePool);
      const projectsId = projectsSchema.databaseId;
      const create = async (properties: Record<string, unknown>) =>
        (await cp.createItem({ databaseId: projectsId, properties: { name: "Project", ...properties } })).id;
      const active = await create({ status: "inProgress" });
      const longTerm = await create({ status: "longTerm" });
      const done = await create({ status: "done" });
      const archived = await create({ status: "archived" });
      const noStatus = await create({ status: null });
      const system = await create({ status: "inProgress", systemActive: true });
      const deactivated = await create({ status: "inProgress", systemActive: false });
      const ids = async (filter: unknown) =>
        new Set((await cp.queryDatabaseItems(projectsId, { filter, limit: 200 })).items.map((item) => item.id));

      const collection = await ids(collectionFilter);
      for (const id of [active, longTerm, done, archived, noStatus]) expect(collection.has(id)).toBe(true);
      expect(collection.has(system)).toBe(false);
      expect(collection.has(deactivated)).toBe(false);
      // The seeded system-module projects are not user projects either.
      const all = await ids(undefined);
      const seeded = [...all].filter(
        (id) => ![active, longTerm, done, archived, noStatus, system, deactivated].includes(id),
      );
      expect(seeded.length).toBeGreaterThan(0);
      for (const id of seeded) expect(collection.has(id)).toBe(false);

      const picker = await ids(pickerFilter);
      expect([...picker].sort()).toEqual([active, longTerm, noStatus].sort());

      // The picker filter is a read hint: a done project stays a valid relation target.
      const tasks = await withTransaction(runtimePool, (client) => getDatabaseByModuleId(client, "tasks"));
      if (!tasks) throw new Error("Tasks not seeded");
      const projectProperty = (await cp.listProperties(tasks.id)).find((property) => property.key === "project");
      if (!projectProperty) throw new Error("Tasks.project not seeded");
      const task = await cp.createItem({ databaseId: tasks.id, properties: { name: "Task" } });
      const edge = await cp.createRelation({
        relationPropertyId: projectProperty.id,
        callerItemId: task.id,
        targetItemId: done,
      });
      expect([edge.itemA, edge.itemB].sort()).toEqual([task.id, done].sort());
    });
  });
});
