import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createUser,
  getAgentRun,
  hashPassword,
  insertAgentRunEvent,
  setNotificationCreatedHook,
  withTransaction,
  type NotificationCreatedEvent,
} from "@semprec/data";
import { reconstructConversationHistory } from "../conversationReconstruction.js";
import type { CompactionAdapter } from "../compaction.js";
import type { ConversationEntry } from "../types.js";
import { repairInterruptedRuns } from "../startupRepair.js";

const noopCompaction: CompactionAdapter = {
  estimateContextTokens: (messages) => messages.length,
  shouldCompact: () => false,
  prepareCompaction: (entries) => entries,
  compact: (prepared) => prepared as ConversationEntry[],
  contextWindow: 1_000_000,
  settings: {},
};

let pool: Pool;

describe("repairInterruptedRuns", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    const passwordHash = await hashPassword("s3cret-password");
    await createUser(pool, { email: "owner@example.test", passwordHash, locale: "en", tenantId: getTenantZeroId() });
  });

  afterEach(() => {
    setNotificationCreatedHook(() => {});
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("closes every running run as error/interrupted and leaves finished runs untouched", async () => {
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
    expect(byId.get(orphanA.id)?.result).toBe("interrupted");
    expect((await getAgentRun(pool, orphanA.id))?.errorCode).toBe("interrupted");
    expect(byId.get(orphanA.id)?.finished_at).not.toBeNull();

    expect(byId.get(orphanB.id)?.status).toBe("error");
    expect(byId.get(orphanB.id)?.result).toBe("interrupted");

    expect(byId.get(alreadyDone.id)?.status).toBe("done");
  });

  it("appends a synthetic tool_result when the last event is an unmatched tool_use", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "search something" });
    await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });
    await insertAgentRunEvent(pool, run.id, "tool_use", {
      kind: "tool_use",
      toolCallId: "call-1",
      name: "search",
      arguments: { q: "secret" },
      operation: "items.search",
      mcp: { server: "docs" },
      targetDatabaseId: "db-1",
      targetItemId: "item-1",
      extra: "dropped",
    });

    await repairInterruptedRuns(pool);

    const { rows } = await pool.query<{ kind: string; payload: unknown }>(
      `SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 AND kind <> 'run_status' ORDER BY id ASC`,
      [run.id],
    );

    expect(rows.map((r) => r.kind)).toEqual(["turn_start", "tool_use", "tool_result"]);
    expect(rows[2]!.payload).toEqual({
      kind: "tool_result",
      toolCallId: "call-1",
      name: "search",
      operation: "items.search",
      mcp: { server: "docs" },
      targetDatabaseId: "db-1",
      targetItemId: "item-1",
      result: {
        content: [{ type: "text", text: expect.stringContaining("interrupted_by_restart") }],
        details: { error: true },
      },
      isError: true,
    });
  });

  it("leaves the repaired history reconstructable under the protocol check", async () => {
    const itemId = "99999999-9999-9999-9999-999999999999";
    const run = await createAgentRun(pool, {
      projectItemId: itemId,
      triggeredBy: "user",
      unit: "session",
      task: "search something",
    });
    await insertAgentRunEvent(pool, run.id, "tool_use", { kind: "tool_use", toolCallId: "call-1", name: "search" });

    await repairInterruptedRuns(pool);

    const history = await reconstructConversationHistory(
      pool,
      { projectItemId: itemId, triggeredBy: "user", parentRunId: null },
      noopCompaction,
    );
    expect(history?.entries.map((e) => e.message.kind)).toEqual(["tool_use", "tool_result"]);
    expect(history?.entries[1]!.message).toMatchObject({ toolCallId: "call-1", name: "search", isError: true });
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

  it("repairs an earlier unmatched call but not matched or absent calls followed by ordinary events", async () => {
    const unmatched = await createAgentRun(pool, { triggeredBy: "user", task: "unmatched" });
    const matched = await createAgentRun(pool, { triggeredBy: "user", task: "matched" });
    const absent = await createAgentRun(pool, { triggeredBy: "user", task: "absent" });
    await insertAgentRunEvent(pool, unmatched.id, "tool_use", {
      kind: "tool_use",
      toolCallId: "pending",
      name: "search",
    });
    await insertAgentRunEvent(pool, unmatched.id, "message", { kind: "message", text: "later" });
    await insertAgentRunEvent(pool, matched.id, "tool_use", { kind: "tool_use", toolCallId: "done", name: "search" });
    await insertAgentRunEvent(pool, matched.id, "tool_result", {
      kind: "tool_result",
      toolCallId: "done",
      name: "search",
    });
    await insertAgentRunEvent(pool, matched.id, "message", { kind: "message", text: "later" });
    await insertAgentRunEvent(pool, absent.id, "message", { kind: "message", text: "later" });

    await repairInterruptedRuns(pool);

    const { rows } = await pool.query<{ agent_run_id: string; kind: string; payload: unknown }>(
      `SELECT agent_run_id, kind, payload FROM agent_run_events
       WHERE agent_run_id = ANY($1::uuid[]) AND kind <> 'run_status' ORDER BY id`,
      [[unmatched.id, matched.id, absent.id]],
    );
    const eventsFor = (id: string) => rows.filter((row) => row.agent_run_id === id);
    expect(eventsFor(unmatched.id).map((row) => row.kind)).toEqual(["tool_use", "message", "tool_result"]);
    expect(eventsFor(unmatched.id)[2]?.payload).toMatchObject({
      kind: "tool_result",
      toolCallId: "pending",
      name: "search",
      isError: true,
    });
    expect(eventsFor(matched.id).map((row) => row.kind)).toEqual(["tool_use", "tool_result", "message"]);
    expect(eventsFor(absent.id).map((row) => row.kind)).toEqual(["message"]);
  });

  it.each([
    [{ kind: "tool_use", name: "search" }, { name: "search" }],
    [
      { kind: "tool_use", toolCallId: "call-without-name" },
      { name: "", toolCallId: "call-without-name" },
    ],
  ])("repairs a call with a missing identity field", async (payload, expectedIdentity) => {
    const run = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "missing tool identity" });
    await insertAgentRunEvent(pool, run.id, "tool_use", payload);
    await repairInterruptedRuns(pool);
    const { rows } = await pool.query<{ payload: unknown }>(
      "SELECT payload FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'tool_result'",
      [run.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ kind: "tool_result", isError: true, ...expectedIdentity });
    if (!("toolCallId" in payload)) expect(rows[0]?.payload).not.toHaveProperty("toolCallId");
  });

  it("falls back to a bare synthetic tool_result when the trailing tool_use payload is not a plain object", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "malformed payload" });
    await pool.query(`INSERT INTO agent_run_events (agent_run_id, kind, payload) VALUES ($1, 'tool_use', $2::jsonb)`, [
      run.id,
      JSON.stringify(["not", "an", "object"]),
    ]);

    await expect(repairInterruptedRuns(pool)).resolves.toEqual({ repairedRunIds: [run.id], closedIdleRunIds: [] });

    const { rows } = await pool.query<{ kind: string; payload: unknown }>(
      `SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`,
      [run.id],
    );
    expect(rows.map((r) => r.kind)).toEqual(["tool_use", "tool_result"]);
    expect(rows[1]!.payload).toMatchObject({ kind: "tool_result", name: "", isError: true });
    expect(rows[1]!.payload).not.toHaveProperty("toolCallId");
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
      result: "interrupted",
    });

    const { rows: mcpEvents } = await pool.query<{ kind: string }>(
      `SELECT kind FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`,
      [mcpRun.id],
    );
    expect(mcpEvents.map((r) => r.kind)).toEqual(["tool_use"]);

    const { rows: heartbeatEvents } = await pool.query<{
      kind: string;
      payload: unknown;
    }>(`SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 AND kind <> 'run_status' ORDER BY id ASC`, [
      heartbeatRun.id,
    ]);
    expect(heartbeatEvents.map((r) => r.kind)).toEqual(["tool_use", "tool_result"]);
    expect(heartbeatEvents[1]!.payload).toMatchObject({ toolCallId: "hb-1", isError: true });

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
      query: ((...args: Parameters<Pool["query"]>) => pool.query(...args)) as Pool["query"],
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

    const failure = await repairInterruptedRuns(commitFailingPool).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toMatchObject({ message: "commit failed" });
    expect(events).toEqual([]);

    await withTransaction(pool, async () => undefined);
    expect(events).toEqual([]);
  });
});
