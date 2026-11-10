import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModuleRegistry } from "@semprec/module-registry";
import { runInTenant } from "@semprec/shared";
import {
  createInboxItemWithClient,
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  CORE_AGENT_RUN_ACTION_ID,
  createAgentRun,
  createChokePoint,
  createHeartbeat,
  createSemprecTickAction,
  getDatabaseByModuleId,
  loadFullModuleRegistry,
  sendSempMessage,
  createUser,
  generatePermissionManifest,
  manualHeartbeatFireJobKey,
  resolveModuleAgentToolsForRun,
  seedSystem,
  setHeartbeatEnabled,
  withTransaction,
} from "@semprec/data";
import { createAgentSessionFactoryForRun } from "../agentSessionComposition.js";
import * as piSession from "../piAgentSession.js";
import type { PiAgentSessionFactoryOptions } from "../piAgentSession.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
const fixturePath = new URL(
  "../../../../packages/module-registry/src/__tests__/fixtures/ownedAgentToolsModule.js",
  import.meta.url,
).href;
const corePath = new URL("../../../../packages/data/src/chokePoint/schemaCoreModuleManifest.js", import.meta.url).href;

describe("module agent tools under project ownership", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  it("resolves the actual Inbox tool for its tick-produced clarification card and refuses other tenants and cards", async () => {
    const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const foreign = await createTestTenant(admin);
    const make = async (owner: string) => {
      await createUser(admin, { tenantId: owner, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
      return runInTenant(owner, async () => {
        await seedSystem(pool);
        const dbs = await withTransaction(pool, async (client) => ({
          inbox: await getDatabaseByModuleId(client, "inbox"),
          types: await getDatabaseByModuleId(client, "inboxItemTypes"),
          proposals: await getDatabaseByModuleId(client, "processingProposals"),
        }));
        if (!dbs.inbox?.ownerProjectItemId || !dbs.types || !dbs.proposals) throw new Error("Missing Inbox setup");
        const projectId = dbs.inbox.ownerProjectItemId;
        const source = await withTransaction(pool, (client) =>
          createInboxItemWithClient(client, {
            inboxDatabaseId: dbs.inbox!.id,
            date: "2026-11-06",
            time: "12:00",
            text: "",
          }),
        );
        const tick = createSemprecTickAction(pool, async () => {
          throw new Error("Unexpected model computation");
        });
        await tick(
          {
            inboxDatabaseId: dbs.inbox.id,
            inboxItemTypesDatabaseId: dbs.types.id,
            processingProposalsDatabaseId: dbs.proposals.id,
          },
          { heartbeatId: randomUUID(), projectItemId: projectId, itemId: source.id },
        );
        const cards = await pool.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL",
          [dbs.proposals.id],
        );
        if (cards.rows.length !== 1 || !cards.rows[0]) throw new Error("Missing clarification card");
        const cardId = cards.rows[0].id;
        const sent = await withTransaction(pool, (client) =>
          sendSempMessage(client, {
            subject: { inboxItemId: source.id, proposalId: cardId },
            text: "Question",
            context: [],
            hasContext: false,
          }),
        );
        const run = await createAgentRun(pool, {
          projectItemId: projectId,
          threadId: sent.threadId,
          triggeredBy: "user",
          unit: "session",
          task: "Question",
        });
        return { projectId, source, cardId, run, proposalsId: dbs.proposals.id };
      });
    };
    const own = await make(tenant);
    const other = await make(foreign);
    await runInTenant(tenant, async () => {
      const registry = await loadFullModuleRegistry();
      const tools = await resolveModuleAgentToolsForRun(pool, registry, own.run.id, own.projectId);
      const tool = tools.find((entry) => entry.name === "inbox.proposal.get");
      if (!tool) throw new Error("Inbox proposal tool missing from registry");
      expect(tool.acceptsArguments({ proposalId: own.cardId, extra: true })).toBe(false);
      const before = await pool.query<{ items: number; edges: number; events: number; attachments: number }>(
        "SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM item_relations) AS edges, (SELECT count(*)::int FROM agent_run_events) AS events, (SELECT count(*)::int FROM inbox_attachments) AS attachments",
      );
      const result = await tool.invoke({ proposalId: own.cardId });
      expect(result.error).toBe(false);
      const decoded: unknown = JSON.parse(result.result);
      if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
        throw new Error("Invalid tool result");
      expect(decoded).toMatchObject({
        captureText: "",
        attachments: [],
        envelope: null,
        status: "needsClarification",
      });
      const denied = await tool.invoke({ proposalId: other.cardId });
      const missing = await tool.invoke({ proposalId: randomUUID() });
      expect(denied).toEqual(missing);
      expect(denied).toEqual({ error: true, result: "Proposal not found" });
      expect(
        (
          await pool.query<{ items: number; edges: number; events: number; attachments: number }>(
            "SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM item_relations) AS edges, (SELECT count(*)::int FROM agent_run_events) AS events, (SELECT count(*)::int FROM inbox_attachments) AS attachments",
          )
        ).rows,
      ).toEqual(before.rows);
    });
  });

  it("admits a module only when every declared database belongs to this project and composes callable tools", async () =>
    runInTenant(tenant, async () => {
      await seedSystem(pool);
      const cp = createChokePoint(pool);
      const projects = (await cp.listDatabases()).find((db) => db.key === "projects");
      if (!projects) throw new Error("Projects missing");
      const project = await cp.createItem({ databaseId: projects.id, properties: { name: "Owner" } });
      const other = await cp.createItem({ databaseId: projects.id, properties: { name: "Other" } });
      const heartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(client, {
          projectItemId: project.id,
          name: "Own",
          rule: { kind: "interval", minutes: 5 },
          actionId: CORE_AGENT_RUN_ACTION_ID,
          actionConfig: { task: "work" },
        }),
      );
      const foreignHeartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(client, {
          projectItemId: other.id,
          name: "Other",
          rule: { kind: "interval", minutes: 5 },
          actionId: CORE_AGENT_RUN_ACTION_ID,
          actionConfig: { task: "work" },
        }),
      );
      const user = await createUser(admin, {
        tenantId: tenant,
        email: `module-${tenant}@example.test`,
        passwordHash: "unused",
      });
      const run = await createAgentRun(pool, {
        projectItemId: project.id,
        userId: user.id,
        triggeredBy: "user",
        task: "tools",
      });
      const registry = new ModuleRegistry(() => new Set(["ownedTools", "schemaCore", "noDatabase", "readOnly"]));
      await registry.loadModule(corePath);
      await registry.loadModule(fixturePath);
      await registry.loadModule(
        new URL("../../../../packages/module-registry/src/__tests__/fixtures/noDatabaseAgentModule.js", import.meta.url)
          .href,
      );
      await registry.loadModule(
        new URL("../../../../packages/module-registry/src/__tests__/fixtures/readOnlyAgentModule.js", import.meta.url)
          .href,
      );
      const ruleKinds = new Map(
        (await registry.getHeartbeatRuleKindDefinitions()).map((definition) => [
          definition.kind,
          { schema: definition.schema, nextFireAt: definition.nextFireAt },
        ]),
      );
      const customHeartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(
          client,
          {
            projectItemId: project.id,
            name: "Module rule",
            rule: { kind: "owned.periodic" },
            actionId: CORE_AGENT_RUN_ACTION_ID,
            actionConfig: { task: "work" },
          },
          ruleKinds,
        ),
      );
      const granted = async () =>
        (
          await withTransaction(pool, (client) =>
            generatePermissionManifest(client, project.id, { moduleRegistry: registry }),
          )
        ).grantedCapabilities;
      expect(await granted()).not.toContain("owned.read");
      expect(await granted()).not.toContain("empty.read");
      let deniedOptions: PiAgentSessionFactoryOptions | undefined;
      const deniedSpy = vi.spyOn(piSession, "createPiAgentSessionFactory").mockImplementation((value) => {
        deniedOptions = value;
        return () => ({ async *messages() {} });
      });
      try {
        const faux = fauxProvider();
        await createAgentSessionFactoryForRun(
          pool,
          registry,
          {
            model: faux.getModel(),
            streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
            isBudgetRefusal: () => false,
          },
          run,
        );
        if (!deniedOptions) throw new Error("Session was not composed");
        expect(deniedOptions.tools.map((tool) => tool.name)).not.toContain("owned_inspect");
      } finally {
        deniedSpy.mockRestore();
      }
      const inbox = (await cp.listDatabases()).find((database) => database.ownerModuleId === "inbox");
      if (!inbox?.ownerProjectItemId) throw new Error("Owned Inbox missing");
      const inboxProjectId = inbox.ownerProjectItemId;
      const inboxGrant = await withTransaction(pool, (client) =>
        generatePermissionManifest(client, inboxProjectId, { moduleRegistry: registry }),
      );
      expect(inboxGrant.grantedCapabilities).not.toContain("readonly.read");
      const one = await cp.createDatabase({
        name: null,
        key: "ownedOne",
        system: true,
        ownerProjectItemId: project.id,
      });
      expect(await granted()).not.toContain("owned.read");
      const two = await cp.createDatabase({ name: null, key: "ownedTwo", system: true, ownerProjectItemId: other.id });
      expect(await granted()).not.toContain("owned.read");
      // The generic API has no operation to transfer an owned system database; this fixture models the already-owned state.
      const transfer = await pool.query("UPDATE databases SET owner_project_item_id=$1 WHERE id=$2", [
        project.id,
        two.id,
      ]);
      expect(transfer.rowCount).toBe(1);
      expect(await granted()).toContain("owned.read");
      let options: PiAgentSessionFactoryOptions | undefined;
      const spy = vi.spyOn(piSession, "createPiAgentSessionFactory").mockImplementation((value) => {
        options = value;
        return () => ({ async *messages() {} });
      });
      try {
        const faux = fauxProvider();
        await createAgentSessionFactoryForRun(
          pool,
          registry,
          {
            model: faux.getModel(),
            streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
            isBudgetRefusal: () => false,
          },
          run,
        );
        if (!options) throw new Error("Session was not composed");
        const tool = options.tools.find((candidate) => candidate.name === "owned_inspect");
        expect(tool).toBeDefined();
        expect(options.tools.map((candidate) => candidate.name)).toEqual(
          expect.arrayContaining(["heartbeat_list", "heartbeat_trigger"]),
        );
        expect(options.tools.map((candidate) => candidate.name)).not.toContain("owned_gated");
        expect(options.tools.map((candidate) => candidate.name)).not.toContain("owned_conditional");
        expect(options.tools.map((candidate) => candidate.name)).not.toContain("owned_unknown");
        expect(options.toolEventMetadata.has("owned_inspect")).toBe(false);
        expect(options.moduleToolNames?.has("owned_inspect")).toBe(true);
        if (!tool) throw new Error("Owned tool missing");
        expect((await tool.execute("call", { value: "hello" })).content).toEqual([{ type: "text", text: "hello" }]);
        expect((await tool.execute("call", { value: "throw" })).content).toEqual([
          { type: "text", text: "Module tool failed." },
        ]);
        expect((await tool.execute("call", { value: 1 })).details).toMatchObject({ error: true });
        const list = options.tools.find((candidate) => candidate.name === "heartbeat_list");
        const trigger = options.tools.find((candidate) => candidate.name === "heartbeat_trigger");
        if (!list || !trigger) throw new Error("Heartbeat tools missing");
        const listed = await list.execute("list", {});
        expect(listed.details).toMatchObject({ error: false });
        expect(JSON.stringify(listed.content)).toContain(customHeartbeat.id);
        const resolved = await resolveModuleAgentToolsForRun(pool, registry, run.id, project.id);
        const resolvedList = resolved.find((candidate) => candidate.name === "heartbeat.list");
        if (!resolvedList) throw new Error("Resolved heartbeat tool missing");
        const expectedList = await resolvedList.invoke({});
        expect(expectedList.error).toBe(false);
        expect(listed.content).toEqual([{ type: "text", text: expectedList.result }]);
        expect((await trigger.execute("trigger", { heartbeatId: foreignHeartbeat.id })).details).toMatchObject({
          error: true,
        });
        expect((await trigger.execute("trigger", { heartbeatId: heartbeat.id })).details).toMatchObject({
          error: false,
        });
        const jobs = async (id: string) =>
          (
            await admin.query<{ id: string; payload: unknown }>(
              "SELECT id, payload FROM graphile_worker._private_jobs WHERE key = $1 ORDER BY id",
              [manualHeartbeatFireJobKey(id)],
            )
          ).rows;
        const beforeQueued = await jobs(heartbeat.id);
        expect(beforeQueued).toHaveLength(1);
        const queued = await trigger.execute("trigger-again", { heartbeatId: heartbeat.id });
        expect(queued.details).toMatchObject({ error: true });
        expect(JSON.stringify(queued.content)).toContain("already");
        expect(await jobs(heartbeat.id)).toEqual(beforeQueued);
        const runningHeartbeat = await withTransaction(pool, (client) =>
          createHeartbeat(client, {
            projectItemId: project.id,
            name: "Running",
            rule: { kind: "interval", minutes: 5 },
            actionId: CORE_AGENT_RUN_ACTION_ID,
            actionConfig: { task: "work" },
          }),
        );
        await createAgentRun(pool, {
          projectItemId: project.id,
          heartbeatId: runningHeartbeat.id,
          triggeredBy: "heartbeat",
          task: "running",
        });
        expect((await trigger.execute("running", { heartbeatId: runningHeartbeat.id })).details).toMatchObject({
          error: true,
        });
        expect(await jobs(runningHeartbeat.id)).toHaveLength(0);
        const disabled = await withTransaction(pool, (client) =>
          createHeartbeat(client, {
            projectItemId: project.id,
            name: "Disabled",
            rule: { kind: "interval", minutes: 5 },
            actionId: CORE_AGENT_RUN_ACTION_ID,
            actionConfig: { task: "work" },
          }),
        );
        await withTransaction(pool, (client) => setHeartbeatEnabled(client, disabled.id, false));
        expect((await trigger.execute("disabled", { heartbeatId: disabled.id })).details).toMatchObject({
          error: true,
        });
        expect(await jobs(disabled.id)).toHaveLength(0);
        const event = await withTransaction(pool, (client) =>
          createHeartbeat(client, {
            projectItemId: project.id,
            name: "Event",
            rule: { kind: "onItemEvent", databaseId: projects.id, event: "create" },
            actionId: CORE_AGENT_RUN_ACTION_ID,
          }),
        );
        expect((await trigger.execute("event", { heartbeatId: event.id })).details).toMatchObject({ error: true });
        expect(await jobs(event.id)).toHaveLength(0);
        expect((await trigger.execute("trigger", { heartbeatId: customHeartbeat.id })).details).toMatchObject({
          error: false,
        });
      } finally {
        spy.mockRestore();
      }
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("heartbeat_list", {}, { id: "list-session" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      const factory = await createAgentSessionFactoryForRun(
        pool,
        registry,
        {
          model: faux.getModel(),
          streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
          isBudgetRefusal: () => false,
        },
        run,
      );
      const resolved = await resolveModuleAgentToolsForRun(pool, registry, run.id, project.id);
      const resolvedList = resolved.find((candidate) => candidate.name === "heartbeat.list");
      if (!resolvedList) throw new Error("Resolved heartbeat tool missing");
      const expectedList = await resolvedList.invoke({});
      let sessionResult: unknown;
      for await (const event of factory({ task: "list heartbeats" }).messages()) {
        if (event.kind === "tool_result" && event.toolCallId === "list-session") sessionResult = event;
      }
      expect(sessionResult).toMatchObject({
        name: "heartbeat_list",
        isError: false,
        result: { content: [{ type: "text", text: expectedList.result }] },
      });
      // Historical system databases can be archived in storage, but the public API refuses it.
      const archived = await pool.query("UPDATE databases SET archived_at=now() WHERE id=$1", [one.id]);
      expect(archived.rowCount).toBe(1);
      expect(await granted()).not.toContain("owned.read");
    }));
  it("does not treat another tenant's module databases as project grants", async () => {
    const foreign = await createTestTenant(admin);
    const cp = createChokePoint(pool);
    await runInTenant(foreign, async () => {
      await seedSystem(pool);
      const projects = (await cp.listDatabases()).find((db) => db.key === "projects");
      if (!projects) throw new Error("Projects missing");
      const project = await cp.createItem({ databaseId: projects.id, properties: { name: "Foreign" } });
      for (const key of ["ownedOne", "ownedTwo"]) {
        await cp.createDatabase({ name: null, key, system: true, ownerProjectItemId: project.id });
      }
    });
    await runInTenant(tenant, async () => {
      await seedSystem(pool);
      const projects = (await cp.listDatabases()).find((db) => db.key === "projects");
      if (!projects) throw new Error("Projects missing");
      const project = await cp.createItem({ databaseId: projects.id, properties: { name: "Own" } });
      const registry = new ModuleRegistry(() => new Set(["ownedTools"]));
      await registry.loadModule(fixturePath);
      const manifest = await withTransaction(pool, (client) =>
        generatePermissionManifest(client, project.id, { moduleRegistry: registry }),
      );
      expect(manifest.grantedCapabilities).not.toContain("owned.read");
    });
  });
  it("does not widen a shared capability when one declaring module is not owned", async () =>
    runInTenant(tenant, async () => {
      await seedSystem(pool);
      const cp = createChokePoint(pool);
      const projects = (await cp.listDatabases()).find((db) => db.key === "projects");
      if (!projects) throw new Error("Projects missing");
      const project = await cp.createItem({ databaseId: projects.id, properties: { name: "Owner" } });
      const registry = new ModuleRegistry(() => new Set(["fixture-good", "fixture-second"]));
      await registry.loadModule(
        new URL("../../../../packages/module-registry/src/__tests__/fixtures/goodModule.js", import.meta.url).href,
      );
      await registry.loadModule(
        new URL("../../../../packages/module-registry/src/__tests__/fixtures/secondModule.js", import.meta.url).href,
      );
      await cp.createDatabase({ name: null, key: "fixtureGoodItems", system: true, ownerProjectItemId: project.id });
      const granted = async () =>
        (
          await withTransaction(pool, (client) =>
            generatePermissionManifest(client, project.id, { moduleRegistry: registry }),
          )
        ).grantedCapabilities;
      expect(await granted()).not.toContain("fixtureGood.send");
      await cp.createDatabase({ name: null, key: "fixtureSecondItems", system: true, ownerProjectItemId: project.id });
      expect(await granted()).toContain("fixtureGood.send");
    }));
});
