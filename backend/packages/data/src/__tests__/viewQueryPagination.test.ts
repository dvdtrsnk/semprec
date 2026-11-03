import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { getTenantZeroId, getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ValidationError } from "../errors.js";
import type { QueryViewResult } from "../views/viewQuery.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";

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

afterAll(async () => {
  await pool?.end();
});

describe("Journal grouped view ordering", () => {
  it("orders the seeded period types in reverse with descending weeks across pages", async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await inTenantZero(() => seedSystem(pool));
    chokePoint = createChokePoint(pool);
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
      "journal",
    ]);
    const journal = rows[0];
    if (!journal) throw new Error("Journal database was not seeded");
    const inputs = [
      ["year", "2026-10-06"],
      ["quarter", "2026-10-06"],
      ["month", "2026-10-06"],
      ["week", "2026-10-06"],
      ["week", "2026-09-29"],
      ["day", "2026-10-06"],
    ] as const;
    const expected = new Map<string, string>();
    for (const [type, date] of inputs) {
      const item = await inTenantZero(() =>
        withTransaction(pool, (client) =>
          getOrCreateJournalItem(client, journal.id, type, new Date(`${date}T12:00:00Z`), "UTC"),
        ),
      );
      expected.set(`${type}:${String(item.properties.period)}`, item.id);
    }
    const view = await chokePoint.createView({
      databaseId: journal.id,
      type: "table",
      name: "Grouped periods",
      config: { groupBy: "type", groupDirection: "desc", sort: [{ property: "period", direction: "desc" }] },
    });
    const result = await collectPages((cursor) => chokePoint.queryView(view.id, { cursor, limit: 2 }));
    expect(result.ids).toEqual(
      ["day:2026-10-06", "week:2026-W41", "week:2026-W40", "month:2026-10", "quarter:2026-Q4", "year:2026"].map((key) =>
        expected.get(key),
      ),
    );
    expect(result.pages).toBe(3);
  });
});

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

