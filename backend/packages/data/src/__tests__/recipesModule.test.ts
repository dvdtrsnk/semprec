import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@alldots/shared";
import { createUser } from "../auth/usersStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { listViewsByDatabase } from "../chokePoint/viewsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import { seedAccountSystemProjectGuidance } from "../projectAgentGuidance/seedSystemProjectAgentGuidance.js";
import { RECIPES_MODULE_ID } from "../seed/recipesModuleKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "../seed/systemProjectAgentGuidance.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// Each test builds one or more tenants with their couple of dozen system databases.
const SEEDING_TEST_TIMEOUT_MS = 90_000;

let adminPool: Pool;
let dataPool: Pool;

/** The seeded shape without ids: the database, its properties in order, its views and owning project. */
const EXPECTED_SHAPE = {
  database: {
    key: "recipes",
    name: null,
    system: true,
    schemaLocked: true,
    ownerModuleId: "recipes",
    archivedAt: null,
  },
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
    { key: "sourceUrl", name: null, type: "url", owner: "user", ownerProcess: null, locked: false, config: {} },
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

const RECIPES_GUIDANCE_MARKDOWN =
  "## Purpose\ncatalog the user's recipes; the ingredients and the method are written on each recipe's page.\n\n" +
  "## Allowed\ncreate or update a Recipes item (name/category/prepMinutes/servings/favorite/photo) via the generic item endpoints.\n\n" +
  "## Not allowed\nwrite 'photo' with anything other than { blobId } of an image blob of this tenant, or null to clear it — every other value is rejected.\n\n" +
  "## General instructions\nuse the same item paths as the UI; there is no separate AI path.\n";

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

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

async function createAccount(tenantId: string): Promise<string> {
  const user = await createUser(adminPool, {
    tenantId,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    role: "admin",
  });
  return user.id;
}

/** In the tenant's own scope on the runtime role. */
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

/** On the admin pool filtered by tenant, with row versions. */
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

describe("Recipes system module (issue #1707)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "alldots_data");
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
    "gives a newly provisioned tenant the recipes database with exactly the seven properties, the gallery default view and its system project",
    async () => {
      const tenantId = await createTestTenant(adminPool, { status: "provisioning" });

      await expect(provisionTenant(dataPool, tenantId)).resolves.toBe("created");

      expect(await recipesShape(tenantId)).toEqual(EXPECTED_SHAPE);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "projects the seeded recipes database with its Czech labels",
    async () => {
      const tenantId = await seededTenant();
      const registry = await loadFullModuleRegistry();
      const projection = await inTenant(tenantId, (client) =>
        generateSchemaProjection(client, registry, { locale: "cs" }),
      );
      const recipes = projection.databases.find((database) => database.key === RECIPES_MODULE_ID);
      if (!recipes) throw new Error("recipes is missing from the schema projection");
      expect(recipes.name).toBe("Recepty");
      expect(Object.fromEntries(recipes.properties.map((property) => [property.key, property.name]))).toEqual({
        name: "Název",
        category: "Kategorie",
        prepMinutes: "Čas",
        servings: "Porce",
        favorite: "Oblíbené",
        photo: "Fotka",
        sourceUrl: "Zdroj",
      });
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "writes no guidance for a tenant without an account, whose Recipes project gets its row when the account is created",
    async () => {
      const tenantId = await seededTenant();

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
});
