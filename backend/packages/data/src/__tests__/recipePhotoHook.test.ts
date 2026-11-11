import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
// The production hook registrations: this file reaches the choke point by its deep path, not through the barrel.
import "../domainWriteHooks.js";
import { createBlob, tenantBlobStorageKey } from "../blobs/blobsStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import type { ItemCreateHookContext, ItemUpdateHookContext } from "../chokePoint/hooks.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { recipePhotoWriteHook } from "../recipes/recipePhotoHook.js";
import { RECIPES_MODULE_ID } from "../seed/recipesModuleKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// Each test seeds two tenants with their couple of dozen system databases.
const SEEDING_HOOK_TIMEOUT_MS = 90_000;

const NOT_AN_IMAGE = {
  status: 400,
  code: "validation_failed",
  message: "photo must reference an image blob",
  details: { field: "photo" },
};

let adminPool: Pool;
let dataPool: Pool;
let chokePoint: ChokePoint;
let tenantId: string;
let otherTenantId: string;
let recipesId: string;

function inTenant<T>(tenant: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenant, () => withTransaction(dataPool, fn));
}

async function databaseId(tenant: string, moduleId: string): Promise<string> {
  const database = await inTenant(tenant, (client) => databasesStore.getDatabaseByModuleId(client, moduleId));
  if (!database) throw new Error(`Database '${moduleId}' was not seeded`);
  return database.id;
}

/** A blob row of `tenant` through the blob owner's store; the hook reads the row only, so no bytes are stored. */
async function blob(tenant: string, mimeType: string): Promise<string> {
  return inTenant(tenant, async (client) => {
    const storageKey = await tenantBlobStorageKey(client, randomUUID());
    return (await createBlob(client, { mimeType, byteSize: 1, storageKey })).id;
  });
}

/** The refusal of a write as the fields an HTTP caller sees; anything but a `ValidationError` is rethrown. */
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
  const items = await inTenant(tenantId, (client) => itemsStore.getAllItemsInDatabase(client, recipesId));
  return items.map(({ id, properties, updatedAt }) => ({ id, properties, updatedAt }));
}

