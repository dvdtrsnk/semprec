import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { runAgentSession } from "../lifecycleAdapter.js";
import type { AgentMessage, AgentSession, CreateAgentSession } from "../types.js";

let pool: Pool;

function fakeSession(messages: AgentMessage[]): CreateAgentSession {
  return (): AgentSession => ({
    async *messages() {
      for (const message of messages) yield message;
    },
  });
}

describe("runAgentSession", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reconstructs a completed run's transcript from agent_run_events in monotonic order", async () => {
    const messages: AgentMessage[] = [
      { kind: "turn_start" },
      { kind: "message_update", text: "Hel" },
      { kind: "message_update", text: "Hello" },
      { kind: "message", text: "Hello there" },
      { kind: "tool_use", tool: "search" },
      { kind: "tool_result", tool: "search", result: "ok" },
      { kind: "run_status", status: "waiting_for_approval" },
      { kind: "turn_end" },
    ];

    const run = await runAgentSession(pool, {
      createAgentSession: fakeSession(messages),
      task: "do the thing",
      triggeredBy: "user",
    });

    expect(run.status).toBe("done");
    expect(run.result).toBe("Hello there");
    expect(run.unit).toBe("invocation");

    const { rows } = await pool.query<{ id: string; kind: string }>(
      "SELECT id, kind FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC",
      [run.id],
    );

    expect(rows.map((r) => r.kind)).toEqual([
      "turn_start",
      "message",
      "tool_use",
      "tool_result",
      "run_status",
      "turn_end",
    ]);

    const ids = rows.map((r) => BigInt(r.id));
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("never persists message_update deltas", async () => {
    const run = await runAgentSession(pool, {
      createAgentSession: fakeSession([
        { kind: "turn_start" },
        { kind: "message_update", text: "partial" },
        { kind: "message_update", text: "partial two" },
        { kind: "turn_end" },
      ]),
      task: "stream something",
      triggeredBy: "mcp",
    });

    const { rows } = await pool.query("SELECT kind FROM agent_run_events WHERE agent_run_id = $1", [run.id]);
    expect(rows.some((r) => r.kind === "message_update")).toBe(false);
  });

  it("persists the caller-chosen unit, defaulting to invocation", async () => {
    const sessionRun = await runAgentSession(pool, {
      createAgentSession: fakeSession([{ kind: "turn_start" }, { kind: "turn_end" }]),
      task: "managed conversation",
      triggeredBy: "user",
      unit: "session",
    });
    expect(sessionRun.unit).toBe("session");

    const invocationRun = await runAgentSession(pool, {
      createAgentSession: fakeSession([{ kind: "turn_start" }, { kind: "turn_end" }]),
      task: "one-shot",
      triggeredBy: "heartbeat",
    });
    expect(invocationRun.unit).toBe("invocation");
  });

  it("marks the run as errored and stops persisting further events when the session throws", async () => {
    const createAgentSession: CreateAgentSession = (): AgentSession => ({
      async *messages() {
        yield { kind: "turn_start" };
        throw new Error("boom");
      },
    });

    await expect(
      runAgentSession(pool, { createAgentSession, task: "fails", triggeredBy: "supervisor" }),
    ).rejects.toThrow("boom");

    const { rows } = await pool.query<{ status: string; result: string | null }>(
      "SELECT status, result FROM agent_runs WHERE task = 'fails'",
    );
    expect(rows[0].status).toBe("error");
    expect(rows[0].result).toBe("boom");
  });

  it("pushes every message, including message_update deltas, as a live agent_run_event NOTIFY", async () => {
    const listenClient = await pool.connect();
    await listenClient.query("LISTEN semprec_realtime");
    const notifications: Array<{ channel: string; payload?: string }> = [];
    listenClient.on("notification", (msg) => notifications.push(msg));

    const messages: AgentMessage[] = [
      { kind: "turn_start" },
      { kind: "message_update", text: "partial" },
      { kind: "message", text: "done" },
      { kind: "turn_end" },
    ];

    const run = await runAgentSession(pool, {
      createAgentSession: fakeSession(messages),
      task: "push live",
      triggeredBy: "user",
    });

    const pushedForRun = () =>
      notifications
        .filter((n) => n.channel === "semprec_realtime")
        .map((n) => JSON.parse(n.payload ?? "{}"))
        .filter((m) => m.agentRunId === run.id);

    // NOTIFY delivery to a LISTEN-ing client is asynchronous relative to the query that
    // triggered it; poll instead of a fixed sleep so this isn't flaky under load.
    const expectedCount = 6; // run_status(running), turn_start, message_update, message, turn_end, run_status(done)
    const deadline = Date.now() + 5000;
    while (pushedForRun().length < expectedCount && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const pushed = pushedForRun();

    expect(pushed.map((m) => m.kind)).toEqual([
      "run_status",
      "turn_start",
      "message_update",
      "message",
      "turn_end",
      "run_status",
    ]);
    expect(pushed.every((m) => m.type === "agent_run_event")).toBe(true);
    expect(pushed.find((m) => m.kind === "message_update")?.payload).toEqual({ kind: "message_update", text: "partial" });
    expect(pushed[0].payload).toEqual({ kind: "run_status", status: "running" });
    expect(pushed[5].payload).toEqual({ kind: "run_status", status: "done" });

    listenClient.release(true);
  });
});
