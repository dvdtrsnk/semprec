import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import {
  createListAgentDatabaseGrantsRouteHandler,
  createPatchAgentDatabaseGrantRouteHandler,
} from "../agentGrants/agentDatabaseGrantsRouteHandlers.js";
import { setAgentDatabaseGrantForProjectSettings } from "../agentGrants/agentDatabaseGrantsForProject.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { manifest as schemaCoreManifest } from "../chokePoint/schemaCoreModuleManifest.js";
import { seedSystem } from "../seed/seedSystem.js";
import { HEALTH_RECORDS_MODULE_ID, PROJECTS_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import type { DatabaseRow } from "../types.js";

// Seeding the system databases of two tenants is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 240_000;
const FORBIDDEN = { status: 403, code: "forbidden" };
const VALIDATION = { status: 400, code: "validation_failed" };
const NOT_FOUND = { status: 404, code: "not_found" };
const LOCK_NOT_AVAILABLE = "55P03";

let adminPool: Pool;
let dataPool: Pool;
let cp: ChokePoint;
let tenantId: string;
let otherTenantId: string;
let health: DatabaseRow;
let tasks: DatabaseRow;
let projectsDatabase: DatabaseRow;

const listPage = z.object({
  rows: z.array(
    z.object({
      databaseId: z.string(),
      key: z.string().nullable(),
      name: z.string(),
      sensitive: z.boolean(),
      system: z.boolean(),
      access: z.enum(["none", "read", "write"]),
    }),
  ),
});
type ListedDatabase = z.infer<typeof listPage>["rows"][number];

function context(params: Record<string, string>, body: unknown, locale: string) {
  return { params, body, identity: { user: { locale } } };
}

function inTenant<T>(fn: () => Promise<T>, tenant = tenantId): Promise<T> {
  return runInTenant(tenant, fn);
}

function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTenant(() => withTransaction(dataPool, fn));
}

/** `GET /api/projects/:id/database-grants` as the caller's tenant, parsed. */
async function list(projectId: string, locale = "en", tenant = tenantId): Promise<ListedDatabase[]> {
  const handler = createListAgentDatabaseGrantsRouteHandler(dataPool);
  const result = await inTenant(() => handler(context({ id: projectId }, undefined, locale)), tenant);
  expect(result.status).toBe(200);
  return listPage.parse(result.body).rows;
}

/** `PATCH /api/projects/:id/database-grants` as the caller's tenant; resolves with the answered body. */
async function patch(projectId: string, body: unknown, locale = "en", tenant = tenantId): Promise<ListedDatabase> {
  const handler = createPatchAgentDatabaseGrantRouteHandler(dataPool);
  const result = await inTenant(() => handler(context({ id: projectId }, body, locale)), tenant);
  expect(result.status).toBe(200);
  return listPage.shape.rows.element.parse(result.body);
}

function patchRequest(projectId: string, body: unknown, tenant = tenantId) {
  const handler = createPatchAgentDatabaseGrantRouteHandler(dataPool);
  return inTenant(() => handler(context({ id: projectId }, body, "en")), tenant);
}

function accessOf(rows: ListedDatabase[], databaseId: string): string | undefined {
  return rows.find((row) => row.databaseId === databaseId)?.access;
}

/** An agent run's writer: the identity `writerIdentityOf` derives for a run credential. */
function agent(projectItemId: string): WriterIdentity {
  return { writerKind: "agent", agentRunId: randomUUID(), agentProjectItemId: projectItemId };
}

function newProject(tenant = tenantId): Promise<string> {
  return inTenant(() => createTestProjectItem(dataPool), tenant);
}

/** A user-created database with a title property. */
async function newUserDatabase(name: string, tenant = tenantId): Promise<DatabaseRow> {
  return inTenant(async () => {
    const database = await cp.createDatabase({ name });
    await cp.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
    return database;
  }, tenant);
}

async function systemDatabase(moduleId: string): Promise<DatabaseRow> {
  const database = await inTransaction((client) => getDatabaseByModuleId(client, moduleId));
  if (!database) throw new Error(`System database ${moduleId} is missing`);
  return database;
}

/** The decision rows stored for a project, read as the superuser: the rows exist, whoever may see them. */
async function storedRows(projectId: string): Promise<Array<{ databaseId: string; access: string }>> {
  const { rows } = await adminPool.query<{ database_id: string; access: string }>(
    "SELECT database_id, access FROM agent_database_grants WHERE project_item_id = $1 ORDER BY database_id",
    [projectId],
  );
  return rows.map((row) => ({ databaseId: row.database_id, access: row.access }));
}

