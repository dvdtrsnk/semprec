import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { sendSempMessage, listSempThreadMessages } from "../../sempThreads/sempThreadsStore.js";
import {
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

// Seeding the tenants' system databases takes a while.
const SEEDING_TEST_TIMEOUT_MS = 120_000;

let setup: TurnSetup;
let foreignTenant: string;
let cp: ReturnType<typeof createChokePoint>;

interface Fixture {
  id: string;
  databaseId: string;
}

interface Patch {
  item: Fixture;
  key: string;
  from: string;
  to: string;
}

/** The events of a reply that patched `patches`, one successful `item.patch` call each. */
function patchEvents(patches: readonly Patch[]): EventSpec[] {
  const calls = patches.flatMap(({ item, key, from, to }, index) => {
    const call = { toolCallId: `p-${index}`, name: "item_patch", operation: "item.patch", targetItemId: item.id };
    return [
      toolUseEvent({ ...call, args: { itemId: item.id, properties: { [key]: to }, ifVersion: "v" } }, 5 + index * 10),
      toolResultEvent(call, 9 + index * 10, {
        text: JSON.stringify({ id: item.id, databaseId: item.databaseId, properties: { [key]: to } }),
        details: { error: false, changes: [{ key, before: from, after: to }] },
      }),
    ];
  });
  return [userMessageEvent(), turnStartEvent(1), ...calls, turnEndEvent(20 + patches.length * 10)];
}

/**
 * Applies `patches` through the choke point, then plays and finishes the reply that made them, with the production
 * writers and the production projector: the item holds the value its stored change says the reply set.
 */
async function replyThatPatched(patches: readonly Patch[], threadId?: string): Promise<PlayedTurn> {
  for (const { item, key, to } of patches) {
    await runInTenant(setup.tenant, () =>
      cp.updateItem({ databaseId: item.databaseId, itemId: item.id, propertiesPatch: { [key]: to } }),
    );
  }
  const turn = await playTurn(setup, patchEvents(patches), threadId === undefined ? {} : { threadId });
  await finishPlayedTurn(setup, turn, "done");
  return turn;
}

function readHistory(threadId: string) {
  return runInTenant(setup.tenant, () =>
    withTransaction(setup.runtime, (client) => listSempThreadMessages(client, threadId, 100, null)),
  );
}

function task(name: string, date: string): Promise<Fixture> {
  return createFixtureItem(setup, "tasks", { name, date });
}

/** The row of a message that was stored by the turn, as the history returns it. */
async function historyRow(turn: PlayedTurn) {
  const row = (await readHistory(turn.threadId)).rows.find((candidate) => candidate.id === turn.messageId);
  if (!row) throw new Error("The reply is missing from the history");
  return row;
}

/** A column value no production writer stores: `changes` is written only by the turn's projector. */
async function forgeChanges(messageId: string, changes: unknown): Promise<void> {
  await setup.admin.query("UPDATE semp_messages SET changes = $2::jsonb WHERE id = $1", [
    messageId,
    JSON.stringify(changes),
  ]);
}

describe("changed-item cards in the Semp thread history (issue #1888)", () => {
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
    for (const tenantId of [tenant, foreignTenant]) {
      await createUser(admin, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
      await runInTenant(tenantId, () => seedSystem(runtime, createViewTypeRegistry()));
    }
    setup = { admin, runtime, tenant };
    cp = createChokePoint(runtime);
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await setup?.runtime.end();
    await setup?.admin.end();
  });

  it("shows the stored previous value in before and the current value in resolved.values for a task edited again later", async () => {
    const moved = await task("Write the report", "2026-11-02");
    const turn = await replyThatPatched([{ item: moved, key: "date", from: "2026-11-02", to: "2026-11-03" }]);

    // The reply's own edit is the current value until the item is edited again.
    expect((await historyRow(turn)).changes).toEqual([
      expect.objectContaining({
        before: { date: "2026-11-02" },
        resolved: expect.objectContaining({ values: { date: "2026-11-03" } }),
      }),
    ]);

    await runInTenant(setup.tenant, () =>
      cp.updateItem({ databaseId: moved.databaseId, itemId: moved.id, propertiesPatch: { date: "2026-11-09" } }),
    );

    expect((await historyRow(turn)).changes).toEqual([
      {
        itemId: moved.id,
        databaseId: moved.databaseId,
        change: "updated",
        changedKeys: ["date"],
        before: { date: "2026-11-02" },
        resolved: {
          label: "Write the report",
          databaseKey: "tasks",
          state: "active",
          values: { date: "2026-11-09" },
        },
      },
    ]);
  });

  it("gives a card the itemId and databaseId of its item in every state, with the state, the label and the values it resolves to", async () => {
    const live = await task("Stays live", "2026-11-02");
    const trashed = await task("Gets trashed", "2026-11-02");
    const purged = await task("Gets purged", "2026-11-02");
    const turn = await replyThatPatched(
      [live, trashed, purged].map((item) => ({ item, key: "date", from: "2026-11-02", to: "2026-11-04" })),
    );
    await runInTenant(setup.tenant, async () => {
      await cp.softDeleteItem(trashed.databaseId, trashed.id);
      await cp.softDeleteItem(purged.databaseId, purged.id);
      await cp.purgeExpiredTrashSubtree(purged.id, new Date("9999-01-01T00:00:00Z"));
    });

    const { changes } = await historyRow(turn);

    expect(changes?.map(({ itemId, databaseId, resolved }) => ({ itemId, databaseId, state: resolved.state }))).toEqual(
      [
        { itemId: live.id, databaseId: live.databaseId, state: "active" },
        { itemId: trashed.id, databaseId: trashed.databaseId, state: "trashed" },
        { itemId: purged.id, databaseId: purged.databaseId, state: "purged" },
      ],
    );
    expect(changes?.[0]?.resolved).toEqual({
      label: "Stays live",
      databaseKey: "tasks",
      state: "active",
      values: { date: "2026-11-04" },
    });
    // A trashed item keeps its content, so the card shows its label and current value.
    expect(changes?.[1]?.resolved).toEqual({
      label: "Gets trashed",
      databaseKey: "tasks",
      state: "trashed",
      values: { date: "2026-11-04" },
    });
    // A purged item has nothing left to resolve; the stored change stays as it was.
    expect(changes?.[2]?.resolved).toEqual({ label: null, databaseKey: null, state: "purged" });
    expect(changes?.[2]?.before).toEqual({ date: "2026-11-02" });
  });

  it("serves a history of 20 changed-item cards with the same number of queries as one card", async () => {
    const countQueries = (threadId: string) =>
      runInTenant(setup.tenant, () =>
        withTransaction(setup.runtime, async (client) => {
          const spy = vi.spyOn(client, "query");
          try {
            const page = await listSempThreadMessages(client, threadId, 100, null);
            return { page, queries: spy.mock.calls.length };
          } finally {
            spy.mockRestore();
          }
        }),
      );
    const first = await replyThatPatched([
      { item: await task("Single", "2026-11-02"), key: "date", from: "2026-11-02", to: "2026-11-03" },
    ]);
    let last = first;
    for (let index = 0; index < 19; index += 1) {
      const item = await task(`Card ${index}`, "2026-11-02");
      last = await replyThatPatched([{ item, key: "date", from: "2026-11-02", to: "2026-11-03" }], first.threadId);
    }

    // A second thread with a single card, read the same way.
    const single = await replyThatPatched([
      { item: await task("One card", "2026-11-02"), key: "date", from: "2026-11-02", to: "2026-11-03" },
    ]);
    const one = await countQueries(single.threadId);
    const twenty = await countQueries(last.threadId);

    expect(one.page.rows.flatMap((row) => row.changes ?? [])).toHaveLength(1);
    expect(twenty.page.rows.flatMap((row) => row.changes ?? [])).toHaveLength(20);
    expect(twenty.queries).toBe(one.queries);
  });

  it("has no change card for a delete that still waits for approval, and no changes key", async () => {
    const waiting = await task("Delete me", "2026-11-02");
    const del = { toolCallId: "d-1", name: "item_delete", operation: "item.delete", targetItemId: waiting.id };
    const turn = await playTurn(setup, [
      userMessageEvent(),
      turnStartEvent(1),
      toolUseEvent(del, 5),
      toolResultEvent(del, 9, {
        text: "Approval request pending",
        details: { error: false, approvalRequestId: randomUUID() },
      }),
      turnEndEvent(12),
    ]);
    await finishPlayedTurn(setup, turn, "done");

    expect(Object.hasOwn(await historyRow(turn), "changes")).toBe(false);
  });

  it("has no changes key on a user message, on a reply that changed nothing and on a reply that has not finished", async () => {
    const turn = await playTurn(setup, [userMessageEvent(), turnStartEvent(1), turnEndEvent(9)]);
    await finishPlayedTurn(setup, turn, "done");
    const unfinished = await runInTenant(setup.tenant, () =>
      withTransaction(setup.runtime, (client) =>
        sendSempMessage(client, { threadId: turn.threadId, text: "Next", context: [], hasContext: false }),
      ),
    );

    const { rows } = await readHistory(turn.threadId);

    expect(rows.map((row) => row.role).sort()).toEqual(["assistant", "assistant", "user", "user"]);
    expect(rows.find((row) => row.id === turn.messageId)).toBeDefined();
    expect(rows.find((row) => row.id === unfinished.assistantMessageId)?.status).toBe("queued");
    for (const row of rows) expect(Object.hasOwn(row, "changes")).toBe(false);
    const stored = await setup.admin.query<{ changes: unknown }>("SELECT changes FROM semp_messages WHERE id = $1", [
      turn.messageId,
    ]);
    // The finished reply stores an empty array and the queued one NULL; neither shows a key.
    expect(stored.rows).toEqual([{ changes: [] }]);
  });

  describe("sensitivity", () => {
    it("resolves an item in a sensitive database with label and state only, without values or before", async () => {
      const record = await createFixtureItem(setup, "healthRecords", { name: "Blood test", type: "PRIVATE-CURRENT" });
      const patch = { toolCallId: "h-1", name: "item_patch", operation: "item.patch", targetItemId: record.id };
      const turn = await playTurn(setup, [
        userMessageEvent(),
        turnStartEvent(1),
        toolUseEvent({ ...patch, args: { itemId: record.id, properties: { type: "PRIVATE-CURRENT" } } }, 5),
        // Stored the way the run log stores a result of a sensitive database: redacted, keys only.
        toolResultEvent(patch, 9, {
          text: "[redacted: sensitive]",
          details: { error: false, changes: [{ key: "type" }] },
        }),
        turnEndEvent(12),
      ]);
      await finishPlayedTurn(setup, turn, "done");
      // The projector keeps no before for a sensitive database; this one models a database that turned sensitive
      // after its entry was stored.
      await forgeChanges(turn.messageId, [
        {
          itemId: record.id,
          databaseId: record.databaseId,
          change: "updated",
          changedKeys: ["type"],
          before: { type: "PRIVATE-BEFORE" },
        },
      ]);

      const { changes } = await historyRow(turn);

      expect(changes).toEqual([
        {
          itemId: record.id,
          databaseId: record.databaseId,
          change: "updated",
          changedKeys: ["type"],
          resolved: { label: "Blood test", databaseKey: "healthRecords", state: "active" },
        },
      ]);
      expect(JSON.stringify(changes)).not.toMatch(/PRIVATE/u);
    });

    it("resolves a file that inherits sensitivity from a linked health record without values, and shows the values of an unlinked file", async () => {
      const linked = await createFixtureItem(setup, "files", { name: "Scan.pdf" });
      const unlinked = await createFixtureItem(setup, "files", { name: "Receipt.pdf" });
      const record = await createFixtureItem(setup, "healthRecords", { name: "Diagnosis" });
      const property = await setup.admin.query<{ id: string }>(
        `SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id
          WHERE d.id = $1 AND p.key = 'healthRecords' AND p.type = 'relation'`,
        [linked.databaseId],
      );
      const relationPropertyId = property.rows[0]?.id;
      if (!relationPropertyId) throw new Error("The Files database has no healthRecords relation");
      await runInTenant(setup.tenant, () =>
        cp.createRelation({ relationPropertyId, callerItemId: linked.id, targetItemId: record.id }),
      );
      const turn = await replyThatPatched([
        { item: linked, key: "name", from: "Scan.pdf", to: "Scan-renamed.pdf" },
        { item: unlinked, key: "name", from: "Receipt.pdf", to: "Receipt-renamed.pdf" },
      ]);

      const cards = (await historyRow(turn)).changes ?? [];

      expect(cards.find((card) => card.itemId === linked.id)).toEqual({
        itemId: linked.id,
        databaseId: linked.databaseId,
        change: "updated",
        changedKeys: ["name"],
        resolved: { label: "Scan-renamed.pdf", databaseKey: "files", state: "active" },
      });
      expect(cards.find((card) => card.itemId === unlinked.id)?.resolved.values).toEqual({
        name: "Receipt-renamed.pdf",
      });
    });
  });

  describe("tenant isolation and unreadable entries", () => {
    it("resolves an entry naming another tenant's item, an unknown item or the wrong database as purged, with no label and no values", async () => {
      const own = await task("Own task", "2026-11-02");
      const foreign = await runInTenant(foreignTenant, () =>
        withTransaction(setup.runtime, async (client) => {
          const database = await getDatabaseByModuleId(client, "tasks");
          if (!database) throw new Error("Missing foreign tasks database");
          const item = await createItemWithClient(
            client,
            { databaseId: database.id, properties: { name: "FOREIGN-SECRET", date: "2026-11-02" } },
            { writer: { writerKind: "system" } },
          );
          return { id: item.id, databaseId: database.id };
        }),
      );
      const healthRecord = await createFixtureItem(setup, "healthRecords", { name: "Other database" });
      const turn = await replyThatPatched([{ item: own, key: "date", from: "2026-11-02", to: "2026-11-03" }]);
      const entry = (itemId: string, databaseId: string) => ({
        itemId,
        databaseId,
        change: "updated",
        changedKeys: ["date"],
        before: { date: "2026-11-02" },
      });
      await forgeChanges(turn.messageId, [
        entry(own.id, own.databaseId),
        entry(foreign.id, foreign.databaseId),
        entry(randomUUID(), own.databaseId),
        // The item exists, but not in the database the entry names.
        entry(own.id, healthRecord.databaseId),
      ]);

      const { changes } = await historyRow(turn);

      expect(changes?.map((card) => card.resolved.state)).toEqual(["active", "purged", "purged", "purged"]);
      expect(changes?.[0]?.resolved.values).toEqual({ date: "2026-11-03" });
      for (const card of changes?.slice(1) ?? [])
        expect(card.resolved).toEqual({ label: null, databaseKey: null, state: "purged" });
      expect(changes?.[1]).toMatchObject({ itemId: foreign.id, databaseId: foreign.databaseId });
      expect(JSON.stringify(changes)).not.toMatch(/FOREIGN-SECRET/u);
    });
  });

  describe("stored values that are not entries", () => {
    it("leaves out an entry without the stored shape and gives no key for a value that is not an array", async () => {
      const kept = await task("Kept", "2026-11-02");
      const turn = await replyThatPatched([{ item: kept, key: "date", from: "2026-11-02", to: "2026-11-03" }]);
      const valid = {
        itemId: kept.id,
        databaseId: kept.databaseId,
        change: "updated",
        changedKeys: ["date"],
        before: { date: "2026-11-02" },
      };
      await forgeChanges(turn.messageId, [{ itemId: "not-a-uuid" }, "text", { ...valid, change: "renamed" }, valid]);

      expect((await historyRow(turn)).changes).toEqual([
        expect.objectContaining({ itemId: kept.id, resolved: expect.objectContaining({ state: "active" }) }),
      ]);

      await forgeChanges(turn.messageId, { not: "an array" });

      expect(Object.hasOwn(await historyRow(turn), "changes")).toBe(false);

      await forgeChanges(turn.messageId, [{ itemId: "not-a-uuid" }]);

      expect(Object.hasOwn(await historyRow(turn), "changes")).toBe(false);
    });
  });

  describe("the values of a card", () => {
    it("shows null for a key the item holds no value for and bounds a long value", async () => {
      const long = "x".repeat(5_000);
      const item = await task("Long value", "2026-11-02");
      const turn = await replyThatPatched([{ item, key: "description", from: "short", to: long }]);
      await forgeChanges(turn.messageId, [
        {
          itemId: item.id,
          databaseId: item.databaseId,
          change: "updated",
          changedKeys: ["description", "doneAt"],
        },
      ]);

      const values = (await historyRow(turn)).changes?.[0]?.resolved.values;

      expect(Object.keys(values ?? {})).toEqual(["description", "doneAt"]);
      expect(values?.doneAt).toBeNull();
      expect(typeof values?.description === "string" && values.description.length).toBeLessThan(long.length);
    });

    it("leaves a changed relation key out of the values, as a link is not a property value, and keeps the other keys", async () => {
      const file = await createFixtureItem(setup, "files", { name: "Scan.pdf" });
      const turn = await replyThatPatched([{ item: file, key: "name", from: "Scan.pdf", to: "Scan-renamed.pdf" }]);
      // A reply that also linked the file to a health record stores the relation property's key beside the others.
      await forgeChanges(turn.messageId, [
        {
          itemId: file.id,
          databaseId: file.databaseId,
          change: "updated",
          changedKeys: ["name", "healthRecords"],
        },
        { itemId: file.id, databaseId: file.databaseId, change: "updated", changedKeys: ["healthRecords"] },
      ]);

      const cards = (await historyRow(turn)).changes ?? [];

      expect(cards.map((card) => card.changedKeys)).toEqual([["name", "healthRecords"], ["healthRecords"]]);
      expect(cards[0]?.resolved.values).toEqual({ name: "Scan-renamed.pdf" });
      expect(cards[1]?.resolved.values).toEqual({});
    });
  });
});
