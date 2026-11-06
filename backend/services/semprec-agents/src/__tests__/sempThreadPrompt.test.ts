import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { closeIdleThreadSessions, SempConversation } from "@semprec/agent-runtime";
import { GENERIC_OPERATION_NAMES, OPERATION_METADATA, runAsSystem, runInTenant } from "@semprec/shared";
import {
  createSempChatThread,
  createChokePoint,
  createAgentRun,
  createHeartbeat,
  createUser,
  getDatabaseByModuleId,
  generatePermissionManifest,
  finishAgentRun,
  loadFullModuleRegistry,
  loadGuidanceSections,
  seedSystem,
  saveGuidanceSections,
  sendSempMessage,
  withTransaction,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createAgentSessionFactoryForRun } from "../agentSessionComposition.js";
import type { GatewayModel } from "../modelComposition.js";
import { createSempMessageTask } from "../sempMessageTask.js";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let userId: string;

describe("Semp thread live prompt", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenant = await createTestTenant(admin);
    const user = await createUser(admin, {
      tenantId: tenant,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      locale: "en",
    });
    userId = user.id;
    await runInTenant(tenant, () => seedSystem(runtime));
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      await runtime?.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await admin?.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Prompt test cleanup failed", { cause: errors[0] });
  });

  it("passes per-turn prefixes to the real session while storing only original user text", async () => {
    const registry = await loadFullModuleRegistry();
    const faux = fauxProvider();
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("one");
      },
      (context) => {
        prompts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("two");
      },
    ]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    const fixture = await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const database = await getDatabaseByModuleId(client, "inbox");
        if (!database?.ownerProjectItemId) throw new Error("Missing Semprec project");
        return { projectId: database.ownerProjectItemId, threadId: await createSempChatThread(client) };
      }),
    );
    const conversation = new SempConversation(runtime, {
      resolveProjectItemId: async () => fixture.projectId,
      createAgentSessionForRun: (run) => createAgentSessionFactoryForRun(runtime, registry, gateway, run),
    });
    try {
      await runInTenant(tenant, () =>
        conversation.send("first", { kind: "chat", threadId: fixture.threadId }, { modelPrefix: "day one" }),
      );
      await runInTenant(tenant, () =>
        conversation.send("second", { kind: "chat", threadId: fixture.threadId }, { modelPrefix: "day two" }),
      );
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("day one\\n\\nfirst");
      expect(prompts[1]).toContain("day two\\n\\nsecond");
      const events = await runInTenant(tenant, () =>
        runtime.query<{ payload: unknown }>(
          "SELECT e.payload FROM agent_run_events e JOIN agent_runs r ON r.id = e.agent_run_id AND r.tenant_id = e.tenant_id WHERE r.thread_id = $1 AND e.kind = 'user_message' ORDER BY e.id",
          [fixture.threadId],
        ),
      );
      expect(events.rows.map((row) => row.payload)).toEqual([
        { kind: "user_message", text: "first", context: [] },
        { kind: "user_message", text: "second", context: [] },
      ]);
      await closeIdleThreadSessions(runtime);
    } finally {
      conversation.clear();
    }
  });

  it("recomputes live dates across midnight and uses a changed stored timezone", async () => {
    const registry = await loadFullModuleRegistry();
    const faux = fauxProvider();
    const prompts: string[] = [];
    faux.setResponses(
      Array.from({ length: 3 }, (_, i) => (context) => {
        prompts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(`reply ${i}`);
      }),
    );
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    const settings = await runInTenant(tenant, async () => {
      const result = await runtime.query<{ id: string; database_id: string }>(
        "SELECT i.id, i.database_id FROM items i JOIN databases d ON d.id = i.database_id WHERE d.owner_module_id = 'systemSettings' AND d.system = true",
      );
      if (result.rows.length !== 1 || !result.rows[0]) throw new Error("Expected one settings item");
      return result.rows[0];
    });
    const setZone = (timezone: string) =>
      runInTenant(tenant, () =>
        createChokePoint(runtime).updateItem({
          databaseId: settings.database_id,
          itemId: settings.id,
          propertiesPatch: { timezone },
        }),
      );
    const task = createSempMessageTask(runtime, registry, gateway, createInFlightAgentRuns());
    const send = (text: string, threadId?: string) =>
      runInTenant(tenant, async () => {
        const turn = await withTransaction(runtime, (client) =>
          sendSempMessage(client, { text, context: [], hasContext: false, ...(threadId ? { threadId } : {}) }),
        );
        await task(
          { threadId: turn.threadId, assistantMessageId: turn.assistantMessageId },
          { job: { id: "prompt-test" } },
        );
        const status = await runtime.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [
          turn.assistantMessageId,
        ]);
        expect(status.rows).toEqual([{ status: "done" }]);
        return turn.threadId;
      });
    await setZone("UTC");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T23:59:00Z"));
      const threadId = await send("first");
      vi.setSystemTime(new Date("2026-01-02T00:01:00Z"));
      await send("second", threadId);
      await setZone("America/Los_Angeles");
      await send("third", threadId);
      const formatted = (date: string, timeZone: string) =>
        new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "full", timeStyle: "long" }).format(new Date(date));
      expect(prompts[0]).toContain(formatted("2026-01-01T23:59:00Z", "UTC"));
      expect(prompts[1]).toContain(formatted("2026-01-02T00:01:00Z", "UTC"));
      expect(prompts[2]).toContain(formatted("2026-01-02T00:01:00Z", "America/Los_Angeles"));
      const events = await runInTenant(tenant, () =>
        runtime.query<{ payload: unknown }>(
          "SELECT e.payload FROM agent_run_events e JOIN agent_runs r ON r.id = e.agent_run_id AND r.tenant_id = e.tenant_id WHERE r.thread_id = $1 AND e.kind = 'user_message' ORDER BY e.id",
          [threadId],
        ),
      );
      expect(events.rows.map((row) => row.payload)).toEqual(
        ["first", "second", "third"].map((text) => ({ kind: "user_message", text, context: [] })),
      );
    } finally {
      vi.useRealTimers();
      await setZone("Europe/Prague");
      await closeIdleThreadSessions(runtime);
    }
  });

  it("binds tick questions and heartbeat tools to the heartbeat project while chat stays general", async () => {
    const registry = await loadFullModuleRegistry();
    const fixture = await runInTenant(tenant, async () => {
      const inbox = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "inbox"));
      if (!inbox?.ownerProjectItemId) throw new Error("Missing Semprec project");
      const projectId = inbox.ownerProjectItemId;
      const chokePoint = createChokePoint(runtime);
      const projects = (await chokePoint.listDatabases()).find((database) => database.key === "projects");
      if (!projects) throw new Error("Missing projects database");
      const otherProject = await chokePoint.createItem({
        databaseId: projects.id,
        properties: { name: "Other project" },
      });
      const own = await withTransaction(runtime, (client) =>
        createHeartbeat(client, {
          projectItemId: projectId,
          name: "Daily own",
          rule: { kind: "interval", minutes: 10 },
          actionId: "core.agentRun",
          actionConfig: { task: "Review my tasks" },
        }),
      );
      const other = await withTransaction(runtime, (client) =>
        createHeartbeat(client, {
          projectItemId: otherProject.id,
          name: "Other private heartbeat",
          rule: { kind: "interval", minutes: 20 },
          actionId: "core.agentRun",
          actionConfig: { task: "Other task" },
        }),
      );
      const prior = await createAgentRun(runtime, {
        projectItemId: projectId,
        heartbeatId: own.id,
        triggeredBy: "heartbeat",
        task: "earlier",
      });
      expect(await finishAgentRun(runtime, prior.id, "done", "Earlier result")).toBe(true);
      // A valid existing tick thread is a fixture: its producing tick-store is private to data.
      const thread = await runtime.query<{ id: string }>(
        "INSERT INTO semp_threads (kind, heartbeat_id) VALUES ('tick', $1) RETURNING id",
        [own.id],
      );
      if (!thread.rows[0]) throw new Error("Missing tick thread");
      const restricted = await withTransaction(runtime, (client) =>
        createHeartbeat(client, {
          projectItemId: projectId,
          name: "Restriction control",
          rule: { kind: "interval", minutes: 30 },
          actionId: "core.agentRun",
          actionConfig: { task: "Control" },
        }),
      );
      await runtime.query("INSERT INTO semp_threads (kind, heartbeat_id) VALUES ('tick', $1)", [restricted.id]);
      return { threadId: thread.rows[0].id, projectId, own: own.id, other: other.id, restricted: restricted.id };
    });
    const faux = fauxProvider();
    const prompts: string[] = [];
    const tools: string[][] = [];
    faux.setResponses([
      (context) => {
        prompts.push(JSON.stringify(context.messages));
        tools.push((context.tools ?? []).map((tool) => tool.name));
        return fauxAssistantMessage([fauxToolCall("heartbeat_list", {}, { id: "tick-list" })], {
          stopReason: "toolUse",
        });
      },
      (context) => {
        prompts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("tick answer");
      },
      (context) => {
        prompts.push(JSON.stringify(context.messages));
        tools.push((context.tools ?? []).map((tool) => tool.name));
        return fauxAssistantMessage("chat answer");
      },
    ]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    const task = createSempMessageTask(runtime, registry, gateway, createInFlightAgentRuns());
    const tick = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        sendSempMessage(client, { threadId: fixture.threadId, text: "What happened?", context: [], hasContext: false }),
      ),
    );
    await runInTenant(tenant, () =>
      task({ threadId: tick.threadId, assistantMessageId: tick.assistantMessageId }, { job: { id: "tick-test" } }),
    );
    const row = await runInTenant(tenant, () =>
      runtime.query<{ status: string; project_item_id: string; agent_run_id: string }>(
        "SELECT m.status, r.project_item_id, r.id AS agent_run_id FROM semp_messages m JOIN agent_runs r ON r.id = m.agent_run_id AND r.tenant_id = m.tenant_id WHERE m.id = $1",
        [tick.assistantMessageId],
      ),
    );
    expect(row.rows).toEqual([expect.objectContaining({ status: "done", project_item_id: fixture.projectId })]);
    expect(prompts[0]).toContain("Daily own");
    expect(prompts[0]).toContain("Review my tasks");
    expect(prompts[0]).toContain("Earlier result");
    expect(prompts[0]).toContain("interval");
    expect(tools[0]).toEqual(expect.arrayContaining(["heartbeat_list", "heartbeat_history", "heartbeat_trigger"]));
    const events = await runInTenant(tenant, () =>
      runtime.query<{ payload: unknown }>(
        "SELECT payload FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'tool_result' ORDER BY id",
        [row.rows[0]?.agent_run_id],
      ),
    );
    const rendered = JSON.stringify(events.rows);
    expect(rendered).toContain(fixture.own);
    expect(rendered).not.toContain(fixture.other);
    const chat = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        sendSempMessage(client, { text: "normal chat", context: [], hasContext: false }),
      ),
    );
    await runInTenant(tenant, () =>
      task({ threadId: chat.threadId, assistantMessageId: chat.assistantMessageId }, { job: { id: "chat-test" } }),
    );
    expect(prompts[2]).not.toContain("Automation:");
    expect(tools[1]).toEqual(expect.arrayContaining(["heartbeat_list", "heartbeat_history", "heartbeat_trigger"]));
    await expect(
      runInTenant(tenant, () => runtime.query("DELETE FROM project_heartbeats WHERE id = $1", [fixture.restricted])),
    ).rejects.toMatchObject({ code: "23001" });
    const retained = await runInTenant(tenant, () =>
      runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_threads WHERE heartbeat_id = $1", [
        fixture.restricted,
      ]),
    );
    expect(retained.rows).toEqual([{ count: 1 }]);
    await closeIdleThreadSessions(runtime);
  });

  it("keeps guidance and granted chat tools while item threads expose no write operations", async () => {
    const registry = await loadFullModuleRegistry();
    const fixture = await runInTenant(tenant, async () => {
      const inbox = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "inbox"));
      if (!inbox?.ownerProjectItemId) throw new Error("Missing Semprec project");
      const projectId = inbox.ownerProjectItemId;
      const source = await createChokePoint(runtime).createItem({
        databaseId: inbox.id,
        properties: { date: "2026-01-01", time: "12:00", text: "item question" },
      });
      const guidance = await withTransaction(runtime, (client) => loadGuidanceSections(client, projectId));
      const saved = await withTransaction(runtime, (client) =>
        saveGuidanceSections(client, {
          actorUserId: userId,
          projectItemId: projectId,
          sections: { ...guidance.sections, generalInstructions: "Batch guidance marker" },
          expectedUpdatedAt: guidance.updatedAt,
        }),
      );
      const manifest = await withTransaction(runtime, (client) =>
        generatePermissionManifest(client, projectId, { moduleRegistry: registry }),
      );
      return { projectId, sourceId: source.id, guidance, saved, grants: manifest.grantedCapabilities };
    });
    const prompts: string[] = [];
    const toolLists: string[][] = [];
    const faux = fauxProvider();
    faux.setResponses(
      Array.from({ length: 3 }, () => (context) => {
        prompts.push(context.systemPrompt ?? "");
        toolLists.push((context.tools ?? []).map((tool) => tool.name));
        return fauxAssistantMessage("answer");
      }),
    );
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    const task = createSempMessageTask(runtime, registry, gateway, createInFlightAgentRuns());
    let failure: { error: unknown } | undefined;
    try {
      const chat = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) => sendSempMessage(client, { text: "chat", context: [], hasContext: false })),
      );
      await runInTenant(tenant, () =>
        task({ threadId: chat.threadId, assistantMessageId: chat.assistantMessageId }, { job: { id: "chat" } }),
      );
      const item = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          sendSempMessage(client, {
            text: "item",
            context: [],
            hasContext: false,
            subject: { inboxItemId: fixture.sourceId },
          }),
        ),
      );
      await runInTenant(tenant, () =>
        task({ threadId: item.threadId, assistantMessageId: item.assistantMessageId }, { job: { id: "item" } }),
      );
      for (const prompt of prompts.slice(0, 2)) {
        expect(prompt).toContain("Batch guidance marker");
        expect(prompt).toContain("user's assistant");
        expect(prompt).toContain("approval");
        expect(prompt).toContain("30 days");
        expect(prompt).toContain("semprec://items/<id>");
        expect(prompt).toContain("Data schema:");
      }
      const modelName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
      const chatTools = toolLists[0] ?? [];
      const itemTools = toolLists[1] ?? [];
      for (const name of GENERIC_OPERATION_NAMES) {
        if (OPERATION_METADATA[name].riskClass !== "read") expect(itemTools).not.toContain(modelName(name));
        if (fixture.grants.includes(OPERATION_METADATA[name].requiresCapability))
          expect(chatTools).toContain(modelName(name));
        else expect(chatTools).not.toContain(modelName(name));
      }
      expect(itemTools).toContain("item_get");
      expect(chatTools).not.toContain("page_create");
      const standalone = await runInTenant(tenant, () =>
        createAgentRun(runtime, { projectItemId: fixture.projectId, triggeredBy: "user", task: "standalone" }),
      );
      await runInTenant(tenant, async () => {
        const factory = await createAgentSessionFactoryForRun(runtime, registry, gateway, standalone);
        for await (const event of factory({ task: "standalone" }).messages()) void event;
      });
      expect(prompts[2]).not.toContain("user's assistant for tasks");
      expect(prompts[2]).toContain("Batch guidance marker");
      expect(await runInTenant(tenant, () => finishAgentRun(runtime, standalone.id, "done", null))).toBe(true);
    } catch (error) {
      failure = { error };
    }
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      async () => closeIdleThreadSessions(runtime),
      async () =>
        runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            saveGuidanceSections(client, {
              actorUserId: userId,
              projectItemId: fixture.projectId,
              sections: fixture.guidance.sections,
              expectedUpdatedAt: fixture.saved.updatedAt,
            }),
          ),
        ),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        "Prompt test cleanup failed",
        { cause: failure?.error },
      );
    if (failure) throw failure.error;
  });
});
