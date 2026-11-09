import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";

let pool: Pool;

describe("Markdown property writes", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("stores valid text exactly and refuses subpages and nonstrings without changing the item", async () => {
    const cp = createChokePoint(pool);
    const db = await cp.createDatabase({ name: "Notes" });
    await cp.createProperty({
      databaseId: db.id,
      key: "body",
      name: "Body",
      type: "longText",
      config: { format: "markdown" },
    });
    const item = await cp.createItem({ databaseId: db.id, properties: { body: "Plain text" } });
    expect(item.properties.body).toBe("Plain text");
    const valid = "# Heading\n\n**bold**";
    const updated = await cp.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { body: valid } });
    expect(updated.properties.body).toBe(valid);
    for (const body of ["[Title](semprec://page/p1)", 42]) {
      await expect(
        cp.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { body } }),
      ).rejects.toMatchObject({ status: 400, details: { field: "body" } });
      expect((await cp.getItem(db.id, item.id))?.properties.body).toBe(valid);
    }
    const cleared = await cp.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { body: null } });
    expect(cleared.properties.body).toBeNull();
  });

  it("rejects invalid formats and types on creation and patch", async () => {
    const cp = createChokePoint(pool);
    const db = await cp.createDatabase({ name: "Notes" });
    for (const [type, format] of [
      ["number", "markdown"],
      ["text", "html"],
    ] as const) {
      await expect(
        cp.createProperty({ databaseId: db.id, key: type, name: type, type, config: { format } }),
      ).rejects.toMatchObject({ status: 400, details: { field: "config" } });
    }
    const property = await cp.createProperty({ databaseId: db.id, key: "body", name: "Body", type: "text" });
    await expect(cp.updatePropertyConfig(property.id, { format: "html" })).rejects.toMatchObject({
      status: 400,
      details: { field: "config" },
    });
  });
});
