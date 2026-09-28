import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createAgentRun, finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import {
  insertAgentRunEvent,
  insertAndNotifyAgentRunEvent,
  getAgentRunEventById,
  listAgentRunEvents,
  listAgentRunEventsAfter,
  listSessionAgentRunEventsFromLastCompaction,
} from "../agentRuns/agentRunEventsStore.js";
import { setAgentRunEventHook } from "../realtimeHook.js";

let pool: Pool;

async function createUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id`,
    [`${randomUUID()}@example.com`],
  );
  return rows[0]!.id;
}

describe("agentRunEventsStore", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await createUser();
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

  describe("listSessionAgentRunEventsFromLastCompaction", () => {
    const PROJECT_ITEM_ID = "99999999-9999-9999-9999-999999999999";
    const filter = { projectItemId: PROJECT_ITEM_ID, triggeredBy: "user" as const, parentRunId: null };

    it("returns the compaction row and everything after it, in (wake_seq, id) order, excluding earlier runs", async () => {
      const runA = await createAgentRun(pool, {
        projectItemId: PROJECT_ITEM_ID,
        triggeredBy: "user",
        unit: "session",
        task: "one",
      });
      await insertAgentRunEvent(pool, runA.id, "message", { kind: "message", text: "a1" });
      await insertAgentRunEvent(pool, runA.id, "message", { kind: "message", text: "a2" });

      const runB = await createAgentRun(pool, {
        projectItemId: PROJECT_ITEM_ID,
        triggeredBy: "user",
        unit: "session",
        task: "two",
      });
      await insertAgentRunEvent(pool, runB.id, "message", { kind: "message", text: "b1 (before checkpoint)" });
      const checkpoint = await insertAgentRunEvent(pool, runB.id, "compaction", [
        { id: "checkpoint", parentId: null, seq: 0, timestamp: 0, message: { kind: "message", text: "summary" } },
      ]);
      const b2 = await insertAgentRunEvent(pool, runB.id, "message", {
        kind: "message",
        text: "b2 (after checkpoint)",
      });

      const runC = await createAgentRun(pool, {
        projectItemId: PROJECT_ITEM_ID,
        triggeredBy: "user",
        unit: "session",
        task: "three",
      });
      const c1 = await insertAgentRunEvent(pool, runC.id, "message", { kind: "message", text: "c1" });
      const c2 = await insertAgentRunEvent(pool, runC.id, "message", { kind: "message", text: "c2" });

      const result = await listSessionAgentRunEventsFromLastCompaction(pool, filter);

      expect(result.map((e) => e.id)).toEqual([checkpoint.id, b2.id, c1.id, c2.id]);
      expect(result[0]!.kind).toBe("compaction");
    });

    it("returns every event of every session run in order when there is no compaction anywhere", async () => {
      const runA = await createAgentRun(pool, {
        projectItemId: PROJECT_ITEM_ID,
        triggeredBy: "user",
        unit: "session",
        task: "one",
      });
      const a1 = await insertAgentRunEvent(pool, runA.id, "message", { kind: "message", text: "a1" });

      const runB = await createAgentRun(pool, {
        projectItemId: PROJECT_ITEM_ID,
        triggeredBy: "user",
        unit: "session",
        task: "two",
      });
      const b1 = await insertAgentRunEvent(pool, runB.id, "message", { kind: "message", text: "b1" });

      const result = await listSessionAgentRunEventsFromLastCompaction(pool, filter);

      expect(result.map((e) => e.id)).toEqual([a1.id, b1.id]);
    });

    it("never includes a run of a different triggeredBy, parentRunId, or projectItemId", async () => {
      const matching = await createAgentRun(pool, {
        projectItemId: PROJECT_ITEM_ID,
        triggeredBy: "user",
        unit: "session",
        task: "matching",
      });
      const matchingEvent = await insertAgentRunEvent(pool, matching.id, "message", {
        kind: "message",
        text: "matching",
      });

      const supervisorRun = await createAgentRun(pool, { triggeredBy: "user", unit: "invocation", task: "sup" });
      const otherTriggeredBy = await createAgentRun(pool, {
        projectItemId: PROJECT_ITEM_ID,
        parentRunId: supervisorRun.id,
        triggeredBy: "supervisor",
        unit: "session",
        task: "other triggeredBy",
      });
      await insertAgentRunEvent(pool, otherTriggeredBy.id, "message", { kind: "message", text: "should not appear" });

      const otherParentRun = await createAgentRun(pool, {
        projectItemId: PROJECT_ITEM_ID,
        parentRunId: supervisorRun.id,
        triggeredBy: "supervisor",
        unit: "session",
        task: "other parent",
      });
      const otherSupervisorRun = await createAgentRun(pool, { triggeredBy: "user", unit: "invocation", task: "sup2" });
      const otherParentRunMatchingTrigger = await createAgentRun(pool, {
        projectItemId: PROJECT_ITEM_ID,
        parentRunId: otherSupervisorRun.id,
        triggeredBy: "supervisor",
        unit: "session",
        task: "other parent 2",
      });
      await insertAgentRunEvent(pool, otherParentRun.id, "message", { kind: "message", text: "should not appear" });
      await insertAgentRunEvent(pool, otherParentRunMatchingTrigger.id, "message", {
        kind: "message",
        text: "should not appear",
      });

      const otherProjectItem = await createAgentRun(pool, {
        projectItemId: "77777777-7777-7777-7777-777777777777",
        triggeredBy: "user",
        unit: "session",
        task: "other project item",
      });
      await insertAgentRunEvent(pool, otherProjectItem.id, "message", { kind: "message", text: "should not appear" });

      const result = await listSessionAgentRunEventsFromLastCompaction(pool, filter);

      expect(result.map((e) => e.id)).toEqual([matchingEvent.id]);
    });
  });

  async function countEvents(agentRunId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM agent_run_events WHERE agent_run_id = $1",
      [agentRunId],
    );
    return Number(rows[0]!.count);
  }

  /** A JSON string payload whose serialization is exactly `bytes` UTF-8 bytes (the two quotes included). */
  function payloadOfSerializedBytes(bytes: number): string {
    return "x".repeat(bytes - 2);
  }

  it("refuses a non-run_status event on a finished run and inserts nothing", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "finished" });
    await finishAgentRun(pool, run.id, "done", null);

    const attempt = insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "late" });
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toThrow(
      `agent run ${run.id} is done; only run_status events may be appended to a finished run`,
    );
    expect(await countEvents(run.id)).toBe(0);
  });

  it("refuses a non-run_status event on a run finished as error", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "errored" });
    await finishAgentRun(pool, run.id, "error", "boom");

    await expect(insertAgentRunEvent(pool, run.id, "tool_result", { kind: "tool_result" })).rejects.toThrow(
      `agent run ${run.id} is error; only run_status events may be appended to a finished run`,
    );
    expect(await countEvents(run.id)).toBe(0);
  });

  it("stores a run_status event on a finished run", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "finished" });
    await finishAgentRun(pool, run.id, "done", null);

    const event = await insertAgentRunEvent(pool, run.id, "run_status", { status: "done" });

    expect(event).toMatchObject({ agentRunId: run.id, kind: "run_status", payload: { status: "done" } });
    expect((await listAgentRunEvents(pool, run.id)).map((e) => e.id)).toEqual([event.id]);
  });

  it("throws NotFoundError for an unknown run id", async () => {
    await expect(insertAgentRunEvent(pool, randomUUID(), "turn_start", { kind: "turn_start" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects a payload one byte over 1 MiB serialized and inserts nothing", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "oversized" });

    const attempt = insertAgentRunEvent(pool, run.id, "tool_result", payloadOfSerializedBytes(1024 * 1024 + 1));
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toThrow(
      "agent run event 'tool_result' payload is 1048577 bytes, over the 1048576-byte cap",
    );
    expect(await countEvents(run.id)).toBe(0);
  });

  it("stores a payload exactly at the 1 MiB cap", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "at cap" });
    const payload = payloadOfSerializedBytes(1024 * 1024);

    const event = await insertAgentRunEvent(pool, run.id, "tool_result", payload);

    expect(event.payload).toBe(payload);
    expect(await countEvents(run.id)).toBe(1);
  });
});
