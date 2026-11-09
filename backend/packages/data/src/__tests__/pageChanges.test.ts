import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Pool, PoolClient } from "pg";
import { deleteBlocks, getBlocksMap, insertBlocks, moveBlocks, writeBlock } from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { loadDoc, mutateDoc } from "../docs/docPersistence.js";
import { rebaselineDocHistory } from "../docs/docHistory.js";
import { putBlockWithClient } from "../docs/docStore.js";
import { getOrCreateDoc } from "../docs/docsStore.js";
import { listPageChanges, PAGE_CHANGES_MAX_BYTES, PAGE_CHANGES_MAX_UPDATES } from "../docs/pageChanges.js";
import { HistoryNotRetainedError, NotFoundError, ValidationError } from "../errors.js";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import type { CreatedBy } from "../types.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
  cp = createChokePoint(pool);
});
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
});
afterAll(async () => {
  const results = await Promise.allSettled([pool?.end(), admin?.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
});

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenant, fn);
}

/** A page document of a fresh item, plus the database clock read after the document exists (the instant to list since). */
async function page(): Promise<{ docId: string; itemId: string; since: Date }> {
  return inTenant(async () => {
    const database = await cp.createDatabase({ name: `Pages ${Math.random()}` });
    const item = await cp.createItem({ databaseId: database.id, properties: {} });
    const doc = await withTransaction(pool, (client) => getOrCreateDoc(client, item.id, "page"));
    const { rows } = await pool.query<{ now: Date }>(`SELECT clock_timestamp() AS now`);
    // The listed updates must be stored strictly after `since`, whatever the timestamp resolution.
    await sleep(15);
    return { docId: doc.id, itemId: item.id, since: rows[0]!.now };
  });
}

async function write(docId: string, origin: CreatedBy, fn: (doc: Y.Doc) => void): Promise<void> {
  await inTenant(() => mutateDoc(pool, docId, origin, fn));
  await sleep(15);
}

function changes(docId: string, since: Date, by: CreatedBy, limit = 100) {
  return inTenant(() => listPageChanges(pool, docId, { since, by, limit }));
}

function editText(doc: Y.Doc, blockId: string, text: string): void {
  const title = getBlocksMap(doc).get(blockId)?.get("text");
  if (!(title instanceof Y.Text)) throw new Error(`Block ${blockId} has no text`);
  title.delete(0, title.length);
  title.insert(0, text);
}

