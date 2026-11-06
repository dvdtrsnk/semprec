import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { claimSempMessage, createAgentRun, createUser, enqueueSempThreadTitleIfFirst, finishSempMessageTurn, insertAgentRunEvent, loadFullModuleRegistry, seedSystem, sendSempMessage, startSempMessageTurn, withTransaction } from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";
import type { GatewayModel } from "../modelComposition.js";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";
import { createSempMessageTask } from "../sempMessageTask.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let registry: ModuleRegistry;
let runtime: AgentsQueueRuntime | undefined;

describe("queued Semp messages", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () => pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    ));
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenant = await createTestTenant(admin);
    await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(tenant, () => seedSystem(pool));
    registry = await loadFullModuleRegistry();
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await runtime?.stop(); } catch (error) { errors.push(error); }
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await admin?.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Semp test cleanup failed", { cause: errors[0] });
  });

  it("runs two queued turns in their stored order through the real agents runtime", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    runtime = await createAgentsQueueRuntime(pool, registry, {
      sempMessageTask: createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns()),
    });
    const first = await runInTenant(tenant, () => withTransaction(pool, (client) =>
      sendSempMessage(client, { text: "first", context: [], hasContext: false }),
    ));
    const second = await runInTenant(tenant, () => withTransaction(pool, (client) =>
      sendSempMessage(client, { threadId: first.threadId, text: "second", context: [], hasContext: false }),
    ));
    const read = () => runInTenant(tenant, () => pool.query<{
      id: string; text: string | null; status: string | null; agent_run_id: string | null; event_from_id: string | null; event_to_id: string | null;
    }>(
      "SELECT id, text, status, agent_run_id, event_from_id, event_to_id FROM semp_messages WHERE id = ANY($1::uuid[]) ORDER BY created_at, id",
      [[first.assistantMessageId, second.assistantMessageId]],
    ));
    const deadline = Date.now() + 15_000;
    let rows = (await read()).rows;
    while (rows.some((row) => row.status !== "done") && Date.now() < deadline) {
      await sleep(50);
      rows = (await read()).rows;
    }
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.id, row.text, row.status])).toEqual([
      [first.assistantMessageId, "first answer", "done"],
      [second.assistantMessageId, "second answer", "done"],
    ]);
    for (const row of rows) {
      expect(row.agent_run_id).toEqual(expect.any(String));
      expect(row.event_from_id).toEqual(expect.any(String));
      expect(row.event_to_id).toEqual(expect.any(String));
    }
  });

  it("rolls back a title job observed in the same transaction as the done transition", async () => {
    await runtime?.stop();
    runtime = undefined;
    const turn = await runInTenant(tenant, () => withTransaction(pool, (client) =>
      sendSempMessage(client, { text: "title rollback", context: [], hasContext: false }),
    ));
    const eventId = await runInTenant(tenant, () => withTransaction(pool, async (client) => {
      expect(await claimSempMessage(client, turn.threadId, turn.assistantMessageId)).toBe(true);
      const run = await createAgentRun(client, { triggeredBy: "user", unit: "session", task: "title rollback", threadId: turn.threadId });
      const event = await insertAgentRunEvent(client, run.id, "message", { kind: "message", text: "answer" });
      await startSempMessageTurn(client, turn.assistantMessageId, run.id, event.id);
      return event.id;
    }));
    await expect(runInTenant(tenant, () => withTransaction(pool, async (client) => {
      expect(await finishSempMessageTurn(client, turn.assistantMessageId, { status: "done", text: "answer", lastEventId: eventId })).toBe(true);
      await enqueueSempThreadTitleIfFirst(client, turn.threadId, turn.assistantMessageId);
      const job = await client.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [`sempThreadTitle:${turn.threadId}`]);
      expect(job.rows).toEqual([{ key: `sempThreadTitle:${turn.threadId}` }]);
      throw new Error("rollback sentinel");
    }))).rejects.toThrow("rollback sentinel");
    const after = await runInTenant(tenant, () => withTransaction(pool, async (client) => ({
      message: await client.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [turn.assistantMessageId]),
      job: await client.query("SELECT key FROM graphile_worker.jobs WHERE key = $1", [`sempThreadTitle:${turn.threadId}`]),
    })));
    expect(after.message.rows).toEqual([{ status: "running" }]);
    expect(after.job.rows).toEqual([]);
  });
});
