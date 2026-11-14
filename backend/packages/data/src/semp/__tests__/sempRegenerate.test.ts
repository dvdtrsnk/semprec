import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import {
  insertAgentRunEvent,
  listSessionAgentRunEventsFromLastCompaction,
} from "../../agentRuns/agentRunEventsStore.js";
import { createUser } from "../../auth/usersStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { createPendingApprovalRequest } from "../../mcp/approvalRequestsStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  claimSempMessage,
  finishSempMessageTurn,
  getSempMessageToken,
  regenerateSempReply,
  startSempMessageTurn,
} from "../sempMessagesStore.js";
import {
  assistantEvent,
  createFixtureItem,
  finishPlayedTurn,
  playTurn,
  toolResultEvent,
  toolUseEvent,
  turnEndEvent,
  turnStartEvent,
  userMessageEvent,
  type EventSpec,
  type PlayedTurn,
  type TurnSetup,
} from "./sempReplyTestSupport.js";

/**
 * Regenerating the latest finished Semp reply (issue gh-1930), through the real store function, the real queue tables and
 * the real event reader, on the runtime role pool. Turns are played with the production writers of the turn handler of
 * `semprec-agents` (see `sempReplyTestSupport.ts`).
 */

// Seeding the tenant's system databases takes a while.
const SEEDING_TEST_TIMEOUT_MS = 90_000;

let setup: TurnSetup;
let foreignTenant: string;

const answerOf = (text: string, atMs = 0): EventSpec[] => [
  userMessageEvent(atMs),
  turnStartEvent(atMs + 1),
  assistantEvent(text, atMs + 2),
  turnEndEvent(atMs + 3),
];

interface StoredMessage {
  id: string;
  role: string;
  status: string | null;
  attempt: number;
  reply_to_message_id: string | null;
  replaced_by_message_id: string | null;
}

function readThread(threadId: string): Promise<StoredMessage[]> {
  return runInTenant(setup.tenant, async () => {
    const { rows } = await setup.runtime.query<StoredMessage>(
      `SELECT id, role, status, attempt, reply_to_message_id, replaced_by_message_id FROM semp_messages
        WHERE thread_id = $1 ORDER BY created_at, id`,
      [threadId],
    );
    return rows;
  });
}

function jobKeysOf(threadId: string): Promise<string[]> {
  return runInTenant(setup.tenant, async () => {
    const { rows } = await setup.runtime.query<{ key: string }>(
      `SELECT j.key FROM graphile_worker.jobs j JOIN semp_messages m ON j.key = 'sempMessage:' || m.id::text
        WHERE m.thread_id = $1 ORDER BY j.key`,
      [threadId],
    );
    return rows.map((row) => row.key);
  });
}

function regenerate(threadId: string, messageId: string, tenant = setup.tenant) {
  return runInTenant(tenant, () =>
    withTransaction(setup.runtime, (client) => regenerateSempReply(client, threadId, messageId)),
  );
}

/** Plays and finishes a turn that answered with `text`; the message it answered is the one before it in the thread. */
async function playAnswer(text: string, reuse: { threadId?: string; runId?: string } = {}): Promise<PlayedTurn> {
  const turn = await playTurn(setup, answerOf(text), reuse);
  await finishPlayedTurn(setup, turn, "done");
  return turn;
}

/** Claims the queued assistant message `messageId` and plays its turn on `runId`, as the turn handler does. */
async function playQueued(
  threadId: string,
  messageId: string,
  events: EventSpec[],
  runId: string,
): Promise<PlayedTurn> {
  return runInTenant(setup.tenant, async () => {
    await withTransaction(setup.runtime, async (client) => {
      expect(await claimSempMessage(client, threadId, messageId)).toBe(true);
    });
    const eventIds: string[] = [];
    for (const spec of events)
      eventIds.push((await insertAgentRunEvent(setup.runtime, runId, spec.kind, spec.payload)).id);
    const first = eventIds[0];
    if (first === undefined) throw new Error("A fixture turn needs at least one event");
    await withTransaction(setup.runtime, (client) => startSempMessageTurn(client, messageId, runId, first));
    return { threadId, messageId, runId, eventIds };
  });
}

async function expectRefused(threadId: string, messageId: string, code: string): Promise<void> {
  const before = await readThread(threadId);
  const jobsBefore = await jobKeysOf(threadId);
  await expect(regenerate(threadId, messageId)).rejects.toMatchObject({ status: 409, code });
  // Nothing was queued, inserted or marked.
  expect(await readThread(threadId)).toEqual(before);
  expect(await jobKeysOf(threadId)).toEqual(jobsBefore);
}

