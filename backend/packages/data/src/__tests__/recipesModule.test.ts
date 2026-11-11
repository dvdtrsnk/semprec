import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { listViewsByDatabase } from "../chokePoint/viewsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { ConflictError } from "../errors.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import { seedAccountSystemProjectGuidance } from "../projectAgentGuidance/seedSystemProjectAgentGuidance.js";
import { runRecipesModuleCutoverMigration } from "../recipes/recipesModuleCutoverMigration.js";
import { RECIPES_MODULE_ID } from "../seed/recipesModuleKeys.js";
import { lockTenantSeedInTransaction, seedSystem } from "../seed/seedSystem.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "../seed/systemProjectAgentGuidance.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

// Each test builds one or more tenants with their couple of dozen system databases.
const SEEDING_TEST_TIMEOUT_MS = 90_000;

let adminPool: Pool;
let dataPool: Pool;

/** What issue #1707 seeds, without ids: the database, its properties in order, its views and its owning project. */
const EXPECTED_SHAPE = {
  database: {
    key: "recipes",
    name: null,
    system: true,
    schemaLocked: true,
    ownerModuleId: "recipes",
    archivedAt: null,
  },
  // In the order the store lists them: by key, because the seed sets no position.
  properties: [
    {
      key: "category",
      name: null,
      type: "select",
      owner: "user",
      ownerProcess: null,
      locked: false,
      config: {
        options: [
          { key: "main", color: "#FF9500" },
          { key: "breakfast", color: "#FFCC00" },
          { key: "dessert", color: "#FF2D55" },
        ],
      },
    },
    { key: "favorite", name: null, type: "checkbox", owner: "user", ownerProcess: null, locked: false, config: {} },
    { key: "name", name: null, type: "title", owner: "user", ownerProcess: null, locked: false, config: {} },
    { key: "photo", name: null, type: "image", owner: "user", ownerProcess: null, locked: false, config: {} },
    {
      key: "prepMinutes",
      name: null,
      type: "number",
      owner: "user",
      ownerProcess: null,
      locked: false,
      config: {
        filterPresets: [
          { value: 15, op: "lte", labelKey: "property.recipes.prepMinutes.preset.15" },
          { value: 30, op: "lte", labelKey: "property.recipes.prepMinutes.preset.30" },
          { value: 60, op: "lte", labelKey: "property.recipes.prepMinutes.preset.60" },
        ],
      },
    },
    { key: "servings", name: null, type: "number", owner: "user", ownerProcess: null, locked: false, config: {} },
  ],
  views: [
    {
      type: "gallery",
      name: "Recipes",
      isDefault: true,
      createdBy: "system",
      ownerModuleId: null,
      config: { columns: 2, aspect: "4:3", coverKey: "photo" },
    },
  ],
  project: {
    name: "Recipes",
    systemActive: true,
    agents: SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS.recipes,
    deletedAt: null,
  },
};

/** The guidance document the Recipes seed text converts to. */
const RECIPES_GUIDANCE_MARKDOWN =
  "## Purpose\ncatalog the user's recipes; the ingredients and the method are written on each recipe's page.\n\n" +
  "## Allowed\ncreate or update a Recipes item (name/category/prepMinutes/servings/favorite/photo) via the generic item endpoints.\n\n" +
  "## Not allowed\nwrite 'photo' with anything other than { blobId } of an image blob of this tenant, or null to clear it — every other value is rejected.\n\n" +
  "## General instructions\nuse the same item paths as the UI; there is no separate AI path.\n";

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

