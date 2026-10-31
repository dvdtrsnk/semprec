import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase, tenantForNextTestUser } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  login,
  seedSystem,
  today,
  withTransaction,
} from "@semprec/data";
import { createSchemaRequestListener } from "../schemaHandler.js";

const PASSWORD = "s3cret-password";

let pool: Pool;
const moduleRegistry = await loadFullModuleRegistry();

async function authHeader(locale?: string): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
    ...(locale !== undefined ? { locale } : {}),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

interface SchemaProjectionBody {
  databases: {
    databaseId: string;
    key: string | null;
    name: string;
    searchPlaceholder: string | null;
    icon: string | null;
    color: string | null;
    overviewOrder: number | null;
    switcherOrder: number | null;
    clientVisible: boolean;
  }[];
  tenant: { timezone: string; today: string };
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

  it("projects stored defaults including the unresolved today token", async () => {
    const res = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader("en") });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({
      databases: expect.arrayContaining([
        expect.objectContaining({
          key: "projects",
          properties: expect.arrayContaining([
            expect.objectContaining({
              key: "status",
              type: "select",
              filterable: true,
              id: expect.stringMatching(/.+/),
              config: { default: "inProgress" },
              options: expect.any(Array),
            }),
          ]),
        }),
        expect.objectContaining({
          key: "files",
          properties: expect.arrayContaining([
            expect.objectContaining({ key: "date", config: { includeTime: false, default: "today" } }),
          ]),
        }),
      ]),
    });
  });

  it("returns the tenant zone and its current day, and reflects a zone change on the next request", async () => {
    const headers = await authHeader("en");
    const fetchTenant = async () => {
      const res = await fetch(`${baseUrl}/api/schema`, { headers });
      expect(res.status).toBe(200);
      return ((await res.json()) as SchemaProjectionBody).tenant;
    };

    const before = new Date();
    const prague = await fetchTenant();
    const after = new Date();
    expect(prague.timezone).toBe("Europe/Prague");
    expect([today("Europe/Prague", before), today("Europe/Prague", after)]).toContain(prague.today);

    await pool.query(
      `UPDATE items SET properties = jsonb_set(properties, '{timezone}', '"Pacific/Kiritimati"')
       WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'systemSettings' AND system = true)`,
    );
    const changedBefore = new Date();
    const changed = await fetchTenant();
    const changedAfter = new Date();
    expect(changed.timezone).toBe("Pacific/Kiritimati");
    expect([today("Pacific/Kiritimati", changedBefore), today("Pacific/Kiritimati", changedAfter)]).toContain(
      changed.today,
    );
  });

  it("loads the empty calendar module and lists no database for it", async () => {
    expect(moduleRegistry.listModuleIds()).toContain("calendar");
    expect(await moduleRegistry.listActiveModuleIds()).toContain("calendar");

    const res = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader("en") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SchemaProjectionBody;
    expect(body.databases.filter((db) => db.key?.startsWith("calendar"))).toEqual([]);
    expect(body.agentTools.filter((tool) => tool.moduleId === "calendar")).toEqual([]);
  });

  it("rejects a request with no credentials", async () => {
    const res = await fetch(`${baseUrl}/api/schema`);
    expect(res.status).toBe(401);
  });

  it("rejects an unauthenticated non-GET request with 401, not 404", async () => {
    const res = await fetch(`${baseUrl}/api/schema`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects an authenticated non-GET request to the right path with 405 and an Allow header (RFC 7231 §6.5.5)", async () => {
    const res = await fetch(`${baseUrl}/api/schema`, { method: "POST", headers: await authHeader("en") });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
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

  it("carries the collection metadata fields on every database", async () => {
    const custom = await createChokePoint(pool).createDatabase({ name: "Custom" });
    const res = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader("en") });
    const body = (await res.json()) as SchemaProjectionBody;

    expect(body.databases.find((db) => db.key === "projects")).toMatchObject({
      icon: "folder",
      color: "#007AFF",
      overviewOrder: 1,
      switcherOrder: 1,
      clientVisible: true,
    });
    expect(body.databases.find((db) => db.key === "tasks")).toMatchObject({ overviewOrder: null, switcherOrder: 2 });
    expect(body.databases.find((db) => db.key === "areas")).toMatchObject({
      icon: "compass",
      overviewOrder: null,
      switcherOrder: null,
      clientVisible: true,
    });
    expect(body.databases.find((db) => db.databaseId === custom.id)).toMatchObject({
      icon: "database",
      color: "#FF9500",
      overviewOrder: null,
      switcherOrder: null,
      clientVisible: true,
    });
  });

  it("carries the same search placeholders as the database envelope", async () => {
    const custom = await createChokePoint(pool).createDatabase({ name: "Custom" });
    const get = async (locale: string): Promise<SchemaProjectionBody["databases"]> => {
      const res = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader(locale) });
      return ((await res.json()) as SchemaProjectionBody).databases;
    };
    const cs = await get("cs");
    const en = await get("en");
    expect(cs.find((db) => db.key === "people")?.searchPlaceholder).toBe("Hledat v Lidech");
    expect(en.find((db) => db.key === "projects")?.searchPlaceholder).toBe("Search projects");
    expect(cs.find((db) => db.databaseId === custom.id)?.searchPlaceholder).toBe("Hledat ve sbírce");
    expect(en.find((db) => db.databaseId === custom.id)?.searchPlaceholder).toBe("Search collection");
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
    expect(body.viewTypes).toEqual(expect.arrayContaining([{ key: "gallery", name: "Galerie" }]));
  });

  it("lists the gallery view type as Gallery for a non-Czech user", async () => {
    const res = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader("en") });
    const body = (await res.json()) as SchemaProjectionBody;
    expect(body.viewTypes).toEqual(expect.arrayContaining([{ key: "gallery", name: "Gallery" }]));
  });

  it("ignores a query-parameter locale override — locale comes only from users.locale", async () => {
    const res = await fetch(`${baseUrl}/api/schema?locale=cs`, { headers: await authHeader("en") });
    const body = (await res.json()) as SchemaProjectionBody;
    expect(body.databases.find((db) => db.key === "tasks")?.name).toBe("Tasks");
  });
});
