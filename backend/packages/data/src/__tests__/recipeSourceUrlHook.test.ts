import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@alldots/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import type { ItemCreateHookContext, ItemUpdateHookContext } from "../chokePoint/hooks.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { recipeSourceUrlWriteHook } from "../recipes/recipeSourceUrlHook.js";
import { RECIPES_MODULE_ID } from "../seed/recipesModuleKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// A recipe's `sourceUrl` is fetched server-side later, so it passes the stored-URL SSRF baseline.
const SEEDING_HOOK_TIMEOUT_MS = 90_000;

const REFUSED = {
  status: 400,
  code: "validation_failed",
  message: "sourceUrl must be an https URL on a public host name",
  details: { field: "sourceUrl" },
};

const PUBLIC_URL = "https://recipes.example.com/goulash?utm=feed";

const REFUSED_VALUES: ReadonlyArray<[string, unknown]> = [
  ["an http URL", "http://recipes.example.com/goulash"],
  ["a URL with a port", "https://recipes.example.com:8443/goulash"],
  ["a URL with userinfo", "https://user:secret@recipes.example.com/goulash"],
  ["a loopback IPv4 literal", "https://127.0.0.1/goulash"],
  ["a private IPv4 literal", "https://10.0.0.5/goulash"],
  ["a link-local IPv4 literal", "https://169.254.169.254/latest/meta-data"],
  ["an IPv6 literal", "https://[::1]/goulash"],
  ["localhost", "https://localhost/goulash"],
  ["a localhost subdomain", "https://app.localhost/goulash"],
  ["text that is not a URL", "goulash"],
  ["an empty string", ""],
  ["a number", 5],
  ["an object", { href: PUBLIC_URL }],
  ["an array", [PUBLIC_URL]],
];

let adminPool: Pool;
let dataPool: Pool;
let chokePoint: ChokePoint;
let tenantId: string;
let recipesId: string;

function inTenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

async function databaseId(moduleId: string): Promise<string> {
  const database = await inTenant((client) => databasesStore.getDatabaseByModuleId(client, moduleId));
  if (!database) throw new Error(`Database '${moduleId}' was not seeded`);
  return database.id;
}