/** The recipes database of `tenantId` as the runtime role sees it in that tenant's scope, or `null` without one. */
async function recipesShape(tenantId: string) {
  return inTenant(tenantId, async (client) => {
    const database = await databasesStore.getDatabaseByModuleId(client, RECIPES_MODULE_ID);
    if (!database) return null;
    const projects = await databasesStore.getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    const project =
      projects && database.ownerProjectItemId
        ? await getItemById(client, projects.id, database.ownerProjectItemId)
        : null;
    return {
      database: {
        key: database.key,
        name: database.name,
        system: database.system,
        schemaLocked: database.schemaLocked,
        ownerModuleId: database.ownerModuleId,
        archivedAt: database.archivedAt,
      },
      properties: (await listPropertiesByDatabase(client, database.id)).map((property) => ({
        key: property.key,
        name: property.name,
        type: property.type,
        owner: property.owner,
        ownerProcess: property.ownerProcess,
        locked: property.locked,
        config: property.config,
      })),
      views: (await listViewsByDatabase(client, database.id)).map((view) => ({
        type: view.type,
        name: view.name,
        isDefault: view.isDefault,
        createdBy: view.createdBy,
        ownerModuleId: view.ownerModuleId,
        config: view.config,
      })),
      project: project && {
        name: project.properties.name,
        systemActive: project.properties.systemActive,
        agents: project.properties.agents,
        deletedAt: project.deletedAt,
      },
    };
  });
}

async function seededTenant(status: "active" | "suspended" = "active"): Promise<string> {
  const tenantId = await createTestTenant(adminPool, { status });
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  return tenantId;
}

/** Gives `tenantId` its account, through the store account creation writes with, and returns the user id. */
async function createAccount(tenantId: string): Promise<string> {
  const user = await createUser(adminPool, {
    tenantId,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    role: "admin",
  });
  return user.id;
}

/**
 * The guidance rows and the drift heartbeats of the Recipes project of `tenantId`, as the runtime role sees
 * them in that tenant's scope.
 */
async function recipesGuidance(tenantId: string) {
  return inTenant(tenantId, async (client) => {
    const recipes = await databasesStore.getDatabaseByModuleId(client, RECIPES_MODULE_ID);
    if (!recipes?.ownerProjectItemId) throw new Error("The tenant has no Recipes project");
    const guidance = await client.query<{ owner_user_id: string; markdown: string }>(
      "SELECT owner_user_id, markdown FROM project_agent_guidance WHERE project_item_id = $1",
      [recipes.ownerProjectItemId],
    );
    const heartbeats = await client.query<{ enabled: boolean }>(
      "SELECT enabled FROM project_heartbeats WHERE project_item_id = $1 AND action_id = 'core.agentGuidanceDrift'",
      [recipes.ownerProjectItemId],
    );
    return { guidance: guidance.rows, driftHeartbeats: heartbeats.rows.map((row) => row.enabled) };
  });
}

/**
 * Every guidance row and every drift heartbeat of `tenantId`, with its row version, on the admin pool filtered
 * by the tenant.
 */
async function guidanceRows(tenantId: string) {
  const read = async (sql: string) => (await adminPool.query<{ version: string; row: unknown }>(sql, [tenantId])).rows;
  return {
    guidance: await read(
      `SELECT xmin::text AS version, to_jsonb(g) AS row FROM project_agent_guidance g
        WHERE tenant_id = $1 ORDER BY project_item_id`,
    ),
    driftHeartbeats: await read(
      `SELECT xmin::text AS version, to_jsonb(h) AS row FROM project_heartbeats h
        WHERE tenant_id = $1 AND action_id = 'core.agentGuidanceDrift' ORDER BY id`,
    ),
  };
}

/**
 * Removes what issue #1707 seeds from a tenant, leaving the state of a tenant seeded before it. The recipes
 * database is a locked system database and no public path deletes it or its project, so the ids are read in
 * the tenant's scope and the rows removed on the admin pool; the database, its partition, properties and
 * views go through the store's own drop.
 */
async function revertToOldShape(tenantId: string): Promise<void> {
  const ids = await inTenant(tenantId, async (client) => {
    const recipes = await databasesStore.getDatabaseByModuleId(client, RECIPES_MODULE_ID);
    const projects = await databasesStore.getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!recipes?.ownerProjectItemId || !projects) throw new Error("Seeded tenant is missing a database");
    return { recipes: recipes.id, project: recipes.ownerProjectItemId, projects: projects.id };
  });
  await withTenantTransaction(adminPool, tenantId, async (client) => {
    await databasesStore.dropDatabaseWithPartition(client, ids.recipes);
    // Raw SQL: no production path hard-deletes the project item of a system module.
    const removed = await client.query("DELETE FROM items WHERE database_id = $1 AND id = $2", [
      ids.projects,
      ids.project,
    ]);
    expect(removed.rowCount).toBe(1);
  });
  expect(await recipesShape(tenantId)).toBeNull();
}

