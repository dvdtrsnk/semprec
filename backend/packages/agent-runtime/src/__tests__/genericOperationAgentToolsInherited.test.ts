import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as application from "@semprec/application";
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
  listAgentRunEvents,
  loadFullModuleRegistry,
  seedSystem,
  withTransaction,
  type AgentDatabaseAccess,
  type ChokePoint,
  type CollectionMetadataResolver,
  type DatabaseRow,
  type ItemRow,
  type PropertyRow,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { runInTenant } from "@semprec/shared";
import { runAgentTurn } from "../lifecycleAdapter.js";
import { createGenericOperationAgentTools } from "../tools/generic/genericOperationAgentTools.js";
import type { AgentMessage } from "../types.js";

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
const LINKED_FILE_NAME = "Blood test results";

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let registry: ModuleRegistry;
let health: DatabaseRow;
let files: DatabaseRow;
let transcripts: DatabaseRow;
let inbox: DatabaseRow;
let projects: DatabaseRow;
let holders: DatabaseRow;
let outers: DatabaseRow;
let fileToHealth: PropertyRow;
let transcriptToHealth: PropertyRow;
let inboxToHealth: PropertyRow;
let holderToFile: PropertyRow;
let outerToHolder: PropertyRow;

/** Everything below runs as the application does: the runtime role under the tenant's scope. */
function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(getTenantZeroId(), fn);
}

async function systemDatabase(moduleId: string): Promise<DatabaseRow> {
  const database = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, moduleId));
  if (!database) throw new Error(`System database ${moduleId} was not seeded`);
  return database;
}

function tools(): ReturnType<typeof createGenericOperationAgentTools> {
  return createGenericOperationAgentTools(runtime, registry, metadataResolver);
}

