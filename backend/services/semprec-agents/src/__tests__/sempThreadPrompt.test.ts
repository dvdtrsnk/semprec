import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { closeIdleThreadSessions, SempConversation } from "@semprec/agent-runtime";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createSempChatThread,
  createChokePoint,
  createUser,
  getDatabaseByModuleId,
  loadFullModuleRegistry,
  seedSystem,
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
    await createUser(admin, {
      tenantId: tenant,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      locale: "en",
    });
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
});