/** Every row of `tenantId` in the tables the seed writes, with its row version, on the admin pool filtered by the tenant. */
async function tenantRows(tenantId: string) {
  const read = async (sql: string) => (await adminPool.query<{ version: string; row: unknown }>(sql, [tenantId])).rows;
  return {
    databases: await read(
      "SELECT xmin::text AS version, to_jsonb(d) AS row FROM databases d WHERE tenant_id = $1 ORDER BY id",
    ),
    properties: await read(
      "SELECT xmin::text AS version, to_jsonb(p) AS row FROM properties p WHERE tenant_id = $1 ORDER BY id",
    ),
    views: await read("SELECT xmin::text AS version, to_jsonb(v) AS row FROM views v WHERE tenant_id = $1 ORDER BY id"),
    items: await read("SELECT xmin::text AS version, to_jsonb(i) AS row FROM items i WHERE tenant_id = $1 ORDER BY id"),
  };
}

/**
 * The rows issue #1707 seeds for `tenantId`, with their row versions: the recipes database, its properties and
 * views, and the project item that owns it. A cutover that rewrote one of them would change its version.
 */
async function recipesRows(tenantId: string) {
  const read = async (sql: string) =>
    (await adminPool.query<{ version: string; row: unknown }>(sql, [tenantId, RECIPES_MODULE_ID])).rows;
  return {
    databases: await read(
      `SELECT xmin::text AS version, to_jsonb(d) AS row FROM databases d
        WHERE tenant_id = $1 AND owner_module_id = $2 ORDER BY id`,
    ),
    properties: await read(
      `SELECT p.xmin::text AS version, to_jsonb(p) AS row FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE d.tenant_id = $1 AND d.owner_module_id = $2 ORDER BY p.id`,
    ),
    views: await read(
      `SELECT v.xmin::text AS version, to_jsonb(v) AS row FROM views v JOIN databases d ON d.id = v.database_id
        WHERE d.tenant_id = $1 AND d.owner_module_id = $2 ORDER BY v.id`,
    ),
    projects: await read(
      `SELECT i.xmin::text AS version, to_jsonb(i) AS row FROM items i JOIN databases d ON d.owner_project_item_id = i.id
        WHERE d.tenant_id = $1 AND d.owner_module_id = $2 ORDER BY i.id`,
    ),
  };
}

function runCutovers(): Promise<void> {
  return runAsSystem("test recipes cutover", () => runTenantCutoverMigrations(dataPool));
}