/** A run of a fresh Projects item with the given per-database decisions. */
async function newAgent(
  grants: readonly { database: DatabaseRow; access: AgentDatabaseAccess }[] = [],
): Promise<{ runId: string }> {
  const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
  const run = await createAgentRun(runtime, { projectItemId: project.id, triggeredBy: "user", task: "inherited" });
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

const newRecord = () => chokePoint.createItem({ databaseId: health.id, properties: { name: "Private diagnosis" } });
const newFile = (name = LINKED_FILE_NAME) => chokePoint.createItem({ databaseId: files.id, properties: { name } });

async function link(property: PropertyRow, caller: ItemRow, target: ItemRow) {
  await chokePoint.createRelation({
    relationPropertyId: property.id,
    callerItemId: caller.id,
    targetItemId: target.id,
  });
  return { relationPropertyId: property.id, callerItemId: caller.id, targetItemId: target.id };
}

/** A file linked to a health record. */
async function newLinkedFile(name?: string): Promise<ItemRow> {
  const file = await newFile(name);
  await link(fileToHealth, file, await newRecord());
  return file;
}

describe("marking the answers that return an item linked to a sensitive record (issue #1999)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    await seedSystem(admin, createViewTypeRegistry());
    await createTenantZeroUser(admin);
    registry = await loadFullModuleRegistry();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    chokePoint = createChokePoint(runtime);
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await inTenant(async () => {
      health = await systemDatabase("healthRecords");
      files = await systemDatabase("files");
      transcripts = await systemDatabase("transcripts");
      inbox = await systemDatabase("inbox");
      projects = await systemDatabase("projects");
      const filesProperties = await chokePoint.listProperties(files.id);
      const healthProperty = filesProperties.find((property) => property.key === "healthRecords");
      if (!healthProperty) throw new Error("The Files database has no healthRecords relation");
      fileToHealth = healthProperty;

      // A fixture the API cannot produce: the schemas of the system databases are locked until a code-level
      // migration changes them, and neither Transcripts nor Inbox has a relation to Health records yet. The
      // superuser pool unlocks them so the relation properties are created through the choke point.
      await admin.query("UPDATE databases SET schema_locked = false WHERE id = ANY($1::uuid[])", [
        [transcripts.id, inbox.id],
      ]);
      transcriptToHealth = (
        await chokePoint.createRelationProperty({
          sourceDatabaseId: transcripts.id,
          key: "diagnoses",
          name: "Diagnoses",
          targetDatabaseId: health.id,
        })
      ).property;
      inboxToHealth = (
        await chokePoint.createRelationProperty({
          sourceDatabaseId: inbox.id,
          key: "diagnoses",
          name: "Diagnoses",
          targetDatabaseId: health.id,
        })
      ).property;
      holders = await chokePoint.createDatabase({ name: "Holders" });
      await chokePoint.createProperty({ databaseId: holders.id, key: "name", name: "Name", type: "title" });
      holderToFile = (
        await chokePoint.createRelationProperty({
          sourceDatabaseId: holders.id,
          key: "files",
          name: "Files",
          targetDatabaseId: files.id,
        })
      ).property;
      outers = await chokePoint.createDatabase({ name: "Outers" });
      await chokePoint.createProperty({ databaseId: outers.id, key: "name", name: "Name", type: "title" });
      outerToHolder = (
        await chokePoint.createRelationProperty({
          sourceDatabaseId: outers.id,
          key: "holders",
          name: "Holders",
          targetDatabaseId: holders.id,
        })
      ).property;
    });
  }, SEEDING_TIMEOUT_MS);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  describe("item.get", () => {
    it("marks a linked file read with a grant and still returns the real item to the running turn", async () => {
      await inTenant(async () => {
        const file = await newLinkedFile();
        const agent = await newAgent([{ database: health, access: "read" }]);
        const outcome = await tools()["item.get"](agent.runId, { itemId: file.id });
        expect(outcome.error).toBe(false);
        expect(outcome.sensitive).toBe(true);
        expect(JSON.parse(outcome.result)).toMatchObject({ id: file.id, properties: { name: LINKED_FILE_NAME } });
      });
    });

    it("refuses a linked file without a grant, does not mark the refusal and keeps the file's name out of it", async () => {
      await inTenant(async () => {
        const file = await newLinkedFile();
        const agent = await newAgent();
        const outcome = await tools()["item.get"](agent.runId, { itemId: file.id });
        expect(outcome.error).toBe(true);
        expect(outcome.result).toMatch(/^forbidden:/);
        expect(outcome).not.toHaveProperty("sensitive");
        expect(outcome.result).not.toContain(LINKED_FILE_NAME);
      });
    });

    it("does not mark a file that is not linked, whatever its name says", async () => {
      await inTenant(async () => {
        const file = await newFile("Medical report");
        const agent = await newAgent();
        const outcome = await tools()["item.get"](agent.runId, { itemId: file.id });
        expect(outcome.error).toBe(false);
        expect(outcome).not.toHaveProperty("sensitive");
        expect(JSON.parse(outcome.result)).toMatchObject({ id: file.id });
      });
    });

    it("marks a linked transcript and a linked Inbox entry, and not a transcript about health without a link", async () => {
      await inTenant(async () => {
        const transcript = await chokePoint.createItem({
          databaseId: transcripts.id,
          properties: { name: "Doctor visit" },
        });
        const entry = await chokePoint.createItem({
          databaseId: inbox.id,
          properties: { date: "2026-11-01", time: "10:00", text: "Doctor visit" },
        });
        const unlinked = await chokePoint.createItem({
          databaseId: transcripts.id,
          properties: { name: "Doctor visit, not linked" },
        });
        await link(transcriptToHealth, transcript, await newRecord());
        await link(inboxToHealth, entry, await newRecord());
        const agent = await newAgent([{ database: health, access: "read" }]);
        for (const item of [transcript, entry]) {
          const outcome = await tools()["item.get"](agent.runId, { itemId: item.id });
          expect(outcome.error).toBe(false);
          expect(outcome.sensitive).toBe(true);
        }
        const open = await tools()["item.get"](agent.runId, { itemId: unlinked.id });
        expect(open.error).toBe(false);
        expect(open).not.toHaveProperty("sensitive");
      });
    });

    it("stops marking the file once the link is removed", async () => {
      await inTenant(async () => {
        const file = await newFile();
        const edge = await link(fileToHealth, file, await newRecord());
        const agent = await newAgent([{ database: health, access: "read" }]);
        expect((await tools()["item.get"](agent.runId, { itemId: file.id })).sensitive).toBe(true);
        await chokePoint.deleteRelation(edge);
        const outcome = await tools()["item.get"](agent.runId, { itemId: file.id });
        expect(outcome.error).toBe(false);
        expect(outcome).not.toHaveProperty("sensitive");
      });
    });
  });

  describe("an answer id that cannot name a stored item", () => {
    it("is not looked up and does not mark the answer, while the run still resolves for real", async () => {
      await inTenant(async () => {
        const open = await chokePoint.createDatabase({ name: "Open notes" });
        const agent = await newAgent();
        const originalFactory = application.createGenericOperationGateway;
        vi.spyOn(application, "createGenericOperationGateway").mockImplementation((...args) => {
          const gateway = originalFactory(...args);
          vi.spyOn(gateway, "invoke").mockImplementation(
            async () => ({ id: "not-a-uuid", databaseId: open.id, properties: {} }) as never,
          );
          return gateway;
        });
        const outcome = await tools()["item.get"](agent.runId, { itemId: "not-a-uuid" });
        expect(outcome.error).toBe(false);
        expect(outcome).not.toHaveProperty("sensitive");
      });
    });
  });

  describe("database.query and item.patch", () => {
    it("omits the linked file from the page of an agent without a grant and marks nothing", async () => {
      await inTenant(async () => {
        const [linked, free] = [await newLinkedFile("Linked scan"), await newFile("Free scan")];
        const agent = await newAgent();
        const outcome = await tools()["database.query"](agent.runId, { databaseId: files.id, limit: 200 });
        expect(outcome.error).toBe(false);
        const page = JSON.parse(outcome.result) as { items: { id: string }[] };
        const returned = page.items.map((item) => item.id);
        expect(returned).toContain(free.id);
        expect(returned).not.toContain(linked.id);
        expect(outcome).not.toHaveProperty("sensitive");
      });
    });

    it("marks the page that returns the linked file to an agent with a read grant", async () => {
      await inTenant(async () => {
        const linked = await newLinkedFile("Granted scan");
        const agent = await newAgent([{ database: health, access: "read" }]);
        const outcome = await tools()["database.query"](agent.runId, { databaseId: files.id, limit: 200 });
        const page = JSON.parse(outcome.result) as { items: { id: string }[] };
        expect(page.items.map((item) => item.id)).toContain(linked.id);
        expect(outcome.sensitive).toBe(true);
      });
    });

    it("marks the answer of a patch of a linked file and keeps the change values for the running turn", async () => {
      await inTenant(async () => {
        const file = await newLinkedFile("Before");
        const agent = await newAgent([{ database: health, access: "write" }]);
        const outcome = await tools()["item.patch"](agent.runId, {
          itemId: file.id,
          properties: { name: "After" },
          ifVersion: file.updatedAt,
        });
        expect(outcome.error).toBe(false);
        expect(outcome.sensitive).toBe(true);
        expect(outcome.changes).toEqual([{ key: "name", before: "Before", after: "After" }]);
      });
    });
  });

  describe("expanded relation targets", () => {
    async function holderOf(file: ItemRow): Promise<ItemRow> {
      const holder = await chokePoint.createItem({ databaseId: holders.id, properties: { name: "Holder" } });
      await link(holderToFile, holder, file);
      return holder;
    }

    it("marks the answer of an open item whose expanded target is a linked file the agent may read", async () => {
      await inTenant(async () => {
        const holder = await holderOf(await newLinkedFile());
        const agent = await newAgent([{ database: health, access: "read" }]);
        const outcome = await tools()["item.get"](agent.runId, {
          itemId: holder.id,
          include: { relations: { files: ["name"] } },
        });
        expect(outcome.error).toBe(false);
        expect(outcome.result).toContain(LINKED_FILE_NAME);
        expect(outcome.sensitive).toBe(true);
      });
    });

    it("does not mark the answer when the linked file is hidden from the agent, and does not mark an open target", async () => {
      await inTenant(async () => {
        const hiddenHolder = await holderOf(await newLinkedFile());
        const openHolder = await holderOf(await newFile("Open scan"));
        const agent = await newAgent();
        const hidden = await tools()["item.get"](agent.runId, {
          itemId: hiddenHolder.id,
          include: { relations: { files: ["name"] } },
        });
        expect(hidden.error).toBe(false);
        expect(hidden.result).not.toContain(LINKED_FILE_NAME);
        expect(hidden).not.toHaveProperty("sensitive");
        const open = await tools()["item.get"](agent.runId, {
          itemId: openHolder.id,
          include: { relations: { files: ["name"] } },
        });
        expect(open.error).toBe(false);
        expect(open.result).toContain("Open scan");
        expect(open).not.toHaveProperty("sensitive");
      });
    });
  });

  describe("a relation property projected on an expanded target", () => {
    /** An item that reaches `file` only through a holder: `outer.holders` is expanded and `holder.files` is projected. */
    async function outerOf(file: ItemRow): Promise<ItemRow> {
      const holder = await chokePoint.createItem({ databaseId: holders.id, properties: { name: "Holder" } });
      await link(holderToFile, holder, file);
      const outer = await chokePoint.createItem({ databaseId: outers.id, properties: { name: "Outer" } });
      await link(outerToHolder, outer, holder);
      return outer;
    }
    const read = (runId: string, outer: ItemRow) =>
      tools()["item.get"](runId, { itemId: outer.id, include: { relations: { holders: ["files"] } } });

    it("marks the answer when the nested entry is a linked file the agent may read and carries its name", async () => {
      await inTenant(async () => {
        const outer = await outerOf(await newLinkedFile());
        const agent = await newAgent([{ database: health, access: "read" }]);
        const outcome = await read(agent.runId, outer);
        expect(outcome.error).toBe(false);
        expect(outcome.result).toContain(LINKED_FILE_NAME);
        expect(outcome.sensitive).toBe(true);
      });
    });

    it("does not mark the answer when the nested linked file is hidden, nor when it is not linked", async () => {
      await inTenant(async () => {
        const hiddenOuter = await outerOf(await newLinkedFile());
        const openOuter = await outerOf(await newFile("Open scan"));
        const agent = await newAgent();
        const hidden = await read(agent.runId, hiddenOuter);
        expect(hidden.error).toBe(false);
        expect(hidden.result).not.toContain(LINKED_FILE_NAME);
        expect(hidden).not.toHaveProperty("sensitive");
        const open = await read(agent.runId, openOuter);
        expect(open.error).toBe(false);
        expect(open.result).toContain("Open scan");
        expect(open).not.toHaveProperty("sensitive");
      });
    });
  });

  describe("the stored tool result", () => {
    it("stores the result of a linked file read with a grant as the marker and the result of an unlinked file in full", async () => {
      const file = await inTenant(newLinkedFile);
      const free = await inTenant(() => newFile("Open scan"));
      const agent = await inTenant(() => newAgent([{ database: health, access: "read" }]));
      const reads = await inTenant(async () => [
        await tools()["item.get"](agent.runId, { itemId: file.id }),
        await tools()["item.get"](agent.runId, { itemId: free.id }),
      ]);
      expect(reads.map((read) => read.sensitive === true)).toEqual([true, false]);

      // The composition root copies the tool's mark into the pi result details (`agentSessionComposition.ts`).
      const turn: AgentMessage[] = [
        { kind: "user_message", text: "read the files", context: [] },
        { kind: "turn_start" },
      ];
      for (const [index, read] of reads.entries()) {
        const toolCallId = `call-${index}`;
        turn.push(
          { kind: "tool_use", toolCallId, name: "item_get", operation: "item.get", arguments: {} },
          {
            kind: "tool_result",
            toolCallId,
            name: "item_get",
            operation: "item.get",
            result: {
              content: [{ type: "text", text: read.result }],
              details: { error: read.error, ...(read.sensitive ? { sensitive: true } : {}) },
            },
            isError: read.error,
          },
        );
      }
      turn.push({ kind: "turn_end" });
      await inTenant(() =>
        runAgentTurn(
          runtime,
          agent.runId,
          (async function* () {
            yield* turn;
          })(),
        ),
      );

      const stored = await inTenant(async () =>
        (await listAgentRunEvents(runtime, agent.runId)).filter((event) => event.kind === "tool_result"),
      );
      expect(stored).toHaveLength(2);
      const [linkedResult, openResult] = stored.map((event) => JSON.stringify(event.payload));
      expect(linkedResult).toContain("[redacted: sensitive]");
      expect(linkedResult).not.toContain(LINKED_FILE_NAME);
      expect(openResult).toContain("Open scan");
    });
  });
});
