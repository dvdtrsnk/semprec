import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { createAgentRun, finishAgentRun } from "../../agentRuns/agentRunsStore.js";
import { insertAgentRunEvent } from "../../agentRuns/agentRunEventsStore.js";
import { handleAgentRunEventsRetentionTask } from "../../agentRuns/agentRunEventsRetention.js";
import { createUser } from "../../auth/usersStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { buildSempReplySummary } from "../sempReplySummary.js";
import {
  assistantEvent,
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

async function tasksProjectPropertyId(): Promise<string> {
  const { rows } = await setup.admin.query<{ id: string }>(
    `SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id
      WHERE d.tenant_id = $1 AND d.owner_module_id = 'tasks' AND p.key = 'project' AND p.type = 'relation'`,
    [setup.tenant],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("The Tasks database has no project relation");
  return id;
}

describe("the items a Semp reply changed (issue #1885)", () => {
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

  it("stores one updated entry with the previous due date for a task the reply moved", async () => {
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
      turnEndEvent(20),
    ]);

    await finishPlayedTurn(setup, turn, "done");
    const stored = await readStoredReply(setup.admin, turn.messageId);

    expect(stored.changes).toEqual([
      {
        itemId: task.id,
        databaseId: task.databaseId,
        change: "updated",
        changedKeys: ["date"],
        before: { date: "2026-11-02" },
      },
    ]);
  });

  it("stores a created entry with the new item and database id for a task the reply created", async () => {
    const created = await createFixtureItem(setup, "tasks", { name: "Created by the reply" });
    const call = {
      toolCallId: "c-1",
      name: "item_create",
      operation: "item.create",
      targetDatabaseId: created.databaseId,
    };
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(1),
      toolUseEvent(
        { ...call, args: { databaseId: created.databaseId, properties: { name: "Created by the reply" } } },
        5,
      ),
      toolResultEvent(call, 9, {
        text: JSON.stringify({
          id: created.id,
          databaseId: created.databaseId,
          properties: { name: "Created by the reply" },
        }),
      }),
      turnEndEvent(12),
    ]);

    await finishPlayedTurn(setup, turn, "done");

    const { changes } = await readStoredReply(setup.admin, turn.messageId);
    expect(changes).toEqual([
      { itemId: created.id, databaseId: created.databaseId, change: "created", changedKeys: ["name"] },
    ]);
    expect(changes).not.toEqual([expect.objectContaining({ before: expect.anything() })]);
  });

  it("stores no entry for a delete waiting for approval", async () => {
    const task = await createFixtureItem(setup, "tasks", { name: "Delete me" });
    const del = { toolCallId: "d-1", name: "item_delete", operation: "item.delete", targetItemId: task.id };
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(1),
      toolUseEvent(del, 5),
      toolResultEvent(del, 9, {
        text: "Approval request pending",
        details: { error: false, approvalRequestId: "approval-1" },
      }),
      turnEndEvent(12),
    ]);

    await finishPlayedTurn(setup, turn, "done");

    expect((await readStoredReply(setup.admin, turn.messageId)).changes).toEqual([]);
  });

  it("stores an empty array, not NULL, for a reply that changed nothing", async () => {
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(1),
      assistantEvent("Nothing to do.", 5),
      turnEndEvent(9),
    ]);

    await finishPlayedTurn(setup, turn, "done");

    expect((await readStoredReply(setup.admin, turn.messageId)).changes).toEqual([]);
  });

  it("stores no before for an item in a sensitive database", async () => {
    const record = await createFixtureItem(setup, "healthRecords", { name: "PRIVATE-NAME" });
    const patch = { toolCallId: "h-1", name: "item_patch", operation: "item.patch", targetItemId: record.id };
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(1),
      toolUseEvent({ ...patch, args: { itemId: record.id, properties: { name: "PRIVATE-NEW" } } }, 5),
      // Stored the way the run log stores a content-bearing result of a sensitive database: redacted, keys only.
      toolResultEvent(patch, 9, {
        text: "[redacted: sensitive]",
        details: { error: false, changes: [{ key: "name" }] },
      }),
      // A result that was not redacted still has no before stored for a sensitive database.
      toolResultEvent({ ...patch, toolCallId: "h-2" }, 12, {
        details: { error: false, changes: [{ key: "type", before: "PRIVATE-BEFORE", after: "x" }] },
      }),
      turnEndEvent(20),
    ]);

    await finishPlayedTurn(setup, turn, "done");
    const { changes } = await readStoredReply(setup.admin, turn.messageId);

    expect(changes).toEqual([
      { itemId: record.id, databaseId: record.databaseId, change: "updated", changedKeys: ["name", "type"] },
    ]);
    expect(JSON.stringify(changes)).not.toMatch(/PRIVATE/u);
  });

  it("stores a link as an update of the calling item under the relation property's key", async () => {
    const task = await createFixtureItem(setup, "tasks", { name: "Linked task" });
    const other = await createFixtureItem(setup, "tasks", { name: "Other task" });
    const propertyId = await tasksProjectPropertyId();
    const put = { toolCallId: "l-1", name: "relation_put", operation: "relation.put" };
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(1),
      toolUseEvent(
        { ...put, args: { relationPropertyId: propertyId, callerItemId: task.id, targetItemId: other.id } },
        5,
      ),
      toolResultEvent(put, 9, { text: JSON.stringify({ id: randomUUID() }) }),
      turnEndEvent(12),
    ]);

    await finishPlayedTurn(setup, turn, "done");

    expect((await readStoredReply(setup.admin, turn.messageId)).changes).toEqual([
      { itemId: task.id, databaseId: task.databaseId, change: "updated", changedKeys: ["project"] },
    ]);
  });

  it("stores a create in a sensitive database as an entry with no keys and no values, through the id the tool kept", async () => {
    const record = await createFixtureItem(setup, "healthRecords", { name: "PRIVATE-NAME" });
    const call = {
      toolCallId: "sc-1",
      name: "item_create",
      operation: "item.create",
      targetDatabaseId: record.databaseId,
    };
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(1),
      // Stored the way the run log stores a content-bearing create in a sensitive database: arguments and result redacted.
      toolUseEvent({ ...call, args: "[redacted: sensitive]" }, 5),
      toolResultEvent(call, 9, {
        text: "[redacted: sensitive]",
        details: { error: false, createdItemId: record.id },
      }),
      turnEndEvent(12),
    ]);

    await finishPlayedTurn(setup, turn, "done");
    const { changes } = await readStoredReply(setup.admin, turn.messageId);

    expect(changes).toEqual([{ itemId: record.id, databaseId: record.databaseId, change: "created", changedKeys: [] }]);
    expect(JSON.stringify(changes)).not.toMatch(/PRIVATE/u);
  });

  it("still stores a link and a create once an earlier result of the turn made the run log redact their arguments", async () => {
    const task = await createFixtureItem(setup, "tasks", { name: "Linked after a sensitive read" });
    const other = await createFixtureItem(setup, "tasks", { name: "Other task" });
    const created = await createFixtureItem(setup, "tasks", { name: "Created after a sensitive read" });
    const put = { toolCallId: "r-1", name: "relation_put", operation: "relation.put", targetItemId: task.id };
    const create = {
      toolCallId: "r-2",
      name: "item_create",
      operation: "item.create",
      targetDatabaseId: created.databaseId,
    };
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(1),
      // The arguments of every call after a sensitive result are stored as the marker, whatever they were.
      toolUseEvent({ ...put, args: "[redacted: sensitive]" }, 5),
      toolResultEvent(put, 9, { text: JSON.stringify({ id: randomUUID(), itemA: task.id, itemB: other.id }) }),
      toolUseEvent({ ...create, args: "[redacted: sensitive]" }, 11),
      toolResultEvent(create, 15, {
        text: JSON.stringify({ id: created.id, databaseId: created.databaseId, properties: {} }),
        details: { error: false, createdItemId: created.id },
      }),
      turnEndEvent(20),
    ]);

    await finishPlayedTurn(setup, turn, "done");

    expect((await readStoredReply(setup.admin, turn.messageId)).changes).toEqual([
      { itemId: task.id, databaseId: task.databaseId, change: "updated", changedKeys: [] },
      { itemId: created.id, databaseId: created.databaseId, change: "created", changedKeys: [] },
    ]);
  });

  it("stores the changes up to the failure when the turn ends in an error", async () => {
    const task = await createFixtureItem(setup, "tasks", { name: "Changed before the failure", date: "2026-11-02" });
    const patch = { toolCallId: "e-1", name: "item_patch", operation: "item.patch", targetItemId: task.id };
    const cut = { toolCallId: "e-2", name: "item_patch", operation: "item.patch", targetItemId: task.id };
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(1),
      toolUseEvent(patch, 5),
      toolResultEvent(patch, 9, {
        text: JSON.stringify({ id: task.id, databaseId: task.databaseId }),
        details: { error: false, changes: [{ key: "date", before: "2026-11-02", after: "2026-11-09" }] },
      }),
      toolUseEvent(cut, 12),
    ]);

    await finishPlayedTurn(setup, turn, "error");
    const stored = await readStoredReply(setup.admin, turn.messageId);

    expect(stored.status).toBe("error");
    expect(stored.changes).toEqual([
      {
        itemId: task.id,
        databaseId: task.databaseId,
        change: "updated",
        changedKeys: ["date"],
        before: { date: "2026-11-02" },
      },
    ]);
  });

  it("keeps the stored changes after retention deleted the events they were made from", async () => {
    const task = await createFixtureItem(setup, "tasks", { name: "Retained", date: "2026-11-02" });
    const patch = { toolCallId: "k-1", name: "item_patch", operation: "item.patch", targetItemId: task.id };
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(1),
      toolUseEvent(patch, 5),
      toolResultEvent(patch, 9, {
        text: JSON.stringify({ id: task.id, databaseId: task.databaseId }),
        details: { error: false, changes: [{ key: "date", before: "2026-11-02", after: "2026-11-04" }] },
      }),
      turnEndEvent(12),
    ]);
    await finishPlayedTurn(setup, turn, "done");
    const before = await readStoredReply(setup.admin, turn.messageId);
    expect(before.changes).toHaveLength(1);

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

  describe("tenant isolation", () => {
    it("records no change for an item of another tenant, however the events name it", async () => {
      const task = await createFixtureItem(setup, "tasks", { name: "Tenant A task", date: "2026-11-02" });
      const patch = { toolCallId: "x-1", name: "item_patch", operation: "item.patch", targetItemId: task.id };
      const del = { toolCallId: "x-2", name: "item_delete", operation: "item.delete", targetItemId: task.id };
      const foreignRun = await runInTenant(foreignTenant, () =>
        createAgentRun(setup.runtime, { triggeredBy: "user", unit: "session", task: "foreign" }),
      );
      const ids = await runInTenant(foreignTenant, async () => {
        const stored: string[] = [];
        for (const spec of [
          turnStartEvent(0),
          toolUseEvent(patch, 1),
          toolResultEvent(patch, 2, {
            text: JSON.stringify({ id: task.id, databaseId: task.databaseId }),
            details: { error: false, changes: [{ key: "date", before: "2026-11-02", after: "x" }] },
          }),
          toolUseEvent(del, 3),
          // Redacted, so the only thing that names the item is the model-written argument.
          toolResultEvent(del, 4, { text: "[redacted: sensitive]" }),
        ]) {
          stored.push((await insertAgentRunEvent(setup.runtime, foreignRun.id, spec.kind, spec.payload)).id);
        }
        return stored;
      });

      const summary = await runInTenant(foreignTenant, () =>
        withTransaction(setup.runtime, (client) =>
          buildSempReplySummary(client, {
            messageId: randomUUID(),
            agentRunId: foreignRun.id,
            firstEventId: ids[0]!,
            lastEventId: ids.at(-1)!,
          }),
        ),
      );

      // The patch's result names tenant A's item and database; neither can be placed from tenant B.
      expect(summary.changes).toEqual([]);
      expect(summary.steps).toHaveLength(2);
    });
  });
});
