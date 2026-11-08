import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bindToTenantZero, getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import type { PropertyRow } from "../types.js";

let pool: Pool;
let cp: ChokePoint;
let databases: Record<string, string>;
let fileProjects: PropertyRow;

async function item(database: string) {
  const id = databases[database];
  if (!id) throw new Error(`Missing database ${database}`);
  return cp.createItem({ databaseId: id, properties: {} });
}

async function fileIds(type: string, property = "projects"): Promise<string[]> {
  const result = await cp.queryDatabaseItems(databases.files!, { filter: { type, property } });
  return result.items.map((row) => row.id).sort();
}

describe("relation_is_empty / relation_is_not_empty production queries", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await inTenantZero(() => seedSystem(pool));
    cp = bindToTenantZero(createChokePoint(pool));
    const rows = await pool.query<{ id: string; key: string }>("SELECT id, key FROM databases");
    databases = Object.fromEntries(rows.rows.map((row) => [row.key, row.id]));
    const found = (await cp.listProperties(databases.files!)).find((entry) => entry.key === "projects");
    if (!found) throw new Error("Missing files.projects");
    fileProjects = found;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("treats no project and only soft-deleted projects as empty, and a live project as not empty", async () => {
    const live = await item("projects");
    const other = await item("projects");
    const deleted = await item("projects");
    const none = await item("files");
    const withLive = await item("files");
    const onlyDeleted = await item("files");
    const mixed = await item("files");
    const deletedFile = await item("files");
    const link = (file: string, project: string) =>
      cp.createRelation({ relationPropertyId: fileProjects.id, callerItemId: file, targetItemId: project });
    await link(withLive.id, live.id);
    await link(onlyDeleted.id, deleted.id);
    await link(mixed.id, deleted.id);
    await link(mixed.id, other.id);
    await cp.softDeleteItem(databases.projects!, deleted.id);
    await cp.softDeleteItem(databases.files!, deletedFile.id);

    expect(await fileIds("relation_is_empty")).toEqual([none.id, onlyDeleted.id].sort());
    expect(await fileIds("relation_is_not_empty")).toEqual([withLive.id, mixed.id].sort());
  });

  it("works from the other relation side and inside not", async () => {
    const project = await item("projects");
    await item("projects");
    const file = await item("files");
    await cp.createRelation({ relationPropertyId: fileProjects.id, callerItemId: file.id, targetItemId: project.id });
    const result = await cp.queryDatabaseItems(databases.projects!, {
      filter: { type: "not", node: { type: "relation_is_empty", property: "files" } },
    });
    expect(result.items.map((row) => row.id)).toEqual([project.id]);
  });

  it.each(["relation_is_empty", "relation_is_not_empty"])(
    "rejects %s on a non-relation property with a ValidationError",
    async (type) => {
      await expect(fileIds(type, "name")).rejects.toMatchObject({ status: 400, details: { field: "name" } });
    },
  );

  it("still rejects is_empty on a relation and points to the relation conditions", async () => {
    await expect(fileIds("is_empty")).rejects.toThrow(/relation_is_empty/);
  });
});
