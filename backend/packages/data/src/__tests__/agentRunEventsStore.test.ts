import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import {
  insertAgentRunEvent,
  insertAndNotifyAgentRunEvent,
  getAgentRunEventById,
  listAgentRunEvents,
  listAgentRunEventsAfter,
} from "../agentRuns/agentRunEventsStore.js";
import { setAgentRunEventHook } from "../realtimeHook.js";

let pool: Pool;

describe("agentRunEventsStore", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  afterEach(() => {
    setAgentRunEventHook(() => {});
  });

  it("lists events for a run in monotonic id order with fields mapped from the raw row", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });

    const inserted = [
      await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" }),
      await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "hi" }),
      await insertAgentRunEvent(pool, run.id, "turn_end", { kind: "turn_end" }),
    ];

    const listed = await listAgentRunEvents(pool, run.id);

    expect(listed.map((e) => e.id)).toEqual(inserted.map((e) => e.id));
    expect(listed.map((e) => e.kind)).toEqual(["turn_start", "message", "turn_end"]);
    expect(listed[1]!.payload).toEqual({ kind: "message", text: "hi" });
    expect(listed.every((e) => e.agentRunId === run.id)).toBe(true);
    expect(listed.every((e) => typeof e.at === "string")).toBe(true);

    const { rows: rawRows } = await pool.query<{ id: string; kind: string }>(
      "SELECT id, kind FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC",
      [run.id],
    );
    expect(listed.map((e) => e.id)).toEqual(rawRows.map((r) => r.id));
    expect(listed.map((e) => e.kind)).toEqual(rawRows.map((r) => r.kind));
  });

  it("scopes listAgentRunEvents to the given run", async () => {
    const runA = await createAgentRun(pool, { triggeredBy: "user", task: "a" });
    const runB = await createAgentRun(pool, { triggeredBy: "user", task: "b" });

    await insertAgentRunEvent(pool, runA.id, "turn_start", { kind: "turn_start" });
    await insertAgentRunEvent(pool, runB.id, "turn_start", { kind: "turn_start" });

    const listedA = await listAgentRunEvents(pool, runA.id);
    expect(listedA).toHaveLength(1);
    expect(listedA[0]!.agentRunId).toBe(runA.id);
  });

  it("replays only later events for the requested run and resolves thin references by that same run", async () => {
    const runA = await createAgentRun(pool, { triggeredBy: "user", task: "a" });
    const runB = await createAgentRun(pool, { triggeredBy: "user", task: "b" });
    const first = await insertAgentRunEvent(pool, runA.id, "turn_start", { kind: "turn_start" });
    const otherRunEvent = await insertAgentRunEvent(pool, runB.id, "turn_start", { kind: "turn_start" });
    const second = await insertAgentRunEvent(pool, runA.id, "message", { kind: "message", text: "second" });
    const last = await insertAgentRunEvent(pool, runA.id, "turn_end", { kind: "turn_end" });

    const replayed = await listAgentRunEventsAfter(pool, runA.id, first.id);
    expect(replayed.map((event) => event.id)).toEqual([second.id, last.id]);
    expect(replayed.every((event) => event.agentRunId === runA.id)).toBe(true);
    expect(await listAgentRunEventsAfter(pool, runA.id, last.id)).toEqual([]);

    await expect(getAgentRunEventById(pool, runA.id, second.id)).resolves.toMatchObject({
      id: second.id,
      agentRunId: runA.id,
    });
    await expect(getAgentRunEventById(pool, runB.id, second.id)).resolves.toBeNull();
    await expect(getAgentRunEventById(pool, runA.id, otherRunEvent.id)).resolves.toBeNull();
  });

  it("announces a thin event reference only after its transaction commits", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "announce" });
    const announced: Array<{ agentRunId: string; eventId: string }> = [];
    setAgentRunEventHook((event) => announced.push(event));

    const event = await withTransaction(pool, async (client) => {
      const inserted = await insertAndNotifyAgentRunEvent(client, run.id, "turn_start", { kind: "turn_start" });
      expect(announced).toEqual([]);
      return inserted;
    });

    expect(announced).toEqual([{ agentRunId: run.id, eventId: event.id }]);
  });

  it("does not announce a durable event when its transaction rolls back", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "rollback announcement" });
    const announced: Array<{ agentRunId: string; eventId: string }> = [];
    setAgentRunEventHook((event) => announced.push(event));

    await expect(
      withTransaction(pool, async (client) => {
        await insertAndNotifyAgentRunEvent(client, run.id, "turn_start", { kind: "turn_start" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(announced).toEqual([]);
  });
});
