import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createAgentRun, insertAgentRunEvent } from "@semprec/data";
import { persistCompaction, reconstructConversationHistory } from "../conversationReconstruction.js";
import type { CompactionAdapter } from "../compaction.js";
import type { AgentMessage, ConversationEntry } from "../types.js";

let pool: Pool;

const PROJECT_ITEM_ID = "99999999-9999-9999-9999-999999999999";

/** Never triggers compaction — `shouldCompact` always false. */
const noopCompaction: CompactionAdapter = {
  estimateContextTokens: (messages) => messages.length,
  shouldCompact: () => false,
  prepareCompaction: (entries) => entries,
  compact: (prepared) => prepared as ConversationEntry[],
  contextWindow: 1_000_000,
  settings: {},
};

/** Always triggers compaction, replacing whatever it's given with one summary entry. */
function alwaysCompacts(summaryText: string): CompactionAdapter {
  return {
    estimateContextTokens: (messages) => messages.length,
    shouldCompact: () => true,
    prepareCompaction: (entries) => entries,
    compact: (prepared) => {
      const entries = prepared as ConversationEntry[];
      const last = entries[entries.length - 1];
      const summary: ConversationEntry = {
        id: "summary",
        parentId: null,
        seq: 0,
        timestamp: last?.timestamp ?? 0,
        message: { kind: "message", text: summaryText },
      };
      return [summary];
    },
    contextWindow: 1,
    settings: {},
  };
}

