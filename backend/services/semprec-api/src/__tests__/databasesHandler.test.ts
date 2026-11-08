import type { CollectionMetadataResolver } from "@semprec/data";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { z } from "zod";
import { getTestPool, resetDatabase, tenantForNextTestUser } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  ForbiddenError,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  setInvalidationHook,
  type InvalidationEvent,
  type ChokePoint,
  type DatabaseRow,
  type PasswordResetMailer,
} from "@semprec/data";
import { createGenericApplicationService } from "@semprec/application";
import { createDispatcher } from "../app.js";
import { createDatabaseRoutes } from "../databasesHandler.js";

const testMetadataResolver: CollectionMetadataResolver = {
  resolve: () => ({ icon: null, color: null, overviewOrder: null, switcherOrder: null, clientVisible: true }),
};

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
    tenantId: await tenantForNextTestUser(pool),
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
  searchPlaceholder: string | null;
  key: string | null;
  ownerModuleId: string | null;
  system: boolean;
  archivedAt: string | null;
  icon: string | null;
  color: string | null;
  overviewOrder: number | null;
  switcherOrder: number | null;
  clientVisible: boolean;
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
  const system = databases.find((db) => db.system && db.key === "projects");
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

  it("returns Czech labels for Areas properties", async () => {
    const areas = (await chokePoint.listDatabases()).find((database) => database.key === "areas");
    if (!areas) throw new Error("expected Areas database from seedSystem");
    const response = await fetch(`${baseUrl}/api/databases/${areas.id}/properties`, {
      headers: await authHeader("cs"),
    });
    expect(response.status).toBe(200);
    const body = z
      .object({ properties: z.array(z.object({ key: z.string(), label: z.string() })) })
      .parse(await response.json());
    expect(
      ["icon", "color", "position"].map((key) => body.properties.find((property) => property.key === key)?.label),
    ).toEqual(["Ikona", "Barva", "Pořadí"]);
  });

  it("returns 400 validation_failed naming 'id' for a non-UUID database id", async () => {
    const headers = await authHeader();
    const res = await fetch(`${baseUrl}/api/databases/foo`, { headers });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details).toEqual({ field: "id" });
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

  it.each([
    [
      "cs",
      "projects",
      [
        { key: "area", label: "Oblast" },
        { key: "date", label: "Termín" },
      ],
    ],
    [
      "en",
      "projects",
      [
        { key: "area", label: "Area" },
        { key: "date", label: "Deadline" },
      ],
    ],
    [
      "cs",
      "areas",
      [
        { key: "company", label: "Firmy" },
        { key: "healthRecord", label: "Zdravotní záznamy" },
      ],
    ],
    [
      "en",
      "areas",
      [
        { key: "company", label: "Companies" },
        { key: "healthRecord", label: "Health records" },
      ],
    ],
    [
      "cs",
      "healthRecords",
      [
        { key: "subject", label: "Kdo" },
        { key: "files", label: "Přílohy" },
        {
          key: "status",
          options: expect.arrayContaining([expect.objectContaining({ key: "monitoring", label: "Sleduje se" })]),
        },
        {
          key: "type",
          options: expect.arrayContaining([expect.objectContaining({ key: "condition", label: "Stav" })]),
        },
        {
          key: "tags",
          options: expect.arrayContaining([
            expect.objectContaining({ key: "dentalHygiene", label: "Dentální hygiena" }),
          ]),
        },
      ],
    ],
    [
      "cs",
      "people",
      [
        {
          key: "relationship",
          options: expect.arrayContaining([expect.objectContaining({ key: "girlfriend", label: "Partnerka" })]),
        },
      ],
    ],
    [
      "cs",
      "events",
      [{ key: "type", options: expect.arrayContaining([expect.objectContaining({ key: "event", label: "Událost" })]) }],
    ],
    [
      "cs",
      "journal",
      [
        {
          key: "type",
          label: "Období",
          options: expect.arrayContaining([expect.objectContaining({ key: "quarter", label: "Kvartál" })]),
        },
      ],
    ],
  ])("returns updated %s labels for %s through the property endpoint", async (locale, key, expected) => {
    const database = (await chokePoint.listDatabases()).find((entry) => entry.key === key);
    if (!database) throw new Error(`Missing seeded database ${key}`);
    const response = await fetch(`${baseUrl}/api/databases/${database.id}/properties`, {
      headers: await authHeader(locale),
    });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      properties: expect.arrayContaining(expected.map((property) => expect.objectContaining(property))),
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

  async function listPage(query: string): Promise<{ databases: DatabaseBody[]; nextCursor: string | null }> {
    const res = await fetch(`${baseUrl}/api/databases${query}`, { headers: await authHeader() });
    expect(res.status).toBe(200);
    return (await res.json()) as { databases: DatabaseBody[]; nextCursor: string | null };
  }

  it("orders by switcher order, then overview-only order, then by name, and carries the descriptor metadata", async () => {
    await chokePoint.createDatabase({ name: "alpha custom" });
    const { databases } = await listPage("?limit=200");
    const keys = databases.map((db) => db.key);
    expect(keys.slice(0, 8)).toEqual([
      "projects",
      "tasks",
      "events",
      "journal",
      "people",
      "companies",
      "files",
      "healthRecords",
    ]);
    const overviewOnly = databases.filter((db) => db.switcherOrder === null && db.overviewOrder !== null);
    expect(overviewOnly.map((db) => db.overviewOrder)).toEqual([...overviewOnly.map((db) => db.overviewOrder)].sort());
    expect(keys.slice(8, 10)).toEqual(["books", "movies"]);
    const rest = databases.slice(8 + overviewOnly.length).map((db) => db.name.toLowerCase());
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));

    const byKey = new Map(databases.map((db) => [db.key, db]));
    expect(byKey.get("projects")).toMatchObject({
      icon: "folder",
      color: "#007AFF",
      overviewOrder: 1,
      switcherOrder: 1,
      clientVisible: true,
    });
    expect(byKey.get("tasks")).toMatchObject({ overviewOrder: null, switcherOrder: 2, clientVisible: true });
    expect(byKey.get("journal")).toMatchObject({ overviewOrder: null, switcherOrder: 4, clientVisible: true });
    expect(byKey.get("healthRecords")).toMatchObject({ overviewOrder: 6, switcherOrder: 8 });
    for (const [key, icon, color, overviewOrder] of [
      ["events", "calendar", "#FF3B30", 2],
      ["people", "person", "#5856D6", 3],
      ["companies", "building", "#5AC8FA", 4],
      ["files", "document", "#8E8E93", 5],
      ["healthRecords", "heart", "#FF2D55", 6],
    ] as const) {
      expect(byKey.get(key)).toMatchObject({ icon, color, overviewOrder });
    }
    for (const key of ["areas", "transcripts"]) {
      expect(byKey.get(key)).toMatchObject({ overviewOrder: null, switcherOrder: null, clientVisible: true });
    }
    expect(byKey.get("books")).toMatchObject({
      icon: "book-open",
      color: "#A2845E",
      overviewOrder: 7,
      switcherOrder: null,
      clientVisible: true,
    });
    expect(byKey.get("movies")).toMatchObject({
      icon: "film",
      color: "#FF6482",
      overviewOrder: 8,
      switcherOrder: null,
      clientVisible: true,
    });
    expect(byKey.get("emails")).toMatchObject({ overviewOrder: null, switcherOrder: null, clientVisible: true });
    for (const key of ["mailboxes", "folders"]) {
      expect(byKey.get(key)).toMatchObject({ clientVisible: false });
    }
    for (const ownerModuleId of ["inbox", "inboxItemTypes", "processingProposals", "mcpServers"]) {
      expect(databases.find((db) => db.ownerModuleId === ownerModuleId)).toMatchObject({ clientVisible: false });
    }
    for (const db of databases.filter(
      (d) =>
        d.system &&
        !["areas", "transcripts", "books", "movies", "emails"].includes(d.key ?? "") &&
        d.overviewOrder === null &&
        d.switcherOrder === null,
    )) {
      expect(db.clientVisible).toBe(false);
    }
    const custom = databases.find((db) => db.name === "alpha custom");
    expect(custom).toMatchObject({
      system: false,
      clientVisible: true,
      icon: "database",
      color: "#FF9500",
      overviewOrder: null,
      switcherOrder: null,
    });
  });

  it("resolves the search placeholder per locale, a generic sentence for user databases and null without an entry", async () => {
    await chokePoint.createDatabase({ name: "Custom placeholder" });
    const list = async (locale: string): Promise<DatabaseBody[]> => {
      const res = await fetch(`${baseUrl}/api/databases?limit=200`, { headers: await authHeader(locale) });
      expect(res.status).toBe(200);
      return ((await res.json()) as { databases: DatabaseBody[] }).databases;
    };
    const cs = await list("cs");
    const en = await list("en");
    const byKey = (databases: DatabaseBody[], key: string): DatabaseBody | undefined =>
      databases.find((db) => db.key === key);
    expect(byKey(cs, "people")?.searchPlaceholder).toBe("Hledat v Lidech");
    expect(byKey(cs, "movies")?.searchPlaceholder).toBe("Hledat ve filmech a seriálech");
    expect(byKey(en, "projects")?.searchPlaceholder).toBe("Search projects");
    expect(cs.find((db) => db.name === "Custom placeholder")?.searchPlaceholder).toBe("Hledat ve sbírce");
    expect(en.find((db) => db.name === "Custom placeholder")?.searchPlaceholder).toBe("Search collection");
    const internal = cs.filter((db) => db.system && !db.clientVisible);
    expect(internal.length).toBeGreaterThan(0);
    for (const db of internal) expect(db.searchPlaceholder, `database ${db.key}`).toBeNull();

    const detail = await fetch(`${baseUrl}/api/databases/${byKey(cs, "people")?.id}`, {
      headers: await authHeader("cs"),
    });
    expect(((await detail.json()) as DatabaseBody).searchPlaceholder).toBe("Hledat v Lidech");
  });

  it("keeps every search placeholder identical in the localized list and schema envelopes", async () => {
    const custom = await chokePoint.createDatabase({ name: "Placeholder comparison" });
    for (const locale of ["cs", "en"]) {
      const headers = await authHeader(locale);
      const listResponse = await fetch(`${baseUrl}/api/databases?limit=200`, { headers });
      const schemaResponse = await fetch(`${baseUrl}/api/schema`, { headers });
      expect(listResponse.status).toBe(200);
      expect(schemaResponse.status).toBe(200);
      const placeholder = z.string().nullable();
      const list = z
        .object({ databases: z.array(z.object({ id: z.string(), searchPlaceholder: placeholder })) })
        .parse(await listResponse.json());
      const schema = z
        .object({ databases: z.array(z.object({ databaseId: z.string(), searchPlaceholder: placeholder })) })
        .parse(await schemaResponse.json());
      expect(list.databases.some((database) => database.id === custom.id)).toBe(true);
      expect(list.databases.some((database) => database.searchPlaceholder === null)).toBe(true);
      expect(new Map(schema.databases.map((database) => [database.databaseId, database.searchPlaceholder]))).toEqual(
        new Map(list.databases.map((database) => [database.id, database.searchPlaceholder])),
      );
    }
  });

  it("projects the same five collection metadata fields in the list and schema endpoints", async () => {
    const headers = await authHeader("en");
    const metadata = z.object({
      icon: z.string().nullable(),
      color: z.string().nullable(),
      overviewOrder: z.number().nullable(),
      switcherOrder: z.number().nullable(),
      clientVisible: z.boolean(),
    });
    const listResponse = await fetch(`${baseUrl}/api/databases?limit=200`, { headers });
    const schemaResponse = await fetch(`${baseUrl}/api/schema`, { headers });
    expect(listResponse.status).toBe(200);
    expect(schemaResponse.status).toBe(200);
    const list = z.object({ databases: z.array(metadata.extend({ id: z.string() })) }).parse(await listResponse.json());
    const schema = z
      .object({ databases: z.array(metadata.extend({ databaseId: z.string() })) })
      .parse(await schemaResponse.json());
    const project = ({ icon, color, overviewOrder, switcherOrder, clientVisible }: z.infer<typeof metadata>) => ({
      icon,
      color,
      overviewOrder,
      switcherOrder,
      clientVisible,
    });
    expect(new Map(schema.databases.map((db) => [db.databaseId, project(db)]))).toEqual(
      new Map(list.databases.map((db) => [db.id, project(db)])),
    );
  });

  it("walks every database exactly once with limit=2 and resumes after the cursor row was archived", async () => {
    await chokePoint.createDatabase({ name: "Zeta custom" });
    const all = (await listPage("?limit=200")).databases.map((db) => db.id);
    expect(all.length).toBeGreaterThan(6);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listPage(`?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
      expect(page.databases.length).toBeLessThanOrEqual(2);
      seen.push(...page.databases.map((db) => db.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(seen).toEqual(all);

    const custom = await chokePoint.createDatabase({ name: "Gamma custom" });
    const first = await listPage("?limit=200");
    const idx = first.databases.findIndex((db) => db.id === custom.id);
    const cursorPage = await listPage(`?limit=${idx + 1}`);
    expect(cursorPage.nextCursor).not.toBeNull();
    await chokePoint.archiveDatabase(custom.id);
    const resumed = await listPage(`?limit=200&cursor=${encodeURIComponent(cursorPage.nextCursor!)}`);
    expect(resumed.databases.map((db) => db.id)).toEqual(first.databases.slice(idx + 1).map((db) => db.id));
  });

  it("rejects a malformed cursor and an out-of-range limit with 400 naming the field", async () => {
    const headers = await authHeader();
    for (const cursor of [
      "not-a-cursor",
      Buffer.from("[1,2]").toString("base64url"),
      Buffer.from('["a",null,"n","i"]').toString("base64url"),
    ]) {
      const res = await fetch(`${baseUrl}/api/databases?cursor=${cursor}`, { headers });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({ field: "cursor" });
    }
    for (const limit of ["0", "201", "x"]) {
      const res = await fetch(`${baseUrl}/api/databases?limit=${limit}`, { headers });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({ field: "limit" });
    }
  });

  it("registers exactly one property-catalog route handler", () => {
    expect(
      createDatabaseRoutes(createGenericApplicationService(pool, testMetadataResolver), moduleRegistry).filter(
        (route) => route.method === "GET" && route.path === "/api/databases/:id/properties",
      ),
    ).toHaveLength(1);
  });

  it("stores icon and color on create and serves the read-time defaults for a bare create", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const picked = await fetch(`${baseUrl}/api/databases`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Gift ideas", icon: "gift", color: "#34c759" }),
    });
    expect(picked.status).toBe(201);
    expect(await picked.json()).toMatchObject({ icon: "gift", color: "#34C759" });

    const bare = await fetch(`${baseUrl}/api/databases`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Bare" }),
    });
    const bareBody = (await bare.json()) as DatabaseBody;
    expect(bareBody).toMatchObject({ icon: "database", color: "#FF9500" });
    const { rows } = await pool.query("SELECT icon, color FROM databases WHERE id = $1", [bareBody.id]);
    expect(rows[0]).toEqual({ icon: null, color: null });
  });

  it("rejects empty and unknown database patches without changing the database", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const created = await fetch(`${baseUrl}/api/databases`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Gifts", color: "#34C759" }),
    });
    const db = (await created.json()) as DatabaseBody;
    const invalidations: InvalidationEvent[] = [];
    setInvalidationHook((event) => invalidations.push(event));
    try {
      for (const patch of [{}, { color: "#007AFF", colro: "red" }, { databaseId: db.id, color: "#007AFF" }]) {
        const response = await fetch(`${baseUrl}/api/databases/${db.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify(patch),
        });
        expect(response.status).toBe(400);
        if (Object.keys(patch).length === 0) {
          const body: unknown = await response.json();
          expect(body).toMatchObject({ error: { code: "validation_failed", details: { reason: "empty_patch" } } });
        }
      }
      expect(invalidations).toEqual([]);
    } finally {
      setInvalidationHook(() => {});
    }
    const response = await fetch(`${baseUrl}/api/databases/${db.id}`, { headers });
    expect(await response.json()).toMatchObject({ color: "#34C759" });
    const badCreate = await fetch(`${baseUrl}/api/databases`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Bad", colro: "red" }),
    });
    expect(badCreate.status).toBe(400);
  });

  describe("create with properties (issue #1592)", () => {
    const jsonHeaders = async (locale = "en") => ({
      ...(await authHeader(locale)),
      "Content-Type": "application/json",
    });
    const post = (headers: Record<string, string>, body: unknown) =>
      fetch(`${baseUrl}/api/databases`, { method: "POST", headers, body: JSON.stringify(body) });
    const footprint = async () => {
      const { rows } = await pool.query<{ databases: string; partitions: string; properties: string }>(
        `SELECT (SELECT count(*) FROM databases WHERE system = false) AS databases,
                (SELECT count(*) FROM pg_class WHERE relname LIKE 'items\\_p\\_%') AS partitions,
                (SELECT count(*) FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.system = false) AS properties`,
      );
      return rows[0];
    };
    const threeProperties = [
      { key: "recipient", name: "Recipient", type: "text" },
      { key: "when", name: "When", type: "date" },
      { key: "status", name: "Status", type: "select", config: { options: [{ key: "idea", label: "Idea" }] } },
    ];

    it("creates the database, a localized title property and the listed properties in order", async () => {
      const headers = await jsonHeaders("cs");
      const res = await post(headers, { name: "Gift ideas", properties: threeProperties });
      expect(res.status).toBe(201);
      const created = (await res.json()) as DatabaseBody;
      const listed = await fetch(`${baseUrl}/api/databases/${created.id}/properties`, { headers });
      const body = (await listed.json()) as PropertyCatalogBody;
      expect(body.properties.map((p) => [p.key, p.type])).toEqual([
        ["name", "title"],
        ["recipient", "text"],
        ["when", "date"],
        ["status", "select"],
      ]);
      expect(body.properties[0]?.label).toBe("Název");
      const item = await fetch(`${baseUrl}/api/databases/${created.id}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ properties: { name: "Book", recipient: "Anna" } }),
      });
      expect(item.status).toBe(201);
    });

    it("creates no title property without properties", async () => {
      const res = await post(await jsonHeaders(), { name: "Bare" });
      const created = (await res.json()) as DatabaseBody;
      expect(await chokePoint.listProperties(created.id)).toEqual([]);
    });

    it("creates and uses an initial relation whose existing target UUID is uppercase", async () => {
      const headers = await jsonHeaders();
      const target = await chokePoint.createDatabase({ name: "Uppercase target" });
      const targetItem = await chokePoint.createItem({ databaseId: target.id, properties: {} });
      const response = await post(headers, {
        name: "Source",
        properties: [
          {
            key: "link",
            name: "Link",
            type: "relation",
            targetDatabaseId: target.id.toUpperCase(),
            cardinality: "many_to_many",
          },
        ],
      });
      expect(response.status).toBe(201);
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
        throw new Error("invalid database response");
      }
      const properties = await chokePoint.listProperties(body.id);
      const relation = properties.find((property) => property.key === "link");
      expect(relation?.type).toBe("relation");
      const sourceItem = await chokePoint.createItem({ databaseId: body.id, properties: { name: "Source item" } });
      const linked = await fetch(`${baseUrl}/api/items/${sourceItem.id}/relations/link/${targetItem.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ metadata: {} }),
      });
      expect(linked.status).toBe(200);
      const listed = await fetch(`${baseUrl}/api/items/${sourceItem.id}/relations`, { headers });
      expect(listed.status).toBe(200);
      const result: unknown = await listed.json();
      expect(result).toMatchObject({
        relations: [
          {
            relationPropertyId: relation?.id,
            propertyKey: "link",
            targetItemId: targetItem.id,
            targetDatabaseId: target.id,
          },
        ],
      });
    });

    it.each([
      ["a bad select config", { key: "status", name: "Status", type: "select", config: { options: "nope" } }],
      ["a duplicate key", { key: "recipient", name: "Again", type: "text" }],
      [
        "a relation to a missing database",
        { key: "link", name: "Link", type: "relation", targetDatabaseId: randomUUID(), cardinality: "many_to_many" },
      ],
    ])("leaves nothing behind when the third property has %s", async (_label, third) => {
      const before = await footprint();
      const res = await post(await jsonHeaders(), {
        name: "Broken",
        properties: [
          { key: "recipient", name: "Recipient", type: "text" },
          { key: "when", name: "When", type: "date" },
          third,
        ],
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await footprint()).toEqual(before);
    });

    it("forbids a non-REST actor from sending properties, writes nothing, and still allows a bare create", async () => {
      const service = createGenericApplicationService(pool, testMetadataResolver);
      const agent = { userId: randomUUID(), runId: randomUUID(), agentProjectItemId: randomUUID() };
      const before = await footprint();
      await expect(
        service.createDatabase(agent, { name: "Agent", properties: [{ key: "a", name: "A", type: "text" }] }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await footprint()).toEqual(before);
      const bare = await service.createDatabase(agent, { name: "Agent bare" });
      expect(bare.name).toBe("Agent bare");
    });

    it("names the missing field of a relation entry and rejects forbidden types", async () => {
      const headers = await jsonHeaders();
      const noTarget = await post(headers, {
        name: "X",
        properties: [{ key: "link", name: "Link", type: "relation", cardinality: "one_to_one" }],
      });
      expect(noTarget.status).toBe(400);
      expect(JSON.stringify(await noTarget.json())).toContain("targetDatabaseId");
      const noCardinality = await post(headers, {
        name: "X",
        properties: [{ key: "link", name: "Link", type: "relation", targetDatabaseId: randomUUID() }],
      });
      expect(noCardinality.status).toBe(400);
      expect(JSON.stringify(await noCardinality.json())).toContain("cardinality");
      const before = await footprint();
      const malformed = await post(headers, {
        name: "Malformed",
        properties: [
          { key: "link", name: "Link", type: "relation", targetDatabaseId: "not-a-uuid", cardinality: "one_to_one" },
        ],
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({
        error: { code: "validation_failed", details: { field: "properties.0.targetDatabaseId" } },
      });
      expect(await footprint()).toEqual(before);
      for (const type of ["rollup", "title", "multi_select"]) {
        const res = await post(headers, { name: "X", properties: [{ key: "k", name: "K", type }] });
        expect(res.status).toBe(400);
      }
    });
  });

  it("patches only the color, resets the icon with null and rejects bad formats", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const created = (await (
      await fetch(`${baseUrl}/api/databases`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Gift ideas", icon: "gift", color: "#34C759" }),
      })
    ).json()) as DatabaseBody;
    const patch = (body: unknown) =>
      fetch(`${baseUrl}/api/databases/${created.id}`, { method: "PATCH", headers, body: JSON.stringify(body) });

    const recolored = await patch({ color: "#007AFF" });
    expect(recolored.status).toBe(200);
    expect(await recolored.json()).toMatchObject({ name: "Gift ideas", icon: "gift", color: "#007AFF" });

    const reset = await patch({ icon: null });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ icon: "database", color: "#007AFF" });

    for (const bad of [{ color: "red" }, { color: "#12345" }, { icon: "my icon" }, { icon: "Gift" }]) {
      const res = await patch(bad);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("validation_failed");
    }
    const create = await fetch(`${baseUrl}/api/databases`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "X", color: "red" }),
    });
    expect(create.status).toBe(400);
  });

  it("forbids icon and color changes on a system database but still renames it", async () => {
    const system = await findSystemDatabase();
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const patch = (body: unknown) =>
      fetch(`${baseUrl}/api/databases/${system.id}`, { method: "PATCH", headers, body: JSON.stringify(body) });

    const before = (await (await fetch(`${baseUrl}/api/databases/${system.id}`, { headers })).json()) as DatabaseBody;
    expect(before).toMatchObject({ icon: "folder", color: "#007AFF" });
    expect((await patch({ color: "#007AFF" })).status).toBe(403);
    expect((await patch({ icon: "gift" })).status).toBe(403);
    const renamed = await patch({ name: "Renamed system" });
    expect(renamed.status).toBe(200);
    const after = (await renamed.json()) as DatabaseBody;
    expect(after.name).toBe("Renamed system");
    expect(after.icon).toBe(before.icon);
    expect(after.color).toBe(before.color);
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
    const body = (await res.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details).toEqual({ field: "type" });
  });

  it("names targetDatabaseId when a relation property is created without it", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "Books" });

    const res = await fetch(`${baseUrl}/api/databases/${database.id}/properties`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "rel", name: "Rel", type: "relation", cardinality: "one_to_many", locked: false }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details).toEqual({ field: "targetDatabaseId" });
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
