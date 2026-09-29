import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createUser,
  hashPassword,
  insertAgentRunEvent,
  setNotificationCreatedHook,
  withTransaction,
  type NotificationCreatedEvent,
} from "@semprec/data";
import { repairInterruptedRuns } from "../startupRepair.js";

let pool: Pool;

describe("repairInterruptedRuns", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    const passwordHash = await hashPassword("s3cret-password");
    await createUser(pool, { email: "owner@example.test", passwordHash, locale: "en" });
  });

  afterEach(() => {
    setNotificationCreatedHook(() => {});
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

    const { rows } = await pool.query<{
      kind: string;
      payload: { tool?: string; toolCallId?: string; error?: boolean };
    }>(`SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`, [run.id]);

    expect(rows.map((r) => r.kind)).toEqual(["turn_start", "tool_use", "tool_result"]);
    const synthetic = rows[2]!.payload;
    expect(synthetic.tool).toBe("search");
    expect(synthetic.toolCallId).toBe("call-1");
    expect(synthetic.error).toBe(true);
  });

  it("does not append a synthetic tool_result when the trailing tool_use already has a tool_result", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "search something" });
    await insertAgentRunEvent(pool, run.id, "tool_use", { kind: "tool_use", tool: "search" });
    await insertAgentRunEvent(pool, run.id, "tool_result", { kind: "tool_result", tool: "search", result: "ok" });

    await repairInterruptedRuns(pool);

    const { rows } = await pool.query(`SELECT kind FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`, [
      run.id,
    ]);
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual(["tool_use", "tool_result"]);
  });

  it("falls back to a bare synthetic tool_result when the trailing tool_use payload is not a plain object", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "malformed payload" });
    await pool.query(`INSERT INTO agent_run_events (agent_run_id, kind, payload) VALUES ($1, 'tool_use', $2::jsonb)`, [
      run.id,
      JSON.stringify(["not", "an", "object"]),
    ]);

    await expect(repairInterruptedRuns(pool)).resolves.toEqual({ repairedRunIds: [run.id] });

    const { rows } = await pool.query<{ kind: string; payload: { error?: boolean } }>(
      `SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`,
      [run.id],
    );
    expect(rows.map((r) => r.kind)).toEqual(["tool_use", "tool_result"]);
    expect(rows[1]!.payload.error).toBe(true);
  });

  it("does not append a synthetic tool_result when the run has no events at all", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "no events yet" });

    const { repairedRunIds } = await repairInterruptedRuns(pool);

    expect(repairedRunIds).toEqual([run.id]);
    const { rows } = await pool.query(`SELECT kind FROM agent_run_events WHERE agent_run_id = $1`, [run.id]);
    expect(rows).toEqual([]);
  });

  it("leaves a running mcp-credential run untouched while repairing a heartbeat run in the same sweep", async () => {
    const mcpRun = await createAgentRun(pool, { triggeredBy: "mcp", task: "mcp credential" });
    await insertAgentRunEvent(pool, mcpRun.id, "tool_use", { kind: "tool_use", tool: "search", toolCallId: "mcp-1" });
    const heartbeatRun = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "search something" });
    await insertAgentRunEvent(pool, heartbeatRun.id, "tool_use", {
      kind: "tool_use",
      tool: "search",
      toolCallId: "hb-1",
    });

    const { repairedRunIds } = await repairInterruptedRuns(pool);

    expect(repairedRunIds).toEqual([heartbeatRun.id]);

    const { rows: runs } = await pool.query<{ id: string; status: string; result: string | null }>(
      `SELECT id, status, result FROM agent_runs WHERE id = ANY($1)`,
      [[mcpRun.id, heartbeatRun.id]],
    );
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(byId.get(mcpRun.id)).toEqual({ id: mcpRun.id, status: "running", result: null });
    expect(byId.get(heartbeatRun.id)).toEqual({
      id: heartbeatRun.id,
      status: "error",
      result: "interrupted_by_restart",
    });

    const { rows: mcpEvents } = await pool.query<{ kind: string }>(
      `SELECT kind FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`,
      [mcpRun.id],
    );
    expect(mcpEvents.map((r) => r.kind)).toEqual(["tool_use"]);

    const { rows: heartbeatEvents } = await pool.query<{
      kind: string;
      payload: { toolCallId?: string; error?: boolean };
    }>(`SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 AND kind <> 'run_status' ORDER BY id ASC`, [
      heartbeatRun.id,
    ]);
    expect(heartbeatEvents.map((r) => r.kind)).toEqual(["tool_use", "tool_result"]);
    expect(heartbeatEvents[1]!.payload.toolCallId).toBe("hb-1");
    expect(heartbeatEvents[1]!.payload.error).toBe(true);

    const { rows: notifications } = await pool.query<{ kind: string; source_id: string }>(
      `SELECT kind, source_id FROM notifications ORDER BY source_id`,
    );
    expect(notifications).toEqual([{ kind: "agent_run_error", source_id: heartbeatRun.id }]);
  });

  it("is a no-op when there are no running runs", async () => {
    const { repairedRunIds } = await repairInterruptedRuns(pool);
    expect(repairedRunIds).toEqual([]);
  });

  it("fires one notification_created hook per repaired run, only after repairInterruptedRuns resolves", async () => {
    const orphanA = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "a" });
    const orphanB = await createAgentRun(pool, { triggeredBy: "user", task: "b" });
    const events: NotificationCreatedEvent[] = [];
    setNotificationCreatedHook((event) => {
      events.push(event);
    });

    const result = repairInterruptedRuns(pool);
    expect(events).toEqual([]);
    const { repairedRunIds } = await result;

    expect(new Set(repairedRunIds)).toEqual(new Set([orphanA.id, orphanB.id]));
    expect(events).toHaveLength(2);
  });

  it("fires no notification_created hook when the repair transaction fails, and none from a later unrelated transaction", async () => {
    await createAgentRun(pool, { triggeredBy: "heartbeat", task: "a" });
    const events: NotificationCreatedEvent[] = [];
    setNotificationCreatedHook((event) => {
      events.push(event);
    });

    const commitFailingPool: Pool = {
      connect: async () => {
        const client = await pool.connect();
        const originalQuery = client.query.bind(client);
        const originalRelease = client.release.bind(client);
        client.query = ((...args: Parameters<PoolClient["query"]>) => {
          if (args[0] === "COMMIT") {
            return Promise.reject(new Error("commit failed"));
          }
          return originalQuery(...args);
        }) as PoolClient["query"];
        // withTransaction's ROLLBACK succeeds here, so it releases this client
        // with no error and pg would return it — with its COMMIT still
        // intercepted — to the real pool's idle queue for reuse by the next
        // withTransaction call below. Force pg to discard it instead.
        client.release = (err?: Error | boolean) => {
          originalRelease(err instanceof Error ? err : new Error("discard client contaminated by commitFailingPool"));
        };
        return client;
      },
    } as unknown as Pool;

    await expect(repairInterruptedRuns(commitFailingPool)).rejects.toThrow("commit failed");
    expect(events).toEqual([]);

    await withTransaction(pool, async () => undefined);
    expect(events).toEqual([]);
  });
});
