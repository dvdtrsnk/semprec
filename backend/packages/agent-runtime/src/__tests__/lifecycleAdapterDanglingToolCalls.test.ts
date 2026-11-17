import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@semprec/data";
import type { Pool } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createAgentRun, createUser, hashPassword, withTransaction } from "@semprec/data";
import { AgentRunCancelledError, closeFailedAgentRun, runAgentSession } from "../lifecycleAdapter.js";
import { repairInterruptedRuns } from "../startupRepair.js";
import { reconstructConversationHistory } from "../conversationReconstruction.js";
import type { CompactionAdapter } from "../compaction.js";
import type { AgentMessage, AgentSession, ConversationEntry, CreateAgentSession } from "../types.js";

const noopCompaction: CompactionAdapter = {
  estimateContextTokens: (messages) => messages.length,
  shouldCompact: () => false,
  prepareCompaction: (entries) => entries,
  compact: (prepared) => prepared as ConversationEntry[],
  contextWindow: 1_000_000,
  settings: {},
};

const ITEM_ID = "99999999-9999-9999-9999-999999999999";

let pool: Pool;

const toolUse = (id: string): AgentMessage => ({
  kind: "tool_use",
  toolCallId: id,
  name: "search",
  arguments: { q: "x" },
});

function sessionThen(first: AgentMessage[], then: () => Promise<never>): CreateAgentSession {
  return (): AgentSession => ({
    async *messages() {
      for (const message of first) yield message;
      return await then();
    },
  });
}

async function storedKinds(runId: string): Promise<string[]> {
  const { rows } = await pool.query<{ kind: string }>(
    `SELECT kind FROM agent_run_events WHERE agent_run_id = $1 AND kind <> 'run_status' ORDER BY id`,
    [runId],
  );
  return rows.map((r) => r.kind);
}

