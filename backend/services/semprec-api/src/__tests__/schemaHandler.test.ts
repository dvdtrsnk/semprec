import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  runTenantCutoverMigrations,
  tenantForNextTestUser,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  getSystemSettingsDatabaseId,
  getSystemSettingsItemId,
  getDatabaseByModuleId,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  today,
  withTransaction,
} from "@semprec/data";
import { createSchemaRequestListener } from "../schemaHandler.js";
import { createDispatcher } from "../app.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { z } from "zod";

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

  it("serves localized Tasks schema on fresh and registered cutover tenants through runtime HTTP", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let serverRuntime: Server | undefined;
    const failures: unknown[] = [];
    try {
      const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      serverRuntime = createServer(createSchemaRequestListener(runtime, moduleRegistry));
      await new Promise<void>((resolve) => serverRuntime?.listen(0, "127.0.0.1", resolve));
      const address = serverRuntime.address();
      if (!address || typeof address === "string") throw new Error("Expected runtime server");
      const base = `http://127.0.0.1:${address.port}`;
      const tenants: { id: string; headers: { Authorization: string }; locale: string }[] = [];
      for (const locale of ["cs", "en"]) {
        const id = await createTestTenant(pool);
        const email = `${randomUUID()}@example.com`;
        await createUser(pool, { tenantId: id, email, passwordHash: await hashPassword(PASSWORD), locale });
        const { token } = await login(pool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
        await runInTenant(id, () => seedSystem(runtime, createViewTypeRegistry()));
        tenants.push({ id, headers: { Authorization: `Bearer ${token}` }, locale });
      }
      const responseSchema = z.object({
        databases: z.array(
          z.object({
            key: z.string().nullable(),
            properties: z.array(z.object({ key: z.string(), name: z.string() })),
          }),
        ),
      });
      const read = async (headers: { Authorization: string }) => {
        const response = await fetch(`${base}/api/schema`, { headers });
        expect(response.status).toBe(200);
        return responseSchema.parse(await response.json());
      };
      const keys = [
        "flagged",
        "description",
        "since",
        "sinceTime",
        "completedOn",
        "completedAt",
        "hiddenUntil",
        "effectiveDate",
        "seriesId",
        "occurrenceDate",
        "recurrence",
        "people",
        "files",
        "hostEvents",
        "completedInEvent",
      ];
      const fresh = new Map<string, ReturnType<typeof responseSchema.parse>>();
      for (const tenant of tenants) {
        const schema = await read(tenant.headers);
        fresh.set(tenant.id, schema);
        const tasks = schema.databases.find((db) => db.key === "tasks");
        for (const key of keys) {
          const name = tasks?.properties.find((property) => property.key === key)?.name;
          expect(name).toBeTruthy();
          expect(name).not.toBe(key);
        }
        for (const [module, propertyKeys] of [
          ["people", ["tasks"]],
          ["files", ["tasks"]],
          ["events", ["hostedTasks", "completedTasks"]],
        ] as const) {
          const database = schema.databases.find((candidate) => candidate.key === module);
          for (const key of propertyKeys) {
            const name = database?.properties.find((property) => property.key === key)?.name;
            expect(name).toBeTruthy();
            expect(name).not.toBe(key);
          }
        }
        expect(tasks?.properties.find((property) => property.key === "sourceEvents")?.name).toBe(
          tenant.locale === "cs" ? "Zdrojové události" : "Source events",
        );
        expect(
          schema.databases.find((db) => db.key === "journal")?.properties.find((property) => property.key === "project")
            ?.name,
        ).toBe(tenant.locale === "cs" ? "Projekt" : "Project");
        expect(tasks?.properties.find((property) => property.key === "flagged")?.name).toBe(
          tenant.locale === "cs" ? "Označeno" : "Flagged",
        );
        await runInTenant(tenant.id, async () => {
          // Synthetic historical catalog: locked built-in properties have no public removal path.
          const removed = await runtime.query(
            `DELETE FROM properties p USING databases d WHERE p.database_id = d.id AND ((d.owner_module_id = 'tasks' AND p.key = ANY($1::text[])) OR (d.owner_module_id = ANY($2::text[]) AND p.key = ANY($3::text[])))`,
            [keys, ["people", "files", "events"], ["tasks", "hostedTasks", "completedTasks"]],
          );
          expect(removed.rowCount).toBe(19);
          const inverse = await runtime.query<{ id: string }>(
            "SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.owner_module_id = 'tasks' AND p.key = 'sourceEvents'",
          );
          if (!inverse.rows[0]) throw new Error("Missing sourceEvents");
          expect(
            (
              await runtime.query("UPDATE relation_definitions SET property_id_b = NULL WHERE property_id_b = $1", [
                inverse.rows[0].id,
              ])
            ).rowCount,
          ).toBe(1);
          expect((await runtime.query("DELETE FROM properties WHERE id = $1", [inverse.rows[0].id])).rowCount).toBe(1);
          expect(
            (
              await runtime.query(
                "DELETE FROM properties p USING databases d WHERE p.database_id = d.id AND d.owner_module_id = 'journal' AND p.key = 'project'",
              )
            ).rowCount,
          ).toBe(1);
        });
      }
      await runAsSystem("test:tasks-schema-cutover", () => runTenantCutoverMigrations(runtime));
      for (const tenant of tenants) {
        const after = await read(tenant.headers);
        for (const module of ["tasks", "people", "files", "events", "journal"]) {
          const projectNames = (value: typeof after) =>
            value.databases
              .find((db) => db.key === module)
              ?.properties.map(({ key, name }) => ({ key, name }))
              .sort((a, b) => a.key.localeCompare(b.key));
          const before = fresh.get(tenant.id);
          if (!before) throw new Error("Missing fresh schema");
          expect(projectNames(after)).toEqual(projectNames(before));
        }
      }
    } catch (error) {
      failures.push(error);
    }
    if (serverRuntime)
      try {
        await new Promise<void>((resolve, reject) =>
          serverRuntime?.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        failures.push(error);
      }
    try {
      await runtime.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Schema HTTP test and settlement failed");
  });

  it("does not expose a kept project deadline in the schema", async () => {
    const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
    if (!database) throw new Error("Projects missing");
    const cp = createChokePoint(pool);
    const item = await cp.createItem({
      databaseId: database.id,
      properties: { name: "Project", status: "inProgress", date: "2042-11-30" },
    });
    await cp.updateItem({ databaseId: database.id, itemId: item.id, propertiesPatch: { status: "longTerm" } });
    const response = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader() });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(JSON.stringify(body)).not.toContain("2042-11-30");
    expect(JSON.stringify(body)).not.toContain("project_kept_dates");
  });

  it("returns custom option colors and omits invalid legacy colors", async () => {
    const cp = createChokePoint(pool);
    const database = await cp.createDatabase({ name: "Custom colors" });
    const valid = await cp.createProperty({
      databaseId: database.id,
      key: "validColor",
      name: "Valid",
      type: "select",
      config: { options: [{ key: "one", color: "#ff3b30" }] },
    });
    const legacy = await cp.createProperty({
      databaseId: database.id,
      key: "legacyColor",
      name: "Legacy",
      type: "select",
      config: { options: [{ key: "one" }] },
    });
    // The production property API refuses this synthetic legacy shape.
    const changed = await pool.query("UPDATE properties SET config = $2::jsonb WHERE id = $1", [
      legacy.id,
      JSON.stringify({ options: [{ key: "one", color: "red" }] }),
    ]);
    expect(changed.rowCount).toBe(1);
    const response = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader("en") });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const projection = z
      .object({
        databases: z.array(
          z.object({
            databaseId: z.string(),
            properties: z.array(
              z.object({
                id: z.string(),
                options: z.array(z.object({ key: z.string(), color: z.string().optional() }).passthrough()).optional(),
              }),
            ),
          }),
        ),
      })
      .parse(body);
    const properties = projection.databases.find((entry) => entry.databaseId === database.id)?.properties;
    expect(properties?.find((entry) => entry.id === valid.id)?.options).toEqual([
      expect.objectContaining({ key: "one", color: "#FF3B30" }),
    ]);
    const legacyOptions = properties?.find((entry) => entry.id === legacy.id)?.options;
    expect(legacyOptions).toHaveLength(1);
    expect(legacyOptions?.[0]).toMatchObject({ key: "one" });
    expect(legacyOptions?.[0]).not.toHaveProperty("color");
  });

  it("returns the Czech Projects completion property through the properties route", async () => {
    const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
    if (!database) throw new Error("Projects missing");
    const server = createServer(
      await createDispatcher(pool, {
        moduleRegistry,
        passwordResetMailer: { async sendPasswordResetEmail() {} },
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-schema-${randomUUID()}`)),
        maxFileSizeBytes: 1048576,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/databases/${database.id}/properties`, {
        headers: await authHeader("cs"),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        properties: expect.arrayContaining([expect.objectContaining({ key: "completedAt", label: "Dokončeno" })]),
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
              options: expect.arrayContaining([
                expect.objectContaining({ key: "inProgress", color: "#007AFF" }),
                expect.objectContaining({ key: "longTerm", color: "#AF52DE" }),
                expect.objectContaining({ key: "done", color: "#34C759" }),
                expect.objectContaining({ key: "archived", color: "#8E8E93" }),
              ]),
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

  it.each([
    ["cs", "Stav", "Probíhá"],
    ["en", "Status", "In progress"],
  ])("localizes Projects status and its options for %s", async (locale, name, label) => {
    const response = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader(locale) });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      databases: expect.arrayContaining([
        expect.objectContaining({
          key: "projects",
          properties: expect.arrayContaining([
            expect.objectContaining({
              key: "status",
              name,
              options: expect.arrayContaining([expect.objectContaining({ key: "inProgress", label })]),
            }),
          ]),
        }),
      ]),
    });
  });

  it.each([
    ["cs", "Oblast", "Termín"],
    ["en", "Area", "Deadline"],
  ])("returns the updated project labels through schema for %s", async (locale, area, date) => {
    const response = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader(locale) });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      databases: expect.arrayContaining([
        expect.objectContaining({
          key: "projects",
          properties: expect.arrayContaining([
            expect.objectContaining({ key: "area", name: area }),
            expect.objectContaining({ key: "date", name: date }),
          ]),
        }),
      ]),
    });
  });

  it("returns the updated Czech property and option labels through schema", async () => {
    const response = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader("cs") });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const property = (key: string, name: string) => expect.objectContaining({ key, name });
    const option = (key: string, optionKey: string, label: string) =>
      expect.objectContaining({
        key,
        options: expect.arrayContaining([expect.objectContaining({ key: optionKey, label })]),
      });
    expect(body).toMatchObject({
      databases: expect.arrayContaining([
        expect.objectContaining({
          key: "areas",
          properties: expect.arrayContaining([
            property("company", "Firmy"),
            property("healthRecord", "Zdravotní záznamy"),
          ]),
        }),
        expect.objectContaining({
          key: "people",
          properties: expect.arrayContaining([option("relationship", "girlfriend", "Partnerka")]),
        }),
        expect.objectContaining({
          key: "healthRecords",
          properties: expect.arrayContaining([
            property("subject", "Kdo"),
            property("files", "Přílohy"),
            option("status", "monitoring", "Sleduje se"),
            option("type", "condition", "Stav"),
            option("tags", "dentalHygiene", "Dentální hygiena"),
          ]),
        }),
        expect.objectContaining({
          key: "events",
          properties: expect.arrayContaining([option("type", "event", "Událost")]),
        }),
        expect.objectContaining({
          key: "journal",
          properties: expect.arrayContaining([property("type", "Období"), option("type", "quarter", "Kvartál")]),
        }),
      ]),
    });
  });

  it("returns the tenant zone and its current day, and reflects a zone change on the next request", async () => {
    const headers = await authHeader("en");
    const fetchProjection = async () => {
      const res = await fetch(`${baseUrl}/api/schema`, { headers });
      expect(res.status).toBe(200);
      const value: unknown = await res.json();
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("Expected schema object");
      if (
        !("tenant" in value) ||
        typeof value.tenant !== "object" ||
        value.tenant === null ||
        Array.isArray(value.tenant)
      ) {
        throw new Error("Expected tenant object");
      }
      const tenant = value.tenant;
      if (
        !("timezone" in tenant) ||
        typeof tenant.timezone !== "string" ||
        !("today" in tenant) ||
        typeof tenant.today !== "string"
      ) {
        throw new Error("Expected tenant timezone and today");
      }
      const { tenant: _tenant, ...rest } = value;
      return { tenant: { timezone: tenant.timezone, today: tenant.today }, rest };
    };

    const before = new Date();
    const original = await fetchProjection();
    const prague = original.tenant;
    const after = new Date();
    expect(prague.timezone).toBe("Europe/Prague");
    expect([today("Europe/Prague", before), today("Europe/Prague", after)]).toContain(prague.today);

    const settings = await withTransaction(pool, async (client) => ({
      databaseId: await getSystemSettingsDatabaseId(client),
      itemId: await getSystemSettingsItemId(client),
    }));
    await createChokePoint(pool).updateItem({ ...settings, propertiesPatch: { timezone: "Pacific/Kiritimati" } });
    const changedBefore = new Date();
    const next = await fetchProjection();
    const changed = next.tenant;
    const changedAfter = new Date();
    expect(changed.timezone).toBe("Pacific/Kiritimati");
    expect([today("Pacific/Kiritimati", changedBefore), today("Pacific/Kiritimati", changedAfter)]).toContain(
      changed.today,
    );
    expect(next.rest).toEqual(original.rest);
  });

  it("loads the calendar module with its calendars database and no agent tool (issue #1600)", async () => {
    expect(moduleRegistry.listModuleIds()).toContain("calendar");
    expect(await moduleRegistry.listActiveModuleIds()).toContain("calendar");

    const res = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader("en") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SchemaProjectionBody;
    expect(body.databases.filter((db) => db.key?.startsWith("calendar")).map((db) => [db.key, db.name])).toEqual([
      ["calendars", "Calendars"],
    ]);
    expect(body.agentTools.filter((tool) => tool.moduleId === "calendar")).toEqual([]);
  });

  it("publishes areaFilter for the seven area-filterable databases and omits it for the others (issue #1597)", async () => {
    const res = await fetch(`${baseUrl}/api/schema`, { headers: await authHeader("en") });
    expect(res.status).toBe(200);
    const body = z
      .object({ databases: z.array(z.object({ key: z.string().nullable() }).passthrough()) })
      .parse(await res.json());
    const filtered = body.databases.filter((db) => Object.hasOwn(db, "areaFilter"));
    expect(filtered.map((db) => db.key).sort()).toEqual([
      "companies",
      "events",
      "files",
      "healthRecords",
      "journal",
      "projects",
      "tasks",
    ]);
    const declared = new Map((await moduleRegistry.getDatabases()).map((db) => [db.key, db.areaFilter]));
    for (const db of filtered) expect(db.areaFilter, db.key ?? "").toEqual(declared.get(db.key ?? ""));
    expect(filtered.find((db) => db.key === "tasks")?.areaFilter).toEqual({
      type: "relation_path_contains",
      path: ["project", "area"],
      value: { areaValue: true },
    });
    expect(filtered.find((db) => db.key === "events")?.areaFilter).toEqual({
      type: "or",
      nodes: [
        { type: "relation_path_contains", path: ["project", "area"], value: { areaValue: true } },
        {
          type: "and",
          nodes: [
            { type: "relation_is_empty", property: "project" },
            { type: "relation_contains", property: "area", value: { areaValue: true } },
          ],
        },
      ],
    });
    // Every other database, system or not, carries no areaFilter key at all.
    expect(body.databases.length).toBeGreaterThan(filtered.length);
    for (const db of body.databases.filter((candidate) => !filtered.includes(candidate))) {
      expect(Object.hasOwn(db, "areaFilter"), db.key ?? "").toBe(false);
    }
  });

  it("fails with a bare 500 and publishes no template when a declared property is missing from the tenant's schema (issue #1597)", async () => {
    const headers = await authHeader("en");
    // Raw SQL: no API renames a locked system property. This is the drifted tenant schema (a manifest
    // declaring a property the tenant does not have) that the compile check before publishing exists for.
    const renamed = await pool.query(
      `UPDATE properties SET key = 'formerArea'
        WHERE key = 'area' AND database_id = (SELECT id FROM databases WHERE owner_module_id = 'companies' AND system)`,
    );
    expect(renamed.rowCount).toBe(1);

    const res = await fetch(`${baseUrl}/api/schema`, { headers });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
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
    expect(body.databases.find((db) => db.key === "emails")).toMatchObject({
      icon: "envelope",
      color: "#007AFF",
      overviewOrder: null,
      switcherOrder: null,
      clientVisible: true,
    });
    for (const key of ["mailboxes", "folders"]) {
      expect(body.databases.find((db) => db.key === key)).toMatchObject({ clientVisible: false });
    }
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
