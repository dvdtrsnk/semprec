import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { runInTenant } from "@semprec/shared";
import {
  createUser,
  loadFullModuleRegistry,
  regenerateSempReply,
  seedSystem,
  sendSempMessage,
  withTransaction,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";
import type { GatewayModel } from "../modelComposition.js";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";
import { createSempMessageTask } from "../sempMessageTask.js";

/**
 * The turns that follow a regenerated Semp reply (issue gh-1930), through the real turn handler, the real queue
 * runtime, the real session registry and the real history reconstruction; only the model is a faux provider. The
 * regeneration is queued by `regenerateSempReply`, the store function behind the route (`sempRegenerate.test.ts` of
 * `semprec-api` covers the route). Everything runs on the runtime role pool.
 */

let admin: Pool;
let pool: Pool;
let registry: ModuleRegistry;
let tenant: string;
let runtime: AgentsQueueRuntime | undefined;

interface StoredMessage {
  status: string;
  text: string | null;
  agent_run_id: string | null;
}

function readMessage(id: string): Promise<StoredMessage | undefined> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<StoredMessage>(
      "SELECT status, text, agent_run_id FROM semp_messages WHERE id = $1",
      [id],
    );
    return rows[0];
  });
}

async function awaitStatus(id: string, status: "done" | "error"): Promise<StoredMessage> {
  const deadline = Date.now() + 20_000;
  let row = await readMessage(id);
  while (row?.status !== status && Date.now() < deadline) {
    await sleep(50);
    row = await readMessage(id);
  }
  if (row?.status !== status) throw new Error(`The message did not reach ${status}: ${row?.status ?? "missing"}`);
  return row;
}

function runStatus(runId: string | null): Promise<string | undefined> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [runId]);
    return rows[0]?.status;
  });
}

function send(text: string, threadId?: string) {
  return runInTenant(tenant, () =>
    withTransaction(pool, (client) =>
      sendSempMessage(client, { ...(threadId ? { threadId } : {}), text, context: [], hasContext: false }),
    ),
  );
}

function regenerate(threadId: string, messageId: string) {
  return runInTenant(tenant, () => withTransaction(pool, (client) => regenerateSempReply(client, threadId, messageId)));
}

/** A model step that answers `text` and records the messages the model was given. */
function recording(inputs: string[], text: string): FauxResponseStep {
  return (context) => {
    inputs.push(JSON.stringify(context.messages));
    return fauxAssistantMessage(text);
  };
}

/** Starts the queue runtime over a new turn handler, and with it a new, empty session registry. */
async function startProcess(responses: FauxResponseStep[]): Promise<void> {
  await runtime?.stop();
  const faux = fauxProvider();
  faux.setResponses(responses);
  const gateway: GatewayModel = {
    model: faux.getModel(),
    streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
    isBudgetRefusal: () => false,
  };
  runtime = await createAgentsQueueRuntime(pool, registry, {
    sempMessageTask: createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns()),
  });
}

describe("the turns of a regenerated Semp reply", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    tenant = await createTestTenant(admin);
    await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(tenant, () => seedSystem(pool));
    registry = await loadFullModuleRegistry();
  });

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("drops the live session of the thread, so the regenerated turn wakes a new one that does not hold the replaced answer", async () => {
    const regenerated: string[] = [];
    await startProcess([fauxAssistantMessage("FIRST ANSWER"), recording(regenerated, "REGENERATED ANSWER")]);
    const first = await send("the question");
    const firstDone = await awaitStatus(first.assistantMessageId, "done");
    // The reply is done and its session is cached in the registry: its wake run is still running.
    expect(await runStatus(firstDone.agent_run_id)).toBe("running");

    const second = await regenerate(first.threadId, first.assistantMessageId);

    const secondDone = await awaitStatus(second.messageId, "done");
    expect(secondDone.text).toBe("REGENERATED ANSWER");
    // A new session answered it: the cached one was paused (its run finished as done) and a new wake run was opened.
    expect(secondDone.agent_run_id).not.toBe(firstDone.agent_run_id);
    expect(await runStatus(firstDone.agent_run_id)).toBe("done");
    // The model got the question again as a new user turn, and not the answer it replaces.
    expect(regenerated).toHaveLength(1);
    expect(regenerated[0]).toContain("the question");
    expect(regenerated[0]).not.toContain("FIRST ANSWER");
  });

  it("keeps the live session of a thread whose reply nobody replaced, which is why the drop above is the regeneration's", async () => {
    const followUp: string[] = [];
    await startProcess([fauxAssistantMessage("FIRST ANSWER"), recording(followUp, "SECOND ANSWER")]);
    const first = await send("the question");
    const firstDone = await awaitStatus(first.assistantMessageId, "done");

    const next = await send("a follow-up", first.threadId);

    const nextDone = await awaitStatus(next.assistantMessageId, "done");
    expect(nextDone.agent_run_id).toBe(firstDone.agent_run_id);
    expect(followUp[0]).toContain("FIRST ANSWER");
  });

  it("rebuilds the history of a later wake without the replaced answer and with the regenerated one", async () => {
    const regenerated: string[] = [];
    const later: string[] = [];
    await startProcess([fauxAssistantMessage("FIRST ANSWER"), recording(regenerated, "REGENERATED ANSWER")]);
    const first = await send("the question");
    await awaitStatus(first.assistantMessageId, "done");
    const second = await regenerate(first.threadId, first.assistantMessageId);
    await awaitStatus(second.messageId, "done");
    // A new process has no live session: the next turn wakes one from the stored history.
    await startProcess([recording(later, "THIRD ANSWER")]);

    const third = await send("a later question", first.threadId);

    await awaitStatus(third.assistantMessageId, "done");
    expect(later).toHaveLength(1);
    expect(later[0]).not.toContain("FIRST ANSWER");
    expect(later[0]).toContain("REGENERATED ANSWER");
    expect(later[0]).toContain("a later question");
    // The question was sent twice (the original turn is hidden with its answer, the regeneration sent it again), so
    // the rebuilt history holds it once.
    expect(later[0]?.split("the question")).toHaveLength(2);
  });
});
