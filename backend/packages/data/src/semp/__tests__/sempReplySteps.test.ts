import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { createAgentRun, finishAgentRun } from "../../agentRuns/agentRunsStore.js";
import { insertAgentRunEvent, listSempTurnEvents } from "../../agentRuns/agentRunEventsStore.js";
import { handleAgentRunEventsRetentionTask } from "../../agentRuns/agentRunEventsRetention.js";
import { failGatewayCall, reserveGatewayCall, settleTokenGatewayCall } from "../../aiGateway/aiGatewayCallsStore.js";
import { createUser } from "../../auth/usersStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { createPendingApprovalRequest } from "../../mcp/approvalRequestsStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { finishSempMessageTurn } from "../sempMessagesStore.js";
import { buildSempReplySummary } from "../sempReplySummary.js";
import {
  assistantEvent,
  CLOCK_START,
  createFixtureItem,
  finishPlayedTurn,
  playTurn,
  readStoredReply,
  toolResultEvent,
  toolUseEvent,
  turnEndEvent,
  turnStartEvent,
  userMessageEvent,
  type TurnSetup,
} from "./sempReplyTestSupport.js";

// Seeding the tenant's system databases takes a while.
const SEEDING_TEST_TIMEOUT_MS = 90_000;
const DAY_MS = 24 * 60 * 60 * 1000;

let setup: TurnSetup;
let foreignTenant: string;

/** Reserves and settles one gateway call attributed to `messageId`, as the gateway does for a model call. */
async function settledCall(messageId: string | null, input: number, output: number): Promise<void> {
  await runInTenant(setup.tenant, async () => {
    const reserved = await reserveGatewayCall(setup.runtime, {
      provider: "test",
      model: "test",
      estimatedCostUsd: 0.01,
      sempMessageId: messageId,
    });
    await settleTokenGatewayCall(setup.runtime, reserved.id, {
      inputTokens: input,
      outputTokens: output,
      costUsd: 0.01,
    });
  });
}