/** A record the person created in `databaseId`, so an agent read has something to find. */
function newRecord(databaseId: string): Promise<string> {
  return inTenant(async () => (await cp.createItem({ databaseId, properties: { name: "Record" } })).id);
}

/** `item.get` as the agent of `projectId`: resolves with the item id, rejects with the refusal. */
function agentRead(projectId: string, itemId: string) {
  return inTenant(() => cp.findItem(itemId, undefined, projectId));
}

function agentWrite(projectId: string, databaseId: string) {
  return inTenant(() =>
    cp.createItem({ databaseId, properties: { name: "By agent" } }, undefined, undefined, agent(projectId)),
  );
}

describe("project database grants over REST (issue #1841)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    otherTenantId = await createTestTenant(adminPool);
    await inTenant(() => seedSystem(dataPool, createViewTypeRegistry()));
    await inTenant(() => seedSystem(dataPool, createViewTypeRegistry()), otherTenantId);
    cp = createChokePoint(dataPool);
    health = await systemDatabase(HEALTH_RECORDS_MODULE_ID);
    tasks = await systemDatabase(TASKS_MODULE_ID);
    projectsDatabase = await systemDatabase(PROJECTS_MODULE_ID);
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await dataPool?.end();
  });

  describe("the manifest", () => {
    it("declares both routes with the justification of each", () => {
      const routes = (schemaCoreManifest.customRoutes ?? []).filter((route) => route.path.endsWith("/database-grants"));
      expect(routes).toEqual([
        expect.objectContaining({
          method: "GET",
          path: "/api/projects/:id/database-grants",
          handlerExport: "createListAgentDatabaseGrantsRouteHandler",
          justification: "single-consumer-read",
        }),
        expect.objectContaining({
          method: "PATCH",
          path: "/api/projects/:id/database-grants",
          handlerExport: "createPatchAgentDatabaseGrantRouteHandler",
          justification: "transactional-semantics",
        }),
      ]);
    });
  });

  describe("GET list", () => {
    it("lists the sensitive and the user-created databases with the right access and no open system database", async () => {
      const project = await newProject();
      const notes = await newUserDatabase("Notes");
      const rows = await list(project);

      expect(rows.find((row) => row.databaseId === health.id)).toEqual({
        databaseId: health.id,
        key: "healthRecords",
        name: "Health records",
        sensitive: true,
        system: true,
        access: "none",
      });
      expect(rows.find((row) => row.databaseId === notes.id)).toEqual({
        databaseId: notes.id,
        key: null,
        name: "Notes",
        sensitive: false,
        system: false,
        access: "write",
      });
      expect(rows.map((row) => row.databaseId)).not.toContain(tasks.id);
      expect(rows.map((row) => row.databaseId)).not.toContain(projectsDatabase.id);
      expect(rows.every((row) => row.sensitive || !row.system)).toBe(true);
      expect(new Set(rows.map((row) => row.databaseId)).size).toBe(rows.length);
    });

    it("lists every sensitive database and every user-created database of the tenant", async () => {
      const project = await newProject();
      const [first, second] = [await newUserDatabase("Alpha"), await newUserDatabase("Beta")];
      const rows = await list(project);
      const { rows: expected } = await adminPool.query<{ id: string }>(
        "SELECT id FROM databases WHERE tenant_id = $1 AND (sensitive OR NOT system)",
        [tenantId],
      );
      expect(rows.map((row) => row.databaseId).sort()).toEqual(expected.map((row) => row.id).sort());
      expect(rows.map((row) => row.databaseId)).toEqual(expect.arrayContaining([first.id, second.id, health.id]));
    });

    it("labels a system database in the caller's locale and keeps the name of a user-created one", async () => {
      const project = await newProject();
      const custom = await newUserDatabase("Moje poznámky");
      const czech = await list(project, "cs");
      const english = await list(project, "en");
      expect(czech.find((row) => row.databaseId === health.id)?.name).toBe("Zdravotní záznamy");
      expect(english.find((row) => row.databaseId === health.id)?.name).toBe("Health records");
      expect(czech.find((row) => row.databaseId === custom.id)?.name).toBe("Moje poznámky");
      expect(english.find((row) => row.databaseId === custom.id)?.name).toBe("Moje poznámky");
    });

    it("shows the stored decision of this project and the default for another project", async () => {
      const [project, other] = [await newProject(), await newProject()];
      const notes = await newUserDatabase("Journal notes");
      await patch(project, { databaseId: health.id, access: "read" });
      await patch(project, { databaseId: notes.id, access: "none" });

      const rows = await list(project);
      expect(accessOf(rows, health.id)).toBe("read");
      expect(accessOf(rows, notes.id)).toBe("none");
      const otherRows = await list(other);
      expect(accessOf(otherRows, health.id)).toBe("none");
      expect(accessOf(otherRows, notes.id)).toBe("write");
    });

    it("lists the same access the agent's point check enforces for a sensitive and three user-created databases", async () => {
      const project = await newProject();
      const [closed, narrowed, untouched] = [
        await newUserDatabase("Closed notes"),
        await newUserDatabase("Narrowed notes"),
        await newUserDatabase("Untouched notes"),
      ];
      await patch(project, { databaseId: health.id, access: "write" });
      await patch(project, { databaseId: closed.id, access: "none" });
      await patch(project, { databaseId: narrowed.id, access: "read" });
      const rows = await list(project);
      const expected = [
        { database: health, listed: "write", readable: true, writable: true },
        { database: closed, listed: "none", readable: false, writable: false },
        { database: narrowed, listed: "read", readable: true, writable: false },
        { database: untouched, listed: "write", readable: true, writable: true },
      ];
      for (const { database, ...want } of expected) {
        const record = await newRecord(database.id);
        const readable = await agentRead(project, record).then(
          () => true,
          () => false,
        );
        const writable = await agentWrite(project, database.id).then(
          () => true,
          () => false,
        );
        expect({ listed: accessOf(rows, database.id), readable, writable }).toEqual(want);
      }
    });

    it("answers 404 for an unknown project", async () => {
      const handler = createListAgentDatabaseGrantsRouteHandler(dataPool);
      await expect(inTenant(() => handler(context({ id: randomUUID() }, undefined, "en")))).rejects.toMatchObject(
        NOT_FOUND,
      );
    });

    it("answers 404 for a project in the trash and lists it again after the restore", async () => {
      const project = await newProject();
      await inTenant(() => cp.softDeleteItem(projectsDatabase.id, project));
      await expect(list(project)).rejects.toMatchObject(NOT_FOUND);
      await inTenant(() => cp.restoreItem(projectsDatabase.id, project));
      expect((await list(project)).length).toBeGreaterThan(0);
    });

    it("answers 404 for an item that is not a project", async () => {
      const task = await inTenant(() => cp.createItem({ databaseId: tasks.id, properties: { name: "Not a project" } }));
      await expect(list(task.id)).rejects.toMatchObject(NOT_FOUND);
    });

    it("answers 404 for another tenant's project, like an unknown one", async () => {
      const foreign = await newProject(otherTenantId);
      const handler = createListAgentDatabaseGrantsRouteHandler(dataPool);
      await expect(inTenant(() => handler(context({ id: foreign }, undefined, "en")))).rejects.toMatchObject(NOT_FOUND);
      expect((await list(foreign, "en", otherTenantId)).length).toBeGreaterThan(0);
    });

    it("lists no database of another tenant", async () => {
      const project = await newProject();
      const foreignDatabase = await newUserDatabase("Foreign only", otherTenantId);
      expect(accessOf(await list(project), foreignDatabase.id)).toBeUndefined();
    });

    it("answers 400 for a project id that is not a UUID", async () => {
      const handler = createListAgentDatabaseGrantsRouteHandler(dataPool);
      await expect(inTenant(() => handler(context({ id: "not-a-uuid" }, undefined, "en")))).rejects.toMatchObject(
        VALIDATION,
      );
    });
  });

  describe("PATCH", () => {
    it("opens a sensitive database for the agent with write, narrows it to read and closes it again with none", async () => {
      const project = await newProject();
      const record = await newRecord(health.id);
      await expect(agentWrite(project, health.id)).rejects.toMatchObject(FORBIDDEN);
      await expect(agentRead(project, record)).rejects.toMatchObject(FORBIDDEN);

      const written = await patch(project, { databaseId: health.id, access: "write" });
      expect(written).toEqual({
        databaseId: health.id,
        key: "healthRecords",
        name: "Health records",
        sensitive: true,
        system: true,
        access: "write",
      });
      expect(await storedRows(project)).toEqual([{ databaseId: health.id, access: "write" }]);
      expect((await agentWrite(project, health.id)).properties.name).toBe("By agent");
      expect((await agentRead(project, record))?.id).toBe(record);

      expect((await patch(project, { databaseId: health.id, access: "read" })).access).toBe("read");
      expect(await storedRows(project)).toEqual([{ databaseId: health.id, access: "read" }]);
      await expect(agentWrite(project, health.id)).rejects.toMatchObject(FORBIDDEN);
      expect((await agentRead(project, record))?.id).toBe(record);

      expect((await patch(project, { databaseId: health.id, access: "none" })).access).toBe("none");
      expect(await storedRows(project)).toEqual([]);
      await expect(agentRead(project, record)).rejects.toMatchObject(FORBIDDEN);
      await expect(agentWrite(project, health.id)).rejects.toMatchObject(FORBIDDEN);
    });

    it("closes a user-created database for the agent with none and removes the row when it is set back to write", async () => {
      const project = await newProject();
      const notes = await newUserDatabase("Private notes");
      const record = await newRecord(notes.id);
      expect((await agentRead(project, record))?.id).toBe(record);

      const closed = await patch(project, { databaseId: notes.id, access: "none" });
      expect(closed).toEqual({
        databaseId: notes.id,
        key: null,
        name: "Private notes",
        sensitive: false,
        system: false,
        access: "none",
      });
      expect(await storedRows(project)).toEqual([{ databaseId: notes.id, access: "none" }]);
      await expect(agentRead(project, record)).rejects.toMatchObject(FORBIDDEN);
      await expect(agentWrite(project, notes.id)).rejects.toMatchObject(FORBIDDEN);

      expect((await patch(project, { databaseId: notes.id, access: "read" })).access).toBe("read");
      expect(await storedRows(project)).toEqual([{ databaseId: notes.id, access: "read" }]);
      expect((await agentRead(project, record))?.id).toBe(record);
      await expect(agentWrite(project, notes.id)).rejects.toMatchObject(FORBIDDEN);

      expect((await patch(project, { databaseId: notes.id, access: "write" })).access).toBe("write");
      expect(await storedRows(project)).toEqual([]);
      expect((await agentWrite(project, notes.id)).properties.name).toBe("By agent");
    });

    it("accepts the default of a database that has no stored decision and stores nothing", async () => {
      const project = await newProject();
      const notes = await newUserDatabase("Untouched notes");
      expect((await patch(project, { databaseId: notes.id, access: "write" })).access).toBe("write");
      expect((await patch(project, { databaseId: health.id, access: "none" })).access).toBe("none");
      expect(await storedRows(project)).toEqual([]);
    });

    it("keeps the decision of one project from changing another project's access", async () => {
      const [project, other] = [await newProject(), await newProject()];
      await patch(project, { databaseId: health.id, access: "write" });
      expect(accessOf(await list(other), health.id)).toBe("none");
      expect(await storedRows(other)).toEqual([]);
    });

    it("answers the database as the list shows it, in the caller's locale", async () => {
      const project = await newProject();
      const answered = await patch(project, { databaseId: health.id, access: "read" }, "cs");
      expect(answered.name).toBe("Zdravotní záznamy");
      expect(await list(project, "cs")).toContainEqual(answered);
    });

    it("rejects a non-sensitive system database with 400 and stores nothing", async () => {
      const project = await newProject();
      for (const access of ["none", "read", "write"]) {
        await expect(patchRequest(project, { databaseId: tasks.id, access })).rejects.toMatchObject({
          ...VALIDATION,
          details: { field: "databaseId" },
        });
      }
      expect(await storedRows(project)).toEqual([]);
    });

    it("answers 404 for an unknown database and for another tenant's database, and stores nothing", async () => {
      const project = await newProject();
      const foreignDatabase = await newUserDatabase("Foreign notes", otherTenantId);
      await expect(patchRequest(project, { databaseId: randomUUID(), access: "none" })).rejects.toMatchObject(
        NOT_FOUND,
      );
      await expect(patchRequest(project, { databaseId: foreignDatabase.id, access: "none" })).rejects.toMatchObject(
        NOT_FOUND,
      );
      expect(await storedRows(project)).toEqual([]);
    });

    it("answers 404 for an unknown project, a project in the trash and another item, and stores nothing", async () => {
      const trashed = await newProject();
      await inTenant(() => cp.softDeleteItem(projectsDatabase.id, trashed));
      const task = await inTenant(() => cp.createItem({ databaseId: tasks.id, properties: { name: "Not a project" } }));
      const unknown = randomUUID();
      for (const id of [unknown, trashed, task.id]) {
        await expect(patchRequest(id, { databaseId: health.id, access: "write" })).rejects.toMatchObject(NOT_FOUND);
        expect(await storedRows(id)).toEqual([]);
      }
      await inTenant(() => cp.restoreItem(projectsDatabase.id, trashed));
      await patch(trashed, { databaseId: health.id, access: "write" });
      expect(await storedRows(trashed)).toEqual([{ databaseId: health.id, access: "write" }]);
    });

    it("answers 404 for another tenant's project and leaves its decisions alone", async () => {
      const foreign = await newProject(otherTenantId);
      await expect(patchRequest(foreign, { databaseId: health.id, access: "write" })).rejects.toMatchObject(NOT_FOUND);
      expect(await storedRows(foreign)).toEqual([]);
    });

    it("answers 400 for a malformed project id or body and stores nothing", async () => {
      const project = await newProject();
      const valid = { databaseId: health.id, access: "write" };
      const bodies: unknown[] = [
        undefined,
        null,
        [],
        "write",
        {},
        { databaseId: health.id },
        { access: "write" },
        { ...valid, access: "admin" },
        { ...valid, access: "WRITE" },
        { ...valid, access: null },
        { ...valid, databaseId: "not-a-uuid" },
        { ...valid, databaseId: 7 },
        { ...valid, extra: true },
        { ...valid, projectItemId: project },
      ];
      for (const body of bodies) {
        await expect(patchRequest(project, body), JSON.stringify(body)).rejects.toMatchObject(VALIDATION);
      }
      await expect(patchRequest("not-a-uuid", valid)).rejects.toMatchObject(VALIDATION);
      expect(await storedRows(project)).toEqual([]);
    });

    it("names the offending field of a malformed body", async () => {
      const project = await newProject();
      await expect(patchRequest(project, { databaseId: health.id, access: "admin" })).rejects.toMatchObject({
        details: { field: "access" },
      });
      await expect(patchRequest(project, { databaseId: "x", access: "none" })).rejects.toMatchObject({
        details: { field: "databaseId" },
      });
      await expect(patchRequest(project, { databaseId: health.id, access: "none", extra: 1 })).rejects.toMatchObject({
        details: { field: "body" },
      });
    });
  });

  describe("the wrapper's locks", () => {
    /**
     * Tries to take the row `FOR NO KEY UPDATE NOWAIT` on a second connection, the lock an archive, a trash or a
     * rename takes (an UPDATE of a non-key column); resolves with the SQLSTATE of a refusal, if any. A stronger
     * probe (`FOR UPDATE`) would also be refused by the `KEY SHARE` that the grant row's foreign key takes on the
     * database row, and could not tell whether the wrapper's own `FOR SHARE` is there.
     */
    async function updateLockRefusal(table: "items" | "databases", id: string): Promise<string | null> {
      try {
        await inTransaction((client) =>
          client.query(
            `SELECT id FROM ${table === "items" ? "items" : "databases"} WHERE id = $1 FOR NO KEY UPDATE NOWAIT`,
            [id],
          ),
        );
        return null;
      } catch (error) {
        return z.object({ code: z.string() }).parse(error).code;
      }
    }

    // `none` on a user-created database stores a row (the foreign key's check runs); `write` is its default and
    // removes the row (no foreign-key check runs), so only the wrapper's own locks can hold the two rows.
    it.each([
      { access: "none", effect: "stores a row" },
      { access: "write", effect: "removes the default row" },
    ] as const)(
      "holds the project row and the database row until the transaction ends when it $effect",
      async ({ access }) => {
        const project = await newProject();
        const notes = await newUserDatabase("Locked notes");
        expect(await updateLockRefusal("items", project)).toBeNull();
        expect(await updateLockRefusal("databases", notes.id)).toBeNull();

        const during = await inTransaction(async (client) => {
          await setAgentDatabaseGrantForProjectSettings(client, {
            projectItemId: project,
            databaseId: notes.id,
            access,
          });
          return {
            project: await updateLockRefusal("items", project),
            database: await updateLockRefusal("databases", notes.id),
          };
        });
        expect(during).toEqual({ project: LOCK_NOT_AVAILABLE, database: LOCK_NOT_AVAILABLE });

        expect(await updateLockRefusal("items", project)).toBeNull();
        expect(await updateLockRefusal("databases", notes.id)).toBeNull();
      },
    );
  });
});
