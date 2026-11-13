import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createDocStore,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  mintMcpRunCredential,
  seedSystem,
  withTransaction,
  type ChokePoint,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import { logger } from "../logger.js";

const PASSWORD = "s3cret-password";
const SECRET = "Secret diagnosis xyz";
const SECRET_PAGE = "Private page text xyz";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

const moduleRegistry = await loadFullModuleRegistry();

/** What `/mcp` answers: a JSON-RPC result, or an error that carries the operation's error code in `data`. */
const rpcBody = z.object({
  result: z.object({ content: z.array(z.object({ text: z.string() })) }).optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.object({ code: z.string() }).optional() })
    .optional(),
});
const itemBody = z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()) });
const databaseListBody = z.object({ items: z.array(z.object({ id: z.string() })) });
const databasePageBody = z.object({ items: z.array(z.object({ id: z.string() })) });

interface DatabaseIds {
  health: string;
  sleepNights: string;
  tasks: string;
}

describe("sensitive databases over POST /mcp (issue #1998)", () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let cp: ChokePoint;
  let docStore: ReturnType<typeof createDocStore>;
  let server: Server;
  let baseUrl: string;
  let databases: DatabaseIds;
  let userId: string;
  let humanHeaders: Record<string, string>;

  function inTenantZero<T>(fn: () => Promise<T>): Promise<T> {
    return runInTenant(getTenantZeroId(), fn);
  }

  beforeAll(async () => {
    adminPool = getTestPool();
    runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
    cp = createChokePoint(runtimePool);
    docStore = createDocStore(runtimePool);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    await inTenantZero(() => seedSystem(runtimePool, createViewTypeRegistry()));
    const email = `${randomUUID()}@example.com`;
    const user = await createUser(adminPool, {
      tenantId: getTenantZeroId(),
      email,
      passwordHash: await hashPassword(PASSWORD),
    });
    userId = user.id;
    const { token } = await login(adminPool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    humanHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const ids = await inTenantZero(async () => {
      const all = await cp.listDatabases();
      const idOf = (moduleId: string) => {
        const match = all.find((database) => database.ownerModuleId === moduleId);
        if (!match) throw new Error(`Missing system database ${moduleId}`);
        return match.id;
      };
      return { health: idOf("healthRecords"), sleepNights: idOf("sleepNights"), tasks: idOf("tasks") };
    });
    databases = ids;

    const dispatch = await createDispatcher(runtimePool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await runtimePool?.end();
  });

  async function call(headers: Record<string, string>, name: string, args: unknown) {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return rpcBody.parse(await res.json());
  }

  /** The tool's JSON output; a refused call fails the test here. */
  async function callOk<T>(headers: Record<string, string>, name: string, args: unknown, schema: z.ZodType<T>) {
    const body = await call(headers, name, args);
    expect(body.error).toBeUndefined();
    const text = body.result?.content[0]?.text;
    if (text === undefined) throw new Error("The tool returned no content");
    return schema.parse(JSON.parse(text));
  }

  /** A refused call: the JSON-RPC error of a `ForbiddenError`, whose code is `forbidden`. */
  function expectForbidden(body: z.infer<typeof rpcBody>): void {
    expect(body.result).toBeUndefined();
    expect(body.error).toMatchObject({ code: -32000, data: { code: "forbidden" } });
    expect(JSON.stringify(body)).not.toContain("Secret diagnosis");
  }

  const newRecord = (name = SECRET) =>
    inTenantZero(() => cp.createItem({ databaseId: databases.health, properties: { name } }));

  async function newUserDatabase(name: string) {
    return inTenantZero(async () => {
      const database = await cp.createDatabase({ name });
      await cp.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
      return database;
    });
  }

  it("refuses semprec.item.get of a health record to a human token over /mcp while REST returns the record", async () => {
    const record = await newRecord();
    const logged = [
      vi.spyOn(logger, "error"),
      vi.spyOn(logger, "warn"),
      vi.spyOn(logger, "info"),
      vi.spyOn(logger, "debug"),
    ];

    expectForbidden(await call(humanHeaders, "semprec.item.get", { itemId: record.id }));

    const rest = await fetch(`${baseUrl}/api/items/${record.id}`, { headers: humanHeaders });
    expect(rest.status).toBe(200);
    expect(itemBody.parse(await rest.json())).toMatchObject({ id: record.id, properties: { name: SECRET } });
    for (const spy of logged) expect(JSON.stringify(spy.mock.calls)).not.toContain("Secret diagnosis");
  });

  it("refuses semprec.database.query of the sleep nights database to a human token", async () => {
    expectForbidden(await call(humanHeaders, "semprec.database.query", { databaseId: databases.sleepNights }));
    expectForbidden(await call(humanHeaders, "semprec.database.get", { databaseId: databases.sleepNights }));

    const rest = await fetch(`${baseUrl}/api/databases/${databases.sleepNights}/query`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({}),
    });
    expect(rest.status).toBe(200);
    expect(databasePageBody.parse(await rest.json()).items).toEqual([]);
  });

  it("refuses semprec.item.create, item.patch and item.delete in Health records and writes nothing", async () => {
    const record = await newRecord("Before");
    const countBefore = (await inTenantZero(() => cp.listItems(databases.health))).items.length;

    expectForbidden(
      await call(humanHeaders, "semprec.item.create", { databaseId: databases.health, properties: { name: "New" } }),
    );
    expectForbidden(
      await call(humanHeaders, "semprec.item.patch", {
        itemId: record.id,
        properties: { name: "After" },
        ifVersion: record.updatedAt,
      }),
    );
    expectForbidden(await call(humanHeaders, "semprec.item.delete", { itemId: record.id }));

    const stored = await inTenantZero(() => cp.findItem(record.id));
    expect(stored?.properties.name).toBe("Before");
    expect(stored?.deletedAt).toBeNull();
    expect((await inTenantZero(() => cp.listItems(databases.health))).items).toHaveLength(countBefore);
  });

  it("refuses the counts, facets, schema, page and view operations on a sensitive database over /mcp and writes nothing", async () => {
    const record = await newRecord();
    await inTenantZero(() =>
      docStore.insertPageMarkdown(record.id, { placement: "end", markdown: SECRET_PAGE, origin: "user" }),
    );
    const [healthProperty] = await inTenantZero(() => cp.listProperties(databases.health));
    const view = await inTenantZero(() =>
      cp.createView({ databaseId: databases.health, type: "table", name: "Health table" }),
    );
    const propertiesBefore = await inTenantZero(() => cp.listProperties(databases.health));

    const refused: Record<string, unknown> = {
      "semprec.database.facets": { databaseId: databases.health, facets: ["type"] },
      "semprec.item.count": { items: [{ databaseId: databases.sleepNights }] },
      "semprec.property.list": { databaseId: databases.health },
      "semprec.property.get": { propertyId: healthProperty?.id },
      "semprec.property.create": { databaseId: databases.health, key: "extra", name: "Extra", type: "text" },
      "semprec.view.get": { viewId: view.id },
      "semprec.view.delete": { viewId: view.id },
      "semprec.page.get": { itemId: record.id, format: "markdown" },
      "semprec.page.insert": { itemId: record.id, placement: "end", markdown: "Written over /mcp" },
      "semprec.database.patch": { databaseId: databases.health, patch: { name: "Renamed over /mcp" } },
    };
    for (const [tool, args] of Object.entries(refused)) {
      const body = await call(humanHeaders, tool, args);
      expectForbidden(body);
      expect(JSON.stringify(body), tool).not.toContain("Private page text");
    }

    expect(await inTenantZero(() => cp.listProperties(databases.health))).toEqual(propertiesBefore);
    expect((await inTenantZero(() => cp.getView(view.id)))?.name).toBe("Health table");
    const page = await inTenantZero(() => docStore.readPageMarkdown(record.id));
    expect(page.markdown).toContain(SECRET_PAGE);
    expect(page.markdown).not.toContain("Written over /mcp");
    expect((await inTenantZero(() => cp.getDatabase(databases.health)))?.name).not.toBe("Renamed over /mcp");
  });

  it("keeps a non-sensitive system database and a user-created database readable and writable over /mcp", async () => {
    const task = await inTenantZero(() =>
      cp.createItem({ databaseId: databases.tasks, properties: { name: "A task" } }),
    );
    const userDatabase = await newUserDatabase("Open notes");
    const note = await inTenantZero(() =>
      cp.createItem({ databaseId: userDatabase.id, properties: { name: "An open note" } }),
    );

    expect((await callOk(humanHeaders, "semprec.item.get", { itemId: task.id }, itemBody)).id).toBe(task.id);
    expect((await callOk(humanHeaders, "semprec.item.get", { itemId: note.id }, itemBody)).id).toBe(note.id);
    const queried = await callOk(
      humanHeaders,
      "semprec.database.query",
      { databaseId: userDatabase.id },
      databasePageBody,
    );
    expect(queried.items.map((item) => item.id)).toEqual([note.id]);
    const created = await callOk(
      humanHeaders,
      "semprec.item.create",
      { databaseId: userDatabase.id, properties: { name: "Written over /mcp" } },
      itemBody,
    );
    expect((await inTenantZero(() => cp.findItem(created.id)))?.properties.name).toBe("Written over /mcp");
  });

  it("omits the sensitive databases from semprec.database.list and lists the user-created ones", async () => {
    const userDatabase = await newUserDatabase("Listed notes");
    const listed = await callOk(humanHeaders, "semprec.database.list", { limit: 200 }, databaseListBody);
    const ids = listed.items.map((database) => database.id);
    expect(ids).toContain(userDatabase.id);
    expect(ids).toContain(databases.tasks);
    expect(ids).not.toContain(databases.health);
    expect(ids).not.toContain(databases.sleepNights);

    const rest = await fetch(`${baseUrl}/api/databases`, { headers: humanHeaders });
    expect(rest.status).toBe(200);
    const restIds = JSON.stringify(await rest.json());
    expect(restIds).toContain(databases.health);
    expect(restIds).toContain(databases.sleepNights);
  });

  describe("a run credential", () => {
    async function runCredentialHeaders(): Promise<{ headers: Record<string, string>; projectItemId: string }> {
      const projectItemId = await inTenantZero(() => createTestProjectItem(runtimePool));
      const minted = await inTenantZero(() =>
        withTransaction(runtimePool, (client) =>
          mintMcpRunCredential(client, {
            projectItemId,
            capabilities: ["core.item.read", "core.database.read"],
            userId,
          }),
        ),
      );
      return {
        headers: { Authorization: `Bearer ${minted.token}`, "Content-Type": "application/json" },
        projectItemId,
      };
    }

    it("keeps the behavior of #1810: refused without a grant on a sensitive database, readable with a read grant, and open on a user-created database", async () => {
      const record = await newRecord();
      const userDatabase = await newUserDatabase("Agent notes");
      const note = await inTenantZero(() =>
        cp.createItem({ databaseId: userDatabase.id, properties: { name: "Agent note" } }),
      );
      const { headers, projectItemId } = await runCredentialHeaders();

      expectForbidden(await call(headers, "semprec.item.get", { itemId: record.id }));
      expect((await callOk(headers, "semprec.item.get", { itemId: note.id }, itemBody)).id).toBe(note.id);

      // The user-only admin store is not exported from `@semprec/data`, so a fixture writes the decision directly.
      await inTenantZero(() =>
        withTransaction(runtimePool, (client) =>
          client.query(
            `INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, 'read')`,
            [projectItemId, databases.health],
          ),
        ),
      );
      expect(await callOk(headers, "semprec.item.get", { itemId: record.id }, itemBody)).toMatchObject({
        id: record.id,
        properties: { name: SECRET },
      });
    });

    it("does not give the human token the grant of a project: the same record stays refused to it", async () => {
      const record = await newRecord();
      const { projectItemId } = await runCredentialHeaders();
      await inTenantZero(() =>
        withTransaction(runtimePool, (client) =>
          client.query(
            `INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, 'write')`,
            [projectItemId, databases.health],
          ),
        ),
      );
      expectForbidden(await call(humanHeaders, "semprec.item.get", { itemId: record.id }));
    });
  });
});
