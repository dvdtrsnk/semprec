import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { withFromInbox } from "../chokePoint/itemOriginReads.js";
import { deleteItemOrigin, insertItemOrigins } from "../inbox/itemOriginsStore.js";

/** Issue #1716: the read-time `fromInbox` flag on item reads and queries. */
let pool: Pool;
let chokePoint: ChokePoint;

describe("fromInbox flag", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeFiles() {
    const db = await chokePoint.createDatabase({ name: "Files" });
    await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
    return db;
  }

  async function markOrigin(itemIds: string[], captureChannel: "inbox" | "transcript" = "inbox") {
    await withTransaction(pool, (client) =>
      insertItemOrigins(client, itemIds, {
        proposalId: randomUUID(),
        inboxItemId: null,
        sourceTranscriptId: null,
        capturedAt: captureChannel === "inbox" ? new Date().toISOString() : null,
        captureTimeBasis: captureChannel === "inbox" ? "inboxCapture" : "unknown",
        captureChannel,
      }),
    );
  }

  it("flags an Inbox-created item true and a hand-created one false in a query", async () => {
    const db = await makeFiles();
    const fromProposal = await chokePoint.createItem({ databaseId: db.id, properties: { title: "A" } });
    const byHand = await chokePoint.createItem({ databaseId: db.id, properties: { title: "B" } });
    await markOrigin([fromProposal.id]);

    const page = await chokePoint.queryDatabaseItems(db.id, {});
    const flags = Object.fromEntries(page.items.map((item) => [item.id, item.fromInbox]));
    expect(flags).toEqual({ [fromProposal.id]: true, [byHand.id]: false });
    expect(page.items.map((item) => item.id).sort()).toEqual([fromProposal.id, byHand.id].sort());
  });

  it("flags single-item reads and listItems", async () => {
    const db = await makeFiles();
    const fromProposal = await chokePoint.createItem({ databaseId: db.id, properties: { title: "A" } });
    const byHand = await chokePoint.createItem({ databaseId: db.id, properties: { title: "B" } });
    await markOrigin([fromProposal.id]);

    expect((await chokePoint.findItem(fromProposal.id))?.fromInbox).toBe(true);
    expect((await chokePoint.findItem(byHand.id))?.fromInbox).toBe(false);
    expect((await chokePoint.getItem(db.id, fromProposal.id))?.fromInbox).toBe(true);
    const listed = await chokePoint.listItems(db.id);
    expect(Object.fromEntries(listed.items.map((item) => [item.id, item.fromInbox]))).toEqual({
      [fromProposal.id]: true,
      [byHand.id]: false,
    });
  });

  it("is false for a transcript origin and once the origin row is removed", async () => {
    const db = await makeFiles();
    const fromTranscript = await chokePoint.createItem({ databaseId: db.id, properties: { title: "T" } });
    const removed = await chokePoint.createItem({ databaseId: db.id, properties: { title: "R" } });
    await markOrigin([fromTranscript.id], "transcript");
    await markOrigin([removed.id]);
    expect((await chokePoint.findItem(removed.id))?.fromInbox).toBe(true);

    await withTransaction(pool, (client) => deleteItemOrigin(client, removed.id));

    expect((await chokePoint.findItem(fromTranscript.id))?.fromInbox).toBe(false);
    expect((await chokePoint.findItem(removed.id))?.fromInbox).toBe(false);
  });

  it("resolves a page of 50 rows with one query, independent of the row count", async () => {
    const db = await makeFiles();
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      ids.push((await chokePoint.createItem({ databaseId: db.id, properties: { title: `F${i}` } })).id);
    }
    await markOrigin(ids.filter((_, i) => i % 2 === 0));

    async function countQueries(itemIds: string[]): Promise<number> {
      return withTransaction(pool, async (client) => {
        const spy = vi.spyOn(client, "query");
        try {
          const stamped = await withFromInbox(
            client,
            itemIds.map((id) => ({ id })),
          );
          expect(stamped).toHaveLength(itemIds.length);
          return spy.mock.calls.length;
        } finally {
          spy.mockRestore();
        }
      });
    }

    expect(await countQueries(ids.slice(0, 1))).toBe(1);
    expect(await countQueries(ids)).toBe(1);
    expect(await countQueries([])).toBe(0);

    async function countProductionOriginQueries(limit: number): Promise<number> {
      const spies: Array<{ mock: { calls: unknown[][] }; mockRestore(): void }> = [];
      const observe = (client: PoolClient) => {
        spies.push(vi.spyOn(client, "query"));
      };
      pool.on("acquire", observe);
      try {
        const page = await chokePoint.queryDatabaseItems(db.id, { limit });
        expect(page.items).toHaveLength(limit);
        return spies
          .flatMap((spy) => spy.mock.calls)
          .filter((args) => typeof args[0] === "string" && args[0].includes("FROM item_origins")).length;
      } finally {
        pool.off("acquire", observe);
        for (const spy of spies) spy.mockRestore();
      }
    }
    expect(await countProductionOriginQueries(1)).toBe(1);
    expect(await countProductionOriginQueries(50)).toBe(1);

    const page = await chokePoint.queryDatabaseItems(db.id, { limit: 50 });
    expect(page.items).toHaveLength(50);
    expect(page.items.filter((item) => item.fromInbox).length).toBe(25);
  });
});
