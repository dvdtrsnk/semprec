import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  login,
  seedSystem,
  type ChokePoint,
  type DatabaseRow,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry = await loadFullModuleRegistry();

async function authHeader(): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
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
