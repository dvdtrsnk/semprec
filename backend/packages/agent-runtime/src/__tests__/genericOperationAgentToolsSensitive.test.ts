import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as application from "@semprec/application";
import * as data from "@semprec/data";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  loadFullModuleRegistry,
  seedSystem,
  withTransaction,
  type AgentDatabaseAccess,
  type ChokePoint,
  type CollectionMetadataResolver,
  type DatabaseRow,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { runInTenant } from "@semprec/shared";
import { logger } from "../logger.js";
import { createGenericOperationAgentTools } from "../tools/generic/genericOperationAgentTools.js";

const metadataResolver: CollectionMetadataResolver = {
  resolve: () => ({
    icon: null,
    color: null,
    overviewOrder: null,
    switcherOrder: null,
    clientVisible: true,
    overviewHidden: false,
  }),
  collectionFilter: () => undefined,
  overviewHideable: () => false,
};

const SEEDING_TIMEOUT_MS = 120_000;
const PRIVATE_NAME = "Private diagnosis";

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let registry: ModuleRegistry;
let health: DatabaseRow;
let sleepNights: DatabaseRow;
let projects: DatabaseRow;
let userId: string;

/** Everything below runs as the application does: the runtime role under the tenant's scope. */
function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(getTenantZeroId(), fn);
}

async function systemDatabase(moduleId: string): Promise<DatabaseRow> {
  const database = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, moduleId));
  if (!database) throw new Error(`System database ${moduleId} was not seeded`);
  return database;
}

/** The tools bound to the runtime pool; built after a gateway stub so the stub is the gateway they use. */
function tools(): ReturnType<typeof createGenericOperationAgentTools> {
  return createGenericOperationAgentTools(runtime, registry, metadataResolver);
}

/** A run of a fresh Projects item with the given per-database decisions. */
async function newAgent(
  grants: readonly { database: DatabaseRow; access: AgentDatabaseAccess }[] = [],
): Promise<{ runId: string }> {
  const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
  const run = await createAgentRun(runtime, { projectItemId: project.id, triggeredBy: "user", task: "sensitive" });
  for (const { database, access } of grants) {
    // The user-only admin store is not exported from `@semprec/data`, so a fixture writes the decision directly.
    await withTransaction(runtime, (client) =>
      client.query("INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, $3)", [
        project.id,
        database.id,
        access,
      ]),
    );
  }
  return { runId: run.id };
}

async function newUserDatabase(name: string): Promise<DatabaseRow> {
  const database = await chokePoint.createDatabase({ name });
  await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
  return database;
}

function newRecord(name = PRIVATE_NAME) {
  return chokePoint.createItem({ databaseId: health.id, properties: { name } });
}

function newNight() {
  return chokePoint.createItem({
    databaseId: sleepNights.id,
    properties: { night: "2026-11-01", bedTime: "23:15", wakeTime: "06:40", alarm: true },
  });
}

/** Replaces what the gateway answers, for the cases a real operation cannot produce; the tools still resolve the run for real. */
function stubGatewayAnswer(answer: unknown): void {
  const originalFactory = application.createGenericOperationGateway;
  vi.spyOn(application, "createGenericOperationGateway").mockImplementation((...args) => {
    const gateway = originalFactory(...args);
    vi.spyOn(gateway, "invoke").mockImplementation(async () => answer as never);
    return gateway;
  });
}

