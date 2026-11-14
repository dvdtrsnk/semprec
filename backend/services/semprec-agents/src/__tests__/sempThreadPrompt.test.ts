import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { closeIdleThreadSessions, createGenericOperationAgentTools, SempConversation } from "@semprec/agent-runtime";
import {
  GENERIC_OPERATION_NAMES,
  OPERATION_METADATA,
  REST_ONLY_OPERATION_NAMES,
  runAsSystem,
  runInTenant,
} from "@semprec/shared";
import {
  createSempChatThread,
  createChokePoint,
  createCollectionMetadataResolver,
  createAgentRun,
  createSemprecTickAction,
  createHeartbeat,
  createInboxProposalReviseTool,
  createUser,
  enqueueSempMessage,
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
import {
  confirmProposalWithClient,
  createInboxItemWithClient,
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  reviseProposalWithClient,
  updateProposalValuesWithClient,
} from "@semprec/data/testSupport";
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
    const missingHeartbeat = randomUUID();
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
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall("heartbeat_history", { heartbeatId: fixture.own }, { id: "history-own" }),
            fauxToolCall("heartbeat_history", { heartbeatId: fixture.other }, { id: "history-other" }),
            fauxToolCall("heartbeat_history", { heartbeatId: missingHeartbeat }, { id: "history-missing" }),
            fauxToolCall("heartbeat_trigger", { heartbeatId: fixture.other }, { id: "trigger-other" }),
            fauxToolCall("heartbeat_trigger", { heartbeatId: missingHeartbeat }, { id: "trigger-missing" }),
            fauxToolCall("heartbeat_trigger", { heartbeatId: fixture.own }, { id: "trigger-own" }),
          ],
          { stopReason: "toolUse" },
        ),
      () => fauxAssistantMessage("tool results checked"),
      () => fauxAssistantMessage("system continuation answered"),
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
    const followup = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        sendSempMessage(client, {
          threadId: fixture.threadId,
          text: "Check automation",
          context: [],
          hasContext: false,
        }),
      ),
    );
    await runInTenant(tenant, () =>
      task(
        { threadId: followup.threadId, assistantMessageId: followup.assistantMessageId },
        { job: { id: "tick-tools" } },
      ),
    );
    const followupEvents = await runInTenant(tenant, () =>
      runtime.query<{ payload: unknown }>(
        "SELECT payload FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'tool_result' ORDER BY id",
        [row.rows[0]?.agent_run_id],
      ),
    );
    const resultFor = (id: string) => {
      const entry = followupEvents.rows.find(
        ({ payload }) =>
          typeof payload === "object" && payload !== null && "toolCallId" in payload && payload.toolCallId === id,
      );
      if (!entry) throw new Error(`Missing tool result ${id}`);
      return JSON.stringify(entry.payload);
    };
    expect(resultFor("history-own")).toContain("Earlier result");
    expect(resultFor("history-other")).toContain("not found");
    expect(resultFor("history-missing")).toContain("not found");
    expect(resultFor("trigger-other")).toContain("not found");
    expect(resultFor("trigger-missing")).toContain("not found");
    expect(resultFor("trigger-own")).toContain(fixture.own);
    const jobs = await runInTenant(tenant, () =>
      runtime.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[])", [
        [fixture.own, fixture.other, missingHeartbeat].map((id) => `heartbeat-fire:manual:${id}`),
      ]),
    );
    expect(jobs.rows).toEqual([{ key: `heartbeat-fire:manual:${fixture.own}` }]);
    // The later system-continuation producer is outside this batch; these rows form a valid stored input to the real task.
    const continuation = await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const source = await client.query<{ id: string }>(
          "INSERT INTO semp_messages (thread_id, role, text) VALUES ($1, 'system', $2) RETURNING id",
          [fixture.threadId, "Continue the automation"],
        );
        const sourceId = source.rows[0]?.id;
        if (!sourceId) throw new Error("Missing system source message");
        const reply = await client.query<{ id: string }>(
          "INSERT INTO semp_messages (thread_id, role, reply_to_message_id, status) VALUES ($1, 'assistant', $2, 'queued') RETURNING id",
          [fixture.threadId, sourceId],
        );
        const assistantMessageId = reply.rows[0]?.id;
        if (!assistantMessageId) throw new Error("Missing system continuation reply");
        await enqueueSempMessage(client, { threadId: fixture.threadId, assistantMessageId });
        return { threadId: fixture.threadId, assistantMessageId };
      }),
    );
    await runInTenant(tenant, () => task(continuation, { job: { id: "system-continuation" } }));
    const systemReply = await runInTenant(tenant, () =>
      runtime.query<{ text: string; status: string }>("SELECT text, status FROM semp_messages WHERE id = $1", [
        continuation.assistantMessageId,
      ]),
    );
    expect(systemReply.rows).toEqual([{ text: "system continuation answered", status: "done" }]);
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
      return {
        projectId,
        inboxId: inbox.id,
        sourceId: source.id,
        guidance,
        saved,
        grants: manifest.grantedCapabilities,
      };
    });
    const prompts: string[] = [];
    const toolLists: string[][] = [];
    const userInputs: string[] = [];
    const faux = fauxProvider();
    faux.setResponses(
      Array.from({ length: 3 }, () => (context) => {
        prompts.push(context.systemPrompt ?? "");
        toolLists.push((context.tools ?? []).map((tool) => tool.name));
        userInputs.push(JSON.stringify(context.messages));
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
        expect(prompt).toContain(`"databaseId":"${fixture.inboxId}","key":null,"name":"Inbox"`);
        expect(prompt).toContain('"key":"areas","name":"Areas"');
        // The project holds no grant on the sensitive databases, so the schema lists none of them (issue #1810).
        expect(prompt).toContain('"sensitive":false');
        expect(prompt).not.toContain('"sensitive":true');
        expect(prompt).toContain('"properties":');
        expect(prompt).toContain('"key":"text"');
      }
      const modelName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
      const chatTools = toolLists[0] ?? [];
      const itemTools = toolLists[1] ?? [];
      expect(userInputs[0]).not.toContain("Automation:");
      expect(userInputs[1]).not.toContain("Automation:");
      // The grants cover the capability of the REST-only operations (issue #1699), so only the gateway keeps them out.
      expect(fixture.grants).toContain("core.schema.write");
      for (const name of GENERIC_OPERATION_NAMES) {
        if (OPERATION_METADATA[name].riskClass !== "read") expect(itemTools).not.toContain(modelName(name));
        const restOnly = REST_ONLY_OPERATION_NAMES.some((restOnlyName) => restOnlyName === name);
        if (!restOnly && fixture.grants.includes(OPERATION_METADATA[name].requiresCapability))
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
  describe("the card of an Inbox item thread (issue #1938)", () => {
    interface ItemThread {
      sourceId: string;
      cardId: string;
      proposalsId: string;
      tasksId: string;
      turn: { threadId: string; assistantMessageId: string };
    }
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);

    /** The text of the last user message of a model call, and the card data in it when it carries any. */
    function lastUserTurn(messages: unknown): { text: string; card: Record<string, unknown> | null } {
      if (!Array.isArray(messages)) throw new Error("The model call has no messages");
      const users = messages.filter(
        (message): message is Record<string, unknown> => isRecord(message) && message.role === "user",
      );
      const content = users.at(-1)?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("")
            : null;
      if (text === null) throw new Error("No user message in the model call");
      const match = /<inbox-card-data>\n(.*)\n<\/inbox-card-data>/s.exec(text);
      const card: unknown = match?.[1] ? JSON.parse(match[1]) : null;
      if (card !== null && !isRecord(card)) throw new Error("The card data is not an object");
      return { text, card };
    }

    /** An Inbox item whose card the tick made, revised into a Tasks proposal and edited by the user, with a message queued in its item thread. */
    async function createItemThread(text = "Buy milk, please"): Promise<ItemThread> {
      return runInTenant(tenant, async () => {
        const dbs = await withTransaction(runtime, async (client) => ({
          inbox: await getDatabaseByModuleId(client, "inbox"),
          types: await getDatabaseByModuleId(client, "inboxItemTypes"),
          proposals: await getDatabaseByModuleId(client, "processingProposals"),
          tasks: await getDatabaseByModuleId(client, "tasks"),
        }));
        if (!dbs.inbox?.ownerProjectItemId || !dbs.types || !dbs.proposals || !dbs.tasks)
          throw new Error("Missing Inbox setup");
        const inboxDatabaseId = dbs.inbox.id;
        const source = await withTransaction(runtime, (client) =>
          createInboxItemWithClient(client, { inboxDatabaseId, date: "2026-11-06", time: "12:30", text }),
        );
        await createSemprecTickAction(runtime, async () => ({ properties: {}, candidates: [] }))(
          {
            inboxDatabaseId: dbs.inbox.id,
            inboxItemTypesDatabaseId: dbs.types.id,
            processingProposalsDatabaseId: dbs.proposals.id,
          },
          { heartbeatId: randomUUID(), projectItemId: dbs.inbox.ownerProjectItemId, itemId: source.id },
        );
        const cards = await runtime.query<{ id: string }>(
          `SELECT card.id FROM items card JOIN item_relations edge ON edge.item_a = card.id OR edge.item_b = card.id
            WHERE card.database_id = $1 AND card.deleted_at IS NULL AND (edge.item_a = $2 OR edge.item_b = $2)`,
          [dbs.proposals.id, source.id],
        );
        const cardId = cards.rows[0]?.id;
        if (cards.rows.length !== 1 || !cardId) throw new Error("Missing tick-produced card");
        const config = { processingProposalsDatabaseId: dbs.proposals.id };
        const tasksId = dbs.tasks.id;
        await withTransaction(runtime, async (client) => {
          await reviseProposalWithClient(client, config, cardId, {
            message: "Filed under Tasks",
            entityKind: "database",
            target: tasksId,
            properties: { name: "Buy milk" },
          });
          await updateProposalValuesWithClient(client, config, cardId, { set: { primary: { name: "Koupit mléko" } } });
        });
        const turn = await withTransaction(runtime, (client) =>
          sendSempMessage(client, {
            subject: { inboxItemId: source.id, proposalId: cardId },
            text: "It belongs to another project",
            context: [],
            hasContext: false,
          }),
        );
        return { sourceId: source.id, cardId, proposalsId: dbs.proposals.id, tasksId, turn };
      });
    }

    function gatewayCapturing(prompts: Array<ReturnType<typeof lastUserTurn>>, replies = 1): GatewayModel {
      const faux = fauxProvider();
      faux.setResponses(
        Array.from({ length: replies }, (_, index) => (context) => {
          prompts.push(lastUserTurn(context.messages));
          return fauxAssistantMessage(`reply ${index}`);
        }),
      );
      return {
        model: faux.getModel(),
        streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
        isBudgetRefusal: () => false,
      };
    }

    const runTurn = (task: ReturnType<typeof createSempMessageTask>, turn: ItemThread["turn"]) =>
      runInTenant(tenant, () =>
        task({ threadId: turn.threadId, assistantMessageId: turn.assistantMessageId }, { job: { id: "card-test" } }),
      );

    it("puts the source, the effective envelope, the edited keys and the history of an open card into the turn's prompt, and into no stored text", async () => {
      const fixture = await createItemThread();
      const prompts: Array<ReturnType<typeof lastUserTurn>> = [];
      const task = createSempMessageTask(
        runtime,
        await loadFullModuleRegistry(),
        gatewayCapturing(prompts),
        createInFlightAgentRuns(),
      );

      await runTurn(task, fixture.turn);

      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.card).toMatchObject({
        proposalId: fixture.cardId,
        status: "proposed",
        source: { text: "Buy milk, please", date: "2026-11-06", time: "12:30" },
        envelope: { properties: { name: "Koupit mléko" } },
        userEditedKeys: ["primary.name"],
      });
      expect(prompts[0]?.card?.history).toMatchObject([{ kind: null }, { kind: null }, { kind: "userEdit" }]);
      expect(prompts[0]?.text).toContain("It belongs to another project");
      const stored = await runInTenant(tenant, () =>
        runtime.query<{ text: string }>(
          `SELECT e.payload->>'text' AS text FROM agent_run_events e JOIN agent_runs r ON r.id = e.agent_run_id AND r.tenant_id = e.tenant_id
            WHERE r.thread_id = $1 AND e.kind = 'user_message'`,
          [fixture.turn.threadId],
        ),
      );
      expect(stored.rows).toEqual([{ text: "It belongs to another project" }]);
      const runs = await runInTenant(tenant, () =>
        runtime.query<{ task: string }>("SELECT task FROM agent_runs WHERE thread_id = $1", [fixture.turn.threadId]),
      );
      expect(runs.rows.every((row) => !row.task.includes("inbox-card-data"))).toBe(true);
      await closeIdleThreadSessions(runtime);
    });

    it("reads the card again for the next turn of the same thread, after the card changed", async () => {
      const fixture = await createItemThread();
      const prompts: Array<ReturnType<typeof lastUserTurn>> = [];
      const task = createSempMessageTask(
        runtime,
        await loadFullModuleRegistry(),
        gatewayCapturing(prompts, 2),
        createInFlightAgentRuns(),
      );
      await runTurn(task, fixture.turn);
      await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          reviseProposalWithClient(client, { processingProposalsDatabaseId: fixture.proposalsId }, fixture.cardId, {
            message: "Chat correction",
            entityKind: "database",
            target: fixture.tasksId,
            properties: { name: "Buy milk", description: "Oat milk" },
          }),
        ),
      );
      const second = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          sendSempMessage(client, {
            threadId: fixture.turn.threadId,
            text: "And now?",
            context: [],
            hasContext: false,
          }),
        ),
      );

      await runTurn(task, second);

      expect(prompts).toHaveLength(2);
      expect(prompts[0]?.card).toMatchObject({ envelope: { properties: { name: "Koupit mléko" } } });
      expect(prompts[1]?.card).toMatchObject({
        envelope: { properties: { name: "Koupit mléko", description: "Oat milk" } },
      });
      await closeIdleThreadSessions(runtime);
    });

    it("lists the items a confirmed card created, without an envelope, and an edit of the created task goes through the item tool and the choke point", async () => {
      const fixture = await createItemThread();
      // The message was queued while the card was open; the card is confirmed before the turn starts.
      await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          confirmProposalWithClient(client, { processingProposalsDatabaseId: fixture.proposalsId }, fixture.cardId),
        ),
      );
      const created = await runInTenant(tenant, () =>
        runtime.query<{ id: string; updated_at: Date }>(
          "SELECT id, updated_at FROM items WHERE database_id = $1 AND deleted_at IS NULL",
          [fixture.tasksId],
        ),
      );
      const prompts: Array<ReturnType<typeof lastUserTurn>> = [];
      const registry = await loadFullModuleRegistry();
      const task = createSempMessageTask(runtime, registry, gatewayCapturing(prompts), createInFlightAgentRuns());

      await runTurn(task, fixture.turn);

      expect(created.rows).toHaveLength(1);
      expect(prompts[0]?.card).toMatchObject({
        status: "confirmed",
        createdItems: [{ itemId: created.rows[0]?.id, databaseKey: "tasks", label: "Koupit mléko" }],
      });
      expect(prompts[0]?.card).not.toHaveProperty("envelope");
      // The item tools edit the created task as any other item; the card itself stays as it was.
      const run = await runInTenant(tenant, () =>
        runtime.query<{ agent_run_id: string }>("SELECT agent_run_id FROM semp_messages WHERE id = $1", [
          fixture.turn.assistantMessageId,
        ]),
      );
      const runId = run.rows[0]?.agent_run_id;
      if (!runId) throw new Error("The turn has no run");
      const tools = createGenericOperationAgentTools(
        runtime,
        registry,
        await createCollectionMetadataResolver(registry),
      );
      const patched = await runInTenant(tenant, () =>
        tools["item.patch"](runId, {
          itemId: created.rows[0]?.id,
          properties: { name: "Koupit ovesné mléko" },
          ifVersion: created.rows[0]?.updated_at.toISOString(),
        }),
      );
      expect(patched, patched.result).toMatchObject({ error: false });
      const after = await runInTenant(tenant, () =>
        runtime.query<{ name: string }>("SELECT properties->>'name' AS name FROM items WHERE id = $1", [
          created.rows[0]?.id,
        ]),
      );
      expect(after.rows).toEqual([{ name: "Koupit ovesné mléko" }]);
      // The revise tool still refuses the confirmed card, and the card stays exactly as it was.
      const card = () =>
        runInTenant(tenant, () =>
          runtime.query<{ properties: unknown; updated_at: Date }>(
            "SELECT properties, updated_at FROM items WHERE id = $1",
            [fixture.cardId],
          ),
        );
      const cardBefore = await card();
      // A thread of a confirmed card takes no new message, so the finished turn's reply is reopened to put the call
      // inside a running reply: the refusal then comes from the card's status, not from a missing running reply.
      await runInTenant(tenant, () =>
        runtime.query("UPDATE semp_messages SET status = 'running' WHERE id = $1", [fixture.turn.assistantMessageId]),
      );
      const refused = await runInTenant(tenant, () =>
        createInboxProposalReviseTool(runtime)(runId, {
          proposalId: fixture.cardId,
          ifVersion: cardBefore.rows[0]?.updated_at.toISOString(),
          properties: { name: "Koupit bio mléko" },
        }),
      );
      expect(refused.error).toBe(true);
      expect(JSON.parse(refused.result)).toMatchObject({ status: 400, error: "validation_failed", field: "status" });
      expect((await card()).rows).toEqual(cardBefore.rows);
      expect(cardBefore.rows[0]?.properties).toMatchObject({ status: "confirmed" });
      await runInTenant(tenant, () =>
        runtime.query("UPDATE semp_messages SET status = 'done' WHERE id = $1", [fixture.turn.assistantMessageId]),
      );
      await closeIdleThreadSessions(runtime);
    });

    it("adds no card context to a turn of an item thread whose item has no card, or to a chat thread", async () => {
      const prompts: Array<ReturnType<typeof lastUserTurn>> = [];
      const task = createSempMessageTask(
        runtime,
        await loadFullModuleRegistry(),
        gatewayCapturing(prompts, 2),
        createInFlightAgentRuns(),
      );
      const noCard = await runInTenant(tenant, async () => {
        const inbox = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "inbox"));
        if (!inbox) throw new Error("Missing Inbox");
        const source = await withTransaction(runtime, (client) =>
          createInboxItemWithClient(client, {
            inboxDatabaseId: inbox.id,
            date: "2026-11-06",
            time: "12:30",
            text: "Idea",
          }),
        );
        return withTransaction(runtime, (client) =>
          sendSempMessage(client, {
            subject: { inboxItemId: source.id },
            text: "What is this?",
            context: [],
            hasContext: false,
          }),
        );
      });
      const chat = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          sendSempMessage(client, { text: "Hello", context: [], hasContext: false }),
        ),
      );

      await runTurn(task, noCard);
      await runTurn(task, chat);

      expect(prompts.map((prompt) => prompt.card)).toEqual([null, null]);
      expect(prompts.map((prompt) => prompt.text.includes("inbox-card-data"))).toEqual([false, false]);
      await closeIdleThreadSessions(runtime);
    });
  });
});
