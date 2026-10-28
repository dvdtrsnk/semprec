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
    await chokePoint.createProperty({
      databaseId,
      key: "status",
      name: "Status",
      type: "select",
      config: { options: [{ key: "done" }, { key: "open" }] },
    });

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

  it("pages a select sort whose rows hold non-string values through every row exactly once", async () => {
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

  it.each([{}, { options: [] }])("pages a select without declared options using id order (%j)", async (config) => {
    const projects = await chokePoint.createDatabase({ name: "Projects" });
    await chokePoint.createProperty({
      databaseId: projects.id,
      key: "status",
      name: "Status",
      type: "select",
      config,
    });
    const itemIds: string[] = [];
    for (const properties of [{ status: "open" }, { status: "done" }, {}]) {
      itemIds.push((await chokePoint.createItem({ databaseId: projects.id, properties })).id);
    }
    for (const direction of ["asc", "desc"]) {
      const paged = await collectPages((cursor) =>
        chokePoint.queryDatabaseItems(projects.id, {
          sort: [{ property: "status", direction }],
          limit: 1,
          cursor,
        }),
      );
      expect(paged.ids).toEqual([...itemIds].sort());
      expect(paged.pages).toBe(3);
    }
  });

  describe("select option order (gh-1408)", () => {
    const optionKeys = ["inProgress", "longTerm", "done", "archived"];
    let projectsId: string;
    let optionIds: string[];
    let nullPositions: { id: string; value: unknown }[];

    beforeEach(async () => {
      projectsId = (await chokePoint.createDatabase({ name: "Projects" })).id;
      await chokePoint.createProperty({
        databaseId: projectsId,
        key: "status",
        name: "Status",
        type: "select",
        config: { options: optionKeys.map((key) => ({ key })) },
      });
      const byKey = new Map<string, string>();
      for (const status of [...optionKeys].sort()) {
        byKey.set(status, (await chokePoint.createItem({ databaseId: projectsId, properties: { status } })).id);
      }
      optionIds = optionKeys.map((key) => byKey.get(key)!);
      nullPositions = [];
      for (const value of [undefined, null, "", "removed", "obsolete"]) {
        const properties = value === undefined ? {} : { status: value };
        const item = await chokePoint.createItem({ databaseId: projectsId, properties });
        nullPositions.push({ id: item.id, value: value ?? null });
      }
      nullPositions.sort((a, b) => a.id.localeCompare(b.id));
    });

    it.each(["asc", "desc"] as const)(
      "sorts projects %s by declared options, with missing, empty and unknown values last across three pages",
      async (direction) => {
        const sort = [{ property: "status", direction }];
        const expected = [
          ...(direction === "asc" ? optionIds : [...optionIds].reverse()),
          ...nullPositions.map((item) => item.id),
        ];
        const unpaged = await chokePoint.queryDatabaseItems(projectsId, { sort });
        expect(unpaged.items.map((item) => item.id)).toEqual(expected);
        expect(unpaged.nextCursor).toBeNull();
        const paged = await collectPages((cursor) =>
          chokePoint.queryDatabaseItems(projectsId, { sort, limit: 3, cursor }),
        );
        expect(paged.ids).toEqual(expected);
        expect(new Set(paged.ids).size).toBe(9);
        expect(paged.pages).toBe(3);
        // Exercise every null-position cursor regardless of random UUID page boundaries.
        for (const [index, item] of nullPositions.entries()) {
          const remaining = await chokePoint.queryDatabaseItems(projectsId, {
            sort,
            cursor: encodeCursor({ v: [item.value], id: item.id }),
          });
          expect(remaining.items.map((row) => row.id)).toEqual(nullPositions.slice(index + 1).map((row) => row.id));
          expect(remaining.nextCursor).toBeNull();
        }
      },
    );

    it("orders select groups by declared options through both stored-view query entry points", async () => {
      const view = await chokePoint.createView({
        databaseId: projectsId,
        type: "table",
        name: "Projects by status",
        config: { groupBy: "status" },
      });
      const expected = [...optionIds, ...nullPositions.map((item) => item.id)];
      expect((await chokePoint.queryView(view.id)).items.map((item) => item.id)).toEqual(expected);
      for (const page of [
        (cursor: string | undefined) => chokePoint.queryView(view.id, { limit: 3, cursor }),
        (cursor: string | undefined) => chokePoint.queryViewItems(view.id, { limit: 3, cursor }),
      ]) {
        const paged = await collectPages(page);
        expect(paged.ids).toEqual(expected);
        expect(paged.pages).toBe(3);
      }
    });

    it.each([
      { shape: "null", entry: null },
      { shape: "number", entry: 42 },
      { shape: "string", entry: "legacy" },
      { shape: "boolean", entry: true },
      { shape: "array", entry: [] },
      { shape: "missing key", entry: {} },
      { shape: "numeric key", entry: { key: 42 } },
      { shape: "null key", entry: { key: null } },
    ])("ignores a malformed $shape option while sorting and continuing select cursors", async ({ entry }) => {
      const numericValue = await chokePoint.createItem({ databaseId: projectsId, properties: { status: 42 } });
      const unknownIds = [...nullPositions.map((item) => item.id), numericValue.id].sort();
      const options: unknown[] = optionKeys.flatMap((key) => [entry, { key }]);
      // Normal property writes reject malformed options; raw SQL reproduces legacy stored configuration.
      const patched = await pool.query<{ id: string }>(
        "UPDATE properties SET config = $1::jsonb WHERE database_id = $2 AND key = $3 RETURNING id",
        [JSON.stringify({ options }), projectsId, "status"],
      );
      expect(patched.rowCount).toBe(1);

      for (const direction of ["asc", "desc"] as const) {
        const sort = [{ property: "status", direction }];
        const expected = [...(direction === "asc" ? optionIds : [...optionIds].reverse()), ...unknownIds];
        expect((await chokePoint.queryDatabaseItems(projectsId, { sort })).items.map((item) => item.id)).toEqual(
          expected,
        );
        // One-row pages exercise both option and null-position cursor continuation.
        const paged = await collectPages((cursor) =>
          chokePoint.queryDatabaseItems(projectsId, { sort, limit: 1, cursor }),
        );
        expect(paged.ids).toEqual(expected);
        expect(new Set(paged.ids).size).toBe(10);
        expect(paged.pages).toBe(10);
      }
    });
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