describe("listPageChanges (issue #1680)", () => {
  it("lists an assistant's insertion, edit and deletion as insert, update and delete with the block ids", async () => {
    const { docId, since } = await page();
    await write(docId, "ai_agent", (doc) =>
      insertBlocks(doc, null, [
        { id: "a", type: "text", text: "First" },
        { id: "b", type: "text", text: "Second" },
      ]),
    );
    await write(docId, "ai_agent", (doc) => editText(doc, "a", "First, edited"));
    await write(docId, "ai_agent", (doc) => deleteBlocks(doc, ["b"]));

    const listed = await changes(docId, since, "ai_agent");

    expect(listed.map(({ kind, blockIds }) => ({ kind, blockIds }))).toEqual([
      { kind: "insert", blockIds: ["a", "b"] },
      { kind: "update", blockIds: ["a"] },
      { kind: "delete", blockIds: ["b"] },
    ]);
    const times = listed.map((change) => Date.parse(change.at));
    expect(times.every((time) => Number.isFinite(time) && time > since.getTime())).toBe(true);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });

  it("excludes a user's edits and a block a user-confirmed proposal stored with author user, and lists them under user", async () => {
    const { docId, itemId, since } = await page();
    await write(docId, "ai_agent", (doc) => insertBlocks(doc, null, [{ id: "mine", type: "text", text: "Semp" }]));
    await write(docId, "user", (doc) => insertBlocks(doc, "mine", [{ id: "typed", type: "text", text: "User" }]));
    // The confirm path writes the proposal's block with the confirming user's origin (the gh-1681 switch); this is its call.
    await inTenant(() =>
      withTransaction(pool, (client) =>
        putBlockWithClient(
          client,
          itemId,
          { id: "confirmed", flavour: "paragraph", fields: { content: "Proposed" } },
          "user",
        ),
      ),
    );
    await write(docId, "user", (doc) => editText(doc, "mine", "Semp, edited by the user"));

    const byAgent = await changes(docId, since, "ai_agent");
    expect(byAgent.map(({ kind, blockIds }) => ({ kind, blockIds }))).toEqual([{ kind: "insert", blockIds: ["mine"] }]);

    const byUser = await changes(docId, since, "user");
    expect(byUser.map(({ kind, blockIds }) => ({ kind, blockIds }))).toEqual([
      { kind: "insert", blockIds: ["typed"] },
      { kind: "insert", blockIds: ["confirmed"] },
      { kind: "update", blockIds: ["mine"] },
    ]);
    expect(await changes(docId, since, "system")).toEqual([]);
  });

  it("never merges updates, and reports one entry per kind for an update that does more than one", async () => {
    const { docId, since } = await page();
    await write(docId, "ai_agent", (doc) => insertBlocks(doc, null, [{ id: "a", type: "text", text: "A" }]));
    await write(docId, "ai_agent", (doc) => insertBlocks(doc, "a", [{ id: "b", type: "text", text: "B" }]));
    await write(docId, "ai_agent", (doc) => {
      insertBlocks(doc, "b", [{ id: "c", type: "text", text: "C" }]);
      editText(doc, "a", "A2");
      deleteBlocks(doc, ["b"]);
    });

    const listed = await changes(docId, since, "ai_agent");

    expect(listed.map(({ kind, blockIds }) => ({ kind, blockIds }))).toEqual([
      { kind: "insert", blockIds: ["a"] },
      { kind: "insert", blockIds: ["b"] },
      { kind: "insert", blockIds: ["c"] },
      { kind: "update", blockIds: ["a"] },
      { kind: "delete", blockIds: ["b"] },
    ]);
    expect(listed[2]?.at).toBe(listed[3]?.at);
    expect(listed[3]?.at).toBe(listed[4]?.at);
  });

  it("starts from the page as it stood at since, so earlier updates are not reported again", async () => {
    const { docId } = await page();
    await write(docId, "ai_agent", (doc) => insertBlocks(doc, null, [{ id: "a", type: "text", text: "Before" }]));
    const { rows } = await inTenant(() => pool.query<{ now: Date }>(`SELECT clock_timestamp() AS now`));
    const since = rows[0]!.now;
    await sleep(15);
    await write(docId, "ai_agent", (doc) => editText(doc, "a", "After"));

    expect((await changes(docId, since, "ai_agent")).map(({ kind, blockIds }) => ({ kind, blockIds }))).toEqual([
      { kind: "update", blockIds: ["a"] },
    ]);

    // A compaction rewrites the stored snapshot, not the history: the same list comes back.
    await inTenant(() => loadDoc(pool, docId, 1));
    expect((await changes(docId, since, "ai_agent")).map(({ kind, blockIds }) => ({ kind, blockIds }))).toEqual([
      { kind: "update", blockIds: ["a"] },
    ]);
  });

  it("returns at most limit entries, oldest first, and does not report a move", async () => {
    const { docId, since } = await page();
    await write(docId, "ai_agent", (doc) =>
      insertBlocks(doc, null, [
        { id: "a", type: "text", text: "A" },
        { id: "b", type: "text", text: "B" },
      ]),
    );
    await write(docId, "ai_agent", (doc) => moveBlocks(doc, ["b"], null));
    await write(docId, "ai_agent", (doc) => insertBlocks(doc, "a", [{ id: "c", type: "text", text: "C" }]));
    await write(docId, "ai_agent", (doc) => insertBlocks(doc, "c", [{ id: "d", type: "text", text: "D" }]));

    expect((await changes(docId, since, "ai_agent", 2)).map((change) => change.blockIds)).toEqual([["a", "b"], ["c"]]);
    // The move of `b` is not an entry, and the ids of the first insert keep the order they had when it was stored.
    expect((await changes(docId, since, "ai_agent")).map((change) => change.blockIds)).toEqual([
      ["a", "b"],
      ["c"],
      ["d"],
    ]);
  });

  it("refuses a since in the future, one before the retained history and an unknown document", async () => {
    const { docId, since } = await page();
    const future = new Date(Date.now() + 60_000);
    const error = (action: Promise<unknown>) =>
      action.then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(await error(changes(docId, future, "ai_agent"))).toBeInstanceOf(ValidationError);
    // Before the document existed there is no history to replay from.
    const beforeDoc = await error(changes(docId, new Date(since.getTime() - 3_600_000), "ai_agent"));
    expect(beforeDoc).toBeInstanceOf(HistoryNotRetainedError);
    expect(beforeDoc).toMatchObject({ status: 410, code: "history_not_retained" });
    expect(await error(changes("00000000-0000-4000-8000-000000000000", since, "ai_agent"))).toBeInstanceOf(
      NotFoundError,
    );
  });
});

