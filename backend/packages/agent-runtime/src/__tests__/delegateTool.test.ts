import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createAgentRun } from "@semprec/data";
import { BUSY_ERROR_MESSAGE, DelegationRegistry, type ReconstructDelegatedHistory } from "../delegationRegistry.js";
import { createDelegateTool } from "../delegateTool.js";
import type { AgentMessage, AgentSession, ConversationEntry, CreateAgentSession } from "../types.js";

let pool: Pool;

function fakeSession(messages: AgentMessage[]): CreateAgentSession {
  return (): AgentSession => ({
    async *messages() {
      for (const message of messages) yield message;
    },
  });
}

describe("createDelegateTool", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("returns the target's final assistant message as a non-error tool_result shape", async () => {
    const registry = new DelegationRegistry(pool);
    const supervisorRun = await createAgentRun(pool, { triggeredBy: "user", task: "supervise" });
    const delegate = createDelegateTool(
      registry,
      fakeSession([{ kind: "turn_start" }, { kind: "message", text: "handled" }, { kind: "turn_end" }]),
    );

    const result = await delegate(supervisorRun.id, {
      targetProjectItemId: "88888888-8888-8888-8888-888888888888",
      task: "handle it",
    });

    expect(result).toEqual({ error: false, result: "handled" });
    registry.clear();
  });

  it("surfaces the busy rejection as an error tool_result instead of throwing", async () => {
    const registry = new DelegationRegistry(pool);
    const supervisorRun = await createAgentRun(pool, { triggeredBy: "user", task: "supervise" });
    const targetProjectItemId = "99999999-9999-9999-9999-999999999999";

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking: CreateAgentSession = (): AgentSession => ({
      async *messages() {
        yield { kind: "turn_start" };
        await gate;
        yield { kind: "message", text: "done" };
        yield { kind: "turn_end" };
      },
    });
    const delegate = createDelegateTool(registry, blocking);

    const inFlight = delegate(supervisorRun.id, { targetProjectItemId, task: "slow" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const duplicate = await delegate(supervisorRun.id, { targetProjectItemId, task: "duplicate" });
    expect(duplicate).toEqual({ error: true, result: BUSY_ERROR_MESSAGE });

    release();
    await inFlight;
    registry.clear();
  });

  it("threads an optional reconstructHistory through to registry.delegate", async () => {
    const registry = new DelegationRegistry(pool);
    const supervisorRun = await createAgentRun(pool, { triggeredBy: "user", task: "supervise" });
    const targetProjectItemId = "77777777-7777-7777-7777-777777777777";
    const priorEntry: ConversationEntry = {
      id: "1",
      parentId: null,
      seq: 0,
      timestamp: 0,
      message: { kind: "message", text: "summary" },
    };
    let seenArgs: { targetProjectItemId: string; supervisorRunId: string } | undefined;
    const reconstructHistory: ReconstructDelegatedHistory = async (_pool, tid, sid) => {
      seenArgs = { supervisorRunId: sid, targetProjectItemId: tid };
      return { entries: [priorEntry], compacted: false };
    };
    const delegate = createDelegateTool(
      registry,
      fakeSession([{ kind: "turn_start" }, { kind: "message", text: "resumed" }, { kind: "turn_end" }]),
      reconstructHistory,
    );

    const result = await delegate(supervisorRun.id, { targetProjectItemId, task: "handle it" });

    expect(result).toEqual({ error: false, result: "resumed" });
    expect(seenArgs).toEqual({ supervisorRunId: supervisorRun.id, targetProjectItemId });
    registry.clear();
  });
});