describe("Recipes system module (issue #1707)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    const role = await dataPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it(
    "gives a newly provisioned tenant the recipes database with exactly the six properties, the gallery default view and its system project",
    async () => {
      const tenantId = await createTestTenant(adminPool, { status: "provisioning" });

      await expect(provisionTenant(dataPool, tenantId)).resolves.toBe("created");

      expect(await recipesShape(tenantId)).toEqual(EXPECTED_SHAPE);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "delivers the module through the registered cutover runner to an active and a suspended tenant seeded before it, with the schema and the labels of a fresh seed",
    async () => {
      const active = await seededTenant();
      const suspended = await seededTenant("suspended");
      const fresh = await seededTenant();
      await revertToOldShape(active);
      await revertToOldShape(suspended);
      const freshBefore = await recipesRows(fresh);
      expect(freshBefore.databases).toHaveLength(1);
      expect(freshBefore.properties).toHaveLength(6);
      expect(freshBefore.views).toHaveLength(1);
      expect(freshBefore.projects).toHaveLength(1);

      await runCutovers();

      expect(await recipesShape(active)).toEqual(EXPECTED_SHAPE);
      expect(await recipesShape(suspended)).toEqual(EXPECTED_SHAPE);
      // The tenant that had the module already keeps its rows unwritten.
      expect(await recipesRows(fresh)).toEqual(freshBefore);

      const registry = await loadFullModuleRegistry();
      const projected = async (tenantId: string) => {
        const projection = await inTenant(tenantId, (client) =>
          generateSchemaProjection(client, registry, { locale: "cs" }),
        );
        const recipes = projection.databases.find((database) => database.key === RECIPES_MODULE_ID);
        if (!recipes) throw new Error("recipes is missing from the schema projection");
        return { ...recipes, databaseId: null, properties: recipes.properties.map((p) => ({ ...p, id: null })) };
      };
      const cutOver = await projected(active);
      expect(cutOver).toEqual(await projected(fresh));
      expect(cutOver.name).toBe("Recepty");
      expect(Object.fromEntries(cutOver.properties.map((property) => [property.key, property.name]))).toEqual({
        name: "Název",
        category: "Kategorie",
        prepMinutes: "Čas",
        servings: "Porce",
        favorite: "Oblíbené",
        photo: "Fotka",
      });
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "writes nothing when the cutover runs again, through the runner and on its own",
    async () => {
      const tenantId = await seededTenant();
      await revertToOldShape(tenantId);
      await runCutovers();
      const delivered = await recipesRows(tenantId);
      expect(delivered.databases).toHaveLength(1);
      expect(delivered.properties).toHaveLength(6);
      expect(delivered.views).toHaveLength(1);
      expect(delivered.projects).toHaveLength(1);

      await runCutovers();
      expect(await recipesRows(tenantId)).toEqual(delivered);

      // On its own the step writes no row of the tenant at all.
      const before = await tenantRows(tenantId);
      await runInTenant(tenantId, () => runRecipesModuleCutoverMigration(dataPool));
      expect(await tenantRows(tenantId)).toEqual(before);
      expect(await recipesRows(tenantId)).toEqual(delivered);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it("skips a tenant that has no Projects database", async () => {
    const bare = await createTestTenant(adminPool);

    await expect(runInTenant(bare, () => runRecipesModuleCutoverMigration(dataPool))).resolves.toBeUndefined();

    const rows = await tenantRows(bare);
    expect(rows).toEqual({ databases: [], properties: [], views: [], items: [] });
  });

  it(
    "writes the guidance row and the drift heartbeat of the Recipes project in the pass that creates it, for an active and a suspended tenant that have an account, and nothing in a second pass",
    async () => {
      const active = await seededTenant();
      const suspended = await seededTenant("suspended");
      const activeUser = await createAccount(active);
      const suspendedUser = await createAccount(suspended);
      await revertToOldShape(active);
      await revertToOldShape(suspended);

      await runCutovers();

      expect(await recipesGuidance(active)).toEqual({
        guidance: [{ owner_user_id: activeUser, markdown: RECIPES_GUIDANCE_MARKDOWN }],
        driftHeartbeats: [true],
      });
      expect(await recipesGuidance(suspended)).toEqual({
        guidance: [{ owner_user_id: suspendedUser, markdown: RECIPES_GUIDANCE_MARKDOWN }],
        driftHeartbeats: [true],
      });

      const afterFirstPass = { active: await guidanceRows(active), suspended: await guidanceRows(suspended) };
      await runCutovers();
      expect({ active: await guidanceRows(active), suspended: await guidanceRows(suspended) }).toEqual(afterFirstPass);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "writes no guidance for a tenant without an account, whose Recipes project gets its row when the account is created",
    async () => {
      const tenantId = await seededTenant();
      await revertToOldShape(tenantId);

      await runInTenant(tenantId, () => runRecipesModuleCutoverMigration(dataPool));

      expect(await recipesShape(tenantId)).toEqual(EXPECTED_SHAPE);
      expect(await guidanceRows(tenantId)).toEqual({ guidance: [], driftHeartbeats: [] });

      const userId = await createAccount(tenantId);
      await seedAccountSystemProjectGuidance(dataPool, tenantId, userId);

      expect(await recipesGuidance(tenantId)).toEqual({
        guidance: [{ owner_user_id: userId, markdown: RECIPES_GUIDANCE_MARKDOWN }],
        driftHeartbeats: [true],
      });
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "seeds only the tenant in scope and leaves another tenant that also lacks the module unchanged",
    async () => {
      const tenantId = await seededTenant();
      const other = await seededTenant();
      const userId = await createAccount(tenantId);
      await createAccount(other);
      await revertToOldShape(tenantId);
      await revertToOldShape(other);
      const otherBefore = await tenantRows(other);

      await runInTenant(tenantId, () => runRecipesModuleCutoverMigration(dataPool));

      expect(await tenantRows(other)).toEqual(otherBefore);
      expect(await recipesShape(other)).toBeNull();
      expect(await guidanceRows(other)).toEqual({ guidance: [], driftHeartbeats: [] });
      expect(await recipesShape(tenantId)).toEqual(EXPECTED_SHAPE);
      expect(await recipesGuidance(tenantId)).toEqual({
        guidance: [{ owner_user_id: userId, markdown: RECIPES_GUIDANCE_MARKDOWN }],
        driftHeartbeats: [true],
      });
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "rolls the whole seed back when a step fails, leaving no Recipes project behind",
    async () => {
      const tenantId = await seededTenant();
      await revertToOldShape(tenantId);
      // A system database that holds the key `recipes` under another owner module: no production path creates
      // one, it only makes the seed's own database insert fail after the project item was inserted.
      await inTenant(tenantId, (client) =>
        databasesStore.createDatabase(client, {
          name: "Key holder",
          key: RECIPES_MODULE_ID,
          system: true,
          ownerModuleId: "recipesKeyHolder",
        }),
      );
      const before = await tenantRows(tenantId);

      await expect(runInTenant(tenantId, () => runRecipesModuleCutoverMigration(dataPool))).rejects.toBeInstanceOf(
        ConflictError,
      );

      expect(await tenantRows(tenantId)).toEqual(before);
      expect(await recipesShape(tenantId)).toBeNull();
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  describe("concurrency", () => {
    const deadline = <T>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 20_000);
      });
      return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
    };

    /** The backends `holderPid` blocks; bounded: each probe is one short statement and the probes stop. */
    async function waitingOn(holderPid: number, expected: number): Promise<number[]> {
      let waiting: number[] = [];
      for (let probe = 0; probe < 4000 && waiting.length < expected; probe += 1) {
        const { rows } = await adminPool.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [holderPid],
        );
        waiting = rows.map((row) => row.pid);
      }
      return waiting;
    }

    it(
      "serializes two cutovers of a tenant without the module on the seed lock, so exactly one seeds",
      async () => {
        const tenantId = await seededTenant();
        await revertToOldShape(tenantId);
        // A transaction on its own admin connection, in the tenant's scope, that holds the seed lock.
        const holder = await adminPool.connect();
        let runs: Promise<void>[] = [];
        let outcomes: PromiseSettledResult<void>[];
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
          const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const holderPid = rows[0]?.pid;
          if (holderPid === undefined) throw new Error("The lock holder has no backend pid");
          await lockTenantSeedInTransaction(holder, "test seed lock holder");
          runs = [1, 2].map(() => runInTenant(tenantId, () => runRecipesModuleCutoverMigration(dataPool)));
          // Both wait for the seed lock before their existence check.
          expect(await waitingOn(holderPid, 2)).toHaveLength(2);
          await holder.query("COMMIT");
        } finally {
          holder.release(true);
          outcomes = await deadline(Promise.allSettled(runs), "both cutovers to settle");
        }

        expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
        const { rows: databases } = await adminPool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM databases WHERE tenant_id = $1 AND owner_module_id = $2",
          [tenantId, RECIPES_MODULE_ID],
        );
        expect(databases).toEqual([{ count: 1 }]);
        const { rows: projects } = await adminPool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM items WHERE tenant_id = $1 AND properties->>'name' = 'Recipes'",
          [tenantId],
        );
        expect(projects).toEqual([{ count: 1 }]);
        expect(await recipesShape(tenantId)).toEqual(EXPECTED_SHAPE);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );
  });
});