/** One stored history row to insert: the update bytes, its stored author and its stored timestamp. */
interface HistoryRow {
  update: Uint8Array;
  by: CreatedBy;
  at: Date;
}

/**
 * Appends rows to a document's history as the superuser. The API cannot produce these shapes: rows whose `created_at`
 * order differs from their `update_id` order, rows older than a retention sweep's cutoff, or a payload of any size.
 * The statement is parameterized, and the rows get the document's own tenant and ids after the document's last one.
 */
async function insertHistory(docId: string, rows: HistoryRow[]): Promise<void> {
  await admin.query(
    `INSERT INTO doc_history_updates (update_id, doc_id, update, created_by, created_at, expires_at, tenant_id)
     SELECT COALESCE((SELECT max(update_id) FROM doc_history_updates WHERE doc_id = $1), 0) + r.ord, $1, r.update,
            r.by, r.at, r.at + interval '90 days', (SELECT tenant_id FROM docs WHERE id = $1)
     FROM unnest($2::bytea[], $3::text[], $4::timestamptz[]) WITH ORDINALITY AS r(update, by, at, ord)`,
    [docId, rows.map((row) => Buffer.from(row.update)), rows.map((row) => row.by), rows.map((row) => row.at)],
  );
}

/** The updates a scripted edit of a scratch document makes, in order: what a client would have sent. */
function scriptedUpdates(edit: (doc: Y.Doc, step: (fn: () => void) => void) => void): Uint8Array[] {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  edit(doc, (fn) => doc.transact(fn));
  doc.destroy();
  return updates;
}

