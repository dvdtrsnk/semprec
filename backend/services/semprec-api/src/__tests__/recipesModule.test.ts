import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
} from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
// Each test seeds two tenants with their couple of dozen system databases and hashes two passwords.
const SEEDING_HOOK_TIMEOUT_MS = 90_000;
// A complete 1×1 RGBA PNG, including its image data and chunk checksums.
const PNG_IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF_DOCUMENT = Buffer.from("%PDF-1.7 document");

const moduleRegistry = await loadFullModuleRegistry();

interface Tenant {
  id: string;
  headers: { Authorization: string };
}

const databaseBody = z.object({
  id: z.string(),
  key: z.string().nullable(),
  name: z.string(),
  searchPlaceholder: z.string().nullable(),
  ownerModuleId: z.string().nullable(),
  schemaLocked: z.boolean(),
  system: z.boolean(),
  archivedAt: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  overviewOrder: z.number().nullable(),
  switcherOrder: z.number().nullable(),
  clientVisible: z.boolean(),
  defaultViewType: z.string().nullable(),
});
const itemBody = z.object({
  id: z.string(),
  updatedAt: z.string(),
  properties: z.record(z.string(), z.unknown()),
});
const errorBody = z.object({
  error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
});

let pool: Pool;
let runtime: Pool;
let server: Server;
let base: string;
let storageDir: string;
let czech: Tenant;
let english: Tenant;

