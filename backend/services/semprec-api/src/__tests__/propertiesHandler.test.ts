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
  getDatabaseByModuleId,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  withTransaction,
  type ChokePoint,
  type PasswordResetMailer,
  type PropertyRow,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry = await loadFullModuleRegistry();

async function authHeader(): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

/**
 * `graphile_worker.jobs` (000017's view) no longer projects `payload` — this reads the
 * underlying `_private_jobs` table it's built on, joined to `_private_tasks` for the identifier.
 */
async function countPropertyTypeMigrationJobs(propertyId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
     WHERE tasks.identifier = 'propertyTypeMigration' AND jobs.payload->'payload'->>'propertyId' = $1`,
    [propertyId],
  );
  return Number(rows[0]!.count);
}

interface PropertyBody {
  id: string;
  key: string;
  name: string;
  type: string;
  locked: boolean;
  migrationStatus: string;
}

describe("property routes (issue #240)", () => {
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
    const res = await fetch(`${baseUrl}/api/properties/${randomUUID()}`, { method: "PATCH" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown property id", async () => {
    const headers = await authHeader();
    const res = await fetch(`${baseUrl}/api/properties/${randomUUID()}`, { method: "PATCH", headers });
    expect(res.status).toBe(404);
  });

  it("returns 400 validation_failed naming 'id' for a non-UUID property id", async () => {
    const headers = await authHeader();
    const res = await fetch(`${baseUrl}/api/properties/foo`, { headers });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details).toEqual({ field: "id" });
  });

  it("renames a property (200, not 204)", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "New Title" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PropertyBody;
    expect(body.name).toBe("New Title");
  });

  it("changing type returns 200 (property.patch's canonical output has no typeChanged status) and enqueues exactly one migration_status job", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "D" });
    const property: PropertyRow = await chokePoint.createProperty({
      databaseId: database.id,
      key: "score",
      name: "Score",
      type: "text",
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ type: "number" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PropertyBody;
    expect(body.type).toBe("number");
    expect(body.migrationStatus).toBe("pending");

    expect(await countPropertyTypeMigrationJobs(property.id)).toBe(1);
  });

  it("returns 200, not 202, when no type change is requested", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ type: "text" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 400 for an unknown property type", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ type: "bogus" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { field?: string } } };
    expect(body.error.details?.field).toBe("patch.type");
  });

  it("returns 403 property_locked when changing the type of a locked property", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });
    await pool.query(`UPDATE properties SET locked = true WHERE id = $1`, [property.id]);

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ type: "number" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("property_locked");
  });

  it("returns 403 schema_locked when changing the config of a property in a schema-locked database", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });
    await pool.query(`UPDATE databases SET schema_locked = true WHERE id = $1`, [database.id]);

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ config: { note: "x" } }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("schema_locked");
  });

  it("deletes a property (200 with its prior representation, not 204)", async () => {
    const headers = await authHeader();
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, { method: "DELETE", headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PropertyBody;
    expect(body.id).toBe(property.id);

    expect(await chokePoint.getProperty(property.id)).toBeNull();
  });

  it("returns 403 property_locked when deleting a locked property", async () => {
    const headers = await authHeader();
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
      locked: true,
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, { method: "DELETE", headers });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("property_locked");
  });

  it("returns 403 schema_locked when deleting a property in a schema-locked database", async () => {
    const headers = await authHeader();
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });
    await pool.query(`UPDATE databases SET schema_locked = true WHERE id = $1`, [database.id]);

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, { method: "DELETE", headers });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("schema_locked");
  });

  it("returns 400 validation_failed empty_patch for an empty patch body (issue #219)", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details?.reason).toBe("empty_patch");
  });

  it("rejects patch.type on a relation property with 400 validation_failed relation_definition_required (issue #219)", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const source = await chokePoint.createDatabase({ name: "Source" });
    const target = await chokePoint.createDatabase({ name: "Target" });
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: source.id,
      key: "assignedTo",
      name: "Assigned To",
      targetDatabaseId: target.id,
      cardinality: "one_to_many",
      owner: "user",
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ type: "text" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { field?: string; reason?: string } } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details?.field).toBe("type");
    expect(body.error.details?.reason).toBe("relation_definition_required");
  });

  it("rejects patch.config on a relation property with 400 validation_failed relation_definition_required (issue #219)", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const source = await chokePoint.createDatabase({ name: "Source" });
    const target = await chokePoint.createDatabase({ name: "Target" });
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: source.id,
      key: "assignedTo",
      name: "Assigned To",
      targetDatabaseId: target.id,
      cardinality: "one_to_many",
      owner: "user",
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ config: { note: "x" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { field?: string; reason?: string } } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details?.field).toBe("config");
    expect(body.error.details?.reason).toBe("relation_definition_required");
  });

  it("still allows renaming a relation property (issue #219)", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const source = await chokePoint.createDatabase({ name: "Source" });
    const target = await chokePoint.createDatabase({ name: "Target" });
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: source.id,
      key: "assignedTo",
      name: "Assigned To",
      targetDatabaseId: target.id,
      cardinality: "one_to_many",
      owner: "user",
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Owner" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PropertyBody;
    expect(body.name).toBe("Owner");
  });

  it("GET /api/properties/:id returns the raw property row, including config (issue #219)", async () => {
    const headers = await authHeader();
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
      config: { note: "raw" },
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; key: string; config: Record<string, unknown> };
    expect(body.id).toBe(property.id);
    expect(body.key).toBe("title");
    expect(body.config).toEqual({ note: "raw" });
  });

  it("GET /api/properties?databaseId= returns the raw Property[] rows, including config (issue #219)", async () => {
    const headers = await authHeader();
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
      config: { note: "raw" },
    });

    const res = await fetch(`${baseUrl}/api/properties?databaseId=${database.id}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { properties: { id: string; config: Record<string, unknown> }[] };
    const found = body.properties.find((p) => p.id === property.id);
    expect(found).toBeDefined();
    expect(found?.config).toEqual({ note: "raw" });
  });

  it("GET /api/properties requires a databaseId query parameter", async () => {
    const headers = await authHeader();
    const res = await fetch(`${baseUrl}/api/properties`, { headers });
    expect(res.status).toBe(400);
  });

  it("returns 409 version_conflict naming 'key' when creating a property with a duplicate key (issue #672)", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "D" });
    await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "text" });

    const res = await fetch(`${baseUrl}/api/databases/${database.id}/properties`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "title", name: "Other Title", type: "text" }),
    });
    expect(res.status).toBe(409);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ error: { code: "version_conflict", details: { field: "key" } } });
  });

  describe("select options on a schema-locked database (issue #1699)", () => {
    const SEEDED_TAG_KEYS = ["bloodTests", "medication", "epilepsy", "dentalHygiene", "bloodPressure", "prevention"];
    const optionShape = z.strictObject({ key: z.string(), label: z.string(), color: z.string().optional() });
    const schemaShape = z.object({
      databases: z.array(
        z.object({
          key: z.string().nullable(),
          properties: z.array(z.object({ key: z.string(), options: z.array(optionShape).optional() })),
        }),
      ),
    });

    /** A session of tenant zero's user, whose tenant `seedSystem` gave the system databases. */
    async function sessionHeaders(locale: "cs" | "en" = "en"): Promise<Record<string, string>> {
      const user = await createUser(pool, {
        tenantId: await tenantForNextTestUser(pool),
        email: `${randomUUID()}@example.com`,
        passwordHash: await hashPassword(PASSWORD),
        locale,
      });
      const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
      return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    }

    async function healthProperty(key: "tags" | "subject"): Promise<PropertyRow> {
      const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "healthRecords"));
      if (!database) throw new Error("Health records database was not seeded");
      expect(database.schemaLocked).toBe(true);
      const property = await chokePoint.getPropertyByKey(database.id, key);
      if (!property) throw new Error(`Health records '${key}' property was not seeded`);
      return property;
    }

    /** The Health records `tags` options as `GET /api/schema` shows them to the caller. */
    async function schemaTags(headers: Record<string, string>): Promise<z.infer<typeof optionShape>[]> {
      const res = await fetch(`${baseUrl}/api/schema`, { headers });
      expect(res.status).toBe(200);
      const schema = schemaShape.parse(await res.json());
      const tags = schema.databases
        .find((database) => database.key === "healthRecords")
        ?.properties.find((property) => property.key === "tags");
      if (!tags?.options) throw new Error("The schema lists no Health records tags options");
      return tags.options;
    }

    function send(path: string, method: "POST" | "PATCH", headers: Record<string, string>, body: unknown) {
      return fetch(`${baseUrl}${path}`, { method, headers, body: JSON.stringify(body) });
    }

    it("adds 'Bylinky' to the Health records tags with 201 and key bylinky, and the schema lists the option", async () => {
      const headers = await sessionHeaders();
      const tags = await healthProperty("tags");
      expect((await schemaTags(headers)).map((option) => option.key)).toEqual(SEEDED_TAG_KEYS);

      const res = await send(`/api/properties/${tags.id}/options`, "POST", headers, { label: "Bylinky" });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ key: "bylinky", label: "Bylinky" });
      const listed = await schemaTags(headers);
      expect(listed.map((option) => option.key)).toEqual([...SEEDED_TAG_KEYS, "bylinky"]);
      expect(listed.at(-1)).toEqual({ key: "bylinky", label: "Bylinky" });
    });

    it("refuses 'léky' with 409 option_label_exists carrying medication, and the schema stays as it was", async () => {
      const headers = await sessionHeaders();
      const tags = await healthProperty("tags");
      const before = await schemaTags(headers);

      const res = await send(`/api/properties/${tags.id}/options`, "POST", headers, { label: "léky" });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: { code: "option_label_exists", details: { key: "medication" } } });
      expect(await schemaTags(headers)).toEqual(before);
    });

    it("gives a second label that yields the key bylinky a suffixed key, and stores a color in upper case", async () => {
      const headers = await sessionHeaders();
      const tags = await healthProperty("tags");
      const first = await send(`/api/properties/${tags.id}/options`, "POST", headers, { label: "Bylinky" });
      expect(first.status).toBe(201);

      const second = await send(`/api/properties/${tags.id}/options`, "POST", headers, {
        label: "Bylinky!",
        color: "#34c759",
      });

      expect(second.status).toBe(201);
      expect(await second.json()).toEqual({ key: "bylinky2", label: "Bylinky!", color: "#34C759" });
      expect((await schemaTags(headers)).slice(-2)).toEqual([
        { key: "bylinky", label: "Bylinky" },
        { key: "bylinky2", label: "Bylinky!", color: "#34C759" },
      ]);
    });

    it("answers 400 validation_failed naming propertyId for a property that is not a select or multi_select", async () => {
      const headers = await sessionHeaders();
      const subject = await healthProperty("subject");
      expect(subject.type).toBe("text");
      const refusal = { error: { code: "validation_failed", details: { field: "propertyId" } } };

      const added = await send(`/api/properties/${subject.id}/options`, "POST", headers, { label: "Bylinky" });
      const updated = await send(`/api/properties/${subject.id}/options/bylinky`, "PATCH", headers, { label: "Herbs" });

      expect(added.status).toBe(400);
      expect(await added.json()).toEqual(refusal);
      expect(updated.status).toBe(400);
      expect(await updated.json()).toEqual(refusal);
      expect((await chokePoint.getProperty(subject.id))?.config).toEqual(subject.config);
    });

    it.each([
      ["a body without a label", {}, { field: "label" }],
      ["an empty label", { label: "" }, { field: "label" }],
      ["a label of only whitespace", { label: "   " }, { field: "label" }],
      ["a label of 61 characters", { label: "a".repeat(61) }, { field: "label" }],
      // `send` writes the next three as the JSON escapes \u0000, \ud83d and \udc8a, which the route parses back.
      ["a label that holds U+0000", { label: "Byl\u0000inky" }, { field: "label" }],
      [
        "a label of 60 code units cut inside a surrogate pair",
        { label: `${"a".repeat(59)}\ud83d` },
        { field: "label" },
      ],
      ["a label that holds a low surrogate without its pair", { label: "\udc8a Bylinky" }, { field: "label" }],
      ["a label that is not a string", { label: 5 }, { field: "label" }],
      ["a color that is not #RRGGBB", { label: "Bylinky", color: "green" }, { field: "color" }],
      ["a body that is not an object", ["Bylinky"], undefined],
    ])("answers 400 validation_failed to an add with %s and writes nothing", async (_case, body, details) => {
      const headers = await sessionHeaders();
      const tags = await healthProperty("tags");

      const res = await send(`/api/properties/${tags.id}/options`, "POST", headers, body);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: "validation_failed", ...(details ? { details } : {}) } });
      expect((await chokePoint.getProperty(tags.id))?.config).toEqual(tags.config);
    });

    it("answers 400 naming 'id' for a property id that is not a UUID and 404 for an unknown one, on both routes", async () => {
      const headers = await sessionHeaders();
      const malformed = { error: { code: "validation_failed", details: { field: "id" } } };

      const requests = [
        (id: string) => send(`/api/properties/${id}/options`, "POST", headers, { label: "Bylinky" }),
        (id: string) => send(`/api/properties/${id}/options/medication`, "PATCH", headers, { label: "Pills" }),
      ];
      for (const request of requests) {
        const bad = await request("tags");
        expect(bad.status).toBe(400);
        expect(await bad.json()).toEqual(malformed);
        const unknown = await request(randomUUID());
        expect(unknown.status).toBe(404);
        expect(await unknown.json()).toEqual({ error: { code: "not_found" } });
      }
    });

    it("renames and recolors an option with 200 under the same key, and the schema shows the new label and color", async () => {
      const headers = await sessionHeaders();
      const tags = await healthProperty("tags");
      expect((await send(`/api/properties/${tags.id}/options`, "POST", headers, { label: "Bylinky" })).status).toBe(
        201,
      );

      const res = await send(`/api/properties/${tags.id}/options/bylinky`, "PATCH", headers, {
        label: "Herbs",
        color: "#ff9500",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ key: "bylinky", label: "Herbs", color: "#FF9500" });
      const listed = await schemaTags(headers);
      expect(listed.map((option) => option.key)).toEqual([...SEEDED_TAG_KEYS, "bylinky"]);
      expect(listed.at(-1)).toEqual({ key: "bylinky", label: "Herbs", color: "#FF9500" });
    });

    it("stores a label whose surrogates are all paired, on an add and on a rename of 60 UTF-16 code units", async () => {
      const headers = await sessionHeaders();
      const tags = await healthProperty("tags");
      // U+1F48A, one character outside the Basic Multilingual Plane: a high surrogate followed by its low surrogate.
      const pill = String.fromCodePoint(0x1f48a);
      const longest = pill.repeat(30);
      expect(longest).toHaveLength(60);

      const added = await send(`/api/properties/${tags.id}/options`, "POST", headers, { label: `Vitamins ${pill}` });
      expect(added.status).toBe(201);
      expect(await added.json()).toEqual({ key: "vitamins", label: `Vitamins ${pill}` });

      const renamed = await send(`/api/properties/${tags.id}/options/vitamins`, "PATCH", headers, { label: longest });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toEqual({ key: "vitamins", label: longest });
      expect((await schemaTags(headers)).at(-1)).toEqual({ key: "vitamins", label: longest });
    });

    it.each([
      ["cs", "Léky"],
      ["en", "Medication"],
    ] as const)(
      "recolors a catalog option for a %s user and answers with its catalog label %s",
      async (locale, label) => {
        const headers = await sessionHeaders(locale);
        const tags = await healthProperty("tags");

        const res = await send(`/api/properties/${tags.id}/options/medication`, "PATCH", headers, { color: "#ff3b30" });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ key: "medication", label, color: "#FF3B30" });
        expect((await schemaTags(headers)).find((option) => option.key === "medication")).toEqual({
          key: "medication",
          label,
          color: "#FF3B30",
        });
      },
    );

    it.each([
      ["an empty patch", "medication", {}, 400, { code: "validation_failed", details: { reason: "empty_patch" } }],
      [
        "a label of 61 characters",
        "medication",
        { label: "a".repeat(61) },
        400,
        { code: "validation_failed", details: { field: "label" } },
      ],
      [
        "a label that holds U+0000",
        "medication",
        { label: "Pil\u0000ls" },
        400,
        { code: "validation_failed", details: { field: "label" } },
      ],
      [
        "a label that is one high surrogate without its pair",
        "medication",
        { label: "\ud83d" },
        400,
        { code: "validation_failed", details: { field: "label" } },
      ],
      [
        "a label that ends in a low surrogate without its pair",
        "medication",
        { label: "Pills \udc8a" },
        400,
        { code: "validation_failed", details: { field: "label" } },
      ],
      [
        "a color that is not #RRGGBB",
        "medication",
        { color: "#12" },
        400,
        { code: "validation_failed", details: { field: "color" } },
      ],
      ["a body that is not an object", "medication", "Pills", 400, { code: "validation_failed" }],
      [
        "the label another option shows",
        "medication",
        { label: "Epilepsie" },
        409,
        { code: "option_label_exists", details: { key: "epilepsy" } },
      ],
    ])("refuses an update with %s and writes nothing", async (_case, key, body, status, error) => {
      const headers = await sessionHeaders();
      const tags = await healthProperty("tags");

      const res = await send(`/api/properties/${tags.id}/options/${key}`, "PATCH", headers, body);

      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
      expect((await chokePoint.getProperty(tags.id))?.config).toEqual(tags.config);
    });

    it("answers 404 not_found naming the option for an option key the property does not hold", async () => {
      const headers = await sessionHeaders();
      const tags = await healthProperty("tags");

      const res = await send(`/api/properties/${tags.id}/options/missing`, "PATCH", headers, { label: "Herbs" });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "not_found", details: { resource: "propertyOption", propertyId: tags.id, key: "missing" } },
      });
      expect((await chokePoint.getProperty(tags.id))?.config).toEqual(tags.config);
    });

    /**
     * A select property of a database the caller creates, holding `key` and then `other` as options without labels.
     * Both are written through REST, as a client stores an option key that is not URL-safe.
     */
    async function propertyWithOptionKey(headers: Record<string, string>, key: string): Promise<string> {
      const idShape = z.object({ id: z.string() });
      const database = await send("/api/databases", "POST", headers, { name: "Tasks of the test" });
      expect(database.status).toBe(201);
      const databaseId = idShape.parse(await database.json()).id;
      const property = await send(`/api/databases/${databaseId}/properties`, "POST", headers, {
        key: "priority",
        name: "Priority",
        type: "select",
        config: { options: [{ key }, { key: "other" }] },
      });
      expect(property.status).toBe(201);
      return idShape.parse(await property.json()).id;
    }

    it.each([
      ["a space and a diacritic", "Vysoká priorita", "Vysok%C3%A1%20priorita"],
      ["a slash", "čeká/na odpověď", "%C4%8Dek%C3%A1%2Fna%20odpov%C4%9B%C4%8F"],
      ["a percent sign", "100 %", "100%20%25"],
      ["the text of an escape sequence", "To%20do", "To%2520do"],
    ])(
      "renames and recolors an option whose key holds %s through its percent-encoded path segment",
      async (_case, key, segment) => {
        expect(segment).toBe(encodeURIComponent(key));
        const headers = await sessionHeaders();
        const propertyId = await propertyWithOptionKey(headers, key);

        const res = await send(`/api/properties/${propertyId}/options/${segment}`, "PATCH", headers, {
          label: "Renamed",
          color: "#ff9500",
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ key, label: "Renamed", color: "#FF9500" });
        expect((await chokePoint.getProperty(propertyId))?.config).toEqual({
          options: [{ key, label: "Renamed", color: "#FF9500" }, { key: "other" }],
        });
      },
    );

    it("names the decoded key in the 404 for a percent-encoded option key the property does not hold", async () => {
      const headers = await sessionHeaders();
      const propertyId = await propertyWithOptionKey(headers, "Vysoká priorita");
      const stored = (await chokePoint.getProperty(propertyId))?.config;

      const res = await send(`/api/properties/${propertyId}/options/N%C3%ADzk%C3%A1%20priorita`, "PATCH", headers, {
        label: "Renamed",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "not_found", details: { resource: "propertyOption", propertyId, key: "Nízká priorita" } },
      });
      expect((await chokePoint.getProperty(propertyId))?.config).toEqual(stored);
    });

    it.each([
      ["a percent sign that starts no escape sequence", "100%"],
      ["an escape sequence that is not hexadecimal", "%zz"],
      ["an escape sequence that is cut short", "medication%2"],
      ["escaped bytes that are not UTF-8", "%C3%28"],
    ])("answers 400 validation_failed naming 'key' to an update whose key segment is %s", async (_case, segment) => {
      const headers = await sessionHeaders();
      const tags = await healthProperty("tags");

      const res = await send(`/api/properties/${tags.id}/options/${segment}`, "PATCH", headers, { label: "Herbs" });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: "validation_failed", details: { field: "key" } } });
      expect((await chokePoint.getProperty(tags.id))?.config).toEqual(tags.config);
    });

    it("still answers 403 schema_locked to a property patch of the same tags config, also after an option was added", async () => {
      const headers = await sessionHeaders();
      const tags = await healthProperty("tags");
      const patch = { config: { options: [{ key: "medication" }, { key: "bylinky", label: "Bylinky" }] } };

      const before = await send(`/api/properties/${tags.id}`, "PATCH", headers, patch);
      expect(before.status).toBe(403);
      expect(await before.json()).toEqual({ error: { code: "schema_locked" } });

      expect((await send(`/api/properties/${tags.id}/options`, "POST", headers, { label: "Vitamíny" })).status).toBe(
        201,
      );
      const stored = (await chokePoint.getProperty(tags.id))?.config;
      const after = await send(`/api/properties/${tags.id}`, "PATCH", headers, patch);
      expect(after.status).toBe(403);
      expect(await after.json()).toEqual({ error: { code: "schema_locked" } });
      expect((await chokePoint.getProperty(tags.id))?.config).toEqual(stored);
    });
  });
});
