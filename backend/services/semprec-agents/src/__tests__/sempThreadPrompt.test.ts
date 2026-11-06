import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { closeIdleThreadSessions, SempConversation } from "@semprec/agent-runtime";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createSempChatThread,
  createUser,
  getDatabaseByModuleId,
  loadFullModuleRegistry,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createAgentSessionFactoryForRun } from "../agentSessionComposition.js";
import type { GatewayModel } from "../modelComposition.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;

describe("Semp thread live prompt", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () => runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    ));
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenant = await createTestTenant(admin);
    await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused", locale: "en" });
    await runInTenant(tenant, () => seedSystem(runtime));
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await runtime?.end(); } catch (error) { errors.push(error); }
    try { await admin?.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Prompt test cleanup failed", { cause: errors[0] });
  });

  it("passes per-turn prefixes to the real session while storing only original user text", async () => {
    const registry = await loadFullModuleRegistry();
    const faux = fauxProvider();
    const prompts: string[] = [];
    faux.setResponses([
      (context) => { prompts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("one"); },
      (context) => { prompts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("two"); },
    ]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    const fixture = await runInTenant(tenant, () => withTransaction(runtime, async (client) => {
      const database = await getDatabaseByModuleId(client, "inbox");
      if (!database?.ownerProjectItemId) throw new Error("Missing Semprec project");
      return { projectId: database.ownerProjectItemId, threadId: await createSempChatThread(client) };
    }));
    const conversation = new SempConversation(runtime, {
      resolveProjectItemId: async () => fixture.projectId,
      createAgentSessionForRun: (run) => createAgentSessionFactoryForRun(runtime, registry, gateway, run),
    });
    try {
      await runInTenant(tenant, () => conversation.send("first", { kind: "chat", threadId: fixture.threadId }, { modelPrefix: "day one" }));
      await runInTenant(tenant, () => conversation.send("second", { kind: "chat", threadId: fixture.threadId }, { modelPrefix: "day two" }));
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("day one\\n\\nfirst");
      expect(prompts[1]).toContain("day two\\n\\nsecond");
      const events = await runInTenant(tenant, () => runtime.query<{ payload: unknown }>(
        "SELECT e.payload FROM agent_run_events e JOIN agent_runs r ON r.id = e.agent_run_id AND r.tenant_id = e.tenant_id WHERE r.thread_id = $1 AND e.kind = 'user_message' ORDER BY e.id",
        [fixture.threadId],
      ));
      expect(events.rows.map((row) => row.payload)).toEqual([
        { kind: "user_message", text: "first", context: [] },
        { kind: "user_message", text: "second", context: [] },
      ]);
      await closeIdleThreadSessions(runtime);
    } finally {
      conversation.clear();
    }
  });
});