async function tenant(locale: string): Promise<Tenant> {
  const id = await createTestTenant(pool);
  const email = `${randomUUID()}@example.com`;
  await createUser(pool, { tenantId: id, email, passwordHash: await hashPassword(PASSWORD), locale });
  const { token } = await login(pool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  await runInTenant(id, () => seedSystem(runtime, createViewTypeRegistry()));
  return { id, headers: { Authorization: `Bearer ${token}` } };
}

async function request(
  who: Tenant,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...who.headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function listDatabases(who: Tenant): Promise<Array<z.infer<typeof databaseBody>>> {
  const { status, body } = await request(who, "GET", "/api/databases?limit=200");
  expect(status).toBe(200);
  return z.object({ databases: z.array(databaseBody) }).parse(body).databases;
}

async function database(who: Tenant, key: string): Promise<z.infer<typeof databaseBody>> {
  const found = (await listDatabases(who)).find((entry) => entry.key === key);
  if (!found) throw new Error(`${key} is missing from GET /api/databases`);
  return found;
}

/** Uploads bytes through `POST /api/blobs` as `who` and returns the blob id. */
async function upload(who: Tenant, bytes: Buffer, contentType: string): Promise<string> {
  const response = await fetch(`${base}/api/blobs`, {
    method: "POST",
    headers: { ...who.headers, "Content-Type": contentType },
    body: bytes,
  });
  expect(response.status).toBe(201);
  return z.object({ blobId: z.string() }).parse(await response.json()).blobId;
}

async function recipeIds(who: Tenant, recipesId: string, filter?: unknown): Promise<string[]> {
  const { status, body } = await request(who, "POST", `/api/databases/${recipesId}/query`, {
    limit: 200,
    ...(filter === undefined ? {} : { filter }),
  });
  expect(status).toBe(200);
  return z
    .object({ items: z.array(itemBody) })
    .parse(body)
    .items.map((item) => item.id);
}

async function createRecipe(who: Tenant, recipesId: string, properties: Record<string, unknown>): Promise<string> {
  const { status, body } = await request(who, "POST", `/api/databases/${recipesId}/items`, { properties });
  expect(status).toBe(201);
  return itemBody.parse(body).id;
}

const PHOTO_REFUSED = { status: 400, body: { error: { code: "validation_failed", details: { field: "photo" } } } };

describe("Recipes module over HTTP (issue #1707)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    runtime = await createRuntimeRolePool(pool, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    storageDir = join(tmpdir(), `semprec-recipes-${randomUUID()}`);
    server = createServer(
      await createDispatcher(runtime, {
        moduleRegistry,
        passwordResetMailer: { async sendPasswordResetEmail() {} },
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        blobStorage: new LocalFsBlobStorageWriter(storageDir),
        maxFileSizeBytes: 1048576,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    base = `http://127.0.0.1:${address.port}`;
    czech = await tenant("cs");
    english = await tenant("en");
  }, SEEDING_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(storageDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await runtime?.end();
    await pool?.end();
  });

  it("returns recipes from GET /api/databases with its icon, color, position 9 of both orders, its default view type gallery and its localized name", async () => {
    const all = await listDatabases(czech);
    const recipes = all.find((entry) => entry.key === "recipes");

    expect(recipes).toEqual({
      id: recipes?.id,
      key: "recipes",
      name: "Recepty",
      searchPlaceholder: "Hledat v receptech",
      ownerModuleId: "recipes",
      schemaLocked: true,
      system: true,
      archivedAt: null,
      icon: "fork-knife",
      color: "#FF9500",
      overviewOrder: 9,
      switcherOrder: 9,
      clientVisible: true,
      defaultViewType: "gallery",
    });
    // Ninth in the list: after the eight collections of switcher positions 1 to 8.
    expect(all.map((entry) => entry.key).indexOf("recipes")).toBe(8);

    const inEnglish = await database(english, "recipes");
    expect(inEnglish).toMatchObject({
      name: "Recipes",
      searchPlaceholder: "Search recipes",
      icon: "fork-knife",
      defaultViewType: "gallery",
    });
    expect(inEnglish.id).not.toBe(recipes?.id);

    const detail = await request(czech, "GET", `/api/databases/${recipes?.id}`);
    expect(detail.status).toBe(200);
    expect(databaseBody.parse(detail.body)).toEqual(recipes);
  });

  it("returns the default view type a manifest declares, and null for a system database that declares none and for a user-created database", async () => {
    const created = await request(czech, "POST", "/api/databases", { name: "Wine cellar" });
    expect(created.status).toBe(201);
    const custom = databaseBody.parse(created.body);
    expect(custom).toMatchObject({ key: null, system: false, defaultViewType: null });

    const all = await listDatabases(czech);

    // Exactly the declarations of the loaded manifests: Journal and Recipes; every other database answers null.
    expect(
      Object.fromEntries(all.filter((entry) => entry.defaultViewType !== null).map((entry) => [entry.key, entry])),
    ).toEqual({
      journal: expect.objectContaining({ system: true, defaultViewType: "temporal-switcher" }),
      recipes: expect.objectContaining({ system: true, defaultViewType: "gallery" }),
    });
    expect(all.find((entry) => entry.key === "projects")).toMatchObject({ system: true, defaultViewType: null });
    expect(all.find((entry) => entry.id === custom.id)).toEqual(custom);

    const journal = await database(czech, "journal");
    const detail = await request(czech, "GET", `/api/databases/${journal.id}`);
    expect(detail.status).toBe(200);
    expect(databaseBody.parse(detail.body)).toEqual(journal);
    const customDetail = await request(czech, "GET", `/api/databases/${custom.id}`);
    expect(customDetail.status).toBe(200);
    expect(databaseBody.parse(customDetail.body)).toEqual(custom);
  });

  it("serves the one view of recipes, its default view of type gallery, from GET /api/views/:id", async () => {
    const recipes = await database(czech, "recipes");
    // No route lists the views of a database, so the id is read through the choke point in the tenant's scope.
    const views = await runInTenant(czech.id, () => createChokePoint(runtime).listViewsByDatabase(recipes.id));
    expect(views).toHaveLength(1);

    const { status, body } = await request(czech, "GET", `/api/views/${views[0]?.id}`);

    expect(status).toBe(200);
    expect(body).toEqual({
      id: views[0]?.id,
      databaseId: recipes.id,
      type: "gallery",
      name: "Recipes",
      config: { columns: 2, aspect: "4:3", coverKey: "photo" },
      isDefault: true,
      ownerModuleId: null,
      createdBy: "system",
      creatorProjectItemId: null,
    });
  });

  it("projects exactly the six properties in GET /api/schema, with Czech and English labels, option colors and time presets", async () => {
    const property = z.object({
      key: z.string(),
      name: z.string(),
      type: z.string(),
      filterable: z.boolean(),
      owner: z.string(),
      locked: z.boolean(),
      options: z.array(z.object({ key: z.string(), label: z.string(), color: z.string().optional() })).optional(),
      config: z.record(z.string(), z.unknown()),
    });
    const schemaOf = async (who: Tenant) => {
      const { status, body } = await request(who, "GET", "/api/schema");
      expect(status).toBe(200);
      const recipes = z
        .object({
          databases: z.array(z.object({ key: z.string().nullable(), name: z.string(), properties: z.array(property) })),
        })
        .parse(body)
        .databases.find((entry) => entry.key === "recipes");
      if (!recipes) throw new Error("recipes is missing from GET /api/schema");
      return { name: recipes.name, properties: Object.fromEntries(recipes.properties.map((p) => [p.key, p])) };
    };
    const user = { owner: "user", locked: false };

    expect(await schemaOf(czech)).toEqual({
      name: "Recepty",
      properties: {
        name: { key: "name", name: "Název", type: "title", filterable: false, ...user, config: {} },
        category: {
          key: "category",
          name: "Kategorie",
          type: "select",
          filterable: true,
          ...user,
          options: [
            { key: "main", label: "Hlavní jídlo", color: "#FF9500" },
            { key: "breakfast", label: "Snídaně", color: "#FFCC00" },
            { key: "dessert", label: "Dezert", color: "#FF2D55" },
          ],
          config: {},
        },
        prepMinutes: {
          key: "prepMinutes",
          name: "Čas",
          type: "number",
          filterable: true,
          ...user,
          config: {
            filterPresets: [
              { value: 15, op: "lte", label: "Do 15 min" },
              { value: 30, op: "lte", label: "Do 30 min" },
              { value: 60, op: "lte", label: "Do hodiny" },
            ],
          },
        },
        servings: { key: "servings", name: "Porce", type: "number", filterable: false, ...user, config: {} },
        favorite: { key: "favorite", name: "Oblíbené", type: "checkbox", filterable: true, ...user, config: {} },
        photo: { key: "photo", name: "Fotka", type: "image", filterable: false, ...user, config: {} },
      },
    });

    const inEnglish = await schemaOf(english);
    expect(inEnglish.name).toBe("Recipes");
    expect(Object.fromEntries(Object.values(inEnglish.properties).map((p) => [p.key, p.name]))).toEqual({
      name: "Name",
      category: "Category",
      prepMinutes: "Time",
      servings: "Servings",
      favorite: "Favorite",
      photo: "Photo",
    });
    expect(inEnglish.properties.category?.options?.map((option) => option.label)).toEqual([
      "Main course",
      "Breakfast",
      "Dessert",
    ]);
    expect(inEnglish.properties.prepMinutes?.config).toEqual({
      filterPresets: [
        { value: 15, op: "lte", label: "Up to 15 min" },
        { value: 30, op: "lte", label: "Up to 30 min" },
        { value: 60, op: "lte", label: "Up to an hour" },
      ],
    });
  });

  it("refuses DELETE /api/databases/:id for recipes exactly as for another system database, and keeps it live", async () => {
    const recipes = await database(czech, "recipes");
    const projects = await database(czech, "projects");

    const refused = await request(czech, "DELETE", `/api/databases/${recipes.id}`);
    const other = await request(czech, "DELETE", `/api/databases/${projects.id}`);

    expect(refused.status).toBe(403);
    expect(errorBody.parse(refused.body).error.code).toBe("forbidden");
    expect(refused).toEqual(other);
    expect(await database(czech, "recipes")).toEqual(recipes);
    const detail = await request(czech, "GET", `/api/databases/${recipes.id}`);
    expect(databaseBody.parse(detail.body).archivedAt).toBeNull();
  });

  it("answers 400 on photo for an unknown blob, a blob of another tenant and a blob that is not an image, and creates the recipe with an image blob of the tenant", async () => {
    const recipes = await database(czech, "recipes");
    const image = await upload(czech, PNG_IMAGE, "image/png");
    const pdf = await upload(czech, PDF_DOCUMENT, "application/pdf");
    const foreign = await upload(english, PNG_IMAGE, "image/png");
    const create = (photo: unknown) =>
      request(czech, "POST", `/api/databases/${recipes.id}/items`, { properties: { name: "Goulash", photo } });

    const unknown = await create({ blobId: randomUUID() });
    expect(unknown).toEqual(PHOTO_REFUSED);
    expect(await create({ blobId: foreign })).toEqual(unknown);
    expect(await create({ blobId: pdf })).toEqual(PHOTO_REFUSED);
    expect(await recipeIds(czech, recipes.id)).toEqual([]);

    const created = await create({ blobId: image });
    expect(created.status).toBe(201);
    const recipe = itemBody.parse(created.body);
    expect(recipe.properties.photo).toMatchObject({ blobId: image });
    expect(await recipeIds(czech, recipes.id)).toEqual([recipe.id]);

    // An update is checked the same way and a refused one leaves the stored photo.
    const patch = (photo: unknown) =>
      request(czech, "PATCH", `/api/items/${recipe.id}`, { properties: { photo }, ifVersion: recipe.updatedAt });
    expect(await patch({ blobId: pdf })).toEqual(PHOTO_REFUSED);
    expect(await patch({ blobId: foreign })).toEqual(PHOTO_REFUSED);
    const read = await request(czech, "GET", `/api/items/${recipe.id}`);
    expect(itemBody.parse(read.body)).toMatchObject({
      updatedAt: recipe.updatedAt,
      properties: { photo: { blobId: image } },
    });
    const secondImage = await upload(czech, Buffer.concat([PNG_IMAGE, Buffer.from("second")]), "image/png");
    const replaced = await patch({ blobId: secondImage });
    expect(replaced.status).toBe(200);
    expect(itemBody.parse(replaced.body).properties.photo).toMatchObject({ blobId: secondImage });

    // The blob the first tenant was refused is usable by the tenant that owns it.
    const englishRecipes = await database(english, "recipes");
    const own = await request(english, "POST", `/api/databases/${englishRecipes.id}/items`, {
      properties: { name: "Stew", photo: { blobId: foreign } },
    });
    expect(own.status).toBe(201);
  });

  it("matches recipes of 10 and 25 minutes with prepMinutes lte 30, not one of 35 minutes or without a time", async () => {
    const recipes = await database(czech, "recipes");
    const ten = await createRecipe(czech, recipes.id, { name: "Omelette", prepMinutes: 10 });
    const twentyFive = await createRecipe(czech, recipes.id, { name: "Pasta", prepMinutes: 25 });
    const thirtyFive = await createRecipe(czech, recipes.id, { name: "Goulash", prepMinutes: 35 });
    const noTime = await createRecipe(czech, recipes.id, { name: "Bread" });
    const englishRecipes = await database(english, "recipes");
    const foreign = await createRecipe(english, englishRecipes.id, { name: "Toast", prepMinutes: 5 });

    const matched = await recipeIds(czech, recipes.id, { type: "lte", property: "prepMinutes", value: 30 });

    expect(matched).toContain(ten);
    expect(matched).toContain(twentyFive);
    expect(matched).not.toContain(thirtyFive);
    expect(matched).not.toContain(noTime);
    expect(matched).not.toContain(foreign);
    expect(matched).toHaveLength(2);
  });
});
