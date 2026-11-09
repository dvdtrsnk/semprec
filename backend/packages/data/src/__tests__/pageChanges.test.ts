import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Pool } from "pg";
import { deleteBlocks, getBlocksMap, insertBlocks, moveBlocks } from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { loadDoc, mutateDoc } from "../docs/docPersistence.js";
import { putBlockWithClient } from "../docs/docStore.js";
import { getOrCreateDoc } from "../docs/docsStore.js";
import { listPageChanges } from "../docs/pageChanges.js";
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
