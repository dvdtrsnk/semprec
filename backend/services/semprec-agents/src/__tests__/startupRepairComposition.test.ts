import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { repairInterruptedRuns } from "@semprec/agent-runtime";
import { createAgentRun, createUser, hashPassword, insertAgentRunEvent } from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { ModuleRegistry } from "@semprec/module-registry";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";

let pool: Pool;
let runtime: AgentsQueueRuntime | undefined;

describe("semprec-agents startup repair (issue #642)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await pool.query("TRUNCATE graphile_worker._private_known_crontabs");
    const passwordHash = await hashPassword("s3cret-password");
    await createUser(pool, { email: "owner@example.test", passwordHash, locale: "en" });
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.stop();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("repairs orphaned runs, skips mcp-credential runs, and creates the queue runtime", async () => {
    const orphan = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "search something" });
    await insertAgentRunEvent(pool, orphan.id, "tool_use", { kind: "tool_use", tool: "search", toolCallId: "call-1" });
    const mcpRun = await createAgentRun(pool, { triggeredBy: "mcp", task: "mcp credential" });
    await insertAgentRunEvent(pool, mcpRun.id, "turn_start", { kind: "turn_start" });

    const { repairedRunIds } = await repairInterruptedRuns(pool);
    runtime = await createAgentsQueueRuntime(pool, new ModuleRegistry(() => new Set()));

    expect(runtime).toBeDefined();
    expect(repairedRunIds).toEqual([orphan.id]);

    const { rows: runs } = await pool.query<{ id: string; status: string; result: string | null }>(
      `SELECT id, status, result FROM agent_runs WHERE id = ANY($1)`,
      [[orphan.id, mcpRun.id]],
    );
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(byId.get(orphan.id)).toEqual({ id: orphan.id, status: "error", result: "interrupted_by_restart" });
    expect(byId.get(mcpRun.id)).toEqual({ id: mcpRun.id, status: "running", result: null });

    const { rows: orphanEvents } = await pool.query<{
      kind: string;
      payload: { toolCallId?: string; error?: boolean };
    }>(`SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 AND kind <> 'run_status' ORDER BY id ASC`, [
      orphan.id,
    ]);
    expect(orphanEvents.map((r) => r.kind)).toEqual(["tool_use", "tool_result"]);
    expect(orphanEvents[1]!.payload.toolCallId).toBe("call-1");
    expect(orphanEvents[1]!.payload.error).toBe(true);

    const { rows: mcpEvents } = await pool.query<{ kind: string }>(
      `SELECT kind FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`,
      [mcpRun.id],
    );
    expect(mcpEvents.map((r) => r.kind)).toEqual(["turn_start"]);
  });
});
