import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createAgentRun } from "@semprec/data";
import { BUSY_ERROR_MESSAGE, DelegationRegistry } from "../delegationRegistry.js";
import { createDelegateTool } from "../delegateTool.js";
import type { AgentMessage, AgentSession, CreateAgentSession } from "../types.js";

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
});