describe("recipe photo write hook (issue #1707)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    const role = await dataPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    chokePoint = createChokePoint(dataPool);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    otherTenantId = await createTestTenant(adminPool);
    for (const tenant of [tenantId, otherTenantId]) {
      await runInTenant(tenant, () => seedSystem(dataPool, createViewTypeRegistry()));
    }
    recipesId = await databaseId(tenantId, RECIPES_MODULE_ID);
  }, SEEDING_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  describe("through the choke point", () => {
    it("accepts a create with an image blob of the tenant, with no photo and with a null photo", async () => {
      const image = await blob(tenantId, "image/png");

      const withPhoto = await createRecipe({ name: "Goulash", photo: { blobId: image } });
      const upperCase = await createRecipe({ name: "Svíčková", photo: { blobId: image.toUpperCase() } });
      const withoutPhoto = await createRecipe({ name: "Pancakes" });
      const nullPhoto = await createRecipe({ name: "Omelette", photo: null });

      expect(withPhoto.properties.photo).toEqual({ blobId: image });
      expect(upperCase.properties.photo).toEqual({ blobId: image.toUpperCase() });
      expect(Object.hasOwn(withoutPhoto.properties, "photo")).toBe(false);
      expect(nullPhoto.properties.photo).toBeNull();
      expect((await recipes()).map((item) => item.id).sort()).toEqual(
        [withPhoto.id, upperCase.id, withoutPhoto.id, nullPhoto.id].sort(),
      );
    });

    it("refuses a create whose photo is a blob that is not an image, and writes no item", async () => {
      const pdf = await blob(tenantId, "application/pdf");

      expect(await refusal(createRecipe({ name: "Goulash", photo: { blobId: pdf } }))).toEqual(NOT_AN_IMAGE);

      expect(await recipes()).toEqual([]);
    });

    it("answers a blob of another tenant exactly as an unknown blob, with field photo, and writes no item", async () => {
      const foreign = await blob(otherTenantId, "image/png");

      const unknown = await refusal(createRecipe({ name: "Goulash", photo: { blobId: randomUUID() } }));
      const otherTenant = await refusal(createRecipe({ name: "Goulash", photo: { blobId: foreign } }));

      expect(unknown).toMatchObject({ status: 400, code: "validation_failed", details: { field: "photo" } });
      expect(otherTenant).toEqual(unknown);
      expect(await recipes()).toEqual([]);
      // The other tenant can use its own blob.
      const otherRecipesId = await databaseId(otherTenantId, RECIPES_MODULE_ID);
      const own = await runInTenant(otherTenantId, () =>
        chokePoint.createItem({ databaseId: otherRecipesId, properties: { name: "Own", photo: { blobId: foreign } } }),
      );
      expect(own.properties.photo).toEqual({ blobId: foreign });
    });

    it.each([
      ["a string", "https://example.com/photo.png"],
      ["an object without a blob id", { url: "https://example.com/photo.png" }],
      ["an empty object", {}],
      ["a number", 5],
      ["an array", ["x"]],
    ])("refuses a photo that is %s, and writes no item", async (_label, photo) => {
      expect(await refusal(createRecipe({ name: "Goulash", photo }))).toEqual(NOT_AN_IMAGE);

      expect(await recipes()).toEqual([]);
    });

    it("judges an update by its patch: a new photo is checked, an untouched one is not, and null clears it", async () => {
      const image = await blob(tenantId, "image/jpeg");
      const secondImage = await blob(tenantId, "image/webp");
      const pdf = await blob(tenantId, "application/pdf");
      const foreign = await blob(otherTenantId, "image/png");
      const recipe = await createRecipe({ name: "Goulash", photo: { blobId: image } });
      const [created] = await recipes();

      expect(await refusal(patchRecipe(recipe.id, { photo: { blobId: pdf } }))).toEqual(NOT_AN_IMAGE);
      expect(await refusal(patchRecipe(recipe.id, { photo: "https://example.com/photo.png" }))).toEqual(NOT_AN_IMAGE);
      const unknown = await refusal(patchRecipe(recipe.id, { photo: { blobId: randomUUID() } }));
      expect(unknown).toMatchObject({ status: 400, details: { field: "photo" } });
      expect(await refusal(patchRecipe(recipe.id, { photo: { blobId: foreign } }))).toEqual(unknown);
      // Every refused update rolled back: the row is the one the create wrote.
      expect(await recipes()).toEqual([created]);

      const untouched = await patchRecipe(recipe.id, { servings: 4 });
      expect(untouched.properties).toMatchObject({ servings: 4, photo: { blobId: image } });
      const replaced = await patchRecipe(recipe.id, { photo: { blobId: secondImage } });
      expect(replaced.properties.photo).toEqual({ blobId: secondImage });
      const cleared = await patchRecipe(recipe.id, { photo: null });
      expect(cleared.properties.photo).toBeNull();
    });

    it("leaves the image property of another database unchecked", async () => {
      const pdf = await blob(tenantId, "application/pdf");
      const item = await runInTenant(tenantId, async () => {
        const database = await chokePoint.createDatabase({ name: "Scans" });
        await chokePoint.createProperty({ databaseId: database.id, key: "photo", name: "Photo", type: "image" });
        return chokePoint.createItem({ databaseId: database.id, properties: { photo: { blobId: pdf } } });
      });

      expect(item.properties.photo).toEqual({ blobId: pdf });
    });
  });

  // The blob reference hook registered before this one refuses an unknown, foreign or malformed blob id first,
  // so these call the hook directly to reach each of its own branches.
  describe("called on its own", () => {
    /** Runs the hook as a create and as an update of a recipe of `tenant` that set `photo`. */
    async function runHook(tenant: string, photo: unknown, moduleId = RECIPES_MODULE_ID): Promise<void> {
      const target = await databaseId(tenant, moduleId);
      await inTenant(tenant, async (client) => {
        const database = await databasesStore.getDatabase(client, target);
        if (!database) throw new Error("The database is missing");
        const item = await itemsStore.insertItem(client, { databaseId: target, properties: { name: "Fixture" } });
        const create: ItemCreateHookContext = {
          client,
          database,
          item,
          properties: { name: "Fixture", photo },
          writer: SYSTEM_WRITER,
        };
        const update: ItemUpdateHookContext = {
          client,
          database,
          item,
          propertiesPatch: { photo },
          writer: SYSTEM_WRITER,
        };
        await recipePhotoWriteHook(create);
        await recipePhotoWriteHook(update);
      });
    }

    it("accepts an image blob of the tenant and a null photo", async () => {
      const image = await blob(tenantId, "image/png");

      await expect(runHook(tenantId, { blobId: image })).resolves.toBeUndefined();
      await expect(runHook(tenantId, null)).resolves.toBeUndefined();
    });

    it("refuses an unknown blob and a blob of another tenant with the same answer", async () => {
      const foreign = await blob(otherTenantId, "image/png");

      expect(await refusal(runHook(tenantId, { blobId: randomUUID() }))).toEqual(NOT_AN_IMAGE);
      expect(await refusal(runHook(tenantId, { blobId: foreign }))).toEqual(NOT_AN_IMAGE);
      // The same id passes in the tenant that owns the blob.
      await expect(runHook(otherTenantId, { blobId: foreign })).resolves.toBeUndefined();
    });

    it("refuses a blob that is not an image", async () => {
      const pdf = await blob(tenantId, "application/pdf");

      expect(await refusal(runHook(tenantId, { blobId: pdf }))).toEqual(NOT_AN_IMAGE);
    });

    it.each([
      ["is not a UUID", { blobId: "not-a-uuid" }],
      ["is not a string", { blobId: 7 }],
    ])("refuses a blob id that %s before any lookup", async (_label, photo) => {
      expect(await refusal(runHook(tenantId, photo))).toEqual(NOT_AN_IMAGE);
    });

    it("checks the update only when its patch has the photo key", async () => {
      const pdf = await blob(tenantId, "application/pdf");
      await inTenant(tenantId, async (client) => {
        const database = await databasesStore.getDatabase(client, recipesId);
        if (!database) throw new Error("The recipes database is missing");
        const item = await itemsStore.insertItem(client, {
          databaseId: recipesId,
          // Written with the raw store, as no choke-point write stores a recipe photo that is not an image.
          properties: { name: "Fixture", photo: { blobId: pdf } },
        });
        const context: ItemUpdateHookContext = {
          client,
          database,
          item,
          propertiesPatch: { name: "Renamed" },
          writer: SYSTEM_WRITER,
        };

        await expect(recipePhotoWriteHook(context)).resolves.toBeUndefined();
      });
    });

    it("passes a write to another system database through", async () => {
      const pdf = await blob(tenantId, "application/pdf");

      await expect(runHook(tenantId, { blobId: pdf }, PROJECTS_MODULE_ID)).resolves.toBeUndefined();
    });
  });
});
