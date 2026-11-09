import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { readPageBlocks, type PageBlock } from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import { insertItem } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { loadDocWithClient } from "../docs/docPersistence.js";
import { createSubpageWithClient } from "../docs/pageOperations.js";
import { PAGE_TITLE_MAX_LENGTH } from "../docs/pageTitle.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  writePageTextBlocks,
} from "../testSupport/testDb.js";
import type { CreatedBy } from "../types.js";
import type { PageCreateSubpageInput, PageCreateSubpageOutput } from "@semprec/shared";

let admin: Pool;
let runtime: Pool;
let tenant: string;

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
});
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  await runInTenant(tenant, () => seedSystem(runtime));
});
afterAll(async () => {
  const results = await Promise.allSettled([runtime?.end(), admin?.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
});

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

function convert(
  parent: string,
  fromBlockIds: string[],
  origin: CreatedBy = "user",
  extra: Partial<PageCreateSubpageInput> = {},
): Promise<PageCreateSubpageOutput> {
  return inTenant((client) =>
    createSubpageWithClient(client, { parent: { itemId: parent }, fromBlockIds, ...extra }, origin),
  );
}

async function readBlocks(itemId: string): Promise<PageBlock[]> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM docs WHERE item_id = $1`, [itemId]);
    const docRow = rows[0];
    if (!docRow) throw new Error(`Item ${itemId} has no document`);
    const doc = await loadDocWithClient(client, docRow.id);
    try {
      return readPageBlocks(doc).filter((block) => !block.synthetic);
    } finally {
      doc.destroy();
    }
  });
}

interface Counts {
  pagesItems: number;
  docs: number;
  parentUpdates: number;
}

/** What a refused conversion must leave as it found it. */
async function counts(parent: string): Promise<Counts> {
  return inTenant(async (client) => {
    const { rows } = await client.query<Counts>(
      `SELECT (SELECT count(*)::int FROM items i JOIN databases d ON d.id = i.database_id WHERE d.owner_module_id = 'pages') AS "pagesItems",
              (SELECT count(*)::int FROM docs) AS docs,
              (SELECT count(*)::int FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1) AS "parentUpdates"`,
      [parent],
    );
    const row = rows[0];
    if (!row) throw new Error("Missing counts");
    return row;
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to be rejected");
}

async function projectWith(texts: string[]): Promise<{ project: string; blocks: PageBlock[] }> {
  const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
  await runInTenant(tenant, () => writePageTextBlocks(runtime, project, texts));
  return { project, blocks: await readBlocks(project) };
}

describe("page.createSubpage with fromBlockIds (issue #2013)", () => {
  it("converts three text blocks into three empty subpages titled by their text, in one document write", async () => {
    const { project, blocks } = await projectWith(["Alpha", "Beta", "Gamma", "Delta"]);
    const [alpha, beta, gamma, delta] = blocks;
    if (!alpha?.id || !beta?.id || !gamma?.id || !delta?.id) throw new Error("Missing seed blocks");
    const before = await counts(project);

    // The ids are listed out of document order; the pages come back in document order.
    const result = await convert(project, [gamma.id, alpha.id, beta.id], "ai_agent", {
      afterBlockId: "ignored-because-fromBlockIds-is-present",
      title: "Ignored title",
    });

    expect(result.pages.map((page) => page.blockId)).toEqual([alpha.id, beta.id, gamma.id]);
    const after = await readBlocks(project);
    expect(after.map((block) => block.id)).toEqual([alpha.id, beta.id, gamma.id, delta.id]);
    expect(after.map((block) => [block.type, block.text.map((run) => run.insert).join("")])).toEqual([
      ["page", "Alpha"],
      ["page", "Beta"],
      ["page", "Gamma"],
      ["text", "Delta"],
    ]);
    expect(after.slice(0, 3).map((block) => block.pageId)).toEqual(result.pages.map((page) => page.pageItemId));

    const stored = await inTenant(async (client) => {
      const items = await client.query<{ id: string; properties: Record<string, unknown> }>(
        `SELECT id, properties FROM items WHERE id = ANY($1::uuid[]) ORDER BY properties->>'title'`,
        [result.pages.map((page) => page.pageItemId)],
      );
      const pageDocs = await client.query<{ item_id: string; kind: string; updates: number }>(
        `SELECT d.item_id, d.kind, (SELECT count(*)::int FROM doc_updates u WHERE u.doc_id = d.id) AS updates
         FROM docs d WHERE d.item_id = ANY($1::uuid[])`,
        [result.pages.map((page) => page.pageItemId)],
      );
      const parentUpdates = await client.query<{ created_by: string }>(
        `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id`,
        [project],
      );
      return { items: items.rows, pageDocs: pageDocs.rows, parentUpdates: parentUpdates.rows };
    });
    expect(stored.items.map((item) => item.properties)).toEqual([
      { title: "Alpha", parentItemId: project },
      { title: "Beta", parentItemId: project },
      { title: "Gamma", parentItemId: project },
    ]);
    // Every new page is empty: a page document with no update.
    expect(stored.pageDocs).toHaveLength(3);
    expect(stored.pageDocs.every((doc) => doc.kind === "page" && doc.updates === 0)).toBe(true);
    // Exactly one document update for all three conversions, authored by the caller's origin.
    expect(stored.parentUpdates.length).toBe(before.parentUpdates + 1);
    expect(stored.parentUpdates.at(-1)?.created_by).toBe("ai_agent");
  });

  it("normalizes a title with a line break for the Pages item while the block keeps its plain text", async () => {
    const { project, blocks } = await projectWith(["Line one\nline two"]);
    const id = blocks[0]?.id;
    if (!id) throw new Error("Missing block");
    const result = await convert(project, [id]);
    const page = result.pages[0];
    if (!page) throw new Error("Missing page");
    const title = await inTenant(async (client) => {
      const { rows } = await client.query<{ title: string }>(
        `SELECT properties->>'title' AS title FROM items WHERE id = $1`,
        [page.pageItemId],
      );
      return rows[0]?.title;
    });
    expect(title).toBe("Line one line two");
  });

  describe("rejections write nothing", () => {
    async function expectRejectedUnchanged(
      project: string,
      fromBlockIds: string[],
      type: typeof ValidationError | typeof NotFoundError,
      details?: Record<string, unknown>,
    ): Promise<void> {
      const beforeCounts = await counts(project);
      const beforeBlocks = await readBlocks(project);
      const error = await rejection(convert(project, fromBlockIds));
      expect(error).toBeInstanceOf(type);
      if (details) expect(error).toMatchObject({ details });
      expect(await counts(project)).toEqual(beforeCounts);
      expect(await readBlocks(project)).toEqual(beforeBlocks);
    }

    it("a block that is already a page block", async () => {
      const { project, blocks } = await projectWith(["Plain"]);
      const plain = blocks[0]?.id;
      if (!plain) throw new Error("Missing block");
      const existing = (
        await inTenant((client) => createSubpageWithClient(client, { parent: { itemId: project } }, "user"))
      ).pages[0];
      if (!existing) throw new Error("Missing page");
      await expectRejectedUnchanged(project, [plain, existing.blockId], ValidationError, { field: "fromBlockIds" });
    });

    it("an unknown block id", async () => {
      const { project, blocks } = await projectWith(["Plain"]);
      const plain = blocks[0]?.id;
      if (!plain) throw new Error("Missing block");
      await expectRejectedUnchanged(project, [plain, randomUUID()], ValidationError, { field: "fromBlockIds" });
    });

    it("a block id listed twice", async () => {
      const { project, blocks } = await projectWith(["Plain"]);
      const plain = blocks[0]?.id;
      if (!plain) throw new Error("Missing block");
      // The input schema already refuses a repeated id at the edge; the operation refuses it too.
      await expectRejectedUnchanged(project, [plain, plain], ValidationError, { field: "fromBlockIds" });
    });

    it("a block whose text is longer than the title limit", async () => {
      const { project, blocks } = await projectWith(["x".repeat(PAGE_TITLE_MAX_LENGTH + 1), "short"]);
      const [long, short] = blocks;
      if (!long?.id || !short?.id) throw new Error("Missing blocks");
      await expectRejectedUnchanged(project, [short.id, long.id], ValidationError, { field: "title" });
    });

    it("a parent of another tenant, answered like an unknown one", async () => {
      const otherTenant = await createTestTenant(admin);
      const foreign = await inTenant(async (client) => {
        const database = await createDatabase(client, { name: "Foreign" });
        return (await insertItem(client, { databaseId: database.id, properties: {} })).id;
      }, otherTenant);
      const { project } = await projectWith(["Mine"]);
      const before = await counts(project);
      const foreignError = await rejection(convert(foreign, [randomUUID()]));
      const unknownError = await rejection(convert(randomUUID(), [randomUUID()]));
      expect(foreignError).toBeInstanceOf(NotFoundError);
      expect(unknownError).toBeInstanceOf(NotFoundError);
      expect(await counts(project)).toEqual(before);
    });
  });

  it("leaves no Pages item and no document when the document write fails", async () => {
    const { project, blocks } = await projectWith(["Alpha", "Beta"]);
    const ids = blocks.flatMap((block) => (block.id ? [block.id] : []));
    const before = await counts(project);
    const beforeBlocks = await readBlocks(project);

    // A test trigger refuses the next insert into doc_updates, so the conversion fails after its Pages items and
    // documents were created and before it commits. The DDL carries no value, so nothing is interpolated.
    await admin.query(
      `CREATE FUNCTION public.zz_test_refuse_doc_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused by the test trigger' USING ERRCODE = 'P0001'; END $$`,
    );
    await admin.query(
      `CREATE TRIGGER zz_test_refuse_doc_update BEFORE INSERT ON doc_updates FOR EACH ROW EXECUTE FUNCTION public.zz_test_refuse_doc_update()`,
    );
    try {
      const error = await rejection(convert(project, ids));
      expect(String(error)).toContain("refused by the test trigger");
    } finally {
      await admin.query(`DROP TRIGGER zz_test_refuse_doc_update ON doc_updates`);
      await admin.query(`DROP FUNCTION public.zz_test_refuse_doc_update()`);
    }

    expect(await counts(project)).toEqual(before);
    expect(await readBlocks(project)).toEqual(beforeBlocks);
  });
});