describe("select option-order sort (issue #1408)", () => {
  let databaseId: string;
  const ids: Record<string, string> = {};
  const optionOrder = ["inProgress", "longTerm", "done", "archived"];

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);

    databaseId = (await chokePoint.createDatabase({ name: "Projects" })).id;
    await chokePoint.createProperty({
      databaseId,
      key: "status",
      name: "Status",
      type: "select",
      config: { options: optionOrder.map((key) => ({ key })) },
    });
    // Created out of option order so an alphabetical or insertion order cannot pass by accident.
    const seed: Record<string, Record<string, unknown>> = {
      archived: { status: "archived" },
      done: { status: "done" },
      none: {},
      longTerm: { status: "longTerm" },
      removed: { status: "removedOption" },
      inProgress: { status: "inProgress" },
      inProgress2: { status: "inProgress" },
    };
    for (const [name, properties] of Object.entries(seed)) {
      ids[name] = (await chokePoint.createItem({ databaseId, properties })).id;
    }
  });

  function byId(...names: string[]): string[] {
    return names.map((name) => ids[name]!).sort();
  }

  const ascending = () => [
    ...byId("inProgress", "inProgress2"),
    ids.longTerm!,
    ids.done!,
    ids.archived!,
    ...byId("none", "removed"),
  ];
  const descending = () => [
    ids.archived!,
    ids.done!,
    ids.longTerm!,
    ...byId("inProgress", "inProgress2"),
    ...byId("none", "removed"),
  ];

  it.each([
    ["asc", ascending],
    ["desc", descending],
  ] as const)("sorts %s in option order with empty and unknown values last", async (direction, expected) => {
    const result = await chokePoint.queryDatabaseItems(databaseId, { sort: [{ property: "status", direction }] });
    expect(result.items.map((item) => item.id)).toEqual(expected());
  });

  it.each([
    ["asc", ascending],
    ["desc", descending],
  ] as const)(
    "pages a %s select sort in three pages without missing or repeating a row",
    async (direction, expected) => {
      const sort = [{ property: "status", direction }];
      const { ids: paged, pages } = await collectPages((cursor) =>
        chokePoint.queryDatabaseItems(databaseId, { sort, limit: 3, cursor }),
      );
      expect(paged).toEqual(expected());
      expect(pages).toBe(3);
    },
  );

  it.each(["asc", "desc"] as const)(
    "continues a %s keyset after both an unknown and an empty select value",
    async (direction) => {
      ids.none2 = (await chokePoint.createItem({ databaseId, properties: {} })).id;
      ids.removed2 = (await chokePoint.createItem({ databaseId, properties: { status: "removedOption" } })).id;
      const sort = [{ property: "status", direction }];
      const { ids: paged, pages } = await collectPages((cursor) =>
        chokePoint.queryDatabaseItems(databaseId, { sort, limit: 1, cursor }),
      );
      const expected = [
        ...(direction === "asc" ? ascending() : descending()).slice(0, -2),
        ...byId("none", "none2", "removed", "removed2"),
      ];
      expect(paged).toEqual(expected);
      expect(pages).toBe(9);
      expect(paged.slice(-4)).toEqual(byId("none", "none2", "removed", "removed2"));
    },
  );

  it("orders the groups of a grouped view by option order, through every page", async () => {
    const view = await chokePoint.createView({
      databaseId,
      type: "table",
      name: "By status",
      config: { groupBy: "status" },
    });
    const { ids: paged } = await collectPages((cursor) => chokePoint.queryViewItems(view.id, { limit: 2, cursor }));
    expect(paged).toEqual(ascending());
  });

  it.each(["asc", "desc"] as const)(
    "pages %s numeric and boolean values that match valid keys among malformed options",
    async (direction) => {
      const db = await chokePoint.createDatabase({ name: "Legacy select" });
      await chokePoint.createProperty({
        databaseId: db.id,
        key: "value",
        name: "Value",
        type: "select",
        config: { options: [] },
      });
      const values = [true, 42, "done", "unknown", null];
      const created: string[] = [];
      for (const value of values) {
        const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
        created.push(item.id);
        await pool.query("UPDATE items SET properties = jsonb_build_object('value', $2::jsonb) WHERE id = $1", [
          item.id,
          JSON.stringify(value),
        ]);
      }
      await pool.query("UPDATE properties SET config = $2::jsonb WHERE database_id = $1 AND key = 'value'", [
        db.id,
        JSON.stringify({ options: [null, {}, { key: 7 }, { key: "true" }, { key: "42" }, { key: "done" }] }),
      ]);
      const expected = direction === "asc" ? created.slice(0, 3) : created.slice(0, 3).reverse();
      expected.push(...created.slice(3).sort());
      const { ids: actual, pages } = await collectPages((cursor) =>
        chokePoint.queryDatabaseItems(db.id, { sort: [{ property: "value", direction }], limit: 1, cursor }),
      );
      expect(actual).toEqual(expected);
      expect(pages).toBe(5);
    },
  );

  it.each(["missing", "non-array", "empty"] as const)(
    "pages missing positions for %s select options in both directions",
    async (kind) => {
      const config = kind === "missing" ? {} : { options: kind === "non-array" ? "invalid" : [] };
      await pool.query("UPDATE properties SET config = $2::jsonb WHERE database_id = $1 AND key = 'status'", [
        databaseId,
        JSON.stringify(config),
      ]);
      const expected = byId("inProgress", "inProgress2", "longTerm", "done", "archived", "none", "removed");
      for (const direction of ["asc", "desc"] as const) {
        const { ids: actual } = await collectPages((cursor) =>
          chokePoint.queryDatabaseItems(databaseId, { sort: [{ property: "status", direction }], limit: 1, cursor }),
        );
        expect(actual).toEqual(expected);
      }
    },
  );
  describe("groupDirection (issue #1532)", () => {
    const createGrouped = (groupDirection?: string) =>
      chokePoint.createView({
        databaseId,
        type: "table",
        name: "Grouped",
        config: { groupBy: "status", ...(groupDirection ? { groupDirection } : {}) },
      });

    it("reverses the group order with desc, items without a value stay last, paging yields each item once", async () => {
      const view = await createGrouped("desc");
      const all = await chokePoint.queryViewItems(view.id, {});
      expect(all.items.map((item) => item.id)).toEqual(descending());
      const { ids: paged } = await collectPages((cursor) => chokePoint.queryViewItems(view.id, { limit: 2, cursor }));
      expect(paged).toEqual(descending());
    });

    it("keeps option order when groupDirection is asc or absent", async () => {
      const view = await createGrouped();
      const explicit = await createGrouped("asc");
      for (const v of [view, explicit]) {
        const { ids: paged } = await collectPages((cursor) => chokePoint.queryViewItems(v.id, { limit: 3, cursor }));
        expect(paged).toEqual(ascending());
      }
    });

    it("refuses a cursor produced under a different group direction", async () => {
      const asc = await createGrouped();
      const desc = await createGrouped("desc");
      const ascCursor = (await chokePoint.queryViewItems(asc.id, { limit: 2 })).nextCursor!;
      const descCursor = (await chokePoint.queryViewItems(desc.id, { limit: 2 })).nextCursor!;
      await expect(chokePoint.queryViewItems(desc.id, { limit: 2, cursor: ascCursor })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(chokePoint.queryViewItems(asc.id, { limit: 2, cursor: descCursor })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("rejects an unknown groupDirection value", async () => {
      await expect(createGrouped("sideways")).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

describe("text sort collation and title tie-break (issue #1524)", () => {
  let databaseId: string;
  const titles = ["Hrad", "Chalupa", "Rybník", "Řeka", "Auto"];
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);
    databaseId = (await chokePoint.createDatabase({ name: "Places" })).id;
    await chokePoint.createProperty({ databaseId, key: "name", name: "Name", type: "title" });
    await chokePoint.createProperty({ databaseId, key: "kind", name: "Kind", type: "text" });
    for (const name of titles) {
      ids[name] = (await chokePoint.createItem({ databaseId, properties: { name, kind: "x" } })).id;
    }
  });

  const nameOf = (id: string) => titles.find((name) => ids[name] === id);

  it("orders Czech titles by the Czech alphabet for locale cs", async () => {
    const page = await chokePoint.queryDatabaseItems(databaseId, {
      sort: [{ property: "name", direction: "asc" }],
      locale: "cs",
    });
    expect(page.items.map((item) => item.properties.name)).toEqual(["Auto", "Hrad", "Chalupa", "Rybník", "Řeka"]);
  });

  it("uses the neutral collation for other locales and for no locale", async () => {
    for (const locale of ["en", undefined]) {
      const page = await chokePoint.queryDatabaseItems(databaseId, {
        sort: [{ property: "name", direction: "asc" }],
        locale,
      });
      expect(page.items.map((item) => item.properties.name)).toEqual(["Auto", "Chalupa", "Hrad", "Řeka", "Rybník"]);
    }
  });

  it("breaks ties on another key by title, then by id", async () => {
    const dupId = (await chokePoint.createItem({ databaseId, properties: { name: "Hrad", kind: "x" } })).id;
    const page = await chokePoint.queryDatabaseItems(databaseId, {
      sort: [{ property: "kind", direction: "asc" }],
      locale: "cs",
    });
    expect(page.items.map((item) => item.properties.name)).toEqual([
      "Auto",
      "Hrad",
      "Hrad",
      "Chalupa",
      "Rybník",
      "Řeka",
    ]);
    const hradIds = page.items.filter((item) => item.properties.name === "Hrad").map((item) => item.id);
    expect(hradIds).toEqual([ids.Hrad!, dupId].sort());
  });

  it("pages a Czech title sort through three pages without missing or repeating a row", async () => {
    const sort = [{ property: "name", direction: "asc" }];
    const { ids: paged, pages } = await collectPages((cursor) =>
      chokePoint.queryDatabaseItems(databaseId, { sort, limit: 2, cursor, locale: "cs" }),
    );
    expect(pages).toBe(3);
    expect(paged.map(nameOf)).toEqual(["Auto", "Hrad", "Chalupa", "Rybník", "Řeka"]);
  });

  it("pages a descending text-key sort with the title tie-break through every row once", async () => {
    const sort = [{ property: "kind", direction: "desc" }];
    const { ids: paged } = await collectPages((cursor) =>
      chokePoint.queryDatabaseItems(databaseId, { sort, limit: 2, cursor, locale: "cs" }),
    );
    expect(paged.map(nameOf)).toEqual(["Auto", "Hrad", "Chalupa", "Rybník", "Řeka"]);
  });

  it("uses the same Czech collation for URL ordering and its keyset cursor", async () => {
    await chokePoint.createProperty({ databaseId, key: "url", name: "URL", type: "url" });
    for (const name of titles) {
      const id = ids[name];
      if (!id) throw new Error(`Missing place ${name}`);
      await chokePoint.updateItem({ databaseId, itemId: id, propertiesPatch: { url: `https://example.test/${name}` } });
    }
    const sort = [{ property: "url", direction: "asc" }];
    const { ids: paged, pages } = await collectPages((cursor) =>
      chokePoint.queryDatabaseItems(databaseId, { sort, limit: 2, cursor, locale: "cs" }),
    );
    expect(pages).toBe(3);
    expect(paged.map(nameOf)).toEqual(["Auto", "Hrad", "Chalupa", "Rybník", "Řeka"]);
    const neutral = await chokePoint.queryDatabaseItems(databaseId, { sort, locale: "en" });
    expect(neutral.items.map((item) => item.properties.name)).toEqual(["Auto", "Chalupa", "Hrad", "Řeka", "Rybník"]);
  });

  it("reads the locale of a user", async () => {
    const user = await createUser(pool, {
      email: `locale-${randomUUID()}@example.test`,
      passwordHash: await hashPassword("s3cret-password"),
      locale: "en",
      tenantId: getTenantZeroId(),
    });
    expect(await chokePoint.findUserLocale(user.id)).toBe("en");
  });
});
