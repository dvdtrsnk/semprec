import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createUser,
  getAgentRun,
  hashPassword,
  insertAgentRunEvent,
  setNotificationCreatedHook,
  type AgentRunEventKind,
} from "@semprec/data";
import { reconstructConversationHistory } from "../conversationReconstruction.js";
import type { CompactionAdapter } from "../compaction.js";
import type { ConversationEntry } from "../types.js";
import { closeIdleThreadSessions, repairInterruptedRuns } from "../startupRepair.js";

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

let lastThreadId = "";

async function threadRun(events: AgentRunEventKind[]): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO semp_threads (tenant_id, kind) VALUES ($1, 'chat') RETURNING id",
    [getTenantZeroId()],
  );
  lastThreadId = rows[0]!.id;
  const run = await createAgentRun(pool, {
    projectItemId: ITEM_ID,
    threadId: rows[0]!.id,
    triggeredBy: "user",
    unit: "session",
    task: "chat",
  });
  for (const kind of events) {
    await insertAgentRunEvent(pool, run.id, kind, { kind });
  }
  return run.id;
}

async function errorNotificationCount(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM notifications WHERE kind = 'agent_run_error'",
  );
  return Number(rows[0]!.n);
}

describe("idle thread sessions on restart and shutdown", () => {
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

  it("startup repair closes an idle thread session as done without a notification and the thread wakes again", async () => {
    const idle = await threadRun(["turn_start", "message", "turn_end"]);

    const result = await repairInterruptedRuns(pool);

    expect(result.closedIdleRunIds).toEqual([idle]);
    expect(result.repairedRunIds).toEqual([]);
    const run = await getAgentRun(pool, idle);
    expect(run?.status).toBe("done");
    expect(run?.errorCode).toBeNull();
    expect(await errorNotificationCount()).toBe(0);
    const history = await reconstructConversationHistory(
      pool,
      { threadId: lastThreadId, triggeredBy: "user", parentRunId: null },
      noopCompaction,
    );
    expect(history?.entries.map((e) => e.message.kind)).toEqual(["turn_start", "message", "turn_end"]);
  });

  it("startup repair still closes a mid-turn thread session as error with its notification", async () => {
    const midTurn = await threadRun(["turn_start", "message"]);

    const result = await repairInterruptedRuns(pool);

    expect(result.repairedRunIds).toEqual([midTurn]);
    expect(result.closedIdleRunIds).toEqual([]);
    expect((await getAgentRun(pool, midTurn))?.status).toBe("error");
    expect(await errorNotificationCount()).toBe(1);
  });

  it("startup repair does not treat an idle-looking run without a thread as a session", async () => {
    const orphan = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "heartbeat" });
    await insertAgentRunEvent(pool, orphan.id, "turn_end", { kind: "turn_end" });

    const result = await repairInterruptedRuns(pool);

    expect(result.repairedRunIds).toEqual([orphan.id]);
    expect((await getAgentRun(pool, orphan.id))?.status).toBe("error");
  });

  it("startup repair pairs every dangling tool_use, not only a trailing one", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "parallel" });
    await insertAgentRunEvent(pool, run.id, "tool_use", { kind: "tool_use", toolCallId: "a", name: "x" });
    await insertAgentRunEvent(pool, run.id, "tool_use", { kind: "tool_use", toolCallId: "b", name: "y" });
    await insertAgentRunEvent(pool, run.id, "tool_result", { kind: "tool_result", toolCallId: "a", name: "x" });
    await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "m" });

    await repairInterruptedRuns(pool);

    const { rows } = await pool.query<{ payload: { toolCallId?: string } }>(
      `SELECT payload FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'tool_result' ORDER BY id`,
      [run.id],
    );
    expect(rows.map((r) => r.payload.toolCallId)).toEqual(["a", "b"]);
  });

  it("closeIdleThreadSessions closes only idle thread sessions, as done, leaving mid-turn ones running", async () => {
    const idle = await threadRun(["turn_start", "turn_end"]);
    const midTurn = await threadRun(["turn_start"]);

    const { closedRunIds } = await closeIdleThreadSessions(pool);

    expect(closedRunIds).toEqual([idle]);
    expect((await getAgentRun(pool, idle))?.status).toBe("done");
    expect((await getAgentRun(pool, midTurn))?.status).toBe("running");
    expect(await errorNotificationCount()).toBe(0);
  });
});