describe("regenerating a Semp reply (issue gh-1930)", () => {
  beforeAll(async () => {
    const admin = getTestPool();
    await resetDatabase(admin);
    const runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const tenant = await createTestTenant(admin);
    foreignTenant = await createTestTenant(admin);
    // A run needs the tenant's user as its actor.
    for (const tenantId of [tenant, foreignTenant])
      await createUser(admin, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(tenant, () => seedSystem(runtime, createViewTypeRegistry()));
    setup = { admin, runtime, tenant };
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await setup?.runtime.end();
    await setup?.admin.end();
  });

  describe("the replacement", () => {
    it("queues the next attempt of the reply it replaces and marks the old reply as replaced", async () => {
      const turn = await playAnswer("first answer");
      const [user, reply] = await readThread(turn.threadId);

      const result = await regenerate(turn.threadId, turn.messageId);

      const messages = await readThread(turn.threadId);
      expect(messages.map((message) => [message.id, message.role, message.status, message.attempt])).toEqual([
        [user?.id, "user", null, 1],
        [reply?.id, "assistant", "done", 1],
        [result.messageId, "assistant", "queued", 2],
      ]);
      expect(messages[1]).toMatchObject({ replaced_by_message_id: result.messageId });
      expect(messages[2]).toMatchObject({ reply_to_message_id: user?.id, replaced_by_message_id: null });
      expect(await jobKeysOf(turn.threadId)).toEqual(
        [`sempMessage:${turn.messageId}`, `sempMessage:${result.messageId}`].sort(),
      );
    });

    it("leaves the replaced reply readable: its text and steps are stored as they were", async () => {
      const turn = await playAnswer("kept answer");
      const read = () =>
        runInTenant(setup.tenant, () =>
          setup.runtime.query(
            "SELECT text, steps, status, duration_ms, tokens, changes FROM semp_messages WHERE id = $1",
            [turn.messageId],
          ),
        );
      const before = await read();

      await regenerate(turn.threadId, turn.messageId);

      expect((await read()).rows).toEqual(before.rows);
      expect(before.rows[0]).toMatchObject({ text: "reply", status: "done" });
    });

    it("changes the token of the replaced reply to name its replacement, which is how a session that cached the old token is found stale", async () => {
      const turn = await playAnswer("first answer");
      const replacedByInToken = async (id: string): Promise<unknown> => {
        const token = await runInTenant(setup.tenant, () =>
          withTransaction(setup.runtime, (client) => getSempMessageToken(client, id)),
        );
        const parsed: unknown = JSON.parse(token ?? "null");
        if (typeof parsed !== "object" || parsed === null || !("replacedBy" in parsed)) {
          throw new Error("The token names no replacedBy");
        }
        return parsed.replacedBy;
      };

      const before = await replacedByInToken(turn.messageId);
      const result = await regenerate(turn.threadId, turn.messageId);

      expect(before).toBeNull();
      expect(await replacedByInToken(turn.messageId)).toBe(result.messageId);
    });

    it("numbers the attempt one above the replaced one, so a second regeneration is attempt 3 and replaces attempt 2", async () => {
      const first = await playAnswer("first answer");
      const second = await regenerate(first.threadId, first.messageId);
      const played = await playQueued(first.threadId, second.messageId, answerOf("second answer", 10), first.runId);
      await finishPlayedTurn(setup, played, "done");

      const third = await regenerate(first.threadId, second.messageId);

      const assistants = (await readThread(first.threadId)).filter((message) => message.role === "assistant");
      expect(assistants.map((message) => [message.id, message.attempt, message.replaced_by_message_id])).toEqual([
        [first.messageId, 1, second.messageId],
        [second.messageId, 2, third.messageId],
        [third.messageId, 3, null],
      ]);
    });

    it("regenerates a reply that finished with an incomplete outcome, which is a done reply that made no changes", async () => {
      const turn = await playTurn(setup, [
        userMessageEvent(),
        turnStartEvent(1),
        toolUseEvent({ toolCallId: "t-1", name: "item_get", operation: "item.get" }, 2),
        toolResultEvent({ toolCallId: "t-1", name: "item_get", operation: "item.get" }, 3, {
          details: { error: true },
          isError: true,
        }),
        assistantEvent("a partial answer", 4),
        turnEndEvent(5),
      ]);
      await finishPlayedTurn(setup, turn, "done");

      const result = await regenerate(turn.threadId, turn.messageId);

      expect((await readThread(turn.threadId)).at(-1)).toMatchObject({ id: result.messageId, attempt: 2 });
    });

    it("regenerates a reply whose compaction checkpoint came before it", async () => {
      const earlier = await playAnswer("earlier answer");
      await runInTenant(setup.tenant, () =>
        insertAgentRunEvent(setup.runtime, earlier.runId, "compaction", [
          { id: "c", parentId: null, seq: 0, timestamp: 1, message: { kind: "message", text: "summary" } },
        ]),
      );
      const turn = await playAnswer("later answer", { threadId: earlier.threadId, runId: earlier.runId });

      const result = await regenerate(turn.threadId, turn.messageId);

      expect((await readThread(turn.threadId)).at(-1)).toMatchObject({ id: result.messageId, attempt: 2 });
    });
  });

  describe("only the latest finished reply is regenerated", () => {
    it("refuses a reply that is not the latest message of the thread", async () => {
      const first = await playAnswer("first answer");
      await playAnswer("second answer", { threadId: first.threadId });

      await expectRefused(first.threadId, first.messageId, "regenerate_not_latest");
    });

    it.each(["queued", "running", "error"] as const)("refuses a latest reply whose turn is %s", async (status) => {
      const sent = await runInTenant(setup.tenant, () =>
        withTransaction(setup.runtime, async (client) => {
          const message = await sendSempMessage(client, { text: "Question", context: [], hasContext: false });
          if (status !== "queued")
            expect(await claimSempMessage(client, message.threadId, message.assistantMessageId)).toBe(true);
          if (status === "error") {
            expect(
              await finishSempMessageTurn(client, message.assistantMessageId, {
                status: "error",
                errorCode: "modelError",
              }),
            ).toBe(true);
          }
          return message;
        }),
      );

      await expectRefused(sent.threadId, sent.assistantMessageId, "regenerate_not_latest");
    });

    it("refuses the latest message of a thread when it is a user message", async () => {
      const turn = await playAnswer("an answer");
      // Raw fixture: the send path always queues the assistant reply with the user message, so a thread whose latest
      // message is a user message cannot be produced by it.
      const user = await runInTenant(setup.tenant, () =>
        setup.runtime.query<{ id: string }>(
          "INSERT INTO semp_messages (thread_id, role, text) VALUES ($1, 'user', 'Unanswered') RETURNING id",
          [turn.threadId],
        ),
      );

      await expectRefused(turn.threadId, user.rows[0]?.id ?? "", "regenerate_not_latest");
    });

    it("refuses a done assistant message that answers no message, as the reply of a heartbeat run does", async () => {
      const turn = await playAnswer("an answer");
      // Raw fixture: a tick run's reply is stored with a run and a range but no `reply_to_message_id`, which no
      // production writer of a thread reply leaves out.
      const orphan = await runInTenant(setup.tenant, () =>
        setup.runtime.query<{ id: string }>(
          `INSERT INTO semp_messages (thread_id, role, status, agent_run_id, event_from_id, event_to_id, created_at)
           VALUES ($1, 'assistant', 'done', $2, $3, $4, now() + interval '1 minute') RETURNING id`,
          [turn.threadId, turn.runId, turn.eventIds[0], turn.eventIds.at(-1)],
        ),
      );

      await expectRefused(turn.threadId, orphan.rows[0]?.id ?? "", "regenerate_not_latest");
    });

    it("refuses a done reply that stored no run or no event range, which leaves nothing to hide from the model", async () => {
      const turn = await playTurn(setup, answerOf("an answer"));
      // Raw fixture: the turn handler stores the run and the range before it finishes a message as done; this is a
      // message finished without them.
      await runInTenant(setup.tenant, () =>
        setup.runtime.query("UPDATE semp_messages SET status = 'done', event_to_id = NULL WHERE id = $1", [
          turn.messageId,
        ]),
      );

      await expectRefused(turn.threadId, turn.messageId, "regenerate_not_latest");
    });
  });

  describe("a reply whose turn wrote or asked is not regenerated", () => {
    it("refuses a reply whose turn moved a task and queues nothing", async () => {
      const task = await createFixtureItem(setup, "tasks", { name: "Write the report", date: "2026-11-02" });
      const patch = { toolCallId: "m-1", name: "item_patch", operation: "item.patch", targetItemId: task.id };
      const turn = await playTurn(setup, [
        userMessageEvent(),
        turnStartEvent(1),
        toolUseEvent({ ...patch, args: { itemId: task.id, properties: { date: "2026-11-03" }, ifVersion: "v" } }, 5),
        toolResultEvent(patch, 15, {
          text: JSON.stringify({ id: task.id, databaseId: task.databaseId, properties: { date: "2026-11-03" } }),
          details: { error: false, changes: [{ key: "date", before: "2026-11-02", after: "2026-11-03" }] },
        }),
        assistantEvent("moved", 18),
        turnEndEvent(20),
      ]);
      await finishPlayedTurn(setup, turn, "done");

      await expectRefused(turn.threadId, turn.messageId, "regenerate_after_writes");
    });

    it("refuses a reply stored without its list of changes, because it is not known to have made none", async () => {
      const turn = await playTurn(setup, answerOf("an old answer"));
      await runInTenant(setup.tenant, () =>
        withTransaction(setup.runtime, async (client) => {
          // The writer a message stored before issue #1885 went through: a done status with no summary.
          expect(
            await finishSempMessageTurn(client, turn.messageId, {
              status: "done",
              text: "an old answer",
              lastEventId: turn.eventIds.at(-1) ?? "",
            }),
          ).toBe(true);
        }),
      );

      await expectRefused(turn.threadId, turn.messageId, "regenerate_after_writes");
    });

    it("refuses a reply that requested an approval for a tool call in its range", async () => {
      const call = { toolCallId: "ap-1", name: "mcp_write_aaaaaaaa", operation: "item.patch" };
      const turn = await playTurn(setup, [
        userMessageEvent(),
        turnStartEvent(1),
        toolUseEvent(call, 2),
        toolResultEvent(call, 3, { details: { error: false } }),
        assistantEvent("asked", 4),
        turnEndEvent(5),
      ]);
      await finishPlayedTurn(setup, turn, "done");
      await runInTenant(setup.tenant, () =>
        createPendingApprovalRequest(setup.runtime, {
          agentRunId: turn.runId,
          toolName: "probe",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
          toolCallId: "ap-1",
        }),
      );

      await expectRefused(turn.threadId, turn.messageId, "regenerate_after_writes");
    });

    it("still refuses it once retention removed the events of its range, by the tool call the stored steps name", async () => {
      const call = { toolCallId: "ap-2", name: "mcp_write_aaaaaaaa", operation: "item.patch" };
      const turn = await playTurn(setup, [
        userMessageEvent(),
        turnStartEvent(1),
        toolUseEvent(call, 2),
        toolResultEvent(call, 3, { details: { error: false } }),
        assistantEvent("asked", 4),
        turnEndEvent(5),
      ]);
      await finishPlayedTurn(setup, turn, "done");
      await runInTenant(setup.tenant, () =>
        createPendingApprovalRequest(setup.runtime, {
          agentRunId: turn.runId,
          toolName: "probe",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
          toolCallId: "ap-2",
        }),
      );
      // Raw statement: the retention task removes events older than 30 days, which the fixture clock cannot reach.
      const removed = await setup.admin.query(
        "DELETE FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'tool_use'",
        [turn.runId],
      );
      expect(removed.rowCount).toBe(1);

      await expectRefused(turn.threadId, turn.messageId, "regenerate_after_writes");
    });

    it("refuses a reply whose stored step carries an approval request, whether or not a request row is found", async () => {
      const call = { toolCallId: "ap-3", name: "item_patch", operation: "item.patch" };
      const turn = await playTurn(setup, [
        userMessageEvent(),
        turnStartEvent(1),
        toolUseEvent(call, 2),
        toolResultEvent(call, 3, { details: { error: false, approvalRequestId: randomUUID() } }),
        assistantEvent("waiting for approval", 4),
        turnEndEvent(5),
      ]);
      const { summary } = await finishPlayedTurn(setup, turn, "done");
      expect(summary.steps.some((step) => step.approvalRequestId !== undefined)).toBe(true);
      expect(summary.changes).toEqual([]);

      await expectRefused(turn.threadId, turn.messageId, "regenerate_after_writes");
    });

    it("regenerates a reply that read items and asked for no approval, even when its run holds an approval of another call", async () => {
      const call = { toolCallId: "r-1", name: "item_get", operation: "item.get" };
      const turn = await playTurn(setup, [
        userMessageEvent(),
        turnStartEvent(1),
        toolUseEvent(call, 2),
        toolResultEvent(call, 3, { details: { error: false } }),
        assistantEvent("read only", 4),
        turnEndEvent(5),
      ]);
      await finishPlayedTurn(setup, turn, "done");
      await runInTenant(setup.tenant, () =>
        createPendingApprovalRequest(setup.runtime, {
          agentRunId: turn.runId,
          toolName: "probe",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
          toolCallId: "another-call",
        }),
      );

      const result = await regenerate(turn.threadId, turn.messageId);

      expect((await readThread(turn.threadId)).at(-1)).toMatchObject({ id: result.messageId, attempt: 2 });
    });
  });

  describe("a reply that a checkpoint already includes is not regenerated", () => {
    it("refuses a reply when a compaction event of the thread's conversation follows its range", async () => {
      const turn = await playAnswer("first answer");
      await runInTenant(setup.tenant, () =>
        insertAgentRunEvent(setup.runtime, turn.runId, "compaction", [
          { id: "c", parentId: null, seq: 0, timestamp: 1, message: { kind: "message", text: "summary" } },
        ]),
      );

      await expectRefused(turn.threadId, turn.messageId, "regenerate_after_compaction");
    });

    it("refuses it for a checkpoint written by a later wake run of the thread as well", async () => {
      const turn = await playAnswer("first answer");
      await runInTenant(setup.tenant, async () => {
        const later = await createAgentRun(setup.runtime, {
          triggeredBy: "user",
          unit: "session",
          task: "later wake",
          threadId: turn.threadId,
        });
        await insertAgentRunEvent(setup.runtime, later.id, "compaction", [
          { id: "c", parentId: null, seq: 0, timestamp: 1, message: { kind: "message", text: "summary" } },
        ]);
      });

      await expectRefused(turn.threadId, turn.messageId, "regenerate_after_compaction");
    });

    it("does not count a checkpoint of another thread", async () => {
      const turn = await playAnswer("first answer");
      const other = await playAnswer("an answer of another thread");
      await runInTenant(setup.tenant, () =>
        insertAgentRunEvent(setup.runtime, other.runId, "compaction", [
          { id: "c", parentId: null, seq: 0, timestamp: 1, message: { kind: "message", text: "summary" } },
        ]),
      );

      const result = await regenerate(turn.threadId, turn.messageId);

      expect((await readThread(turn.threadId)).at(-1)).toMatchObject({ id: result.messageId });
    });
  });

  describe("the order of the checks", () => {
    it("answers not-latest before writes: an older reply that wrote something is not the latest", async () => {
      const task = await createFixtureItem(setup, "tasks", { name: "Older task", date: "2026-11-02" });
      const patch = { toolCallId: "o-1", name: "item_patch", operation: "item.patch", targetItemId: task.id };
      const older = await playTurn(setup, [
        userMessageEvent(),
        turnStartEvent(1),
        toolUseEvent({ ...patch, args: { itemId: task.id, properties: { date: "2026-11-03" } } }, 2),
        toolResultEvent(patch, 3, {
          text: JSON.stringify({ id: task.id, databaseId: task.databaseId, properties: { date: "2026-11-03" } }),
          details: { error: false, changes: [{ key: "date", before: "2026-11-02", after: "2026-11-03" }] },
        }),
        assistantEvent("moved", 4),
        turnEndEvent(5),
      ]);
      await finishPlayedTurn(setup, older, "done");
      await playAnswer("newer answer", { threadId: older.threadId });

      await expectRefused(older.threadId, older.messageId, "regenerate_not_latest");
    });

    it("answers writes before compaction: a reply that wrote and is followed by a checkpoint", async () => {
      const task = await createFixtureItem(setup, "tasks", { name: "Both task", date: "2026-11-02" });
      const patch = { toolCallId: "b-1", name: "item_patch", operation: "item.patch", targetItemId: task.id };
      const turn = await playTurn(setup, [
        userMessageEvent(),
        turnStartEvent(1),
        toolUseEvent({ ...patch, args: { itemId: task.id, properties: { date: "2026-11-03" } } }, 2),
        toolResultEvent(patch, 3, {
          text: JSON.stringify({ id: task.id, databaseId: task.databaseId, properties: { date: "2026-11-03" } }),
          details: { error: false, changes: [{ key: "date", before: "2026-11-02", after: "2026-11-03" }] },
        }),
        assistantEvent("moved", 4),
        turnEndEvent(5),
      ]);
      await finishPlayedTurn(setup, turn, "done");
      await runInTenant(setup.tenant, () =>
        insertAgentRunEvent(setup.runtime, turn.runId, "compaction", [
          { id: "c", parentId: null, seq: 0, timestamp: 1, message: { kind: "message", text: "summary" } },
        ]),
      );

      await expectRefused(turn.threadId, turn.messageId, "regenerate_after_writes");
    });
  });

  describe("tenants", () => {
    it("answers a thread or message of another tenant as an unknown one and changes nothing", async () => {
      const turn = await playAnswer("first answer");
      const before = await readThread(turn.threadId);

      await expect(regenerate(turn.threadId, turn.messageId, foreignTenant)).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      });
      await expect(regenerate(randomUUID(), randomUUID(), foreignTenant)).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      });
      await expect(regenerate(turn.threadId, randomUUID())).rejects.toMatchObject({ status: 404, code: "not_found" });

      expect(await readThread(turn.threadId)).toEqual(before);
    });

    it("refuses a replacement that points at another tenant's message at the foreign key", async () => {
      const turn = await playAnswer("first answer");
      // Raw statement on the admin pool: no production writer sets the column to anything but the new message of the
      // same thread, so the constraint is proven by writing what a faulty writer would.
      const foreignMessage = await setup.admin.query<{ id: string }>(
        `INSERT INTO semp_threads (tenant_id, kind) VALUES ($1, 'chat') RETURNING id`,
        [foreignTenant],
      );
      const foreignThread = foreignMessage.rows[0]?.id;
      const foreignReply = await setup.admin.query<{ id: string }>(
        "INSERT INTO semp_messages (tenant_id, thread_id, role, text) VALUES ($1, $2, 'user', 'foreign') RETURNING id",
        [foreignTenant, foreignThread],
      );

      await expect(
        setup.admin.query("UPDATE semp_messages SET replaced_by_message_id = $2 WHERE id = $1", [
          turn.messageId,
          foreignReply.rows[0]?.id,
        ]),
      ).rejects.toMatchObject({ code: "23503", constraint: "semp_messages_replaced_by_fkey" });
    });
  });

  describe("the history events of a thread", () => {
    const eventsOf = async (threadId: string, bounds?: { maxRows: number; maxBytes: number }) =>
      runInTenant(setup.tenant, () =>
        listSessionAgentRunEventsFromLastCompaction(
          setup.runtime,
          { threadId, triggeredBy: "user", parentRunId: null },
          bounds,
        ),
      );

    it.each([
      ["without bounds", undefined],
      ["with the replay bounds", { maxRows: 2000, maxBytes: 262144 }],
    ])(
      "leave out the whole turn of a replaced reply and keep the other turns of its run, %s",
      async (_label, bounds) => {
        const first = await playAnswer("first answer");
        const second = await playAnswer("second answer", { threadId: first.threadId, runId: first.runId });
        await regenerate(first.threadId, second.messageId);

        const events = await eventsOf(first.threadId, bounds);

        expect(events.map((event) => event.id)).toEqual(first.eventIds);
        expect(second.eventIds.some((id) => events.some((event) => event.id === id))).toBe(false);
      },
    );

    it("keep the events of a failed attempt that was retried, and of a reply nobody replaced", async () => {
      const failed = await playTurn(setup, answerOf("a failed turn"));
      await runInTenant(setup.tenant, () =>
        withTransaction(setup.runtime, async (client) => {
          expect(
            await finishSempMessageTurn(client, failed.messageId, { status: "error", errorCode: "modelError" }),
          ).toBe(true);
        }),
      );
      const answered = await playAnswer("an answer", { threadId: failed.threadId });

      expect((await eventsOf(failed.threadId)).map((event) => event.id)).toEqual([
        ...failed.eventIds,
        ...answered.eventIds,
      ]);
    });

    it("do not count the events of a replaced reply toward the replay bounds", async () => {
      const first = await playAnswer("first answer");
      await regenerate(first.threadId, first.messageId);

      // The thread holds four events, all of the replaced turn; a bound of one row would overflow on them.
      expect(await eventsOf(first.threadId, { maxRows: 1, maxBytes: 262144 })).toEqual([]);
    });

    it("leave the events of another thread out of a thread's replaced range", async () => {
      const first = await playAnswer("first answer");
      const other = await playAnswer("an answer of another thread");
      await regenerate(first.threadId, first.messageId);

      expect((await eventsOf(other.threadId)).map((event) => event.id)).toEqual(other.eventIds);
    });
  });
});
