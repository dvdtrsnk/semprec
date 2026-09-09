import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  login,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createSchemaRequestListener } from "../schemaHandler.js";

const PASSWORD = "s3cret-password";

let pool: Pool;
const moduleRegistry = await loadFullModuleRegistry();

async function authHeader(locale?: string): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
    ...(locale !== undefined ? { locale } : {}),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

interface SchemaProjectionBody {
  databases: { databaseId: string; key: string | null; name: string }[];
  viewTypes: { key: string; name: string }[];
  agentTools: { moduleId: string; name: string; label: string }[];
}

describe("createSchemaRequestListener (issue #147)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());

    server = createServer(createSchemaRequestListener(pool, moduleRegistry));
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

  it("rejects a request with no credentials", async () => {
    const res = await fetch(`${baseUrl}/api/schema`);
    expect(res.status).toBe(401);
  });

  it("rejects an unauthenticated non-GET request with 401, not 404", async () => {
    const res = await fetch(`${baseUrl}/api/schema`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects an authenticated non-GET request to the right path with 405", async () => {
    const res = await fetch(`${baseUrl}/api/schema`, { method: "POST", headers: await authHeader("en") });
    expect(res.status).toBe(405);
  });

  it("resolves the ten hardcoded system databases' names in cs, including ones with no project owner", async () => {
    const res = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader("cs") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SchemaProjectionBody;

    const tasks = body.databases.find((db) => db.key === "tasks");
    expect(tasks?.name).toBe("Úkoly");
    const journal = body.databases.find((db) => db.key === "journal");
    expect(journal?.name).toBe("Deník");
  });

  it("resolves the same databases' names in en for a different locale", async () => {
    const res = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader("en") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SchemaProjectionBody;

    const tasks = body.databases.find((db) => db.key === "tasks");
    expect(tasks?.name).toBe("Tasks");
  });

  it("falls back to en for an unrecognized locale", async () => {
    const res = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader("fr") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SchemaProjectionBody;

    const tasks = body.databases.find((db) => db.key === "tasks");
    expect(tasks?.name).toBe("Tasks");
  });

  it("lets a stored override win over the catalog in both locales", async () => {
    await withTransaction(pool, (client) =>
      client.query(`UPDATE databases SET name = $1 WHERE key = 'tasks'`, ["My Tasks"]),
    );

    for (const locale of ["cs", "en"]) {
      const res = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader(locale) });
      const body = (await res.json()) as SchemaProjectionBody;
      expect(body.databases.find((db) => db.key === "tasks")?.name).toBe("My Tasks");
    }
  });

  it("resolves the built-in view type names for the caller's locale", async () => {
    const res = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader("cs") });
    const body = (await res.json()) as SchemaProjectionBody;
    expect(body.viewTypes).toEqual(expect.arrayContaining([{ key: "table", name: "Tabulka" }]));
  });

  it("ignores a query-parameter locale override — locale comes only from users.locale", async () => {
    const res = await fetch(`${baseUrl}/api/schema?locale=cs`, { headers: await authHeader("en") });
    const body = (await res.json()) as SchemaProjectionBody;
    expect(body.databases.find((db) => db.key === "tasks")?.name).toBe("Tasks");
  });
});
