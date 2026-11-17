import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { parseViewConfig } from "../views/viewConfig.js";
import type { QueryViewResult } from "../views/viewQuery.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";

let adminPool: Pool;
let chokePoint: ChokePoint;

async function collectPages(
  page: (cursor: string | undefined) => Promise<QueryViewResult>,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const result = await page(cursor);
    pages += 1;
    ids.push(...result.items.map((item) => item.id));
    if (result.nextCursor === null) return { ids, pages };
    cursor = result.nextCursor;
    if (pages > 50) throw new Error("paging did not terminate");
  }
}

function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

async function makeDatabase(name: string): Promise<string> {
  const db = await chokePoint.createDatabase({ name });
  await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "title" });
  return db.id;
}

async function createInOneTransaction(pool: Pool, databaseId: string, titles: string[]): Promise<string[]> {
  return withTransaction(pool, async (client) => {
    const ids: string[] = [];
    for (const title of titles) {
      ids.push((await createItemWithClient(client, { databaseId, properties: { title } })).id);
    }
    return ids;
  });
}

async function expectValidationError(promise: Promise<unknown>, field: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ValidationError);
  await expect(promise).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field } });
}

describe("items.created_at and system-timestamp sorting (issue #1594)", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    chokePoint = createChokePoint(adminPool);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await adminPool?.end();
  });

  it("sorts by system createdAt descending with the latest added item first and pages every item exactly once", async () => {
    const databaseId = await makeDatabase("Library");
    // Seven items share one creation timestamp; paging two at a time must visit each once, by title and id tie-breaks.
    const sameInstant = await createInOneTransaction(adminPool, databaseId, ["g", "e", "c", "a", "f", "d", "b"]);
    // Moved one minute back (no write path sets created_at) so "added later" is in the data, not the clock.
    const shifted = await adminPool.query(
      "UPDATE items SET created_at = created_at - interval '1 minute' WHERE database_id = $1 AND id = ANY($2::uuid[])",
      [databaseId, sameInstant],
    );
    expect(shifted.rowCount).toBe(sameInstant.length);
    const latest = await chokePoint.createItem({ databaseId, properties: { title: "z" } });
    const sort = [{ system: "createdAt", direction: "desc" }];

    const { ids, pages } = await collectPages((cursor) =>
      chokePoint.queryDatabaseItems(databaseId, { sort, limit: 2, cursor }),
    );
    expect(pages).toBe(4);
    expect(ids[0]).toBe(latest.id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids)).toEqual(new Set([latest.id, ...sameInstant]));

    const rows = await adminPool.query<{ id: string; title: string; same: boolean }>(
      `SELECT id, properties->>'title' AS title, created_at = (SELECT created_at FROM items WHERE id = $2) AS same
         FROM items WHERE database_id = $1`,
      [databaseId, sameInstant[0]],
    );
    expect(
      rows.rows
        .filter((row) => row.same)
        .map((row) => row.id)
        .sort(),
    ).toEqual([...sameInstant].sort());
    const titleById = new Map(rows.rows.map((row) => [row.id, row.title]));
    expect(ids.map((id) => titleById.get(id))).toEqual(["z", "a", "b", "c", "d", "e", "f", "g"]);
  });

  it("orders ascending by system updatedAt, resuming from the cursor after an edit moves an item last", async () => {
    const databaseId = await makeDatabase("Notes");
    const first = await chokePoint.createItem({ databaseId, properties: { title: "a" } });
    const second = await chokePoint.createItem({ databaseId, properties: { title: "b" } });
    const third = await chokePoint.createItem({ databaseId, properties: { title: "c" } });
    // The edit's millisecond is never earlier; on a tie the title "z" still sorts it last.
    await chokePoint.updateItem({ databaseId, itemId: first.id, propertiesPatch: { title: "z" } });
    const sort = [{ system: "updatedAt", direction: "asc" }];
    const { ids, pages } = await collectPages((cursor) =>
      chokePoint.queryDatabaseItems(databaseId, { sort, limit: 1, cursor }),
    );
    expect(pages).toBe(3);
    expect(ids).toEqual([second.id, third.id, first.id]);
  });

  it("keeps a collection's own createdAt property and the system createdAt column apart", async () => {
    const databaseId = await makeDatabase("Imports");
    await chokePoint.createProperty({ databaseId, key: "createdAt", name: "Created at", type: "number" });
    const a = await chokePoint.createItem({ databaseId, properties: { title: "a", createdAt: 3 } });
    const b = await chokePoint.createItem({ databaseId, properties: { title: "b", createdAt: 2 } });
    const c = await chokePoint.createItem({ databaseId, properties: { title: "c", createdAt: 1 } });

    const byProperty = await chokePoint.queryDatabaseItems(databaseId, {
      sort: [{ property: "createdAt", direction: "asc" }],
    });
    expect(byProperty.items.map((item) => item.id)).toEqual([c.id, b.id, a.id]);

    const bySystem = await chokePoint.queryDatabaseItems(databaseId, {
      sort: [{ system: "createdAt", direction: "asc" }],
    });
    expect(bySystem.items.map((item) => item.id)).toEqual([a.id, b.id, c.id]);
    expect(bySystem.items.map((item) => item.properties.createdAt)).toEqual([3, 2, 1]);
  });

  it.each([
    ["both property and system", [{ property: "title", system: "createdAt", direction: "asc" }]],
    ["an unknown system field", [{ system: "deletedAt", direction: "asc" }]],
    ["a system field without a direction", [{ system: "createdAt" }]],
  ])("rejects a sort spec naming %s with 400", async (_label, sort) => {
    const databaseId = await makeDatabase("Rejected");
    await expectValidationError(chokePoint.queryDatabaseItems(databaseId, { sort }), "sort");
    expect(() => parseViewConfig({ sort })).toThrow(ValidationError);
  });

  /** Raw SQL: two writes within one millisecond cannot be produced on demand, so the instants are relabelled. */
  const RELABEL = {
    createdAt: "UPDATE items SET created_at = $2::timestamptz WHERE id = $1",
    updatedAt: "UPDATE items SET updated_at = $2::timestamptz WHERE id = $1",
  } as const;

  it.each(["createdAt", "updatedAt"] as const)(
    "orders %s at full precision within one millisecond, across pages of one item, in both directions",
    async (field) => {
      const databaseId = await makeDatabase(`Precision ${field}`);
      // Pair A: older instant, later title. Pair B: equal titles, older instant, larger id. A millisecond comparison
      // would order each pair the wrong way round.
      const [aOld, aNew] = [
        await chokePoint.createItem({ databaseId, properties: { title: "z" } }),
        await chokePoint.createItem({ databaseId, properties: { title: "a" } }),
      ];
      const [first, second] = [
        await chokePoint.createItem({ databaseId, properties: { title: "same" } }),
        await chokePoint.createItem({ databaseId, properties: { title: "same" } }),
      ];
      const [bOld, bNew] = first.id > second.id ? [first, second] : [second, first];
      const instants: Array<[string, string]> = [
        [aOld.id, "2026-11-07T10:00:00.123100Z"],
        [aNew.id, "2026-11-07T10:00:00.123900Z"],
        [bOld.id, "2026-11-07T10:00:00.124100Z"],
        [bNew.id, "2026-11-07T10:00:00.124900Z"],
      ];
      for (const [id, instant] of instants) {
        expect((await adminPool.query(RELABEL[field], [id, instant])).rowCount).toBe(1);
      }
      const ascending = [aOld.id, aNew.id, bOld.id, bNew.id];

      for (const direction of ["asc", "desc"] as const) {
        const sort = [{ system: field, direction }];
        const { ids, pages } = await collectPages((cursor) =>
          chokePoint.queryDatabaseItems(databaseId, { sort, limit: 1, cursor }),
        );
        expect(ids, direction).toEqual(direction === "asc" ? ascending : [...ascending].reverse());
        expect(pages, direction).toBe(4);
      }
      const page = await chokePoint.queryDatabaseItems(databaseId, {
        sort: [{ system: field, direction: "asc" }],
        limit: 1,
      });
      const cursor = z
        .object({ v: z.array(z.unknown()), id: z.string() })
        .parse(JSON.parse(Buffer.from(page.nextCursor ?? "", "base64url").toString("utf8")));
      expect(cursor).toEqual({ v: ["2026-11-07T10:00:00.123100Z", "z"], id: aOld.id });
    },
  );

  it.each([
    ["a non-ISO string", "yesterday"],
    ["an ISO string without milliseconds", "2026-10-16T08:00:00Z"],
    ["an impossible date", "2026-02-30T08:00:00.000Z"],
    ["a millisecond value, the item envelope's precision", "2026-10-16T08:00:00.123Z"],
    ["an impossible date at microsecond precision", "2026-02-30T08:00:00.000000Z"],
    ["seven fractional digits", "2026-10-16T08:00:00.1234567Z"],
    ["a number", 1760601600000],
    ["null", null],
  ])("rejects a system-key cursor holding %s with 400", async (_label, value) => {
    const databaseId = await makeDatabase("Cursors");
    const item = await chokePoint.createItem({ databaseId, properties: { title: "a" } });
    const sort = [{ system: "createdAt", direction: "desc" }];
    const cursor = encodeCursor({ v: [value, "a"], id: item.id });
    await expectValidationError(chokePoint.queryDatabaseItems(databaseId, { sort, cursor }), "cursor");
  });

  it("returns createdAt on reads and writes, set by the database and unchanged by later updates", async () => {
    const databaseId = await makeDatabase("Envelope");
    const created = await chokePoint.createItem({ databaseId, properties: { title: "a" } });
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(created.createdAt).toBe(created.updatedAt);
    const read = await chokePoint.getItem(databaseId, created.id);
    expect(read?.createdAt).toBe(created.createdAt);

    const updated = await chokePoint.updateItem({ databaseId, itemId: created.id, propertiesPatch: { title: "b" } });
    expect(updated.createdAt).toBe(created.createdAt);
    const page = await chokePoint.queryDatabaseItems(databaseId, {});
    expect(page.items.map((item) => item.createdAt)).toEqual([created.createdAt]);
    const { rows } = await adminPool.query<{ created_at: string; updated_at: string }>(
      `SELECT created_at::text, updated_at::text FROM items WHERE database_id = $1 AND id = $2`,
      [databaseId, created.id],
    );
    expect(rows[0]?.created_at).not.toBe(rows[0]?.updated_at);
  });
});
