import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { runItemsCreatedAtBackfillCutoverMigration } from "../db/itemsCreatedAtBackfillCutoverMigration.js";
import { ValidationError } from "../errors.js";
import { parseViewConfig } from "../views/viewConfig.js";
import type { QueryViewResult } from "../views/viewQuery.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let adminPool: Pool;
let chokePoint: ChokePoint;

/** Follows `nextCursor` to the end, returning the item ids of every page in order. */
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

/** Creates `count` items through the production create path inside ONE transaction, so all share `now()`. */
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
    // Seven items share one creation timestamp (one transaction); paging through them at two per page
    // must still visit each exactly once, ordered by the title and id tie-breaks.
    const sameInstant = await createInOneTransaction(adminPool, databaseId, ["g", "e", "c", "a", "f", "d", "b"]);
    // Two consecutive transactions may start within one millisecond, the precision the sort compares at.
    // The batch is moved one minute into the past on the admin pool (no write path sets created_at) so
    // that "added later" is a fact of the data rather than of the clock; the seven still share one value.
    const shifted = await adminPool.query(
      "UPDATE items SET created_at = created_at - interval '1 minute' WHERE database_id = $1 AND id = ANY($2::uuid[])",
      [databaseId, sameInstant],
    );
    expect(shifted.rowCount).toBe(sameInstant.length);
    // Titled "z": a title order would put it last, so being first shows the creation order decided.
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
    // The edit is a later transaction, so its millisecond is never earlier than the others'; on a tie the
    // title "z" still sorts it last, so the expected order holds without depending on the clock.
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
    // Created in this order, so the column order is a, b, c; the property order is the reverse.
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
      // Pair A: the older instant has the later title. Pair B: equal titles, the older instant the larger id.
      // A millisecond comparison would order each pair by its title or id tie-break, the wrong way round.
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
      // The cursor carries the row's value at full precision.
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
    // The title tie-break is part of the cursor tuple.
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

  describe("created_at backfill cutover", () => {
    let dataPool: Pool;

    beforeAll(async () => {
      dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    });

    afterAll(async () => {
      await dataPool?.end();
    });

    const snapshotSchema = z.array(
      z.object({ id: z.string(), tenant_id: z.string(), created_at: z.string(), updated_at: z.string() }),
    );

    /** Every item row with its timestamps as full-precision text, so microseconds are compared too. */
    async function snapshot(): Promise<z.infer<typeof snapshotSchema>> {
      const { rows } = await adminPool.query<Record<string, unknown>>(
        "SELECT id::text, tenant_id::text, created_at::text, updated_at::text FROM items ORDER BY id",
      );
      return snapshotSchema.parse(rows);
    }

    /**
     * Gives the tenant's rows the state `0143_items_created_at.sql` left on an install: `created_at` later
     * than `updated_at`. The migration has already run for the test database, so its stored missing value
     * cannot be reproduced through any write; this raw update on the admin pool stands in for it.
     */
    async function ageRows(tenantId: string): Promise<void> {
      const result = await adminPool.query(
        "UPDATE items SET created_at = updated_at + interval '1 day 0.123456 second' WHERE tenant_id = $1",
        [tenantId],
      );
      expect(result.rowCount).toBeGreaterThan(0);
    }

    it("sets every old row's created_at to its updated_at across batches and tenants, leaves updated_at alone, and is idempotent", async () => {
      const zero = getTenantZeroId();
      const other = await createTestTenant(adminPool);
      const zeroDatabase = await makeDatabase("Old rows");
      // One more row than a backfill batch holds, so the cutover takes a second batch.
      await createInOneTransaction(
        adminPool,
        zeroDatabase,
        Array.from({ length: 501 }, (_, index) => `row ${index}`),
      );
      const trashed = await chokePoint.createItem({ databaseId: zeroDatabase, properties: { title: "trashed" } });
      await chokePoint.softDeleteItem(zeroDatabase, trashed.id);
      const otherChokePoint = createChokePoint(dataPool);
      await runInTenant(other, async () => {
        const db = await otherChokePoint.createDatabase({ name: "Other tenant" });
        await otherChokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "title" });
        await otherChokePoint.createItem({ databaseId: db.id, properties: { title: "theirs" } });
      });
      await ageRows(zero);
      await ageRows(other);
      const before = await snapshot();
      expect(before.every((row) => row.created_at > row.updated_at)).toBe(true);

      await runAsSystem("test created_at backfill", () => runTenantCutoverMigrations(dataPool));
      const after = await snapshot();
      expect(after.map(({ id, tenant_id, updated_at }) => ({ id, tenant_id, updated_at }))).toEqual(
        before.map(({ id, tenant_id, updated_at }) => ({ id, tenant_id, updated_at })),
      );
      expect(after.filter((row) => row.created_at !== row.updated_at)).toEqual([]);
      expect(after.filter((row) => row.tenant_id === other)).toHaveLength(1);

      await runInTenant(zero, () => runItemsCreatedAtBackfillCutoverMigration(dataPool));
      await runInTenant(other, () => runItemsCreatedAtBackfillCutoverMigration(dataPool));
      expect(await snapshot()).toEqual(after);
    });

    it("keeps the migration time for a pre-existing row written before its batch, backfills the others and is idempotent", async () => {
      const zero = getTenantZeroId();
      const databaseId = await makeDatabase("Window");
      const [untouched, written] = await createInOneTransaction(adminPool, databaseId, ["untouched", "written"]);
      // Raw SQL, labeled: the state 0143 left on an install, with fixed instants instead of the clock. Both
      // rows last changed on 2020-01-01; the ALTER (their created_at) ran on 2020-06-01.
      const aged = await adminPool.query(
        `UPDATE items SET updated_at = '2020-01-01T00:00:00Z', created_at = '2020-06-01T00:00:00Z'
          WHERE database_id = $1 AND id = ANY($2::uuid[])`,
        [databaseId, [untouched, written]],
      );
      expect(aged.rowCount).toBe(2);
      // A real write between the ALTER and the backfill moves the row's updated_at past its created_at.
      await chokePoint.updateItem({ databaseId, itemId: written!, propertiesPatch: { title: "written again" } });
      const fresh = await chokePoint.createItem({ databaseId, properties: { title: "fresh" } });
      const before = await snapshot();
      const row = (id: string, rows: typeof before) => rows.find((candidate) => candidate.id === id)!;
      expect(row(written!, before).updated_at > row(written!, before).created_at).toBe(true);

      await runInTenant(zero, () => runItemsCreatedAtBackfillCutoverMigration(dataPool));
      const after = await snapshot();
      // Not written in the window: created_at now equals its updated_at.
      expect(row(untouched!, after).created_at).toBe(row(untouched!, after).updated_at);
      // Written in the window: no longer matches the backfill and keeps the migration time.
      expect(row(written!, after)).toEqual(row(written!, before));
      expect(row(written!, after).created_at).not.toBe(row(written!, after).updated_at);
      // Created after the migration: untouched. No updated_at changed.
      expect(row(fresh.id, after)).toEqual(row(fresh.id, before));
      expect(after.map(({ id, updated_at }) => ({ id, updated_at }))).toEqual(
        before.map(({ id, updated_at }) => ({ id, updated_at })),
      );

      await runInTenant(zero, () => runItemsCreatedAtBackfillCutoverMigration(dataPool));
      expect(await snapshot()).toEqual(after);
    });

    it("leaves a row created after the migration untouched", async () => {
      const zero = getTenantZeroId();
      const databaseId = await makeDatabase("New rows");
      const item = await chokePoint.createItem({ databaseId, properties: { title: "new" } });
      await chokePoint.updateItem({ databaseId, itemId: item.id, propertiesPatch: { title: "newer" } });
      const before = await snapshot();
      const row = before.find((candidate) => candidate.id === item.id);
      expect(row && row.created_at < row.updated_at).toBe(true);
      await runInTenant(zero, () => runItemsCreatedAtBackfillCutoverMigration(dataPool));
      expect(await snapshot()).toEqual(before);
    });
  });
});