describe("runAgentSession pairs dangling tool calls when a turn fails", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    const passwordHash = await hashPassword("s3cret-password");
    await createUser(pool, { email: "owner@example.test", passwordHash, locale: "en", tenantId: getTenantZeroId() });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function runnableRunIds(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM agent_runs ORDER BY started_at DESC LIMIT 1");
    return rows[0]!.id;
  }

  it("a turn cancelled mid-tool-call leaves a paired history the next wake can reconstruct", async () => {
    const controller = new AbortController();
    const createAgentSession = sessionThen([{ kind: "turn_start" }, toolUse("call-1"), toolUse("call-2")], () => {
      controller.abort();
      return new Promise<never>(() => {});
    });

    await expect(
      runAgentSession(pool, {
        createAgentSession,
        task: "t",
        triggeredBy: "user",
        unit: "session",
        projectItemId: ITEM_ID,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AgentRunCancelledError);

    const runId = await runnableRunIds();
    expect(await storedKinds(runId)).toEqual(["turn_start", "tool_use", "tool_use", "tool_result", "tool_result"]);
    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'tool_result' ORDER BY id`,
      [runId],
    );
    expect(rows[0]!.payload).toEqual({
      kind: "tool_result",
      toolCallId: "call-1",
      name: "search",
      result: { content: [{ type: "text", text: expect.stringContaining("cancelled") }], details: { error: true } },
      isError: true,
    });
    expect(rows[1]!.payload).toMatchObject({ toolCallId: "call-2", isError: true });

    const { rows: status } = await pool.query<{ status: string; error_code: string }>(
      "SELECT status, error_code FROM agent_runs WHERE id = $1",
      [runId],
    );
    expect(status[0]).toEqual({ status: "error", error_code: "cancelled" });

    // reconstructConversationHistory runs validateProtocolInvariants: it throws on an unpaired tool_use.
    const history = await reconstructConversationHistory(
      pool,
      { projectItemId: ITEM_ID, triggeredBy: "user", parentRunId: null },
      noopCompaction,
    );
    expect(history?.entries.map((e) => e.message.kind)).toEqual([
      "turn_start",
      "tool_use",
      "tool_use",
      "tool_result",
      "tool_result",
    ]);
  });

  it("a turn that fails after a tool_use is paired as failed and keeps the original error", async () => {
    const failure = new Error("model exploded");
    const createAgentSession = sessionThen([toolUse("call-1")], () => Promise.reject(failure));

    await expect(
      runAgentSession(pool, {
        createAgentSession,
        task: "t",
        triggeredBy: "user",
        unit: "session",
        projectItemId: ITEM_ID,
      }),
    ).rejects.toBe(failure);

    const runId = await runnableRunIds();
    expect(await storedKinds(runId)).toEqual(["tool_use", "tool_result"]);
    const { rows } = await pool.query<{ payload: { result: { content: Array<{ text: string }> } } }>(
      `SELECT payload FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'tool_result'`,
      [runId],
    );
    expect(rows[0]!.payload.result.content[0]!.text).toContain("failed");
  });

  it("rolls back pairing when terminalization fails and allows later startup repair", async () => {
    const failure = new Error("turn failed");
    const createAgentSession = sessionThen([toolUse("call-1")], () => Promise.reject(failure));
    let testFailure: { error: unknown } | undefined;
    try {
      await pool.query(`CREATE FUNCTION batch15_reject_tool_result() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.kind = 'run_status' AND NEW.payload->>'status' = 'error' THEN RAISE EXCEPTION 'terminal status rejected'; END IF; RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER batch15_reject_tool_result BEFORE INSERT ON agent_run_events
        FOR EACH ROW EXECUTE FUNCTION batch15_reject_tool_result()`);
      const result: unknown = await runAgentSession(pool, {
        createAgentSession,
        task: "t",
        triggeredBy: "user",
        unit: "session",
        projectItemId: ITEM_ID,
      }).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AggregateError);
      if (!(result instanceof AggregateError)) throw new Error("Expected recovery failure");
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toBe(failure);
      expect(result.cause).toBe(failure);
      expect(result.errors[1]).toBeInstanceOf(Error);
      const runId = await runnableRunIds();
      expect(await storedKinds(runId)).toEqual(["tool_use"]);
      const state = await pool.query<{ status: string; notifications: string }>(
        "SELECT status, (SELECT count(*)::text FROM notifications WHERE source_id = $1::text) AS notifications FROM agent_runs WHERE id = $1::uuid",
        [runId],
      );
      expect(state.rows).toEqual([{ status: "running", notifications: "0" }]);
      await pool.query("DROP TRIGGER batch15_reject_tool_result ON agent_run_events");
      const repaired = await repairInterruptedRuns(pool);
      expect(repaired.repairedRunIds).toContain(runId);
      expect(await storedKinds(runId)).toEqual(["tool_use", "tool_result"]);
    } catch (error) {
      testFailure = { error };
    }
    const cleanupErrors: unknown[] = [];
    for (const sql of [
      "DROP TRIGGER IF EXISTS batch15_reject_tool_result ON agent_run_events",
      "DROP FUNCTION IF EXISTS batch15_reject_tool_result()",
    ]) {
      try {
        await pool.query(sql);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        testFailure ? [testFailure.error, ...cleanupErrors] : cleanupErrors,
        "Recovery test cleanup failed",
      );
    if (testFailure) throw testFailure.error;
  });

  it("retains undefined primary and recovery failures and marks a supplied transaction rollback-only", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const spy = vi.spyOn(data, "getAgentRun").mockRejectedValueOnce(undefined);
    let observed: { error: unknown } | undefined;
    try {
      await expect(
        withTransaction(pool, async (client) => {
          try {
            await closeFailedAgentRun(client, run.id, undefined);
          } catch (error) {
            observed = { error };
          }
        }),
      ).rejects.toBeUndefined();
      expect(observed?.error).toBeInstanceOf(AggregateError);
      if (!(observed?.error instanceof AggregateError)) throw new Error("Expected aggregate failure");
      expect(observed.error.errors).toEqual([undefined, undefined]);
      expect(Object.hasOwn(observed.error, "cause")).toBe(true);
      expect(observed.error.cause).toBeUndefined();
      const { rows } = await pool.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [run.id]);
      expect(rows).toEqual([{ status: "running" }]);
    } finally {
      spy.mockRestore();
    }
  });

  it("a turn that fails with every tool call paired adds no synthetic result", async () => {
    const createAgentSession = sessionThen(
      [toolUse("call-1"), { kind: "tool_result", toolCallId: "call-1", name: "search" }],
      () => Promise.reject(new Error("later failure")),
    );

    await expect(
      runAgentSession(pool, { createAgentSession, task: "t", triggeredBy: "user", projectItemId: ITEM_ID }),
    ).rejects.toThrow("later failure");

    expect(await storedKinds(await runnableRunIds())).toEqual(["tool_use", "tool_result"]);
  });
});