describe("the typed step summary of a Semp reply (issue #1860)", () => {
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

  it("stores two tool steps with their durations and statuses, and the time of the whole turn", async () => {
    const task = await createFixtureItem(setup, "tasks", { name: "Write the report" });
    const patch = { toolCallId: "t-1", name: "item_patch", operation: "item.patch", targetItemId: task.id };
    const list = { toolCallId: "t-2", name: "database_list", operation: "database.list" };
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(10),
      toolUseEvent(patch, 100),
      toolResultEvent(patch, 600, {
        details: { error: false, changes: [{ key: "date", before: "2026-11-02", after: "2026-11-03" }] },
      }),
      toolUseEvent(list, 700),
      toolResultEvent(list, 1000, { isError: true, details: { error: true, errorCode: "forbidden" } }),
      assistantEvent("Done.", 1200),
      turnEndEvent(1500),
    ]);

    await finishPlayedTurn(setup, turn, "done");
    const stored = await readStoredReply(setup.admin, turn.messageId);

    expect(stored.status).toBe("done");
    // The whole turn (turn_start at 10 ms to turn_end at 1500 ms), not the 500 + 300 ms of its steps.
    expect(stored.duration_ms).toBe(1490);
    expect(stored.steps).toEqual([
      {
        kind: "tool",
        toolCallId: "t-1",
        toolName: "item_patch",
        operation: "item.patch",
        label: { key: "agentStep.title.operation.item.patch", params: { targetModuleId: "tasks" } },
        detail: {
          key: "agentStep.summary.changedProperties",
          params: {
            itemName: "Write the report",
            count: 1,
            changedKeys: ["date"],
            changes: [{ key: "date", before: "2026-11-02", after: "2026-11-03" }],
          },
        },
        status: "ok",
        startedAt: new Date(CLOCK_START + 100).toISOString(),
        durationMs: 500,
      },
      {
        kind: "tool",
        toolCallId: "t-2",
        toolName: "database_list",
        operation: "database.list",
        label: { key: "agentStep.title.operation.database.list", params: {} },
        detail: { key: "agentStep.summary.failed", params: {} },
        status: "error",
        startedAt: new Date(CLOCK_START + 700).toISOString(),
        durationMs: 300,
        errorCode: "forbidden",
      },
    ]);
  });

  it("marks a delete waiting for approval as waiting, with the id of the stored approval request", async () => {
    const task = await createFixtureItem(setup, "tasks", { name: "Old task" });
    const del = { toolCallId: "del-1", name: "item_delete", operation: "item.delete", targetItemId: task.id };
    const run = await runInTenant(setup.tenant, () =>
      createAgentRun(setup.runtime, { triggeredBy: "user", unit: "session", task: "approval" }),
    );
    // The tool creates the request before its result event is stored.
    const request = await runInTenant(setup.tenant, () =>
      createPendingApprovalRequest(setup.runtime, {
        agentRunId: run.id,
        toolName: "item.delete",
        riskClass: "unclassified",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "test", resourceId: task.id, sha256: null },
        toolCallId: "del-1",
      }),
    );
    const turn = await playTurn(
      setup,
      [
        userMessageEvent(),
        turnStartEvent(5),
        toolUseEvent(del, 10),
        toolResultEvent(del, 40, { details: { error: false, approvalRequestId: request.id } }),
        turnEndEvent(50),
      ],
      { runId: run.id },
    );

    await finishPlayedTurn(setup, turn, "done");
    const reply = await readStoredReply(setup.admin, turn.messageId);

    const row = await setup.admin.query<{ id: string }>(
      "SELECT id FROM approval_requests WHERE agent_run_id = $1 AND tool_call_id = 'del-1'",
      [run.id],
    );
    expect(row.rows).toEqual([{ id: request.id }]);
    expect(reply.steps).toEqual([
      expect.objectContaining({
        toolCallId: "del-1",
        status: "wait",
        approvalRequestId: request.id,
        detail: { key: "agentStep.summary.approvalRequested", params: { itemName: "Old task" } },
        durationMs: 30,
      }),
    ]);
  });

  it("keeps the stored steps unchanged after retention deleted the events they were made from", async () => {
    const list = { toolCallId: "r-1", name: "database_list", operation: "database.list" };
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(1),
      toolUseEvent(list, 5),
      toolResultEvent(list, 25),
      assistantEvent("ok", 30),
      turnEndEvent(40),
    ]);
    await finishPlayedTurn(setup, turn, "done");
    const before = await readStoredReply(setup.admin, turn.messageId);
    expect(before.steps).toHaveLength(1);

    // A later turn checkpoint makes the first turn's events removable; the run is finished and old.
    await runInTenant(setup.tenant, () =>
      insertAgentRunEvent(setup.runtime, turn.runId, "compaction", { kind: "compaction" }),
    );
    await runInTenant(setup.tenant, () => finishAgentRun(setup.runtime, turn.runId, "done", null));
    await setup.admin.query("UPDATE agent_run_events SET at = $2 WHERE agent_run_id = $1", [
      turn.runId,
      new Date(Date.now() - 40 * DAY_MS),
    ]);
    await handleAgentRunEventsRetentionTask(setup.admin);

    const remaining = await setup.admin.query<{ id: string }>(
      "SELECT id FROM agent_run_events WHERE id = ANY($1::bigint[])",
      [turn.eventIds],
    );
    expect(remaining.rows).toEqual([]);
    expect(await readStoredReply(setup.admin, turn.messageId)).toEqual(before);
  });

  it("counts only the settled gateway calls of each reply", async () => {
    const first = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(1),
      assistantEvent("one", 5),
      turnEndEvent(9),
    ]);
    const second = await playTurn(
      setup,
      [userMessageEvent(), turnStartEvent(1), assistantEvent("two", 5), turnEndEvent(9)],
      { threadId: first.threadId, runId: first.runId },
    );
    const third = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(1),
      assistantEvent("three", 5),
      turnEndEvent(9),
    ]);
    await settledCall(first.messageId, 100, 10);
    await settledCall(first.messageId, 200, 20);
    await settledCall(second.messageId, 5, 1);
    await settledCall(null, 9_000, 900);
    // A reserved call has only an estimate, and a failed one used nothing.
    await runInTenant(setup.tenant, async () => {
      await reserveGatewayCall(setup.runtime, {
        provider: "test",
        model: "test",
        estimatedCostUsd: 1,
        sempMessageId: first.messageId,
      });
      const failed = await reserveGatewayCall(setup.runtime, {
        provider: "test",
        model: "test",
        estimatedCostUsd: 1,
        sempMessageId: first.messageId,
      });
      await failGatewayCall(setup.runtime, failed.id);
    });
    // Raw SQL, because production leaves the token columns of a reserved or failed call NULL, where a sum would skip
    // them anyway: give them tokens, so only the status filter keeps them out of the total.
    await setup.admin.query(
      "UPDATE ai_gateway_calls SET input_tokens = 1000, output_tokens = 100 WHERE semp_message_id = $1 AND status IN ('reserved', 'failed')",
      [first.messageId],
    );

    for (const turn of [first, second, third]) await finishPlayedTurn(setup, turn, "done");

    expect((await readStoredReply(setup.admin, first.messageId)).tokens).toEqual({ input: 300, output: 30 });
    expect((await readStoredReply(setup.admin, second.messageId)).tokens).toEqual({ input: 5, output: 1 });
    expect((await readStoredReply(setup.admin, third.messageId)).tokens).toEqual({ input: 0, output: 0 });
  });

  it("stores no name, field value or free text for a step on an item of a sensitive database", async () => {
    const record = await createFixtureItem(setup, "healthRecords", { name: "Blood test PRIVATE-NAME" });
    const patch = { toolCallId: "s-1", name: "item_patch", operation: "item.patch", targetItemId: record.id };
    const del = { toolCallId: "s-2", name: "item_delete", operation: "item.delete", targetItemId: record.id };
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(1),
      // Stored the way the run log stores a content-bearing result of a sensitive database: redacted.
      toolUseEvent({ ...patch, args: { itemId: record.id, properties: { name: "PRIVATE-VALUE" } } }, 5),
      toolResultEvent(patch, 15, {
        text: "[redacted: sensitive]",
        details: { error: false, changes: [{ key: "name" }] },
      }),
      // A call that is not redacted still points at an item of the sensitive database.
      toolUseEvent(del, 20),
      toolResultEvent(del, 30, { details: { error: false, approvalRequestId: "approval-sensitive" } }),
      turnEndEvent(40),
    ]);

    await finishPlayedTurn(setup, turn, "done");
    const stored = await readStoredReply(setup.admin, turn.messageId);

    expect(stored.steps).toEqual([
      expect.objectContaining({
        toolCallId: "s-1",
        status: "ok",
        label: { key: "agentStep.title.operation.item.patch", params: { targetModuleId: "healthRecords" } },
        detail: { key: "agentStep.summary.operation.item.patch", params: {} },
      }),
      expect.objectContaining({
        toolCallId: "s-2",
        status: "wait",
        detail: { key: "agentStep.summary.approvalRequested", params: {} },
      }),
    ]);
    expect(JSON.stringify(stored.steps)).not.toMatch(/PRIVATE/u);
  });

  it("keeps the steps up to the failure when the turn ends in an error", async () => {
    const done = { toolCallId: "e-1", name: "database_list", operation: "database.list" };
    const cut = { toolCallId: "e-2", name: "database_list", operation: "database.list" };
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(0),
      toolUseEvent(done, 10),
      toolResultEvent(done, 30),
      toolUseEvent(cut, 40),
    ]);

    const { stored } = await finishPlayedTurn(setup, turn, "error");
    const reply = await readStoredReply(setup.admin, turn.messageId);

    expect(stored).toBe(true);
    expect(reply.status).toBe("error");
    expect(reply.event_to_id).toBeNull();
    expect(reply.duration_ms).toBe(40);
    expect(reply.steps).toEqual([
      expect.objectContaining({ toolCallId: "e-1", status: "ok", durationMs: 20 }),
      expect.objectContaining({ toolCallId: "e-2", status: "error", durationMs: 0 }),
    ]);
    expect(reply.tokens).toEqual({ input: 0, output: 0 });
  });

  it("leaves the summary columns empty for a final status stored without a summary", async () => {
    const turn = await playTurn(setup, [userMessageEvent(), turnStartEvent(1), turnEndEvent(2)]);
    const lastEventId = turn.eventIds.at(-1)!;

    await runInTenant(setup.tenant, () =>
      withTransaction(setup.runtime, (client) =>
        finishSempMessageTurn(client, turn.messageId, { status: "done", text: "x", lastEventId }),
      ),
    );

    const reply = await readStoredReply(setup.admin, turn.messageId);
    expect([reply.status, reply.steps, reply.duration_ms, reply.tokens, reply.changes]).toEqual([
      "done",
      null,
      null,
      null,
      null,
    ]);
  });

  it("does not overwrite the summary of a message that is no longer running", async () => {
    const list = { toolCallId: "o-1", name: "database_list", operation: "database.list" };
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(0),
      toolUseEvent(list, 5),
      toolResultEvent(list, 9),
      turnEndEvent(12),
    ]);
    await finishPlayedTurn(setup, turn, "done");
    const first = await readStoredReply(setup.admin, turn.messageId);

    const second = await finishPlayedTurn(setup, turn, "error");

    expect(second.stored).toBe(false);
    expect(await readStoredReply(setup.admin, turn.messageId)).toEqual(first);
  });

  describe("tenant isolation", () => {
    it("reads nothing of another tenant's turn, items or calls through the runtime role", async () => {
      const task = await createFixtureItem(setup, "tasks", { name: "Tenant A secret name" });
      const patch = { toolCallId: "x-1", name: "item_patch", operation: "item.patch", targetItemId: task.id };
      const turn = await playTurn(setup, [
        userMessageEvent(),
        turnStartEvent(0),
        toolUseEvent(patch, 5),
        toolResultEvent(patch, 9, { details: { error: false } }),
        turnEndEvent(12),
      ]);
      await settledCall(turn.messageId, 7, 3);

      const own = await runInTenant(setup.tenant, () =>
        withTransaction(setup.runtime, (client) =>
          buildSempReplySummary(client, {
            messageId: turn.messageId,
            agentRunId: turn.runId,
            firstEventId: turn.eventIds[0]!,
            lastEventId: turn.eventIds.at(-1)!,
          }),
        ),
      );
      const foreign = await runInTenant(foreignTenant, () =>
        withTransaction(setup.runtime, (client) =>
          buildSempReplySummary(client, {
            messageId: turn.messageId,
            agentRunId: turn.runId,
            firstEventId: turn.eventIds[0]!,
            lastEventId: turn.eventIds.at(-1)!,
          }),
        ),
      );
      const foreignEvents = await runInTenant(foreignTenant, () =>
        listSempTurnEvents(setup.runtime, turn.runId, turn.eventIds[0]!, null),
      );

      expect(own.steps).toHaveLength(1);
      expect(own.tokens).toEqual({ input: 7, output: 3 });
      expect(foreign).toEqual({ steps: [], durationMs: null, tokens: { input: 0, output: 0 }, changes: [] });
      expect(foreignEvents).toEqual([]);
    });

    it("gives a step of another tenant's item no name even when the events are handed over", async () => {
      const task = await createFixtureItem(setup, "tasks", { name: "Tenant A secret name" });
      const patch = { toolCallId: "y-1", name: "item_patch", operation: "item.patch", targetItemId: task.id };
      // The foreign tenant's own run carries events that name tenant A's item id.
      const foreignRun = await runInTenant(foreignTenant, () =>
        createAgentRun(setup.runtime, { triggeredBy: "user", unit: "session", task: "foreign" }),
      );
      const stored = await runInTenant(foreignTenant, async () => {
        const ids: string[] = [];
        for (const spec of [
          turnStartEvent(0),
          toolUseEvent(patch, 1),
          toolResultEvent(patch, 2, { details: { error: false } }),
        ]) {
          ids.push((await insertAgentRunEvent(setup.runtime, foreignRun.id, spec.kind, spec.payload)).id);
        }
        return ids;
      });

      const summary = await runInTenant(foreignTenant, () =>
        withTransaction(setup.runtime, (client) =>
          buildSempReplySummary(client, {
            messageId: randomUUID(),
            agentRunId: foreignRun.id,
            firstEventId: stored[0]!,
            lastEventId: stored.at(-1)!,
          }),
        ),
      );

      expect(summary.steps).toHaveLength(1);
      expect(JSON.stringify(summary.steps)).not.toContain("Tenant A secret name");
      expect(summary.steps[0]).toMatchObject({ detail: { params: {} }, label: { params: {} } });
    });
  });

  describe("the events of a turn", () => {
    it("are bounded by the message's first and last event and leave out user text and checkpoints", async () => {
      const list = { toolCallId: "b-1", name: "database_list", operation: "database.list" };
      const first = await playTurn(setup, [
        userMessageEvent(),
        turnStartEvent(0),
        toolUseEvent(list, 1),
        toolResultEvent(list, 2),
        turnEndEvent(3),
      ]);
      const second = await playTurn(
        setup,
        [
          userMessageEvent(),
          turnStartEvent(10),
          { kind: "compaction", atMs: 11, payload: { kind: "compaction" } },
          assistantEvent("later", 12),
          turnEndEvent(13),
        ],
        { threadId: first.threadId, runId: first.runId },
      );

      const firstKinds = await runInTenant(setup.tenant, () =>
        listSempTurnEvents(setup.runtime, first.runId, first.eventIds[0]!, first.eventIds.at(-1)!),
      );
      const secondKinds = await runInTenant(setup.tenant, () =>
        listSempTurnEvents(setup.runtime, second.runId, second.eventIds[0]!, null),
      );

      expect(firstKinds.map((event) => event.kind)).toEqual(["turn_start", "tool_use", "tool_result", "turn_end"]);
      expect(secondKinds.map((event) => event.kind)).toEqual(["turn_start", "message", "turn_end"]);
      expect(secondKinds.map((event) => event.id)).not.toContain(first.eventIds[0]);
    });
  });
});
