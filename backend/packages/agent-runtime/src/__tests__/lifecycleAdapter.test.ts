import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { setAgentRunEventHook } from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { getTraceContext } from "@semprec/shared";
import { publishRealtimeMessage } from "@semprec/realtime";
import { runAgentSession } from "../lifecycleAdapter.js";
import type { AgentMessage, AgentSession, CreateAgentSession } from "../types.js";

let pool: Pool;

async function createUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id`,
    [`${randomUUID()}@example.com`],
  );
  return rows[0]!.id;
}

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
    await createUser();
    setAgentRunEventHook((event) => {
      publishRealtimeMessage(pool, { type: "agent_run_event", ...event }).catch((err: unknown) => {
        console.error("Failed to publish agent_run_event realtime message", err);
      });
    });
  });

  afterEach(() => {
    setAgentRunEventHook(() => {});
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
  });

  it("binds the new run's id into the trace context the session's message stream runs under (#167)", async () => {
    const observed: { traceId: string | undefined; agentRunId: string | undefined }[] = [];
    const createAgentSession: CreateAgentSession = (): AgentSession => ({
      async *messages() {
        observed.push({ traceId: getTraceContext()?.traceId, agentRunId: getTraceContext()?.agentRunId });
        yield { kind: "turn_start" };
        yield { kind: "turn_end" };
      },
    });

    const run = await runAgentSession(pool, {
      createAgentSession,
      task: "do the thing",
      triggeredBy: "user",
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]!.agentRunId).toBe(run.id);
    expect(observed[0]!.traceId).toMatch(/^[0-9a-f-]{36}$/i);
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
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.result).toBe("boom");
  });

  it("announces durable events as thin references and sends message_update only on the ephemeral stream", async () => {
    const listenClient = await pool.connect();
    await listenClient.query("LISTEN semprec_events");
    await listenClient.query("LISTEN semprec_agent_stream");
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

    const durableForRun = () =>
      notifications
        .filter((n) => n.channel === "semprec_events")
        .map((n) => JSON.parse(n.payload ?? "{}"))
        .filter((m) => m.agentRunId === run.id);
    const deltasForRun = () =>
      notifications
        .filter((n) => n.channel === "semprec_agent_stream")
        .map((n) => JSON.parse(n.payload ?? "{}"))
        .filter((m) => m.agentRunId === run.id);

    // NOTIFY delivery to a LISTEN-ing client is asynchronous relative to the query that
    // triggered it; poll instead of a fixed sleep so this isn't flaky under load.
    const expectedCount = 5; // run_status(running), turn_start, message, turn_end, run_status(done)
    const deadline = Date.now() + 5000;
    while ((durableForRun().length < expectedCount || deltasForRun().length < 1) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const durable = durableForRun();
    const { rows } = await pool.query<{ id: string; kind: string }>(
      "SELECT id, kind FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC",
      [run.id],
    );
    expect(durable.every((m) => m.type === "agent_run_event")).toBe(true);
    expect(durable.map((m) => m.eventId)).toEqual(rows.map((row) => row.id));
    expect(durable.every((m) => !("payload" in m) && !("kind" in m))).toBe(true);
    expect(deltasForRun()).toEqual([
      {
        type: "agent_run_delta",
        agentRunId: run.id,
        delta: {
          kind: "message_update",
          text: "partial",
        },
      },
    ]);
    expect(rows.some((row) => row.kind === "message_update")).toBe(false);
    expect(deltasForRun()[0]?.delta).toEqual({
      kind: "message_update",
      text: "partial",
    });

    listenClient.release(true);
  });
});
