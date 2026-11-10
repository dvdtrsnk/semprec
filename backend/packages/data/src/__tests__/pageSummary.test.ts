import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { readPageBlocks, writeBlock } from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createDocStore } from "../docs/docStore.js";
import { mutateDoc } from "../docs/docPersistence.js";

let admin: Pool;
let data: Pool;
let cp: ChokePoint;
let tenant: string;

describe("read-only page summary", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(data);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });
  it("does not create or compact a document and counts all real blocks before limit", async () => {
    await runInTenant(tenant, async () => {
      const db = await cp.createDatabase({ name: "Pages" });
      const item = await cp.createItem({ databaseId: db.id, properties: {} });
      const store = createDocStore(data);
      expect(await store.getPageSummary(item.id, "cs")).toMatchObject({
        docId: null,
        title: "Poznámky",
        blocks: [],
        blockCount: 0,
        subpageCount: 0,
        lastEditedAt: null,
        lastEditedBy: null,
      });
      expect((await data.query("SELECT id FROM docs WHERE item_id = $1", [item.id])).rows).toHaveLength(0);
      const row = await store.getOrCreateDoc(item.id, "page");
      expect(await store.getPageSummary(item.id, "en")).toMatchObject({
        docId: row.id,
        title: "Notes",
        blocks: [],
        lastEditedAt: row.createdAt,
        lastEditedBy: null,
      });
      await mutateDoc(data, row.id, "user", (doc) => {
        doc.getMap("meta").set("title", "Title");
        for (let i = 0; i < 14; i++) {
          const id = `b${i}`;
          if (i < 2) writeBlock(doc, { id, type: "page", pageId: `page-${i}` });
          else if (i === 2) writeBlock(doc, { id, type: "h1", text: [{ insert: "Bold", attributes: { bold: true } }] });
          else writeBlock(doc, { id, type: "text", text: `text ${i}` });
        }
        expect(readPageBlocks(doc).filter((block) => !block.synthetic)).toHaveLength(14);
      });
      const before = await data.query<{ id: string }>("SELECT id FROM doc_updates WHERE doc_id = $1 ORDER BY id", [
        row.id,
      ]);
      const summary = await store.getPageSummary(item.id, "en", 5);
      expect(summary).toMatchObject({
        docId: row.id,
        title: "Title",
        blockCount: 14,
        subpageCount: 2,
        blocks: [
          { id: "b0", pageId: "page-0" },
          { id: "b1", pageId: "page-1" },
          { id: "b2", text: "**Bold**" },
          {},
          {},
        ],
        headings: [{ id: "b2", type: "h1", text: "**Bold**" }],
        lastEditedBy: "user",
      });
      expect(
        (await data.query<{ id: string }>("SELECT id FROM doc_updates WHERE doc_id = $1 ORDER BY id", [row.id])).rows,
      ).toEqual(before.rows);
    });
  });
});
