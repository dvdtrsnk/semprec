import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ValidationError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;
let databaseId: string;
let matching: string[];

const filter = { type: "in", property: "status", value: ["inProgress", "longTerm"] };

function isFieldError(err: unknown, field: string): boolean {
  return err instanceof ValidationError && (err.details as { field?: string } | undefined)?.field === field;
}

describe("query totalCount (includeCount)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);
    databaseId = (await chokePoint.createDatabase({ name: "Tasks" })).id;
    await chokePoint.createProperty({ databaseId, key: "status", name: "Status", type: "select" });
    matching = [];
    for (let i = 0; i < 13; i += 1) {
      const status = i % 2 === 0 ? "inProgress" : "longTerm";
      matching.push((await chokePoint.createItem({ databaseId, properties: { status } })).id);
    }
    for (const status of ["done", "done", "open"]) {
      await chokePoint.createItem({ databaseId, properties: { status } });
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("counts every match independent of limit and keeps the count on every page", async () => {
    const first = await chokePoint.queryDatabaseItems(databaseId, { filter, limit: 5, includeCount: true });
    expect(first.items).toHaveLength(5);
    expect(first.totalCount).toBe(13);

    const second = await chokePoint.queryDatabaseItems(databaseId, {
      filter,
      limit: 5,
      includeCount: true,
      cursor: first.nextCursor!,
    });
    const third = await chokePoint.queryDatabaseItems(databaseId, {
      filter,
      limit: 5,
      includeCount: true,
      cursor: second.nextCursor!,
    });
    expect(third.items).toHaveLength(3);
    expect([second.totalCount, third.totalCount]).toEqual([13, 13]);
  });

  it("ignores sort and counts the whole database without a filter", async () => {
    const sorted = await chokePoint.queryDatabaseItems(databaseId, {
      filter,
      sort: [{ property: "status", direction: "desc" }],
      limit: 2,
      includeCount: true,
    });
    expect(sorted.totalCount).toBe(13);
    expect((await chokePoint.queryDatabaseItems(databaseId, { includeCount: true })).totalCount).toBe(16);
  });

  it("omits totalCount when includeCount is absent or false", async () => {
    expect(await chokePoint.queryDatabaseItems(databaseId, { filter })).not.toHaveProperty("totalCount");
    expect(await chokePoint.queryDatabaseItems(databaseId, { filter, includeCount: false })).not.toHaveProperty(
      "totalCount",
    );
  });

  it("drops a soft-deleted match from the count, returns it after restore, and counts it with inTrash", async () => {
    await chokePoint.softDeleteItem(databaseId, matching[0]!);
    expect((await chokePoint.queryDatabaseItems(databaseId, { filter, includeCount: true })).totalCount).toBe(12);
    expect(
      (await chokePoint.queryDatabaseItems(databaseId, { filter, includeCount: true, inTrash: true })).totalCount,
    ).toBe(13);
    await chokePoint.restoreItem(databaseId, matching[0]!);
    expect((await chokePoint.queryDatabaseItems(databaseId, { filter, includeCount: true })).totalCount).toBe(13);
  });

  it("gives a view over the database the same count, using its stored filter or a request override", async () => {
    const view = await chokePoint.createView({ databaseId, type: "table", name: "Active", config: { filter } });
    expect((await chokePoint.queryViewItems(view.id, { includeCount: true, limit: 5 })).totalCount).toBe(13);
    const override = { type: "equals", property: "status", value: "done" };
    expect((await chokePoint.queryViewItems(view.id, { includeCount: true, filter: override })).totalCount).toBe(2);
    expect(await chokePoint.queryViewItems(view.id, {})).not.toHaveProperty("totalCount");
  });

  it("counts the live members of a curated view, and all members with inTrash", async () => {
    const view = await chokePoint.createView({ type: "list", name: "Picked", config: { membership: "manual" } });
    for (const itemId of matching.slice(0, 4)) {
      await chokePoint.addViewItem({ viewId: view.id, itemId, actor: { type: "user" } });
    }
    await chokePoint.softDeleteItem(databaseId, matching[0]!);
    const live = await chokePoint.queryViewItems(view.id, { includeCount: true, limit: 2 });
    expect(live.items).toHaveLength(2);
    expect(live.totalCount).toBe(3);
    expect((await chokePoint.queryViewItems(view.id, { includeCount: true, inTrash: true })).totalCount).toBe(4);
    expect(await chokePoint.queryViewItems(view.id, {})).not.toHaveProperty("totalCount");
  });

  it("rejects a non-boolean includeCount naming the field", async () => {
    const view = await chokePoint.createView({ databaseId, type: "table", name: "V" });
    await expect(chokePoint.queryDatabaseItems(databaseId, { includeCount: "yes" })).rejects.toSatisfy((err) =>
      isFieldError(err, "includeCount"),
    );
    await expect(chokePoint.queryViewItems(view.id, { includeCount: 1 })).rejects.toSatisfy((err) =>
      isFieldError(err, "includeCount"),
    );
  });
});
