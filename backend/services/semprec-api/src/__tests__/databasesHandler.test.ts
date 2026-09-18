import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  type ChokePoint,
  type DatabaseRow,
  type PasswordResetMailer,
} from "@semprec/data";
import { createGenericApplicationService } from "@semprec/application";
import { createDispatcher } from "../app.js";
import { createDatabaseRoutes } from "../databasesHandler.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry = await loadFullModuleRegistry();

async function authHeader(locale = "en"): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
    locale,
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

interface DatabaseBody {
  id: string;
  name: string;
  key: string | null;
  system: boolean;
  archivedAt: string | null;
}

interface PropertyCatalogBody {
  properties: Array<{
    id: string;
    databaseId: string;
    key: string;
    type: string;
    label: string;
    options?: Array<{ key: string; label: string }>;
    locked: boolean;
    owner: string;
    ownerProcess: string | null;
    migrationStatus: string;
  }>;
}

async function findSystemDatabase(): Promise<DatabaseRow> {
  const databases = await chokePoint.listDatabases();
  const system = databases.find((db) => db.system);
  if (!system) throw new Error("expected at least one system database from seedSystem");
  return system;
}

describe("database routes (issue #240)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());

    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await fetch(`${baseUrl}/api/databases`);
    expect(res.status).toBe(401);
  });

  it("creates, lists, fetches, renames, and archives a database", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };

    const createRes = await fetch(`${baseUrl}/api/databases`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Recipes" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as DatabaseBody;
    expect(created.name).toBe("Recipes");
    expect(created.system).toBe(false);
    expect(created.archivedAt).toBeNull();

    const listRes = await fetch(`${baseUrl}/api/databases`, { headers });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { databases: DatabaseBody[] };
    expect(list.databases.some((db) => db.id === created.id)).toBe(true);

    const detailRes = await fetch(`${baseUrl}/api/databases/${created.id}`, { headers });
    expect(detailRes.status).toBe(200);
    expect(((await detailRes.json()) as DatabaseBody).id).toBe(created.id);

    const patchRes = await fetch(`${baseUrl}/api/databases/${created.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Family Recipes" }),
    });
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as DatabaseBody).name).toBe("Family Recipes");

    const deleteRes = await fetch(`${baseUrl}/api/databases/${created.id}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(200);
    const archived = (await deleteRes.json()) as DatabaseBody;
    expect(archived.archivedAt).not.toBeNull();
  });

  it("returns 404 for an unknown database id", async () => {
    const headers = await authHeader();
    const res = await fetch(`${baseUrl}/api/databases/${randomUUID()}`, { headers });
    expect(res.status).toBe(404);
  });

  it("serves one locale-resolved property catalog and preserves its authoritative raw fields", async () => {
    const movies = (await chokePoint.listDatabases()).find((database) => database.key === "movies");
    if (!movies) throw new Error("expected Movies database from seedSystem");

    const getCatalog = async (locale: string): Promise<PropertyCatalogBody> => {
      const res = await fetch(`${baseUrl}/api/databases/${movies.id}/properties`, {
        headers: await authHeader(locale),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as PropertyCatalogBody;
    };

    const cs = await getCatalog("cs");
    const csType = cs.properties.find((property) => property.key === "type");
    expect(csType).toMatchObject({
      databaseId: movies.id,
      type: "select",
      label: "Typ",
      locked: false,
      owner: "user",
      ownerProcess: null,
      migrationStatus: "stable",
      options: [
        { key: "movie", label: "Film" },
        { key: "series", label: "Seriál" },
      ],
    });
    expect(cs.properties.find((property) => property.key === "year")).not.toHaveProperty("options");

    const en = await getCatalog("en");
    expect(en.properties.find((property) => property.key === "type")).toMatchObject({
      label: "Type",
      options: [
        { key: "movie", label: "Movie" },
        { key: "series", label: "Series" },
      ],
    });
  });

  it("lets a property label override win and falls back to a raw key without a catalog", async () => {
    const movies = (await chokePoint.listDatabases()).find((database) => database.key === "movies");
    if (!movies) throw new Error("expected Movies database from seedSystem");
    const ratingProperty = (await chokePoint.listProperties(movies.id)).find((property) => property.key === "rating");
    if (!ratingProperty) throw new Error("expected rating property on the Movies database");
    await chokePoint.updateProperty(ratingProperty.id, { name: "My rating" });

    const overridden = await fetch(`${baseUrl}/api/databases/${movies.id}/properties`, {
      headers: await authHeader("cs"),
    });
    const overriddenBody = (await overridden.json()) as PropertyCatalogBody;
    expect(overriddenBody.properties.find((property) => property.key === "rating")?.label).toBe("My rating");

    const custom = await chokePoint.createDatabase({ name: "Custom" });
    const raw = await chokePoint.createProperty({
      databaseId: custom.id,
      key: "untranslated",
      name: "Untranslated",
      type: "text",
    });
    await pool.query(`UPDATE properties SET name = NULL WHERE id = $1`, [raw.id]);
    const rawResponse = await fetch(`${baseUrl}/api/databases/${custom.id}/properties`, {
      headers: await authHeader("cs"),
    });
    const rawBody = (await rawResponse.json()) as PropertyCatalogBody;
    expect(rawBody.properties).toEqual([
      expect.objectContaining({ id: raw.id, databaseId: custom.id, key: "untranslated", label: "untranslated" }),
    ]);
  });

  it("keeps archived databases readable and returns the established not_found and 401 failures", async () => {
    const database = await chokePoint.createDatabase({ name: "Archived" });
    await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "text" });
    await chokePoint.archiveDatabase(database.id);

    const archived = await fetch(`${baseUrl}/api/databases/${database.id}/properties`, { headers: await authHeader() });
    expect(archived.status).toBe(200);

    const missing = await fetch(`${baseUrl}/api/databases/${randomUUID()}/properties`, { headers: await authHeader() });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not_found");

    const unauthenticated = await fetch(`${baseUrl}/api/databases/${database.id}/properties`);
    expect(unauthenticated.status).toBe(401);
  });

  it("registers exactly one property-catalog route handler", () => {
    expect(
      createDatabaseRoutes(createGenericApplicationService(pool), moduleRegistry).filter(
        (route) => route.method === "GET" && route.path === "/api/databases/:id/properties",
      ),
    ).toHaveLength(1);
  });

  it("forbids archiving/deleting a system database with 403", async () => {
    const system = await findSystemDatabase();
    const headers = await authHeader();

    const res = await fetch(`${baseUrl}/api/databases/${system.id}`, { method: "DELETE", headers });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("creates a property on a database", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const createRes = await fetch(`${baseUrl}/api/databases`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Books" }),
    });
    const database = (await createRes.json()) as DatabaseBody;

    const propRes = await fetch(`${baseUrl}/api/databases/${database.id}/properties`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "title", name: "Title", type: "text" }),
    });
    expect(propRes.status).toBe(201);
    const property = (await propRes.json()) as { id: string; key: string; type: string; databaseId: string };
    expect(property.key).toBe("title");
    expect(property.type).toBe("text");
    expect(property.databaseId).toBe(database.id);
  });

  it("returns 400 for an unknown property type", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "Books" });

    const res = await fetch(`${baseUrl}/api/databases/${database.id}/properties`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "title", name: "Title", type: "bogus" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  it("returns 403 schema_locked when creating a property on a schema-locked database", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "Locked" });
    await pool.query(`UPDATE databases SET schema_locked = true WHERE id = $1`, [database.id]);

    const res = await fetch(`${baseUrl}/api/databases/${database.id}/properties`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "title", name: "Title", type: "text" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("schema_locked");
  });

  it("never returns 204 for a successful mutation", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const createRes = await fetch(`${baseUrl}/api/databases`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "NoContentCheck" }),
    });
    expect(createRes.status).not.toBe(204);
    const database = (await createRes.json()) as DatabaseBody;

    const patchRes = await fetch(`${baseUrl}/api/databases/${database.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(patchRes.status).not.toBe(204);

    const deleteRes = await fetch(`${baseUrl}/api/databases/${database.id}`, { method: "DELETE", headers });
    expect(deleteRes.status).not.toBe(204);
  });
});