describe("listPageChanges replay (issue #1680 repair)", () => {
  it("replays in update-id order, so an update written on top of a later-stored one is never held back", async () => {
    const { docId, since } = await page();
    const [inserted, deleted] = scriptedUpdates((doc, step) => {
      step(() => writeBlock(doc, { id: "b", type: "text", text: "kept?" }));
      step(() => deleteBlocks(doc, ["b"]));
    });
    if (!inserted || !deleted) throw new Error("Missing scripted updates");
    // The assistant's insert has the lower id but the later stored time; the user's deletion of that block has the
    // higher id and a stored time at `since` (the transaction that started earlier committed later).
    await insertHistory(docId, [
      { update: inserted, by: "ai_agent", at: new Date(since.getTime() + 60_000) },
      { update: deleted, by: "user", at: new Date(since.getTime() - 60_000) },
    ]);

    expect((await changes(docId, since, "ai_agent")).map(({ kind, blockIds }) => ({ kind, blockIds }))).toEqual([
      { kind: "insert", blockIds: ["b"] },
    ]);
    expect(await changes(docId, since, "user")).toEqual([]);
  });

  it("reads one snapshot: a retention sweep that commits between the checkpoint and the history cannot hide changes", async () => {
    const { docId } = await page();
    const day = 24 * 3_600_000;
    const [first, second] = scriptedUpdates((doc, step) => {
      step(() => writeBlock(doc, { id: "a", type: "text", text: "first" }));
      step(() => writeBlock(doc, { id: "b", type: "text", text: "second" }));
    });
    if (!first || !second) throw new Error("Missing scripted updates");
    const now = Date.now();
    await insertHistory(docId, [
      { update: first, by: "ai_agent", at: new Date(now - 9 * day) },
      { update: second, by: "ai_agent", at: new Date(now - 8 * day) },
    ]);
    // The document is older than the history: its baseline checkpoint and retained window start 40 days back.
    await admin.query(`UPDATE docs SET history_available_from = now() - interval '40 days' WHERE id = $1`, [docId]);
    await admin.query(`UPDATE doc_snapshot_history SET represented_at = now() - interval '40 days' WHERE doc_id = $1`, [
      docId,
    ]);
    const since = new Date(now - 10 * day);
    const expected = [
      { kind: "insert", blockIds: ["a"] },
      { kind: "insert", blockIds: ["b"] },
    ];

    // A dedicated pool whose clients run a 7-day retention sweep (folding both rows into a new baseline and deleting
    // them and the old checkpoint) right after the reader has read its checkpoint, on another connection.
    const reader = await createRuntimeRolePool(admin, "semprec_data");
    let swept = false;
    const connect = reader.connect.bind(reader) as unknown as () => Promise<PoolClient>;
    vi.spyOn(reader as unknown as { connect: () => Promise<PoolClient> }, "connect").mockImplementation(async () => {
      const client = await connect();
      const query = client.query.bind(client) as unknown as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
        const result = await query(...args);
        if (!swept && typeof args[0] === "string" && /FROM doc_snapshot_history/.test(args[0])) {
          swept = true;
          expect(await inTenant(() => rebaselineDocHistory(pool, docId, 7))).toBe(true);
        }
        return result;
      };
      return client;
    });
    try {
      const listed = await inTenant(() => listPageChanges(reader, docId, { since, by: "ai_agent", limit: 100 }));
      expect(swept).toBe(true);
      expect(listed.map(({ kind, blockIds }) => ({ kind, blockIds }))).toEqual(expected);
    } finally {
      vi.restoreAllMocks();
      await reader.end();
    }
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM doc_history_updates WHERE doc_id = $1`,
      [docId],
    );
    expect(rows[0]?.n).toBe(0);
  });

  describe("fixed replay budget", () => {
    /** Valid tiny updates that edit one text block, all stored at or before `since` (silently replayed). */
    function silentEdits(count: number, at: Date): HistoryRow[] {
      const updates = scriptedUpdates((doc, step) => {
        step(() => writeBlock(doc, { id: "a", type: "text", text: "" }));
        const text = getBlocksMap(doc).get("a")?.get("text");
        if (!(text instanceof Y.Text)) throw new Error("Missing text");
        for (let index = 1; index < count; index += 1) step(() => text.insert(0, "x"));
      });
      return updates.map((update) => ({ update, by: "user", at }));
    }

    it("refuses a window of more than the update budget with a safe 400 reason", async () => {
      const { docId, since } = await page();
      await insertHistory(docId, silentEdits(PAGE_CHANGES_MAX_UPDATES + 1, new Date(since.getTime() - 60_000)));

      const error = await changes(docId, since, "ai_agent").then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ details: { field: "since", reason: "history_window_too_large" } });
      // Exactly the budget is replayed: one update fewer is within it.
      await admin.query(`DELETE FROM doc_history_updates WHERE doc_id = $1 AND update_id = $2`, [
        docId,
        PAGE_CHANGES_MAX_UPDATES + 1,
      ]);
      expect(await changes(docId, since, "ai_agent")).toEqual([]);
    });

    it("stops replaying once the limit is filled, so a satisfied request never reads the rest", async () => {
      const { docId, since } = await page();
      const [agentInsert] = scriptedUpdates((doc, step) => {
        step(() => writeBlock(doc, { id: "z", type: "text", text: "now" }));
      });
      if (!agentInsert) throw new Error("Missing scripted update");
      const first: HistoryRow = { update: agentInsert, by: "ai_agent", at: new Date(since.getTime() + 60_000) };
      // The first stored update fills `limit = 1`; the rest would exceed the update budget if it were replayed.
      await insertHistory(docId, [first]);
      await admin.query(
        `INSERT INTO doc_history_updates (update_id, doc_id, update, created_by, created_at, expires_at, tenant_id)
         SELECT 1 + g, $1, '\x00'::bytea, 'user', now(), now() + interval '90 days', (SELECT tenant_id FROM docs WHERE id = $1)
         FROM generate_series(1, $2::int) AS g`,
        [docId, PAGE_CHANGES_MAX_UPDATES + 10],
      );

      expect(await changes(docId, since, "ai_agent", 1)).toEqual([
        { at: first.at.toISOString(), blockIds: ["z"], kind: "insert" },
      ]);
    });

    it("refuses an update larger than the byte budget before fetching it, and an oversized checkpoint before decoding it", async () => {
      const { docId, since } = await page();
      // Not a Yjs update: if the size were read after the fetch or decode, this would fail as a decode error instead.
      await admin.query(
        `INSERT INTO doc_history_updates (update_id, doc_id, update, created_by, created_at, expires_at, tenant_id)
         SELECT 1, $1, convert_to(repeat('a', $2::int), 'UTF8'), 'user', now() - interval '1 minute',
                now() + interval '90 days', (SELECT tenant_id FROM docs WHERE id = $1)`,
        [docId, PAGE_CHANGES_MAX_BYTES + 1],
      );
      const tooLarge = { details: { field: "since", reason: "history_window_too_large" } };
      await expect(changes(docId, since, "ai_agent")).rejects.toMatchObject(tooLarge);

      await admin.query(`DELETE FROM doc_history_updates WHERE doc_id = $1`, [docId]);
      await admin.query(
        `UPDATE doc_snapshot_history SET state = convert_to(repeat('a', $2::int), 'UTF8') WHERE doc_id = $1`,
        [docId, PAGE_CHANGES_MAX_BYTES + 1],
      );
      await expect(changes(docId, since, "ai_agent")).rejects.toMatchObject(tooLarge);
    });
  });
});
