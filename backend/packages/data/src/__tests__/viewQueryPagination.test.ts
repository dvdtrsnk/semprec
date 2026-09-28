import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ValidationError } from "../errors.js";
import type { QueryViewResult } from "../views/viewQuery.js";

let pool: Pool;
let chokePoint: ChokePoint;

type Page = (cursor: string | undefined) => Promise<QueryViewResult>;

/** Follows `nextCursor` until it is `null`, returning every page's item ids in order. */
async function collectPages(page: Page): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const result = await page(cursor);
    pages += 1;
    ids.push(...result.items.map((item) => item.id));
    if (result.nextCursor === null) return { ids, pages };
    cursor = result.nextCursor;
    if (pages > 20) throw new Error("paging did not terminate");
  }
}

function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

describe("sorted view query pagination (issue #664)", () => {
  let databaseId: string;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);

    const db = await chokePoint.createDatabase({ name: "Tasks" });
    databaseId = db.id;
    await chokePoint.createProperty({ databaseId, key: "rank", name: "Rank", type: "number" });
    await chokePoint.createProperty({ databaseId, key: "due", name: "Due", type: "date" });
    await chokePoint.createProperty({ databaseId, key: "status", name: "Status", type: "select" });

    const seed: Record<string, Record<string, unknown>> = {
      a: { rank: 3, due: "2026-01-03T00:00:00Z", status: "open" },
      b: { rank: 1, status: "done" },
      c: { due: "2026-01-01T00:00:00Z", status: "open" },
      d: { rank: 3, due: "2026-01-02T00:00:00Z" },
      e: { rank: 2, due: "2026-01-03T00:00:00Z", status: "done" },
      f: { status: "open" },
      g: { rank: 1, due: "2026-01-05T00:00:00Z", status: "done" },
    };
    for (const [name, properties] of Object.entries(seed)) {
      ids[name] = (await chokePoint.createItem({ databaseId, properties })).id;
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** Ties inside a sort key resolve by item id, so an expected order lists tied rows id-sorted. */
  function byId(...names: string[]): string[] {
    return names.map((name) => ids[name]!).sort();
  }

  it.each([
    ["asc", () => [ids.b!, ids.g!].sort().concat(ids.e!, ...byId("a", "d"), ...byId("c", "f"))],
    ["desc", () => [...byId("a", "d"), ids.e!, ...byId("b", "g"), ...byId("c", "f")]],
  ] as const)(
    "pages a %s number sort with limit 3 through every row exactly once, nulls last",
    async (direction, expected) => {
      const sort = [{ property: "rank", direction }];
      const unpaged = await chokePoint.queryDatabaseItems(databaseId, { sort });
      expect(unpaged.items.map((item) => item.id)).toEqual(expected());
      expect(unpaged.nextCursor).toBeNull();

      const { ids: paged, pages } = await collectPages((cursor) =>
        chokePoint.queryDatabaseItems(databaseId, { sort, limit: 3, cursor }),
      );
      expect(paged).toEqual(expected());
      expect(new Set(paged).size).toBe(7);
      expect(pages).toBe(3);
    },
  );

  it.each(["asc", "desc"] as const)("pages a %s date sort with null dates last", async (direction) => {
    const sort = [{ property: "due", direction }];
    const unpaged = (await chokePoint.queryDatabaseItems(databaseId, { sort })).items.map((item) => item.id);
    expect(unpaged.slice(-2)).toEqual(byId("b", "f"));

    const { ids: paged } = await collectPages((cursor) =>
      chokePoint.queryDatabaseItems(databaseId, { sort, limit: 3, cursor }),
    );
    expect(paged).toEqual(unpaged);
  });

  it("pages a stored view's groupBy + date desc sort, through both the request route and the view's own page", async () => {
    const view = await chokePoint.createView({
      databaseId,
      type: "table",
      name: "By status",
      config: { groupBy: "status", sort: [{ property: "due", direction: "desc" }] },
    });
    const expected = [ids.g!, ids.e!, ids.b!, ids.a!, ids.c!, ids.f!, ids.d!];
    expect((await chokePoint.queryViewItems(view.id, {})).items.map((item) => item.id)).toEqual(expected);

    const viaRoute = await collectPages((cursor) => chokePoint.queryViewItems(view.id, { limit: 3, cursor }));
    expect(viaRoute.ids).toEqual(expected);
    const viaViewPage = await collectPages((cursor) => chokePoint.queryView(view.id, { limit: 3, cursor }));
    expect(viaViewPage.ids).toEqual(expected);
  });

  it("pages an uncast sort key whose rows hold non-string values through every row exactly once", async () => {
    await chokePoint.createItem({ databaseId, properties: { status: 42 } });
    await chokePoint.createItem({ databaseId, properties: { status: true } });
    const sort = [{ property: "status", direction: "asc" as const }];
    const unpaged = (await chokePoint.queryDatabaseItems(databaseId, { sort })).items.map((item) => item.id);
    expect(unpaged).toHaveLength(9);

    const { ids: paged } = await collectPages((cursor) =>
      chokePoint.queryDatabaseItems(databaseId, { sort, limit: 1, cursor }),
    );
    expect(paged).toEqual(unpaged);
  });

  it("rejects a malformed or foreign cursor on a sorted query as a ValidationError naming cursor", async () => {
    const sort = [{ property: "rank", direction: "asc" as const }];
    const tampered = [
      "not-a-cursor",
      ids.a!,
      encodeCursor(["not", "an", "object"]),
      encodeCursor({ v: [1, 2], id: ids.a }),
      encodeCursor({ v: [1], id: "not-a-uuid" }),
      encodeCursor({ v: "1", id: ids.a }),
      encodeCursor({ v: ["abc"], id: ids.a }),
    ];
    for (const cursor of tampered) {
      const error = await chokePoint.queryDatabaseItems(databaseId, { sort, cursor }).catch((err: unknown) => err);
      expect(error, cursor).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe("validation_failed");
      expect((error as ValidationError).details).toEqual({ field: "cursor" });
    }

    const dateSort = [{ property: "due", direction: "desc" as const }];
    await expect(
      chokePoint.queryDatabaseItems(databaseId, {
        sort: dateSort,
        cursor: encodeCursor({ v: ["not a date"], id: ids.a }),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("caps a limit of 500 to 200 and still returns a cursor when more rows match", async () => {
    for (let i = 0; i < 195; i += 1) {
      await chokePoint.createItem({ databaseId, properties: { rank: i } });
    }
    const sort = [{ property: "rank", direction: "asc" as const }];
    const first = await chokePoint.queryDatabaseItems(databaseId, { sort, limit: 500 });
    expect(first.items).toHaveLength(200);
    expect(first.nextCursor).not.toBeNull();

    const second = await chokePoint.queryDatabaseItems(databaseId, { sort, limit: 500, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(202);
  });

  it("keeps the last item id as the cursor for an unsorted query", async () => {
    const first = await chokePoint.queryDatabaseItems(databaseId, { limit: 3 });
    expect(first.nextCursor).toBe(first.items[2]!.id);

    const { ids: paged } = await collectPages((cursor) =>
      chokePoint.queryDatabaseItems(databaseId, { limit: 3, cursor }),
    );
    expect(paged).toEqual(Object.values(ids).sort());
  });
});
