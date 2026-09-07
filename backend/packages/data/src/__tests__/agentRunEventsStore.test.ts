import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { insertAgentRunEvent, listAgentRunEvents } from "../agentRuns/agentRunEventsStore.js";

let pool: Pool;

describe("agentRunEventsStore", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
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
    expect(listed[1].payload).toEqual({ kind: "message", text: "hi" });
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
    expect(listedA[0].agentRunId).toBe(runA.id);
  });
});