describe("marking the answers of sensitive databases in the generic operation AgentTools (issue #1827)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    await seedSystem(admin, createViewTypeRegistry());
    userId = (await createTenantZeroUser(admin)).id;
    registry = await loadFullModuleRegistry();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    chokePoint = createChokePoint(runtime);
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await inTenant(async () => {
      health = await systemDatabase("healthRecords");
      sleepNights = await systemDatabase("sleepNights");
      projects = await systemDatabase("projects");
    });
    expect([health.sensitive, sleepNights.sensitive, projects.sensitive]).toEqual([true, true, false]);
  }, SEEDING_TIMEOUT_MS);

  afterEach(async () => {
    vi.restoreAllMocks();
    // Test teardown on the superuser pool: the two sensitive system databases are shared, so a test starts from none of their items.
    await admin.query("DELETE FROM items WHERE database_id = ANY($1::uuid[])", [[health.id, sleepNights.id]]);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  describe("item.get", () => {
    it("marks the answer for an item of a sensitive database and still returns the real item to the running turn", async () => {
      await inTenant(async () => {
        const record = await newRecord();
        const agent = await newAgent([{ database: health, access: "read" }]);
        const outcome = await tools()["item.get"](agent.runId, { itemId: record.id });
        expect(outcome.error).toBe(false);
        expect(outcome.sensitive).toBe(true);
        expect(JSON.parse(outcome.result)).toMatchObject({ id: record.id, properties: { name: PRIVATE_NAME } });
      });
    });

    it("does not mark the answer for an item of a non-sensitive database", async () => {
      await inTenant(async () => {
        const open = await newUserDatabase("Open notes");
        const note = await chokePoint.createItem({ databaseId: open.id, properties: { name: "Open note" } });
        const agent = await newAgent();
        const outcome = await tools()["item.get"](agent.runId, { itemId: note.id });
        expect(outcome.error).toBe(false);
        expect(outcome).not.toHaveProperty("sensitive");
        expect(JSON.parse(outcome.result)).toMatchObject({ id: note.id, properties: { name: "Open note" } });
      });
    });

    it("does not mark the refusal of a read without a grant and the refusal names no item value", async () => {
      await inTenant(async () => {
        const record = await newRecord();
        const agent = await newAgent();
        const outcome = await tools()["item.get"](agent.runId, { itemId: record.id });
        expect(outcome.error).toBe(true);
        expect(outcome.result).toMatch(/^forbidden:/);
        expect(outcome).not.toHaveProperty("sensitive");
        expect(outcome.result).not.toContain(PRIVATE_NAME);
      });
    });
  });

  describe("database.query", () => {
    it("marks the page of a query on sleepNights", async () => {
      await inTenant(async () => {
        const night = await newNight();
        const agent = await newAgent([{ database: sleepNights, access: "read" }]);
        const outcome = await tools()["database.query"](agent.runId, { databaseId: sleepNights.id });
        expect(outcome.error).toBe(false);
        expect(outcome.sensitive).toBe(true);
        expect(JSON.parse(outcome.result)).toMatchObject({
          items: [{ id: night.id, properties: { bedTime: "23:15" } }],
        });
      });
    });

    it("marks an empty page because the queried database is sensitive", async () => {
      await inTenant(async () => {
        const agent = await newAgent([{ database: sleepNights, access: "read" }]);
        const outcome = await tools()["database.query"](agent.runId, { databaseId: sleepNights.id });
        expect(JSON.parse(outcome.result)).toMatchObject({ items: [] });
        expect(outcome.sensitive).toBe(true);
      });
    });

    it("does not mark the page of a non-sensitive database", async () => {
      await inTenant(async () => {
        const open = await newUserDatabase("Open notes");
        await chokePoint.createItem({ databaseId: open.id, properties: { name: "Open note" } });
        const agent = await newAgent();
        const outcome = await tools()["database.query"](agent.runId, { databaseId: open.id });
        expect(outcome.error).toBe(false);
        expect(outcome).not.toHaveProperty("sensitive");
      });
    });
  });

  describe("view.query", () => {
    it("marks the page of a view of a sensitive database, also when the page is empty", async () => {
      await inTenant(async () => {
        const view = await chokePoint.createView({ databaseId: sleepNights.id, type: "table", name: "All nights" });
        const agent = await newAgent([{ database: sleepNights, access: "read" }]);
        const empty = await tools()["view.query"](agent.runId, { viewId: view.id });
        expect(JSON.parse(empty.result)).toMatchObject({ items: [] });
        expect(empty.sensitive).toBe(true);
        const night = await newNight();
        const filled = await tools()["view.query"](agent.runId, { viewId: view.id });
        expect(JSON.parse(filled.result)).toMatchObject({ items: [{ id: night.id }] });
        expect(filled.sensitive).toBe(true);
      });
    });

    it("marks the page of a curated view that holds an item of a sensitive database and not one that holds none", async () => {
      await inTenant(async () => {
        const open = await newUserDatabase("Open notes");
        const note = await chokePoint.createItem({ databaseId: open.id, properties: { name: "Open note" } });
        const record = await newRecord();
        const mixed = await chokePoint.createView({ type: "list", name: "Mixed", config: { membership: "manual" } });
        const plain = await chokePoint.createView({ type: "list", name: "Plain", config: { membership: "manual" } });
        for (const [view, itemId] of [
          [mixed, note.id],
          [mixed, record.id],
          [plain, note.id],
        ] as const) {
          await chokePoint.addViewItem({ viewId: view.id, itemId, actor: { type: "user" } });
        }
        const agent = await newAgent([{ database: health, access: "read" }]);
        const withRecord = await tools()["view.query"](agent.runId, { viewId: mixed.id });
        const page = JSON.parse(withRecord.result) as { items: { id: string }[] };
        expect(page.items.map((item) => item.id).sort()).toEqual([note.id, record.id].sort());
        expect(withRecord.sensitive).toBe(true);
        const withoutRecord = await tools()["view.query"](agent.runId, { viewId: plain.id });
        expect(withoutRecord.error).toBe(false);
        expect(withoutRecord).not.toHaveProperty("sensitive");
      });
    });

    it("does not mark the page of a view of a non-sensitive database", async () => {
      await inTenant(async () => {
        const open = await newUserDatabase("Open notes");
        const view = await chokePoint.createView({ databaseId: open.id, type: "table", name: "All notes" });
        const agent = await newAgent();
        const outcome = await tools()["view.query"](agent.runId, { viewId: view.id });
        expect(outcome.error).toBe(false);
        expect(outcome).not.toHaveProperty("sensitive");
      });
    });
  });

  describe("writes", () => {
    it("marks item.create, item.patch and item.restore on a sensitive database", async () => {
      await inTenant(async () => {
        const agent = await newAgent([{ database: health, access: "write" }]);
        const created = await tools()["item.create"](agent.runId, {
          databaseId: health.id,
          properties: { name: PRIVATE_NAME },
        });
        expect(created.error).toBe(false);
        expect(created.sensitive).toBe(true);
        const createdItem = JSON.parse(created.result) as { id: string; updatedAt: string };
        // The id of the new item is kept for the run history, which stores the result text redacted (issue #1885).
        expect(created.createdItemId).toBe(createdItem.id);

        const patched = await tools()["item.patch"](agent.runId, {
          itemId: createdItem.id,
          properties: { name: "Renamed diagnosis" },
          ifVersion: createdItem.updatedAt,
        });
        expect(patched.error).toBe(false);
        expect(patched.sensitive).toBe(true);
        // The running turn keeps the real change values; only the stored copy is redacted.
        expect(patched.changes).toEqual([{ key: "name", before: PRIVATE_NAME, after: "Renamed diagnosis" }]);

        await chokePoint.softDeleteItem(health.id, createdItem.id, userId);
        const restored = await tools()["item.restore"](agent.runId, { itemId: createdItem.id });
        expect(restored.error).toBe(false);
        expect(restored.sensitive).toBe(true);
        expect(JSON.parse(restored.result)).toMatchObject({ id: createdItem.id });
      });
    });

    it("does not mark item.create and item.patch on a non-sensitive database", async () => {
      await inTenant(async () => {
        const open = await newUserDatabase("Open notes");
        const agent = await newAgent();
        const created = await tools()["item.create"](agent.runId, {
          databaseId: open.id,
          properties: { name: "Open note" },
        });
        expect(created.error).toBe(false);
        expect(created).not.toHaveProperty("sensitive");
        const createdItem = JSON.parse(created.result) as { id: string; updatedAt: string };
        expect(created.createdItemId).toBe(createdItem.id);
        const patched = await tools()["item.patch"](agent.runId, {
          itemId: createdItem.id,
          properties: { name: "Renamed note" },
          ifVersion: createdItem.updatedAt,
        });
        expect(patched.error).toBe(false);
        expect(patched).not.toHaveProperty("sensitive");
        expect(patched).not.toHaveProperty("createdItemId");
      });
    });

    it("does not mark the deferred item.delete of a sensitive item, and its text carries no item value", async () => {
      await inTenant(async () => {
        const record = await newRecord();
        const agent = await newAgent([{ database: health, access: "write" }]);
        const outcome = await tools()["item.delete"](agent.runId, { itemId: record.id });
        expect(outcome.error).toBe(false);
        expect(outcome.approvalRequestId).toEqual(expect.any(String));
        expect(outcome).not.toHaveProperty("sensitive");
        expect(outcome.result).not.toContain(PRIVATE_NAME);
      });
    });
  });

  describe("a relation target expanded inside the answer", () => {
    /** An open database whose items point at `target` through the relation property `link`; returns one linked pair. */
    async function linkedPair(
      target: DatabaseRow,
      targetItemId: string,
    ): Promise<{ open: DatabaseRow; note: { id: string } }> {
      const open = await newUserDatabase("Open notes");
      const note = await chokePoint.createItem({ databaseId: open.id, properties: { name: "Open note" } });
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: open.id,
        key: "link",
        name: "Link",
        targetDatabaseId: target.id,
      });
      await chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: note.id, targetItemId });
      return { open, note };
    }

    const include = { relations: { link: ["name"] } };

    it("marks item.get of a non-sensitive item whose expanded target is an item of a sensitive database", async () => {
      await inTenant(async () => {
        const record = await newRecord();
        const { note } = await linkedPair(health, record.id);
        const agent = await newAgent([{ database: health, access: "read" }]);
        const outcome = await tools()["item.get"](agent.runId, { itemId: note.id, include });
        expect(outcome.error).toBe(false);
        expect(outcome.sensitive).toBe(true);
        // The running turn keeps the real target.
        expect(JSON.parse(outcome.result)).toMatchObject({
          relations: { link: [{ id: record.id, properties: { name: PRIVATE_NAME } }] },
        });
      });
    });

    it("marks database.query and view.query pages whose items expand a target of a sensitive database", async () => {
      await inTenant(async () => {
        const record = await newRecord();
        const { open, note } = await linkedPair(health, record.id);
        const view = await chokePoint.createView({ databaseId: open.id, type: "table", name: "All notes" });
        const agent = await newAgent([{ database: health, access: "read" }]);
        const queried = await tools()["database.query"](agent.runId, { databaseId: open.id, include });
        expect(JSON.parse(queried.result)).toMatchObject({ items: [{ id: note.id }] });
        expect(queried.sensitive).toBe(true);
        const viewed = await tools()["view.query"](agent.runId, { viewId: view.id, include });
        expect(JSON.parse(viewed.result)).toMatchObject({ items: [{ id: note.id }] });
        expect(viewed.sensitive).toBe(true);
      });
    });

    it("does not mark the answer when the agent may not read the target and gets only its hidden id", async () => {
      await inTenant(async () => {
        const record = await newRecord();
        const { note } = await linkedPair(health, record.id);
        const agent = await newAgent();
        const outcome = await tools()["item.get"](agent.runId, { itemId: note.id, include });
        expect(outcome.error).toBe(false);
        expect(JSON.parse(outcome.result)).toMatchObject({ relations: { link: [{ id: record.id, hidden: true }] } });
        expect(outcome.result).not.toContain(PRIVATE_NAME);
        expect(outcome).not.toHaveProperty("sensitive");
      });
    });

    it("does not mark the answer when every expanded target is in a non-sensitive database", async () => {
      await inTenant(async () => {
        const other = await newUserDatabase("Other notes");
        const otherNote = await chokePoint.createItem({ databaseId: other.id, properties: { name: "Other note" } });
        const { note } = await linkedPair(other, otherNote.id);
        const agent = await newAgent();
        const outcome = await tools()["item.get"](agent.runId, { itemId: note.id, include });
        expect(outcome.error).toBe(false);
        expect(JSON.parse(outcome.result)).toMatchObject({
          relations: { link: [{ id: otherNote.id, properties: { name: "Other note" } }] },
        });
        expect(outcome).not.toHaveProperty("sensitive");
      });
    });

    describe("a relation property projected on the target", () => {
      /** note -link-> middle -toHealth-> `leaf`; the nested target arrives as a reduced entry without a database id. */
      async function chain(leaf: DatabaseRow, leafItemId: string): Promise<{ note: { id: string } }> {
        const middleDatabase = await newUserDatabase("Middle notes");
        const middle = await chokePoint.createItem({ databaseId: middleDatabase.id, properties: { name: "Middle" } });
        const { property: toLeaf } = await chokePoint.createRelationProperty({
          sourceDatabaseId: middleDatabase.id,
          key: "toLeaf",
          name: "To leaf",
          targetDatabaseId: leaf.id,
        });
        await chokePoint.createRelation({
          relationPropertyId: toLeaf.id,
          callerItemId: middle.id,
          targetItemId: leafItemId,
        });
        return { note: (await linkedPair(middleDatabase, middle.id)).note };
      }

      it("marks the answer when the nested target is an item of a sensitive database", async () => {
        await inTenant(async () => {
          const record = await newRecord();
          const { note } = await chain(health, record.id);
          const agent = await newAgent([{ database: health, access: "read" }]);
          const outcome = await tools()["item.get"](agent.runId, {
            itemId: note.id,
            include: { relations: { link: ["toLeaf"] } },
          });
          expect(outcome.error).toBe(false);
          expect(JSON.parse(outcome.result)).toMatchObject({
            relations: { link: [{ properties: { toLeaf: [{ id: record.id, title: PRIVATE_NAME }] } }] },
          });
          expect(outcome.sensitive).toBe(true);
        });
      });

      it("does not mark the answer when the nested target is hidden from the agent", async () => {
        await inTenant(async () => {
          const record = await newRecord();
          const { note } = await chain(health, record.id);
          const agent = await newAgent();
          const outcome = await tools()["item.get"](agent.runId, {
            itemId: note.id,
            include: { relations: { link: ["toLeaf"] } },
          });
          expect(JSON.parse(outcome.result)).toMatchObject({
            relations: { link: [{ properties: { toLeaf: [{ id: record.id, hidden: true }] } }] },
          });
          expect(outcome.result).not.toContain(PRIVATE_NAME);
          expect(outcome).not.toHaveProperty("sensitive");
        });
      });

      it("does not mark the answer when the nested target is in a non-sensitive database", async () => {
        await inTenant(async () => {
          const leafDatabase = await newUserDatabase("Leaf notes");
          const leaf = await chokePoint.createItem({ databaseId: leafDatabase.id, properties: { name: "Leaf note" } });
          const { note } = await chain(leafDatabase, leaf.id);
          const agent = await newAgent();
          const outcome = await tools()["item.get"](agent.runId, {
            itemId: note.id,
            include: { relations: { link: ["toLeaf"] } },
          });
          expect(JSON.parse(outcome.result)).toMatchObject({
            relations: { link: [{ properties: { toLeaf: [{ id: leaf.id, title: "Leaf note" }] } }] },
          });
          expect(outcome).not.toHaveProperty("sensitive");
        });
      });
    });

    describe("an answer whose expanded content names no database", () => {
      it.each([
        ["a target without a database id", { link: [{ id: "target-1", title: PRIVATE_NAME }] }],
        ["a target that is not an object", { link: ["target-1"] }],
        ["a relation entry that is not a list", { link: { id: "target-1" } }],
        ["a relations field that is not an object", "target-1"],
      ])("marks the answer for %s", async (_name, relations) => {
        await inTenant(async () => {
          const open = await newUserDatabase("Open notes");
          const agent = await newAgent();
          stubGatewayAnswer({ id: "item-1", databaseId: open.id, properties: {}, relations });
          const outcome = await tools()["item.get"](agent.runId, { itemId: "item-1" });
          expect(outcome.sensitive).toBe(true);
        });
      });

      it("does not mark an answer whose only target is hidden, or whose target carries a list that is no relation property", async () => {
        await inTenant(async () => {
          const open = await newUserDatabase("Open notes");
          const agent = await newAgent();
          stubGatewayAnswer({
            id: "item-1",
            databaseId: open.id,
            properties: {},
            relations: {
              link: [
                { id: "hidden-1", hidden: true },
                { id: "target-1", databaseId: open.id, title: "t", properties: { name: "n", tags: [{ id: "x" }] } },
              ],
            },
          });
          const outcome = await tools()["item.get"](agent.runId, { itemId: "item-1" });
          expect(outcome).not.toHaveProperty("sensitive");
        });
      });

      it("marks the answer when a projected relation property has no target database in its configuration", async () => {
        await inTenant(async () => {
          const open = await newUserDatabase("Open notes");
          const agent = await newAgent();
          const original = data.createChokePoint;
          vi.spyOn(data, "createChokePoint").mockImplementation((...args) => {
            const real = original(...args);
            vi.spyOn(real, "listProperties").mockResolvedValue([
              { id: "p1", databaseId: open.id, key: "toLeaf", type: "relation", config: {} } as never,
            ]);
            return real;
          });
          stubGatewayAnswer({
            id: "item-1",
            databaseId: open.id,
            properties: {},
            relations: {
              link: [{ id: "t1", databaseId: open.id, title: "t", properties: { toLeaf: [{ id: "l1", title: "x" }] } }],
            },
          });
          const outcome = await tools()["item.get"](agent.runId, { itemId: "item-1" });
          expect(outcome.sensitive).toBe(true);
        });
      });
    });
  });

  it("does not mark an operation that answers with structure only, also on a sensitive database", async () => {
    await inTenant(async () => {
      const agent = await newAgent([{ database: health, access: "read" }]);
      const outcome = await tools()["database.get"](agent.runId, { databaseId: health.id });
      expect(outcome.error).toBe(false);
      expect(JSON.parse(outcome.result)).toMatchObject({ id: health.id, sensitive: true });
      expect(outcome).not.toHaveProperty("sensitive");
    });
  });

  describe("an answer the flag cannot be decided for", () => {
    it("is marked, and the log names the operation, the run and the error class but no value", async () => {
      await inTenant(async () => {
        const agent = await newAgent();
        const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined);
        // A database id that is not a uuid makes the flag lookup fail inside Postgres.
        stubGatewayAnswer({ id: "item-1", databaseId: "not-a-uuid", properties: { name: PRIVATE_NAME } });
        const outcome = await tools()["item.get"](agent.runId, { itemId: "item-1" });
        expect(outcome.error).toBe(false);
        expect(outcome.sensitive).toBe(true);
        expect(JSON.parse(outcome.result)).toMatchObject({ properties: { name: PRIVATE_NAME } });
        expect(logged).toHaveBeenCalledTimes(1);
        const [fields, message] = logged.mock.calls[0] ?? [];
        expect(fields).toEqual({ operation: "item.get", agentRunId: agent.runId, errorName: "error" });
        expect(message).toBe("Could not read whether an agent tool answer is sensitive; treating it as sensitive");
        expect(JSON.stringify(logged.mock.calls)).not.toContain(PRIVATE_NAME);
      });
    });

    it("is marked when the database of the answer does not exist", async () => {
      await inTenant(async () => {
        const agent = await newAgent();
        stubGatewayAnswer({ id: "item-1", databaseId: randomUUID(), properties: { name: PRIVATE_NAME } });
        const outcome = await tools()["item.get"](agent.runId, { itemId: "item-1" });
        expect(outcome.sensitive).toBe(true);
      });
    });
  });

  describe("a query whose database cannot be told from its arguments", () => {
    it.each([
      ["database.query", null],
      ["database.query", { databaseId: 7 }],
      ["view.query", { viewId: 7 }],
      ["view.query", { viewId: randomUUID() }],
    ] as const)("%s with %j is not marked when its page holds no item", async (operation, args) => {
      await inTenant(async () => {
        const agent = await newAgent();
        stubGatewayAnswer({ items: [], nextCursor: null });
        const outcome = await tools()[operation](agent.runId, args);
        expect(outcome.error).toBe(false);
        expect(outcome).not.toHaveProperty("sensitive");
      });
    });

    it("does not mark an answer that names no database", async () => {
      await inTenant(async () => {
        const agent = await newAgent();
        stubGatewayAnswer("plain text");
        const outcome = await tools()["item.get"](agent.runId, { itemId: "item-1" });
        expect(outcome).not.toHaveProperty("sensitive");
      });
    });
  });
});
