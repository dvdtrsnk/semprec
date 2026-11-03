import type { CollectionMetadataResolver } from "@semprec/data";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as application from "@semprec/application";
import type { Pool } from "pg";
import { createTenantZeroUser, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createItemWithClient,
  createChokePoint,
  createViewTypeRegistry,
  loadFullModuleRegistry,
  getDatabaseByModuleId,
  seedSystem,
  withTransaction,
  type ChokePoint,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { GENERIC_OPERATION_NAMES } from "@semprec/shared";
import {
  TOOL_CHANGE_VALUE_MAX_LENGTH,
  createGenericOperationAgentTools,
  listGrantedGenericOperationAgentTools,
} from "../tools/generic/genericOperationAgentTools.js";

const testMetadataResolver: CollectionMetadataResolver = {
  resolve: () => ({ icon: null, color: null, overviewOrder: null, switcherOrder: null, clientVisible: true }),
};

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry: ModuleRegistry = await loadFullModuleRegistry();

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

async function projectsDatabaseId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = 'projects'`);
  if (!rows[0]) throw new Error("Projects database was not seeded");
  return rows[0].id;
}

async function createProjectItem(): Promise<string> {
  const projectsDbId = await projectsDatabaseId();
  const item = await chokePoint.createItem({ databaseId: projectsDbId, properties: {} });
  return item.id;
}

function parseSuccess<T>(outcome: { error: boolean; result: string }): T {
  expect(outcome.error).toBe(false);
  return JSON.parse(outcome.result) as T;
}

describe("generic operation AgentTools (issue #220)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    await createUser();
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("createGenericOperationAgentTools", () => {
    it("refuses a Journal item without type or period through the agent tool without creating a row", async () => {
      const journal = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "journal"));
      if (!journal) throw new Error("Journal database was not seeded");
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "create a journal entry" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);

      const outcome = await tools["item.create"](run.id, { databaseId: journal.id, properties: {} });

      expect(outcome.error).toBe(true);
      expect(outcome.result).toMatch(/^forbidden:/);
      const { rows } = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM items WHERE database_id = $1",
        [journal.id],
      );
      expect(rows[0]?.count).toBe(0);
    });

    it("returns owner_violation, never touching the choke point, for a currentRunId that doesn't exist", async () => {
      const tools = createGenericOperationAgentTools(pool, undefined, testMetadataResolver);

      const outcome = await tools["item.get"](randomUUID(), { itemId: randomUUID() });

      expect(outcome.error).toBe(true);
      expect(outcome.result).toMatch(/^owner_violation:/);
    });

    it("returns owner_violation for a run whose project_item_id is NULL", async () => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "no project" });
      const tools = createGenericOperationAgentTools(pool, undefined, testMetadataResolver);

      const outcome = await tools["item.get"](run.id, { itemId: randomUUID() });

      expect(outcome.error).toBe(true);
      expect(outcome.result).toMatch(/^owner_violation:/);
    });

    it("derives the actor exclusively from the persisted run — a spoofed identity-shaped field in args is rejected, and a legitimate call attributes the write to the run's own project", async () => {
      const projectItemId = await createProjectItem();
      const otherProjectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "make a view" });
      const database = await chokePoint.createDatabase({ name: "Tools DB" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);

      // Every generic-operation input schema is a strict zod object with none of these field
      // names (see AuthenticatedActor's own doc comment) — an attempt to smuggle a different
      // identity in through `args` fails validation rather than silently being ignored.
      const spoofed = await tools["view.create"](run.id, {
        databaseId: database.id,
        type: "table",
        name: "Stolen view",
        agentProjectItemId: otherProjectItemId,
        runId: randomUUID(),
        userId: randomUUID(),
      });
      expect(spoofed.error).toBe(true);

      const legit = await tools["view.create"](run.id, {
        databaseId: database.id,
        type: "table",
        name: "Legit view",
      });
      const view = parseSuccess<{ id: string; creatorProjectItemId: string | null }>(legit);
      expect(view.creatorProjectItemId).toBe(projectItemId);
      expect(view.creatorProjectItemId).not.toBe(otherProjectItemId);
    });

    it("a destructive operation, granted, returns a synthetic-success result and creates exactly one pending approval request, without executing", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete a view" });
      // Owned by this same agent identity (issue #89's preflight now runs the destructive
      // command's own `assertViewWritable` ownership check before ever creating the approval
      // row) — a view owned by someone else is exactly what that preflight must reject outright,
      // not synthesize a pending approval for, so this fixture has to match the calling agent.
      const view = await chokePoint.createView(
        { type: "list", name: "Scratch", config: { membership: "manual" } },
        { type: "ai_agent", agentProjectItemId: projectItemId },
      );
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);

      const outcome = await tools["view.delete"](run.id, { viewId: view.id });

      expect(outcome.error).toBe(false);
      expect(outcome.result).toContain("requires human approval");

      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM approval_requests WHERE agent_run_id = $1`,
        [run.id],
      );
      expect(rows[0]!.count).toBe(1);
      expect(await chokePoint.getView(view.id)).not.toBeNull();
    });

    it("returns the id of the approval request it created as approvalRequestId, with the same text", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete a view" });
      const view = await chokePoint.createView(
        { type: "list", name: "Scratch", config: { membership: "manual" } },
        { type: "ai_agent", agentProjectItemId: projectItemId },
      );
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);

      const outcome = await tools["view.delete"](run.id, { viewId: view.id });

      const { rows } = await pool.query<{ id: string }>(`SELECT id FROM approval_requests WHERE agent_run_id = $1`, [
        run.id,
      ]);
      expect(outcome.approvalRequestId).toBe(rows[0]!.id);
      expect(outcome.result).toContain(`Approval request ${rows[0]!.id} has been created`);
      expect(outcome.changes).toBeUndefined();
    });
  });

  describe("item.patch changes", () => {
    it("preserves write classification through the actual registered email projection", async () => {
      const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "emails"));
      if (!database) throw new Error("Emails not seeded");
      const item = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          {
            databaseId: database.id,
            properties: { body: "<p>safe</p><script>projection-sentinel</script>", read: false },
          },
          { allowedSystemKeys: ["body"] },
        ),
      );
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "patch" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
      const outcome = await tools["item.patch"](run.id, {
        itemId: item.id,
        properties: { read: true },
        ifVersion: item.updatedAt,
      });
      expect(outcome.error).toBe(false);
      expect(outcome.result).toContain("safe");
      expect(outcome.result).not.toContain("projection-sentinel");
      expect(outcome.changes).toEqual([{ key: "read", before: false, after: true }]);
    });
    async function patchFixture() {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "patch" });
      const database = await chokePoint.createDatabase({ name: "Tasks for changes" });
      await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "text" });
      await chokePoint.createProperty({ databaseId: database.id, key: "due", name: "Due", type: "text" });
      await chokePoint.createProperty({ databaseId: database.id, key: "body", name: "Body", type: "longText" });
      const item = await chokePoint.createItem({
        databaseId: database.id,
        properties: { title: "Write", due: "2026-10-21T14:00", body: "secret old body" },
      });
      return { run, item, tools: createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver) };
    }

    it("reports the previous and new value of a changed property", async () => {
      const { run, item, tools } = await patchFixture();

      const outcome = await tools["item.patch"](run.id, {
        itemId: item.id,
        properties: { due: "2026-10-22T09:00" },
        ifVersion: item.updatedAt,
      });

      expect(outcome.error).toBe(false);
      expect(outcome.changes).toEqual([{ key: "due", before: "2026-10-21T14:00", after: "2026-10-22T09:00" }]);
      expect(outcome.approvalRequestId).toBeUndefined();
    });

    it("keeps a changed key without before when the operation output omits its previous value", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "patch" });
      const database = await chokePoint.createDatabase({ name: "Missing previous" });
      await chokePoint.createProperty({ databaseId: database.id, key: "due", name: "Due", type: "text" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: { due: "old" } });
      const originalFactory = application.createGenericOperationGateway;
      const factorySpy = vi.spyOn(application, "createGenericOperationGateway").mockImplementation((...args) => {
        const gateway = originalFactory(...args);
        const invoke = gateway.invoke.bind(gateway);
        vi.spyOn(gateway, "invoke").mockImplementation(async (...call) => {
          const output = await invoke(...call);
          if (call[0] === "item.patch") Object.defineProperty(output, "previous", { value: {} });
          return output;
        });
        return gateway;
      });
      try {
        const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
        const outcome = await tools["item.patch"](run.id, {
          itemId: item.id,
          properties: { due: "new" },
          ifVersion: item.updatedAt,
        });
        expect(outcome.error).toBe(false);
        expect(outcome.changes).toEqual([{ key: "due", after: "new" }]);
        expect(outcome.changes?.[0]).not.toHaveProperty("before");
      } finally {
        factorySpy.mockRestore();
        vi.restoreAllMocks();
      }
    });

    it("shortens long string values and stores no content of a longText property", async () => {
      const { run, item, tools } = await patchFixture();
      const long = "x".repeat(TOOL_CHANGE_VALUE_MAX_LENGTH + 50);

      const outcome = await tools["item.patch"](run.id, {
        itemId: item.id,
        properties: { title: long, body: "secret new body" },
        ifVersion: item.updatedAt,
      });

      expect(outcome.error).toBe(false);
      expect(outcome.changes).toEqual([
        { key: "title", before: "Write", after: "x".repeat(TOOL_CHANGE_VALUE_MAX_LENGTH) },
        { key: "body" },
      ]);
      expect(JSON.stringify(outcome.changes)).not.toContain("secret");
    });

    it.each(["type change", "deletion"] as const)(
      "keeps longText values private after a post-write %s",
      async (change) => {
        const projectItemId = await createProjectItem();
        const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "patch" });
        const database = await chokePoint.createDatabase({ name: "Redaction" });
        const property = await chokePoint.createProperty({
          databaseId: database.id,
          key: "body",
          name: "Body",
          type: "longText",
        });
        const item = await chokePoint.createItem({ databaseId: database.id, properties: { body: "old secret" } });
        const originalFactory = application.createGenericOperationGateway;
        const factorySpy = vi.spyOn(application, "createGenericOperationGateway").mockImplementation((...args) => {
          const gateway = originalFactory(...args);
          const invoke = gateway.invoke.bind(gateway);
          vi.spyOn(gateway, "invoke").mockImplementation(async (...call) => {
            const output = await invoke(...call);
            if (call[0] === "item.patch") {
              if (change === "type change") {
                // The public conversion catalog has no longText-to-text path; simulate the committed schema change directly.
                const updated = await withTransaction(pool, (client) =>
                  client.query("UPDATE properties SET type = 'text' WHERE id = $1", [property.id]),
                );
                expect(updated.rowCount).toBe(1);
              } else await chokePoint.deleteProperty(property.id);
            }
            return output;
          });
          return gateway;
        });
        try {
          const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
          const result = await tools["item.patch"](run.id, {
            itemId: item.id,
            properties: { body: "new secret" },
            ifVersion: item.updatedAt,
          });
          expect(result.error).toBe(false);
          expect(result.changes).toEqual([{ key: "body" }]);
          expect(JSON.stringify(result.changes)).not.toContain("secret");
        } finally {
          factorySpy.mockRestore();
          vi.restoreAllMocks();
        }
      },
    );

    it.each(["missing", "invalid"] as const)(
      "fails closed when an item.patch classification carrier is %s",
      async (mode) => {
        const { run, item } = await patchFixture();
        const originalFactory = application.createGenericOperationGateway;
        const factorySpy = vi.spyOn(application, "createGenericOperationGateway").mockImplementation((...args) => {
          const gateway = originalFactory(...args);
          const invoke = gateway.invoke.bind(gateway);
          vi.spyOn(gateway, "invoke").mockImplementation(async (...call) => {
            const output = await invoke(...call);
            if (call[0] === "item.patch") {
              const symbols = Object.getOwnPropertySymbols(output);
              expect(symbols).toHaveLength(1);
              if (mode === "missing") Reflect.deleteProperty(output, symbols[0]!);
              else Object.defineProperty(output, symbols[0]!, { value: "invalid" });
            }
            return output;
          });
          return gateway;
        });
        try {
          const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
          const result = await tools["item.patch"](run.id, {
            itemId: item.id,
            properties: { due: "new" },
            ifVersion: item.updatedAt,
          });
          expect(result.error).toBe(false);
          expect(result.changes).toEqual([{ key: "due" }]);
        } finally {
          factorySpy.mockRestore();
          vi.restoreAllMocks();
        }
      },
    );

    it("stores no changes for a failed patch or for a read", async () => {
      const { run, item, tools } = await patchFixture();

      const failed = await tools["item.patch"](run.id, {
        itemId: item.id,
        properties: { due: "later" },
        ifVersion: "2000-01-01T00:00:00.000Z",
      });
      const read = await tools["item.get"](run.id, { itemId: item.id });

      expect(failed.error).toBe(true);
      expect(failed.changes).toBeUndefined();
      expect(read.error).toBe(false);
      expect(read.changes).toBeUndefined();
      expect(read.approvalRequestId).toBeUndefined();
    });
  });

  describe("listGrantedGenericOperationAgentTools", () => {
    it("returns [] for a run with no project context", async () => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "no project" });

      const granted = await listGrantedGenericOperationAgentTools(pool, moduleRegistry, run.id, testMetadataResolver);

      expect(granted).toEqual([]);
    });

    it("returns [] when no moduleRegistry is supplied — an ungranted operation is absent, never present-but-forbidden", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "check tools" });

      const granted = await listGrantedGenericOperationAgentTools(pool, undefined, run.id, testMetadataResolver);

      expect(granted).toEqual([]);
    });

    it("returns every operation once every generic-operation capability is granted", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "check tools" });

      const granted = await listGrantedGenericOperationAgentTools(pool, moduleRegistry, run.id, testMetadataResolver);

      expect(granted.sort()).toEqual([...GENERIC_OPERATION_NAMES].sort());
    });
  });
});
