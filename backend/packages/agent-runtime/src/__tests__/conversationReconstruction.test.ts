import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createAgentRun,
  createSempChatThread,
  createUser as createStoredUser,
  insertAgentRunEvent,
  withTransaction,
} from "@semprec/data";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  persistCompaction,
  reconstructBoundedThreadHistory,
  reconstructConversationHistory,
} from "../conversationReconstruction.js";
import type { CompactionAdapter } from "../compaction.js";
import type { AgentMessage, ConversationEntry } from "../types.js";

let pool: Pool;

const PROJECT_ITEM_ID = "99999999-9999-9999-9999-999999999999";

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

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
    await createUser();
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

  it("removes synthetic persisted checkpoint image fields without changing legacy metadata or stored rows", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tenant = getTenantZeroId();
      const foreign = await createTestTenant(pool);
      const ref = { kind: "item", itemId: randomUUID(), databaseId: randomUUID(), label: "Reference" };
      // Synthetic historical payload; this is not evidence that an old binary wrote images.
      const payload = [
        {
          id: "one",
          parentId: null,
          seq: 0,
          timestamp: 1,
          message: { kind: "user_message", text: "first", context: [ref] },
          images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/jpeg" }],
          legacy: { retained: true },
        },
        {
          id: "two",
          parentId: "one",
          seq: 1,
          timestamp: 2,
          message: { kind: "user_message", text: "second", context: [] },
          images: "malformed",
          legacy: "retained",
        },
      ];
      const fixture = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const threadId = await createSempChatThread(client);
          const run = await createAgentRun(client, {
            threadId,
            triggeredBy: "user",
            unit: "session",
            task: "checkpoint",
          });
          await insertAgentRunEvent(client, run.id, "compaction", payload);
          await insertAgentRunEvent(client, run.id, "message", { kind: "message", text: "tail" });
          return { threadId, runId: run.id };
        }),
      );
      const stored = () =>
        runInTenant(tenant, () =>
          runtime.query<{ payload: unknown }>(
            "SELECT payload FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'compaction'",
            [fixture.runId],
          ),
        );
      const before = await stored();
      const generic = await runInTenant(tenant, () =>
        reconstructConversationHistory(
          runtime,
          { threadId: fixture.threadId, triggeredBy: "user", parentRunId: null },
          noopCompaction,
        ),
      );
      const bounded = await runInTenant(tenant, () => reconstructBoundedThreadHistory(runtime, fixture.threadId));
      for (const result of [generic, bounded]) {
        expect(result?.entries).toHaveLength(3);
        expect(result?.entries[0]).toMatchObject({
          id: "one",
          legacy: { retained: true },
          message: { text: "first", context: [ref] },
        });
        expect(result?.entries[1]).toMatchObject({
          id: "two",
          parentId: "one",
          legacy: "retained",
          message: { text: "second" },
        });
        expect(result?.entries[2]?.message).toMatchObject({ text: "tail" });
        expect(result?.entries[0]).not.toHaveProperty("images");
        expect(result?.entries[1]).not.toHaveProperty("images");
      }
      expect((await stored()).rows).toEqual(before.rows);
      expect(before.rows[0]?.payload).toEqual(payload);
      expect(await runInTenant(foreign, () => reconstructBoundedThreadHistory(runtime, fixture.threadId))).toBeNull();
    } finally {
      await runtime.end();
    }
  });

  it("bounds stored rows and expanded checkpoints with tenant-scoped complete replay", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const role = await runAsSystem("test:replay-role", () =>
        runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tenant = getTenantZeroId();
      const foreign = await createTestTenant(pool);
      const fixture = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const threadId = await createSempChatThread(client);
          const run = await createAgentRun(client, { threadId, triggeredBy: "user", unit: "session", task: "bounded" });
          for (let i = 0; i < 2000; i++)
            await insertAgentRunEvent(client, run.id, "message", { kind: "message", text: `entry ${i}` });
          return { threadId, runId: run.id };
        }),
      );
      const complete = await runInTenant(tenant, () => reconstructBoundedThreadHistory(runtime, fixture.threadId));
      expect(complete?.entries).toHaveLength(2000);
      expect(complete?.entries[0]?.message).toMatchObject({ kind: "message", text: "entry 0" });
      expect(complete?.entries.at(-1)?.message).toMatchObject({ kind: "message", text: "entry 1999" });
      expect(await runInTenant(foreign, () => reconstructBoundedThreadHistory(runtime, fixture.threadId))).toBeNull();
      expect(await runInTenant(foreign, () => reconstructBoundedThreadHistory(runtime, randomUUID()))).toBeNull();
      await runInTenant(tenant, () =>
        insertAgentRunEvent(runtime, fixture.runId, "message", { kind: "message", text: "overflow" }),
      );
      await expect(
        runInTenant(tenant, () => reconstructBoundedThreadHistory(runtime, fixture.threadId)),
      ).rejects.toThrow("Semp conversation history exceeds replay limits");
      const count = await runInTenant(tenant, () =>
        runtime.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM agent_run_events WHERE agent_run_id = $1",
          [fixture.runId],
        ),
      );
      expect(count.rows).toEqual([{ count: 2001 }]);
      const checkpoint = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const threadId = await createSempChatThread(client);
          const run = await createAgentRun(client, {
            threadId,
            triggeredBy: "user",
            unit: "session",
            task: "checkpoint",
          });
          return { threadId, runId: run.id };
        }),
      );
      const entries: ConversationEntry[] = Array.from({ length: 2001 }, (_, seq) => ({
        id: String(seq),
        parentId: seq === 0 ? null : String(seq - 1),
        seq,
        timestamp: 0,
        message: { kind: "message", text: "x" },
      }));
      await runInTenant(tenant, () =>
        persistCompaction(runtime, checkpoint.runId, entries, {
          threadId: checkpoint.threadId,
          triggeredBy: "user",
          parentRunId: null,
        }),
      );
      await expect(
        runInTenant(tenant, () => reconstructBoundedThreadHistory(runtime, checkpoint.threadId)),
      ).rejects.toThrow("Semp conversation history exceeds replay limits");
      expect(
        await runInTenant(foreign, () => reconstructBoundedThreadHistory(runtime, checkpoint.threadId)),
      ).toBeNull();

      const paired = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const threadId = await createSempChatThread(client);
          const run = await createAgentRun(client, {
            threadId,
            triggeredBy: "user",
            unit: "session",
            task: "checkpoint pair",
          });
          await insertAgentRunEvent(client, run.id, "message", { kind: "message", text: "superseded" });
          return { threadId, runId: run.id };
        }),
      );
      await runInTenant(tenant, () =>
        persistCompaction(
          runtime,
          paired.runId,
          [
            { id: "summary", parentId: null, seq: 0, timestamp: 0, message: { kind: "message", text: "summary" } },
            {
              id: "tool",
              parentId: "summary",
              seq: 1,
              timestamp: 0,
              message: { kind: "tool_use", toolCallId: "pair", name: "search" },
            },
          ],
          { threadId: paired.threadId, triggeredBy: "user", parentRunId: null },
        ),
      );
      await runInTenant(tenant, () =>
        insertAgentRunEvent(runtime, paired.runId, "tool_result", {
          kind: "tool_result",
          toolCallId: "pair",
          result: "ok",
        }),
      );
      const replay = await runInTenant(tenant, () => reconstructBoundedThreadHistory(runtime, paired.threadId));
      expect(replay?.entries.map((entry) => entry.message.kind)).toEqual(["message", "tool_use", "tool_result"]);
      expect(replay?.entries[0]?.message).toMatchObject({ text: "summary" });
      expect(replay?.entries[1]?.message).toMatchObject({ toolCallId: "pair" });
      expect(replay?.entries[2]?.message).toMatchObject({ toolCallId: "pair" });
      expect(replay?.entries[2]?.parentId).toBe("tool");
      expect(await runInTenant(foreign, () => reconstructBoundedThreadHistory(runtime, paired.threadId))).toBeNull();

      const bytes = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const threadId = await createSempChatThread(client);
          const run = await createAgentRun(client, { threadId, triggeredBy: "user", unit: "session", task: "bytes" });
          const baseline = await client.query<{ size: number }>(
            "SELECT octet_length(jsonb_build_object('kind', 'message', 'text', '')::text)::int AS size",
          );
          if (!baseline.rows[0]) throw new Error("Missing JSON payload size");
          const text = "x".repeat(262144 - baseline.rows[0].size);
          await insertAgentRunEvent(client, run.id, "message", { kind: "message", text });
          const overThreadId = await createSempChatThread(client);
          const overRun = await createAgentRun(client, {
            threadId: overThreadId,
            triggeredBy: "user",
            unit: "session",
            task: "one byte over",
          });
          await insertAgentRunEvent(client, overRun.id, "message", { kind: "message", text: `${text}x` });
          return { threadId, runId: run.id, overThreadId, overRunId: overRun.id };
        }),
      );
      const size = await runInTenant(tenant, () =>
        runtime.query<{ size: number }>(
          "SELECT octet_length(payload::text)::int AS size FROM agent_run_events WHERE agent_run_id = $1",
          [bytes.runId],
        ),
      );
      expect(size.rows).toEqual([{ size: 262144 }]);
      expect(
        (await runInTenant(tenant, () => reconstructBoundedThreadHistory(runtime, bytes.threadId)))?.entries,
      ).toHaveLength(1);
      const overSize = await runInTenant(tenant, () =>
        runtime.query<{ size: number }>(
          "SELECT octet_length(payload::text)::int AS size FROM agent_run_events WHERE agent_run_id = $1",
          [bytes.overRunId],
        ),
      );
      expect(overSize.rows).toEqual([{ size: 262145 }]);
      await expect(
        runInTenant(tenant, () => reconstructBoundedThreadHistory(runtime, bytes.overThreadId)),
      ).rejects.toThrow("Semp conversation history exceeds replay limits");
      expect(await runInTenant(foreign, () => reconstructBoundedThreadHistory(runtime, bytes.threadId))).toBeNull();

      const oversizedCheckpoint = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const threadId = await createSempChatThread(client);
          const run = await createAgentRun(client, {
            threadId,
            triggeredBy: "user",
            unit: "session",
            task: "large checkpoint",
          });
          return { threadId, runId: run.id };
        }),
      );
      await runInTenant(tenant, () =>
        persistCompaction(
          runtime,
          oversizedCheckpoint.runId,
          [
            {
              id: "large",
              parentId: null,
              seq: 0,
              timestamp: 0,
              message: { kind: "message", text: "x".repeat(262144) },
            },
          ],
          { threadId: oversizedCheckpoint.threadId, triggeredBy: "user", parentRunId: null },
        ),
      );
      const checkpointSize = await runInTenant(tenant, () =>
        runtime.query<{ size: number }>(
          "SELECT octet_length(payload::text)::int AS size FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'compaction'",
          [oversizedCheckpoint.runId],
        ),
      );
      expect(checkpointSize.rows[0]!.size).toBeGreaterThan(262144);
      await expect(
        runInTenant(tenant, () => reconstructBoundedThreadHistory(runtime, oversizedCheckpoint.threadId)),
      ).rejects.toThrow("Semp conversation history exceeds replay limits");
    } finally {
      await runtime.end();
    }
  }, 60_000);

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

  it("reconstructs the identical Entry[] after the rows preceding the latest checkpoint are deleted", async () => {
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
    const { rows: checkpointRows } = await pool.query<{ id: string }>(
      `SELECT id FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'compaction'`,
      [runB.id],
    );
    const checkpointEventId = checkpointRows[0]!.id;
    await insertAgentRunEvent(pool, runB.id, "message", { kind: "message", text: "third" });

    const filter = { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user" as const, parentRunId: null };
    const before = await reconstructConversationHistory(pool, filter, noopCompaction);

    await pool.query(`DELETE FROM agent_run_events WHERE id < $1`, [checkpointEventId]);

    const after = await reconstructConversationHistory(pool, filter, noopCompaction);

    expect(after).toEqual(before);
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

  it("reconstructs and compacts each thread from its own runs only", async () => {
    const insertThread = async (): Promise<string> =>
      (await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id")).rows[0]!.id;
    const threadA = await insertThread();
    const threadB = await insertThread();
    const runA = await createAgentRun(pool, { threadId: threadA, triggeredBy: "user", unit: "session", task: "a" });
    const runB = await createAgentRun(pool, { threadId: threadB, triggeredBy: "user", unit: "session", task: "b" });
    const delegated = await createAgentRun(pool, {
      triggeredBy: "supervisor",
      unit: "session",
      task: "d",
      parentRunId: runA.id,
    });
    await insertAgentRunEvent(pool, runA.id, "message", { kind: "message", text: "from A" });
    await insertAgentRunEvent(pool, runB.id, "message", { kind: "message", text: "from B" });
    await insertAgentRunEvent(pool, delegated.id, "message", { kind: "message", text: "delegated" });

    const filterA = { threadId: threadA, triggeredBy: "user", parentRunId: null } as const;
    const filterB = { threadId: threadB, triggeredBy: "user", parentRunId: null } as const;
    const texts = (h: { entries: ConversationEntry[] } | null) =>
      h?.entries.map((e) => (e.message as { text?: string }).text);

    expect(texts(await reconstructConversationHistory(pool, filterA, noopCompaction))).toEqual(["from A"]);
    expect(texts(await reconstructConversationHistory(pool, filterB, noopCompaction))).toEqual(["from B"]);

    const compactedA = await reconstructConversationHistory(pool, filterA, alwaysCompacts("summary of A"));
    await persistCompaction(pool, runA.id, compactedA!.entries, filterA);

    expect(texts(await reconstructConversationHistory(pool, filterA, noopCompaction))).toEqual(["summary of A"]);
    expect(texts(await reconstructConversationHistory(pool, filterB, noopCompaction))).toEqual(["from B"]);
  });

  it("checks the compaction target and filter in one tenant-scoped transaction", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    await createStoredUser(pool, { email: `${randomUUID()}@example.test`, passwordHash: "unused", tenantId: tenantB });
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const makeRun = (tenantId: string) =>
        runInTenant(tenantId, async () => {
          const { rows } = await runtime.query<{ id: string }>(
            "INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id",
          );
          const threadId = rows[0]!.id;
          const run = await createAgentRun(runtime, {
            projectItemId: PROJECT_ITEM_ID,
            threadId,
            triggeredBy: "user",
            unit: "session",
            task: "thread",
          });
          return { threadId, run };
        });
      const a = await makeRun(tenantA);
      const b = await makeRun(tenantA);
      const foreign = await makeRun(tenantB);
      const delegated = await runInTenant(tenantA, () =>
        createAgentRun(runtime, {
          projectItemId: PROJECT_ITEM_ID,
          parentRunId: a.run.id,
          triggeredBy: "supervisor",
          unit: "session",
          task: "delegated",
        }),
      );
      const filterA = { threadId: a.threadId, triggeredBy: "user", parentRunId: null } as const;
      const legacy = { projectItemId: PROJECT_ITEM_ID, triggeredBy: "supervisor", parentRunId: a.run.id } as const;
      const entries: ConversationEntry[] = [
        { id: "summary", parentId: null, seq: 0, timestamp: 0, message: { kind: "message", text: "summary" } },
      ];
      await runInTenant(tenantA, async () => {
        await persistCompaction(runtime, a.run.id, entries, filterA);
        await expect(persistCompaction(runtime, b.run.id, entries, filterA)).rejects.toThrow(
          "Invalid compaction target",
        );
        await expect(persistCompaction(runtime, a.run.id, entries)).rejects.toThrow("Invalid compaction target");
        await expect(persistCompaction(runtime, delegated.id, entries, filterA)).rejects.toThrow(
          "Invalid compaction target",
        );
        await expect(persistCompaction(runtime, a.run.id, entries, legacy)).rejects.toThrow(
          "Invalid compaction target",
        );
        await expect(
          persistCompaction(runtime, delegated.id, entries, { ...legacy, projectItemId: randomUUID() }),
        ).rejects.toThrow("Invalid compaction target");
        await expect(persistCompaction(runtime, randomUUID(), entries, filterA)).rejects.toThrow(
          "Invalid compaction target",
        );
        await expect(persistCompaction(runtime, foreign.run.id, entries, filterA)).rejects.toThrow(
          "Invalid compaction target",
        );
        await persistCompaction(runtime, delegated.id, entries, legacy);
        await persistCompaction(runtime, delegated.id, entries);
        const counts = await runtime.query<{ agent_run_id: string; count: string }>(
          "SELECT agent_run_id, count(*)::text AS count FROM agent_run_events WHERE kind = 'compaction' GROUP BY agent_run_id ORDER BY agent_run_id",
        );
        expect(counts.rows).toEqual(
          expect.arrayContaining([
            { agent_run_id: a.run.id, count: "1" },
            { agent_run_id: delegated.id, count: "2" },
          ]),
        );
        expect(counts.rows).toHaveLength(2);
      });
      await runInTenant(tenantB, async () => {
        const count = await runtime.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM agent_run_events WHERE kind = 'compaction'",
        );
        expect(count.rows).toEqual([{ count: "0" }]);
      });
      const raced = await makeRun(tenantA);
      let releaseWriter: (() => void) | undefined;
      let writerPid = 0;
      let writerFailure: { error: unknown } | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      const writer = runInTenant(tenantA, () =>
        withTransaction(runtime, async (client) => {
          const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
          await client.query("UPDATE agent_runs SET thread_id = $2 WHERE id = $1", [raced.run.id, b.threadId]);
          writerPid = pid;
          await gate;
        }),
      );
      void writer.catch((error: unknown) => {
        writerFailure = { error };
      });
      let attempt: Promise<unknown> | undefined;
      try {
        await vi.waitFor(
          () => {
            if (writerFailure)
              throw writerFailure.error instanceof Error ? writerFailure.error : new Error("Compaction writer failed");
            expect(writerPid).toBeGreaterThan(0);
          },
          { timeout: 5000, interval: 20 },
        );
        const staleFilter = { threadId: raced.threadId, triggeredBy: "user", parentRunId: null } as const;
        attempt = runInTenant(tenantA, () => persistCompaction(runtime, raced.run.id, entries, staleFilter)).then(
          () => null,
          (error: unknown) => error,
        );
        await vi.waitFor(
          async () => {
            const { rows } = await pool.query<{ blocked: boolean }>(
              "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM agent_runs WHERE id =%FOR UPDATE%') AS blocked",
              [writerPid],
            );
            expect(rows[0]?.blocked).toBe(true);
          },
          { timeout: 5000, interval: 20 },
        );
      } finally {
        releaseWriter?.();
        await Promise.allSettled([writer, attempt]);
      }
      if (writerFailure)
        throw writerFailure.error instanceof Error ? writerFailure.error : new Error("Compaction writer failed");
      const failure = await attempt;
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error("expected compaction refusal");
      expect(failure.message).toBe("Invalid compaction target");
      const racedEvents = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'compaction'",
        [raced.run.id],
      );
      expect(racedEvents.rows).toEqual([{ count: "0" }]);
    } finally {
      await runtime.end();
    }
  });

  it("reconstructs a woken conversation as question then answer, with follow-up turns, in order", async () => {
    const run = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "first question",
    });
    const refs = [{ label: "Budget", kind: "item", itemId: randomUUID(), databaseId: randomUUID() }];
    await insertAgentRunEvent(pool, run.id, "user_message", {
      kind: "user_message",
      text: "first question",
      context: refs,
    });
    await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "first answer" });
    await insertAgentRunEvent(pool, run.id, "user_message", { kind: "user_message", text: "follow-up", context: [] });
    await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "second answer" });

    const history = await reconstructConversationHistory(
      pool,
      { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user", parentRunId: null },
      noopCompaction,
    );

    expect(history!.entries.map((e) => [e.message.kind, (e.message as { text?: string }).text])).toEqual([
      ["user_message", "first question"],
      ["message", "first answer"],
      ["user_message", "follow-up"],
      ["message", "second answer"],
    ]);
    expect(history!.entries[0]!.message.context).toEqual(refs);
  });

  it.each(["normal", "compaction"] as const)(
    "rejects malformed stored user turns from %s without echoing content",
    async (source) => {
      const run = await createAgentRun(pool, {
        projectItemId: PROJECT_ITEM_ID,
        triggeredBy: "user",
        unit: "session",
        task: "test",
      });
      const validRef = { kind: "item", itemId: randomUUID(), databaseId: randomUUID(), label: "safe" };
      const invalid: Record<string, unknown>[] = [
        { kind: "user_message", context: [] },
        { kind: "user_message", text: "private-sentinel" },
        { kind: "user_message", text: 42, context: [] },
        { kind: "user_message", text: "private-sentinel", context: null },
        { kind: "user_message", text: "private-sentinel", context: [{ ...validRef, label: 42 }] },
        { kind: "user_message", text: "private-sentinel", context: [{ ...validRef, expanded: "ref-sentinel" }] },
      ];
      for (const message of invalid) {
        if (source === "normal") {
          await insertAgentRunEvent(pool, run.id, "user_message", message);
        } else {
          await insertAgentRunEvent(pool, run.id, "compaction", [
            { id: "entry", parentId: null, seq: 0, timestamp: 0, message },
          ]);
        }
        await expect(
          reconstructConversationHistory(
            pool,
            { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user", parentRunId: null },
            noopCompaction,
          ),
        ).rejects.toThrow(/^Invalid stored user message$/);
        await pool.query("DELETE FROM agent_run_events WHERE agent_run_id = $1", [run.id]);
      }
    },
  );

  it("keeps unknown metadata on compatible legacy messages", async () => {
    const run = await createAgentRun(pool, {
      projectItemId: PROJECT_ITEM_ID,
      triggeredBy: "user",
      unit: "session",
      task: "test",
    });
    await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "legacy", extra: { preserved: true } });
    const history = await reconstructConversationHistory(
      pool,
      { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user", parentRunId: null },
      noopCompaction,
    );
    expect(history?.entries[0]?.message).toMatchObject({ kind: "message", text: "legacy", extra: { preserved: true } });
  });
});
