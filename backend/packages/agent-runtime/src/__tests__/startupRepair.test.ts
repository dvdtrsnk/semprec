import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createAgentRun, insertAgentRunEvent } from "@semprec/data";
import { repairInterruptedRuns } from "../startupRepair.js";

let pool: Pool;

describe("repairInterruptedRuns", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("closes every running run as error/interrupted_by_restart and leaves finished runs untouched", async () => {
    const orphanA = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "a" });
    const orphanB = await createAgentRun(pool, { triggeredBy: "user", task: "b" });
    const alreadyDone = await createAgentRun(pool, { triggeredBy: "mcp", task: "c" });
    await pool.query(`UPDATE agent_runs SET status = 'done', finished_at = now() WHERE id = $1`, [alreadyDone.id]);

    const { repairedRunIds } = await repairInterruptedRuns(pool);

    expect(new Set(repairedRunIds)).toEqual(new Set([orphanA.id, orphanB.id]));

    const { rows } = await pool.query<{ id: string; status: string; result: string | null; finished_at: Date | null }>(
      `SELECT id, status, result, finished_at FROM agent_runs WHERE id = ANY($1)`,
      [[orphanA.id, orphanB.id, alreadyDone.id]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(orphanA.id)?.status).toBe("error");
    expect(byId.get(orphanA.id)?.result).toBe("interrupted_by_restart");
    expect(byId.get(orphanA.id)?.finished_at).not.toBeNull();

    expect(byId.get(orphanB.id)?.status).toBe("error");
    expect(byId.get(orphanB.id)?.result).toBe("interrupted_by_restart");

    expect(byId.get(alreadyDone.id)?.status).toBe("done");
  });

  it("appends a synthetic tool_result when the last event is an unmatched tool_use", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "search something" });
    await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });
    await insertAgentRunEvent(pool, run.id, "tool_use", { kind: "tool_use", tool: "search", toolCallId: "call-1" });

    await repairInterruptedRuns(pool);

    const { rows } = await pool.query<{ kind: string; payload: { tool?: string; toolCallId?: string; error?: boolean } }>(
      `SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`,
      [run.id],
    );

    expect(rows.map((r) => r.kind)).toEqual(["turn_start", "tool_use", "tool_result"]);
    const synthetic = rows[2].payload;
    expect(synthetic.tool).toBe("search");
    expect(synthetic.toolCallId).toBe("call-1");
    expect(synthetic.error).toBe(true);
  });

  it("does not append a synthetic tool_result when the trailing tool_use already has a tool_result", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "search something" });
    await insertAgentRunEvent(pool, run.id, "tool_use", { kind: "tool_use", tool: "search" });
    await insertAgentRunEvent(pool, run.id, "tool_result", { kind: "tool_result", tool: "search", result: "ok" });

    await repairInterruptedRuns(pool);

    const { rows } = await pool.query(`SELECT kind FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`, [run.id]);
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual(["tool_use", "tool_result"]);
  });

  it("falls back to a bare synthetic tool_result when the trailing tool_use payload is not a plain object", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "malformed payload" });
    await pool.query(
      `INSERT INTO agent_run_events (agent_run_id, kind, payload) VALUES ($1, 'tool_use', $2::jsonb)`,
      [run.id, JSON.stringify(["not", "an", "object"])],
    );

    await expect(repairInterruptedRuns(pool)).resolves.toEqual({ repairedRunIds: [run.id] });

    const { rows } = await pool.query<{ kind: string; payload: { error?: boolean } }>(
      `SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`,
      [run.id],
    );
    expect(rows.map((r) => r.kind)).toEqual(["tool_use", "tool_result"]);
    expect(rows[1].payload.error).toBe(true);
  });

  it("does not append a synthetic tool_result when the run has no events at all", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "no events yet" });

    const { repairedRunIds } = await repairInterruptedRuns(pool);

    expect(repairedRunIds).toEqual([run.id]);
    const { rows } = await pool.query(`SELECT kind FROM agent_run_events WHERE agent_run_id = $1`, [run.id]);
    expect(rows).toEqual([]);
  });

  it("is a no-op when there are no running runs", async () => {
    const { repairedRunIds } = await repairInterruptedRuns(pool);
    expect(repairedRunIds).toEqual([]);
  });
});