async function refusal(write: Promise<unknown>) {
  try {
    await write;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  throw new Error("Expected the write to be refused");
}

const createRecipe = (properties: Record<string, unknown>) =>
  runInTenant(tenantId, () => chokePoint.createItem({ databaseId: recipesId, properties }));

const patchRecipe = (itemId: string, propertiesPatch: Record<string, unknown>) =>
  runInTenant(tenantId, () => chokePoint.updateItem({ databaseId: recipesId, itemId, propertiesPatch }));

async function recipes(): Promise<Array<{ id: string; properties: Record<string, unknown>; updatedAt: string }>> {
  const items = await inTenant((client) => itemsStore.getAllItemsInDatabase(client, recipesId));
  return items.map(({ id, properties, updatedAt }) => ({ id, properties, updatedAt }));
}

describe("recipe sourceUrl write hook (issue gh-1974)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "alldots_data");
    const role = await dataPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    chokePoint = createChokePoint(dataPool);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
    recipesId = await databaseId(RECIPES_MODULE_ID);
  }, SEEDING_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("seeds sourceUrl as a user-owned url property of the recipes database", async () => {
    const property = await inTenant((client) => propertiesStore.getPropertyByKey(client, recipesId, "sourceUrl"));

    expect(property).toMatchObject({ key: "sourceUrl", type: "url", owner: "user", name: null });
  });

  describe("through the choke point", () => {
    it("accepts a create with a public https URL, with no sourceUrl and with a null sourceUrl", async () => {
      const withUrl = await createRecipe({ name: "Goulash", sourceUrl: PUBLIC_URL });
      const withoutUrl = await createRecipe({ name: "Pancakes" });
      const nullUrl = await createRecipe({ name: "Omelette", sourceUrl: null });

      expect(withUrl.properties.sourceUrl).toBe(PUBLIC_URL);
      expect(Object.hasOwn(withoutUrl.properties, "sourceUrl")).toBe(false);
      expect(nullUrl.properties.sourceUrl).toBeNull();
      expect((await recipes()).map((item) => item.id).sort()).toEqual([withUrl.id, withoutUrl.id, nullUrl.id].sort());
    });

    it.each(REFUSED_VALUES)("refuses a create whose sourceUrl is %s, and writes no item", async (_label, value) => {
      expect(await refusal(createRecipe({ name: "Goulash", sourceUrl: value }))).toEqual(REFUSED);

      expect(await recipes()).toEqual([]);
    });

    it("judges an update by its patch: a new sourceUrl is checked, an untouched one is not, and null clears it", async () => {
      const recipe = await createRecipe({ name: "Goulash", sourceUrl: PUBLIC_URL });
      const [created] = await recipes();

      for (const [, value] of REFUSED_VALUES) {
        expect(await refusal(patchRecipe(recipe.id, { sourceUrl: value }))).toEqual(REFUSED);
      }
      expect(await recipes()).toEqual([created]);

      const untouched = await patchRecipe(recipe.id, { servings: 4 });
      expect(untouched.properties).toMatchObject({ servings: 4, sourceUrl: PUBLIC_URL });
      const replaced = await patchRecipe(recipe.id, { sourceUrl: "https://kitchen.example.org/goulash" });
      expect(replaced.properties.sourceUrl).toBe("https://kitchen.example.org/goulash");
      const cleared = await patchRecipe(recipe.id, { sourceUrl: null });
      expect(cleared.properties.sourceUrl).toBeNull();
    });

    it("leaves a url property named sourceUrl of another database unchecked", async () => {
      const item = await runInTenant(tenantId, async () => {
        const database = await chokePoint.createDatabase({ name: "Bookmarks" });
        await chokePoint.createProperty({ databaseId: database.id, key: "sourceUrl", name: "Source", type: "url" });
        return chokePoint.createItem({ databaseId: database.id, properties: { sourceUrl: "http://127.0.0.1/x" } });
      });

      expect(item.properties.sourceUrl).toBe("http://127.0.0.1/x");
    });
  });

  // The hook is registered for both registries, so these call it directly to reach each branch on its own.
  describe("called on its own", () => {
    async function runHook(sourceUrl: unknown, moduleId = RECIPES_MODULE_ID): Promise<void> {
      const target = await databaseId(moduleId);
      await inTenant(async (client) => {
        const database = await databasesStore.getDatabase(client, target);
        if (!database) throw new Error("The database is missing");
        const item = await itemsStore.insertItem(client, { databaseId: target, properties: { name: "Fixture" } });
        const create: ItemCreateHookContext = {
          client,
          database,
          item,
          properties: { name: "Fixture", sourceUrl },
          writer: SYSTEM_WRITER,
        };
        const update: ItemUpdateHookContext = {
          client,
          database,
          item,
          propertiesPatch: { sourceUrl },
          writer: SYSTEM_WRITER,
        };
        await recipeSourceUrlWriteHook(create);
        await recipeSourceUrlWriteHook(update);
      });
    }

    it("accepts a public https URL and null", async () => {
      await expect(runHook(PUBLIC_URL)).resolves.toBeUndefined();
      await expect(runHook(null)).resolves.toBeUndefined();
    });

    it("refuses a loopback literal on the create and on the update", async () => {
      expect(await refusal(runHook("https://127.0.0.1/goulash"))).toEqual(REFUSED);
    });

    it("checks the update only when its patch has the sourceUrl key", async () => {
      await inTenant(async (client) => {
        const database = await databasesStore.getDatabase(client, recipesId);
        if (!database) throw new Error("The recipes database is missing");
        const item = await itemsStore.insertItem(client, {
          databaseId: recipesId,
          // Raw store: no choke-point write stores a source that fails the baseline.
          properties: { name: "Fixture", sourceUrl: "http://127.0.0.1/legacy" },
        });
        const context: ItemUpdateHookContext = {
          client,
          database,
          item,
          propertiesPatch: { name: "Renamed" },
          writer: SYSTEM_WRITER,
        };

        await expect(recipeSourceUrlWriteHook(context)).resolves.toBeUndefined();
      });
    });

    it("passes a write to another system database through", async () => {
      await expect(runHook("https://127.0.0.1/goulash", PROJECTS_MODULE_ID)).resolves.toBeUndefined();
    });
  });
});
