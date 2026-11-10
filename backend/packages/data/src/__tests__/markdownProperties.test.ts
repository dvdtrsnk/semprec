import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { seedSystem } from "../seed/seedSystem.js";
import { runInboxMarkdownFormatCutoverMigration } from "../inbox/inboxMarkdownFormatCutoverMigration.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";

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

  it.each(["text", "longText"] as const)(
    "validates markdown %s on creation and rejects incompatible retyping",
    async (type) => {
      const cp = createChokePoint(pool);
      const db = await cp.createDatabase({ name: "Notes" });
      const property = await cp.createProperty({
        databaseId: db.id,
        key: "body",
        name: "Body",
        type,
        config: { format: "markdown" },
      });
      const before = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [
        db.id,
      ]);
      for (const body of ["[Title](semprec://page/p1)", 42]) {
        await expect(cp.createItem({ databaseId: db.id, properties: { body } })).rejects.toMatchObject({
          status: 400,
          details: { field: "body" },
        });
      }
      expect(
        (await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [db.id])).rows,
      ).toEqual(before.rows);
      await expect(cp.updateProperty(property.id, { type: "number" })).rejects.toMatchObject({ status: 400 });
      expect((await cp.listProperties(db.id)).find((candidate) => candidate.id === property.id)).toMatchObject({
        type,
        config: { format: "markdown" },
      });
    },
  );

  it("fails clearly for malformed historical property configuration without changing an item", async () => {
    const cp = createChokePoint(pool);
    const db = await cp.createDatabase({ name: "Notes" });
    const property = await cp.createProperty({ databaseId: db.id, key: "body", name: "Body", type: "text" });
    const item = await cp.createItem({ databaseId: db.id, properties: { body: "Before" } });
    // Synthetic historical JSON null: the property API does not accept this config.
    await pool.query("UPDATE properties SET config = 'null'::jsonb WHERE id = $1", [property.id]);
    await expect(
      cp.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { body: "After" } }),
    ).rejects.toThrow("Malformed property config");
    expect((await cp.getItem(db.id, item.id))?.properties.body).toBe("Before");
  });

  it("leaves a malformed historical Inbox config unchanged during cutover", async () => {
    await inTenantZero(() => seedSystem(pool));
    const property = await pool.query<{ id: string }>(
      "SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.owner_module_id = 'inbox' AND p.key = 'text'",
    );
    const id = property.rows[0]?.id;
    if (!id) throw new Error("Missing Inbox text property");
    // Synthetic legacy scalar: normal schema writes require an object.
    await pool.query("UPDATE properties SET config = 'null'::jsonb WHERE id = $1", [id]);
    await expect(inTenantZero(() => runInboxMarkdownFormatCutoverMigration(pool))).rejects.toThrow(
      "Malformed Inbox text property config",
    );
    expect((await pool.query<{ config: unknown }>("SELECT config FROM properties WHERE id = $1", [id])).rows).toEqual([
      { config: null },
    ]);
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