describe("reconstructConversationHistory", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("returns null when the conversation has never woken before", async () => {
    const result = await reconstructConversationHistory(
      pool,
      { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user", parentRunId: null },
      noopCompaction,
    );
    expect(result).toBeNull();
  });

  it("walks every prior user/session agent_runs row's events, in order, into one linear Entry[] chain", async () => {
    const runA = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "one",
    });
    await insertAgentRunEvent(pool, runA.id, "turn_start", { kind: "turn_start" });
    await insertAgentRunEvent(pool, runA.id, "message", { kind: "message", text: "first" });
    await insertAgentRunEvent(pool, runA.id, "turn_end", { kind: "turn_end" });

    // Not part of this conversation: a different unit, a different trigger, a different project item.
    const invocation = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "invocation",
      task: "x",
    });
    await insertAgentRunEvent(pool, invocation.id, "message", { kind: "message", text: "should not appear" });
    const otherProjectItem = await createAgentRun(pool, {
      projectItemId: "77777777-7777-7777-7777-777777777777",
      triggeredBy: "user",
      unit: "session",
      task: "y",
    });
    await insertAgentRunEvent(pool, otherProjectItem.id, "message", {
      kind: "message",
      text: "should not appear either",
    });

    const runB = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "two",
    });
    await insertAgentRunEvent(pool, runB.id, "turn_start", { kind: "turn_start" });
    await insertAgentRunEvent(pool, runB.id, "message", { kind: "message", text: "second" });
    await insertAgentRunEvent(pool, runB.id, "turn_end", { kind: "turn_end" });

    const result = await reconstructConversationHistory(
      pool,
      { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user", parentRunId: null },
      noopCompaction,
    );

    expect(result).not.toBeNull();
    expect(result?.compacted).toBe(false);
    const texts = result?.entries.map((e) => (e.message as { text?: string }).text ?? e.message.kind);
    expect(texts).toEqual(["turn_start", "first", "turn_end", "turn_start", "second", "turn_end"]);

    // seq is monotonic across both runs, and every entry after the first chains to the one before it.
    expect(result?.entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    for (let i = 1; i < (result?.entries.length ?? 0); i++) {
      expect(result?.entries[i]!.parentId).toBe(result?.entries[i - 1]!.id);
    }
    expect(result?.entries[0]!.parentId).toBeNull();
  });

  it("excludes run_status bookkeeping events from the reconstructed Entry[] tree", async () => {
    const run = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "one",
    });
    await insertAgentRunEvent(pool, run.id, "run_status", { kind: "run_status", status: "running" });
    await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "hi" });
    await insertAgentRunEvent(pool, run.id, "run_status", { kind: "run_status", status: "done" });

    const result = await reconstructConversationHistory(
      pool,
      { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user", parentRunId: null },
      noopCompaction,
    );

    expect(result?.entries).toHaveLength(1);
    expect((result?.entries[0]!.message as AgentMessage & { text: string }).text).toBe("hi");
  });

  it("preserves tool_use/tool_result pairing and ordering through reconstruction", async () => {
    const run = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "one",
    });
    await insertAgentRunEvent(pool, run.id, "tool_use", { kind: "tool_use", toolCallId: "call_1", name: "search" });
    await insertAgentRunEvent(pool, run.id, "tool_result", { kind: "tool_result", toolCallId: "call_1", result: "ok" });

    const result = await reconstructConversationHistory(
      pool,
      { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user", parentRunId: null },
      noopCompaction,
    );

    expect(result?.entries.map((e) => e.message.kind)).toEqual(["tool_use", "tool_result"]);
    const use = result!.entries[0]!;
    const res = result!.entries[1]!;
    expect((use.message as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect((res.message as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect(res.parentId).toBe(use.id);
  });

  it("compacts an oversized history through prepareCompaction/compact instead of handing the raw Entry[] to the caller", async () => {
    const run = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "one",
    });
    await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "first" });
    await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "second" });

    const result = await reconstructConversationHistory(
      pool,
      { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user", parentRunId: null },
      alwaysCompacts("summary of first/second"),
    );

    expect(result?.compacted).toBe(true);
    expect(result?.entries).toHaveLength(1);
    expect((result?.entries[0]!.message as { text?: string }).text).toBe("summary of first/second");
  });

  it("resumes from a persisted compaction checkpoint instead of re-walking the raw history it replaced", async () => {
    const runA = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "one",
    });
    await insertAgentRunEvent(pool, runA.id, "message", { kind: "message", text: "first" });
    await insertAgentRunEvent(pool, runA.id, "message", { kind: "message", text: "second" });

    const runB = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "two",
    });
    const checkpoint: ConversationEntry = {
      id: "checkpoint",
      parentId: null,
      seq: 0,
      timestamp: 123,
      message: { kind: "message", text: "compacted summary" },
    };
    await persistCompaction(pool, runB.id, [checkpoint]);
    await insertAgentRunEvent(pool, runB.id, "message", { kind: "message", text: "third" });

    const result = await reconstructConversationHistory(
      pool,
      { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user", parentRunId: null },
      noopCompaction,
    );

    // Everything from runA is superseded by runB's checkpoint; only the checkpoint and what
    // came after it in runB survive the walk.
    const texts = result?.entries.map((e) => (e.message as { text?: string }).text);
    expect(texts).toEqual(["compacted summary", "third"]);
    expect(result?.entries[1]!.parentId).toBe("checkpoint");
  });

  it("restarting the same walk twice over unchanged agent_run_events produces an identical Entry[] tree", async () => {
    const run = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "one",
    });
    await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "first" });
    await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "second" });

    const filter = { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user" as const, parentRunId: null };
    const first = await reconstructConversationHistory(pool, filter, noopCompaction);
    const second = await reconstructConversationHistory(pool, filter, noopCompaction);

    expect(second).toEqual(first);
  });

  it("reconstructs a delegated conversation keyed by (targetProjectItemId, supervisorRunId), separately from Semp's own", async () => {
    const supervisorRun = await createAgentRun(pool, { triggeredBy: "user", unit: "invocation", task: "supervisor" });
    const delegated = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      parentRunId: supervisorRun.id,
      triggeredBy: "supervisor",
      unit: "session",
      task: "delegated",
    });
    await insertAgentRunEvent(pool, delegated.id, "message", { kind: "message", text: "delegated turn" });

    const semp = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "semp",
    });
    await insertAgentRunEvent(pool, semp.id, "message", { kind: "message", text: "semp turn" });

    const delegatedResult = await reconstructConversationHistory(
      pool,
      { projectItemId: PROJECT_ITEM_ID, triggeredBy: "supervisor", parentRunId: supervisorRun.id },
      noopCompaction,
    );
    const sempResult = await reconstructConversationHistory(
      pool,
      { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user", parentRunId: null },
      noopCompaction,
    );

    expect(delegatedResult?.entries.map((e) => (e.message as { text?: string }).text)).toEqual(["delegated turn"]);
    expect(sempResult?.entries.map((e) => (e.message as { text?: string }).text)).toEqual(["semp turn"]);
  });

  it("rejects a stored event payload that is not a valid AgentMessage instead of silently reconstructing it", async () => {
    const run = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "one",
    });
    await pool.query(`INSERT INTO agent_run_events (agent_run_id, kind, payload) VALUES ($1, 'message', $2::jsonb)`, [
      run.id,
      JSON.stringify(["not", "a", "message"]),
    ]);

    await expect(
      reconstructConversationHistory(
        pool,
        { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user", parentRunId: null },
        noopCompaction,
      ),
    ).rejects.toThrow(/not a valid AgentMessage/);
  });

  it("rejects a persisted 'compaction' checkpoint whose payload is not a valid ConversationEntry[]", async () => {
    const run = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "one",
    });
    await insertAgentRunEvent(pool, run.id, "compaction", [{ id: "bad", seq: "not-a-number" }]);

    await expect(
      reconstructConversationHistory(
        pool,
        { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user", parentRunId: null },
        noopCompaction,
      ),
    ).rejects.toThrow(/not a valid ConversationEntry\[\]/);
  });

  it("rejects a reconstructed history with an unmatched trailing tool_use", async () => {
    const run = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "one",
    });
    await insertAgentRunEvent(pool, run.id, "tool_use", { kind: "tool_use", toolCallId: "call_1", name: "search" });

    await expect(
      reconstructConversationHistory(
        pool,
        { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user", parentRunId: null },
        noopCompaction,
      ),
    ).rejects.toThrow(/unmatched tool_use/);
  });

  it("rejects a reconstructed history with a tool_result whose toolCallId doesn't match the pending tool_use", async () => {
    const run = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "one",
    });
    await insertAgentRunEvent(pool, run.id, "tool_use", { kind: "tool_use", toolCallId: "call_1", name: "search" });
    await insertAgentRunEvent(pool, run.id, "tool_result", { kind: "tool_result", toolCallId: "call_2", result: "ok" });

    await expect(
      reconstructConversationHistory(
        pool,
        { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user", parentRunId: null },
        noopCompaction,
      ),
    ).rejects.toThrow(/does not match the pending tool_use call/);
  });
});
