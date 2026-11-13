import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { runInTenant, runAsSystem } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { createAgentRun, finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import {
  insertAgentRunEvent,
  insertAndNotifyAgentRunEvent,
  countAgentRunToolSteps,
  getAgentRunEventById,
  listAgentRunEvents,
  listAgentRunEventsAfter,
  listAgentRunEventsForStepPage,
  listSessionAgentRunEventsFromLastCompaction,
} from "../agentRuns/agentRunEventsStore.js";
import { agentRunStepPageRowLimit } from "../agentRuns/agentRunStepPages.js";
import { setAgentRunEventHook } from "../realtimeHook.js";
import { sendSempMessage } from "../sempThreads/sempThreadsStore.js";
import { claimSempMessage, finishSempMessageTurn, startSempMessageTurn } from "../semp/sempMessagesStore.js";

let pool: Pool;

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
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

  it("accepts a user_message event (CHECK constraint) and reads it back in listAgentRunEvents and replay", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", unit: "session", task: "t" });
    const first = await insertAgentRunEvent(pool, run.id, "user_message", {
      kind: "user_message",
      text: "hello",
      context: [{ label: "Doc" }],
    });
    const second = await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "hi" });

    expect((await listAgentRunEvents(pool, run.id)).map((e) => e.kind)).toEqual(["user_message", "message"]);
    expect((await listAgentRunEventsAfter(pool, run.id, first.id)).map((e) => e.id)).toEqual([second.id]);
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

  it("bounds cursor reads before materialization while preserving unlimited and tenant-scoped reads", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const role = await runAsSystem("test:role", () =>
        runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tenant = getTenantZeroId();
      const foreign = await createTestTenant(pool);
      const run = await runInTenant(tenant, () => createAgentRun(runtime, { triggeredBy: "user", task: "bounded" }));
      for (let i = 0; i < 260; i++)
        await runInTenant(tenant, () => insertAgentRunEvent(runtime, run.id, "message", { kind: "message", index: i }));
      const all = await runInTenant(tenant, () => listAgentRunEventsAfter(runtime, run.id, "0"));
      expect(all).toHaveLength(260);
      for (const limit of [1, 2, 256, 257]) {
        const actual = await runInTenant(tenant, () => listAgentRunEventsAfter(runtime, run.id, "0", limit));
        expect(actual.map((event) => event.id)).toEqual(all.slice(0, limit).map((event) => event.id));
      }
      expect(await runInTenant(tenant, () => listAgentRunEventsAfter(runtime, run.id, all[0]!.id, 2))).toEqual(
        all.slice(1, 3),
      );
      expect(await runInTenant(foreign, () => listAgentRunEventsAfter(runtime, run.id, "0", 257))).toEqual([]);
      expect(await runInTenant(tenant, () => listAgentRunEventsAfter(runtime, randomUUID(), "0", 257))).toEqual([]);
      for (const limit of [0, -1, 1.5, NaN, Infinity, 258])
        await expect(listAgentRunEventsAfter(runtime, run.id, "0", limit)).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await runtime.end();
    }
  });

  it("scopes successive Semp messages on the same run in the event query snapshot", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const tenant = getTenantZeroId();
    try {
      const role = await runAsSystem("test:role", () =>
        runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const foreign = await createTestTenant(pool);
      const run = await runInTenant(tenant, () => createAgentRun(runtime, { triggeredBy: "user", task: "two turns" }));
      const first = await runInTenant(tenant, () =>
        insertAgentRunEvent(runtime, run.id, "user_message", { kind: "user_message", text: "first" }),
      );
      const firstTurn = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const turn = await sendSempMessage(client, { text: "first", context: [], hasContext: false });
          expect(await claimSempMessage(client, turn.threadId, turn.assistantMessageId)).toBe(true);
          await startSempMessageTurn(client, turn.assistantMessageId, run.id, first.id);
          return turn;
        }),
      );
      const end = await runInTenant(tenant, () =>
        insertAgentRunEvent(runtime, run.id, "message", { kind: "message", text: "first answer" }),
      );
      await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          finishSempMessageTurn(client, firstTurn.assistantMessageId, {
            status: "done",
            text: "first answer",
            lastEventId: end.id,
          }),
        ),
      );
      const next = await runInTenant(tenant, () =>
        insertAgentRunEvent(runtime, run.id, "user_message", { kind: "user_message", text: "second" }),
      );
      const secondTurn = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const turn = await sendSempMessage(client, {
            threadId: firstTurn.threadId,
            text: "second",
            context: [],
            hasContext: false,
          });
          expect(await claimSempMessage(client, turn.threadId, turn.assistantMessageId)).toBe(true);
          await startSempMessageTurn(client, turn.assistantMessageId, run.id, next.id);
          return turn;
        }),
      );
      const last = await runInTenant(tenant, () =>
        insertAgentRunEvent(runtime, run.id, "message", { kind: "message", text: "second answer" }),
      );
      const scopeA = { threadId: firstTurn.threadId, sempMessageId: firstTurn.assistantMessageId };
      const scopeB = { threadId: secondTurn.threadId, sempMessageId: secondTurn.assistantMessageId };
      const list = (scope: typeof scopeA, cursor = "0", limit = 257) =>
        runInTenant(tenant, () => listAgentRunEventsAfter(runtime, run.id, cursor, limit, scope));
      expect((await list(scopeA)).map((event) => event.id)).toEqual([first.id, end.id]);
      expect((await list(scopeA, first.id)).map((event) => event.id)).toEqual([end.id]);
      expect(
        (
          await runInTenant(tenant, () =>
            listAgentRunEventsAfter(runtime, run.id, "0", 257, { ...scopeA, throughEventId: first.id }),
          )
        ).map((event) => event.id),
      ).toEqual([first.id]);
      expect(
        (
          await runInTenant(tenant, () =>
            listAgentRunEventsAfter(runtime, run.id, first.id, 257, { ...scopeA, throughEventId: end.id }),
          )
        ).map((event) => event.id),
      ).toEqual([end.id]);
      expect(
        await runInTenant(foreign, () =>
          listAgentRunEventsAfter(runtime, run.id, "0", 257, { ...scopeA, throughEventId: end.id }),
        ),
      ).toEqual([]);
      for (const throughEventId of ["0", "01", "-1", "9223372036854775808"]) {
        await expect(
          runInTenant(tenant, () => listAgentRunEventsAfter(runtime, run.id, "0", 257, { ...scopeA, throughEventId })),
        ).rejects.toBeInstanceOf(ValidationError);
      }
      expect((await list(scopeB, "0", 1)).map((event) => event.id)).toEqual([next.id]);
      expect((await list(scopeB)).map((event) => event.id)).toEqual([next.id, last.id]);
      expect(await runInTenant(tenant, () => getAgentRunEventById(runtime, run.id, last.id, scopeA))).toBeNull();
      expect((await runInTenant(tenant, () => getAgentRunEventById(runtime, run.id, last.id, scopeB)))?.id).toBe(
        last.id,
      );
      expect(await list({ ...scopeA, threadId: randomUUID() })).toEqual([]);
      expect(await list({ ...scopeA, sempMessageId: randomUUID() })).toEqual([]);
      expect(await runInTenant(foreign, () => listAgentRunEventsAfter(runtime, run.id, "0", 257, scopeA))).toEqual([]);
      expect(await runInTenant(tenant, () => listAgentRunEventsAfter(runtime, randomUUID(), "0", 257, scopeA))).toEqual(
        [],
      );
      expect(await listAgentRunEventsAfter(runtime, run.id, "0", 257, scopeA)).toEqual([]);
      expect(await getAgentRunEventById(runtime, run.id, last.id, scopeA)).toBeNull();
      await expect(list({ ...scopeA, threadId: "invalid" })).rejects.toBeInstanceOf(ValidationError);
      expect(
        (await runInTenant(tenant, () => listAgentRunEventsAfter(runtime, run.id, "0"))).map((event) => event.id),
      ).toEqual([first.id, end.id, next.id, last.id]);
      await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          finishSempMessageTurn(client, secondTurn.assistantMessageId, { status: "error" }),
        ),
      );
      expect(await list(scopeB)).toEqual([]);
      const queued = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          sendSempMessage(client, { threadId: firstTurn.threadId, text: "queued", context: [], hasContext: false }),
        ),
      );
      expect(await list({ threadId: queued.threadId, sempMessageId: queued.assistantMessageId })).toEqual([]);
    } finally {
      await runtime.end();
    }
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
    await finishAgentRun(pool, run.id, "error", "internal");

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

  describe("listAgentRunEventsForStepPage (issue #1821)", () => {
    it("returns the step-producing events of the run after the cursor in id order and leaves out the others", async () => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "page" });
      const other = await createAgentRun(pool, { triggeredBy: "user", task: "other run" });
      const first = await insertAgentRunEvent(pool, run.id, "run_status", { status: "running" });
      await insertAgentRunEvent(pool, run.id, "turn_start", {});
      await insertAgentRunEvent(pool, other.id, "message", {});
      const message = await insertAgentRunEvent(pool, run.id, "message", {});
      await insertAgentRunEvent(pool, run.id, "compaction", {});
      await insertAgentRunEvent(pool, run.id, "user_message", {});
      const use = await insertAgentRunEvent(pool, run.id, "tool_use", {});
      const result = await insertAgentRunEvent(pool, run.id, "tool_result", {});
      await insertAgentRunEvent(pool, run.id, "turn_end", {});

      const all = await listAgentRunEventsForStepPage(pool, run.id, "0", 100);
      const afterFirst = await listAgentRunEventsForStepPage(pool, run.id, first.id, 100);

      expect(all.events.map((e) => e.id)).toEqual([first.id, message.id, use.id, result.id]);
      expect(all.hasMore).toBe(false);
      expect(afterFirst.events.map((e) => e.id)).toEqual([message.id, use.id, result.id]);
    });

    it("reads at most two events per step and a margin, and says when more follow", async () => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "bounded" });
      // One step needs at most two events; the read of a one-step page holds 102.
      const rowLimit = agentRunStepPageRowLimit(1);
      for (let i = 0; i < rowLimit + 1; i++) await insertAgentRunEvent(pool, run.id, "message", {});

      const full = await listAgentRunEventsForStepPage(pool, run.id, "0", 1);
      expect(full.events).toHaveLength(rowLimit);
      expect(full.hasMore).toBe(true);

      const rest = await listAgentRunEventsForStepPage(pool, run.id, full.events.at(-1)!.id, 1);
      expect(rest.events).toHaveLength(1);
      expect(rest.hasMore).toBe(false);

      await pool.query("DELETE FROM agent_run_events WHERE id = $1", [rest.events[0]!.id]);
      const exact = await listAgentRunEventsForStepPage(pool, run.id, "0", 1);
      expect(exact.events).toHaveLength(rowLimit);
      expect(exact.hasMore).toBe(false);
    });

    it.each([0, -1, 1.5, 501, Number.NaN])("rejects a step limit of %s before it queries", async (limit) => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "limit" });

      await expect(listAgentRunEventsForStepPage(pool, run.id, "0", limit)).rejects.toBeInstanceOf(ValidationError);
    });

    it("accepts the largest step limit", async () => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "limit" });

      await expect(listAgentRunEventsForStepPage(pool, run.id, "0", 500)).resolves.toEqual({
        events: [],
        hasMore: false,
      });
    });
  });

  describe("countAgentRunToolSteps (issue #1847)", () => {
    it("counts one tool step per tool call id and one approval step per call whose result has a request id", async () => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "count" });
      const other = await createAgentRun(pool, { triggeredBy: "user", task: "another run" });
      const use = (toolCallId: string) => ({ kind: "tool_use", toolCallId, name: "item_get", arguments: {} });
      const result = (toolCallId: string, details: unknown) => ({
        kind: "tool_result",
        toolCallId,
        name: "item_get",
        result: { content: [], details },
        isError: false,
      });
      await insertAgentRunEvent(pool, run.id, "tool_use", use("a"));
      await insertAgentRunEvent(pool, run.id, "tool_result", result("a", { error: false }));
      await insertAgentRunEvent(pool, run.id, "tool_use", use("b"));
      await insertAgentRunEvent(
        pool,
        run.id,
        "tool_result",
        result("b", { error: false, approvalRequestId: randomUUID() }),
      );
      // A call that has no result yet is a step too; so is a result whose call is gone.
      await insertAgentRunEvent(pool, run.id, "tool_use", use("c"));
      await insertAgentRunEvent(pool, run.id, "tool_result", result("gone", { error: false }));
      // A non-string request id is no approval, and a payload without a call id is no step.
      await insertAgentRunEvent(pool, run.id, "tool_result", result("d", { error: false, approvalRequestId: 7 }));
      await insertAgentRunEvent(pool, run.id, "tool_result", { kind: "tool_result", result: "no id" });
      await insertAgentRunEvent(pool, run.id, "message", { kind: "message", role: "assistant", text: "not a tool" });
      await insertAgentRunEvent(pool, other.id, "tool_use", use("other-run"));

      await expect(countAgentRunToolSteps(pool, run.id)).resolves.toEqual({ toolCount: 5, approvalCount: 1 });
    });

    it("counts nothing for a run without tool events", async () => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "no tools" });

      await expect(countAgentRunToolSteps(pool, run.id)).resolves.toEqual({ toolCount: 0, approvalCount: 0 });
    });
  });
});
