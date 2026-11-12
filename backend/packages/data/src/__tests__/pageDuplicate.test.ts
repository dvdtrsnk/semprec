import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  deleteBlocks,
  insertBlocks,
  readPageBlocks,
  setIndent,
  writeBlock,
  type NewBlockInput,
  type PageBlock,
} from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { lockItemById, lockItemByIdNowait, softDeleteItem } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { loadDocWithClient, mutateDoc } from "../docs/docPersistence.js";
import { createDocStore } from "../docs/docStore.js";
import {
  createSubpageWithClient,
  duplicatePageWithClient,
  MAX_DUPLICATE_PAGES,
  renamePageWithClient,
  type DuplicatePageOptions,
} from "../docs/pageOperations.js";
import { PAGES_MODULE_ID } from "../docs/pagesDatabase.js";
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
import type { PageDuplicateOutput } from "@semprec/shared";

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

interface Subpage {
  pageItemId: string;
  docId: string;
  blockId: string;
}

async function subpage(
  parentItemId: string,
  title: string,
  afterBlockId?: string,
  tenantId = tenant,
): Promise<Subpage> {
  const created = await inTenant(
    (client) => createSubpageWithClient(client, { parent: { itemId: parentItemId }, title, afterBlockId }, "user"),
    tenantId,
  );
  const page = created.pages[0];
  if (!page) throw new Error("Missing page");
  return page;
}

function duplicate(pageItemId: string, options: Partial<DuplicatePageOptions> = {}): Promise<PageDuplicateOutput> {
  return inTenant((client) =>
    duplicatePageWithClient(client, pageItemId, { origin: "user", locale: "cs", ...options }),
  );
}

async function docIdOf(itemId: string): Promise<string> {
  const { rows } = await inTenant((client) =>
    client.query<{ id: string }>(`SELECT id FROM docs WHERE item_id = $1`, [itemId]),
  );
  const row = rows[0];
  if (!row) throw new Error(`Item ${itemId} has no document`);
  return row.id;
}

async function readBlocks(itemId: string): Promise<PageBlock[]> {
  const docId = await docIdOf(itemId);
  return inTenant(async (client) => {
    const doc = await loadDocWithClient(client, docId);
    try {
      return readPageBlocks(doc).filter((block) => !block.synthetic);
    } finally {
      doc.destroy();
    }
  });
}

/** Appends `blocks` to the page document of `itemId` through the docs module's own write. */
async function appendBlocks(itemId: string, blocks: NewBlockInput[]): Promise<string[]> {
  const docId = await docIdOf(itemId);
  return runInTenant(tenant, () =>
    mutateDoc(runtime, docId, "user", (doc) => {
      const last = readPageBlocks(doc)
        .filter((block) => !block.synthetic)
        .at(-1);
      return insertBlocks(doc, last?.id ?? null, blocks);
    }),
  );
}

/**
 * Writes `text` as the caption of the page block of `page` in the document of `parentItemId`, as an edit of the title
 * in the parent does. The mirror job does not run in this file, so the item of `page` keeps the title it had.
 */
async function retitleInParent(parentItemId: string, page: Subpage, text: string): Promise<void> {
  const parentDocId = await docIdOf(parentItemId);
  await runInTenant(tenant, () =>
    mutateDoc(runtime, parentDocId, "user", (doc) =>
      writeBlock(doc, { id: page.blockId, type: "page", pageId: page.pageItemId, text }),
    ),
  );
}

/** A block as it must survive a copy: everything but its id and the page it names. */
function content(block: PageBlock): Omit<PageBlock, "id" | "pageId"> {
  const { id: _id, pageId: _pageId, ...rest } = block;
  return rest;
}

async function propertiesOf(itemId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await inTenant((client) =>
    client.query<{ properties: Record<string, unknown> }>(`SELECT properties FROM items WHERE id = $1`, [itemId]),
  );
  return rows[0]?.properties;
}

/** Every stored row of the given items and of their documents, bytes included, for a byte-for-byte comparison. */
async function storedRows(itemIds: string[]): Promise<Record<string, unknown[]>> {
  return inTenant(async (client) => {
    const read = async (sql: string): Promise<unknown[]> =>
      (await client.query<{ row: unknown }>(sql, [itemIds])).rows.map((row) => row.row);
    return {
      items: await read(`SELECT to_jsonb(i) AS row FROM items i WHERE i.id = ANY($1::uuid[]) ORDER BY i.id`),
      docs: await read(`SELECT to_jsonb(d) AS row FROM docs d WHERE d.item_id = ANY($1::uuid[]) ORDER BY d.id`),
      snapshots: await read(
        `SELECT to_jsonb(s) AS row FROM doc_snapshots s JOIN docs d ON d.id = s.doc_id
         WHERE d.item_id = ANY($1::uuid[]) ORDER BY d.id`,
      ),
      updates: await read(
        `SELECT to_jsonb(u) AS row FROM doc_updates u JOIN docs d ON d.id = u.doc_id
         WHERE d.item_id = ANY($1::uuid[]) ORDER BY u.id`,
      ),
    };
  });
}

interface WriteCounts {
  pagesItems: number;
  docs: number;
  docUpdates: number;
}

/** What a refused call must leave exactly as it found it, read inside the tenant. */
async function writeCounts(tenantId = tenant): Promise<WriteCounts> {
  return inTenant(async (client) => {
    const { rows } = await client.query<WriteCounts>(
      `SELECT (SELECT count(*)::int FROM items i JOIN databases d ON d.id = i.database_id WHERE d.owner_module_id = $1) AS "pagesItems",
              (SELECT count(*)::int FROM docs) AS docs,
              (SELECT count(*)::int FROM doc_updates) AS "docUpdates"`,
      [PAGES_MODULE_ID],
    );
    const row = rows[0];
    if (!row) throw new Error("Missing counts");
    return row;
  }, tenantId);
}

async function databaseIdOf(itemId: string): Promise<string> {
  const { rows } = await inTenant((client) =>
    client.query<{ database_id: string }>(`SELECT database_id FROM items WHERE id = $1`, [itemId]),
  );
  const databaseId = rows[0]?.database_id;
  if (!databaseId) throw new Error(`Item ${itemId} not found`);
  return databaseId;
}

/** Resolves once a statement on this test database waits for a lock, and fails after ten seconds. */
async function lockWait(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await admin.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE NOT l.granted AND a.datname = current_database()`,
    );
    if ((rows[0]?.waiting ?? 0) >= 1) return;
    if (Date.now() > deadline) throw new Error("The duplicate never waited for a lock");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Runs `body` while a transaction of its own on a dedicated connection, scoped to the tenant, is open. `body` commits
 * it through `commit`; a transaction still open afterwards is rolled back.
 */
async function withOpenTransaction(
  body: (holder: PoolClient, commit: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const holder = await runtime.connect();
  let open = false;
  try {
    await holder.query("BEGIN");
    open = true;
    await holder.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await body(holder, async () => {
      await holder.query("COMMIT");
      open = false;
    });
  } finally {
    try {
      if (open) await holder.query("ROLLBACK");
    } finally {
      holder.release();
    }
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to be rejected");
}

/** Expects `pageItemId` to be refused as not found, with nothing written. */
async function expectNotFoundUnchanged(pageItemId: string): Promise<NotFoundError> {
  const before = await writeCounts();
  const error = await rejection(duplicate(pageItemId));
  if (!(error instanceof NotFoundError)) throw new Error(`Expected a NotFoundError, got ${String(error)}`);
  expect(await writeCounts()).toEqual(before);
  return error;
}

async function trash(itemId: string): Promise<void> {
  const databaseId = await databaseIdOf(itemId);
  const trashed = await runInTenant(tenant, () => createChokePoint(runtime).softDeleteItem(databaseId, itemId));
  expect(trashed).not.toBeNull();
}

async function isInTrash(itemId: string): Promise<boolean> {
  const { rows } = await inTenant((client) =>
    client.query<{ trashed: boolean }>(`SELECT deleted_at IS NOT NULL AS trashed FROM items WHERE id = $1`, [itemId]),
  );
  const row = rows[0];
  if (!row) throw new Error(`Item ${itemId} not found`);
  return row.trashed;
}

/** The ids the `page` blocks of the document of `itemId` name, in document order. */
async function namedPageIds(itemId: string): Promise<Array<string | null>> {
  return (await readBlocks(itemId)).filter((block) => block.type === "page").map((block) => block.pageId);
}

/**
 * An instant of the database clock that a document's history places after every write made so far and before every
 * write made once this returns. The history dates an update by the start of its transaction and keeps that start in
 * whole milliseconds, so the instant is the whole millisecond after the current one, and it is returned once the
 * database clock has left that millisecond.
 */
async function instantAfterWrites(): Promise<Date> {
  const { rows } = await admin.query<{ at: Date }>(
    `SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS at`,
  );
  const at = rows[0]?.at;
  if (!at) throw new Error("Missing database clock");
  const deadline = Date.now() + 3000;
  for (;;) {
    const past = await admin.query<{ past: boolean }>(
      `SELECT date_trunc('milliseconds', clock_timestamp()) > $1::timestamptz AS past`,
      [at],
    );
    if (past.rows[0]?.past) return at;
    if (Date.now() >= deadline) throw new Error("The database clock did not leave the instant");
  }
}

/** A project whose page holds "first", the page block of "Release checklist" and "last", in that order. */
async function projectWithChecklist(): Promise<{
  project: string;
  checklist: Subpage;
  firstId: string;
  lastId: string;
}> {
  const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
  await runInTenant(tenant, () => writePageTextBlocks(runtime, project, ["first", "last"]));
  const [first, last] = await readBlocks(project);
  if (!first?.id || !last?.id) throw new Error("Missing seed blocks");
  const checklist = await subpage(project, "Release checklist", first.id);
  return { project, checklist, firstId: first.id, lastId: last.id };
}

describe("page.duplicate (issue #1722)", () => {
  it("copies a page and its nested page as new pages next to the original and leaves the originals byte for byte unchanged", async () => {
    const { project, checklist, firstId, lastId } = await projectWithChecklist();
    await appendBlocks(checklist.pageItemId, [{ type: "text", text: "Before the nested page" }]);
    const notes = await subpage(checklist.pageItemId, "Notes for 0.4");
    await appendBlocks(checklist.pageItemId, [{ type: "text", text: "After the nested page" }]);
    await appendBlocks(notes.pageItemId, [{ type: "text", text: "A note" }]);
    const originals = [checklist.pageItemId, notes.pageItemId];
    const originalRows = await storedRows(originals);
    const originalChecklistBlocks = await readBlocks(checklist.pageItemId);
    const originalNotesBlocks = await readBlocks(notes.pageItemId);
    const before = await writeCounts();

    const copy = await duplicate(checklist.pageItemId);

    // The copy stands right after the original in the parent, titled with the Czech suffix.
    const parentBlocks = await readBlocks(project);
    expect(parentBlocks.map((block) => block.id)).toEqual([firstId, checklist.blockId, copy.blockId, lastId]);
    expect(parentBlocks[2]).toMatchObject({
      type: "page",
      indent: 0,
      pageId: copy.pageItemId,
      text: [{ insert: "Release checklist (kopie)" }],
    });
    expect(await propertiesOf(copy.pageItemId)).toEqual({ title: "Release checklist (kopie)", parentItemId: project });
    expect(await docIdOf(copy.pageItemId)).toBe(copy.docId);

    // The copy holds the same blocks in the same order under new ids, and its own copy of the nested page.
    const copyBlocks = await readBlocks(copy.pageItemId);
    expect(copyBlocks.map(content)).toEqual(originalChecklistBlocks.map(content));
    const nestedCopyId = copyBlocks[1]?.pageId;
    if (!nestedCopyId) throw new Error("The copy has no nested page block");
    expect(copyBlocks.map((block) => block.pageId)).toEqual([null, nestedCopyId, null]);
    expect(await propertiesOf(nestedCopyId)).toEqual({ title: "Notes for 0.4", parentItemId: copy.pageItemId });
    const nestedCopyBlocks = await readBlocks(nestedCopyId);
    expect(nestedCopyBlocks.map(content)).toEqual(originalNotesBlocks.map(content));

    // Every page item id, document id and block id of the copy is new.
    const copiedIds = [
      copy.pageItemId,
      nestedCopyId,
      copy.docId,
      await docIdOf(nestedCopyId),
      ...copyBlocks.map((block) => block.id),
      ...nestedCopyBlocks.map((block) => block.id),
    ];
    const originalIds = new Set([
      ...originals,
      checklist.docId,
      notes.docId,
      ...originalChecklistBlocks.map((block) => block.id),
      ...originalNotesBlocks.map((block) => block.id),
    ]);
    expect(copiedIds.filter((id) => originalIds.has(id))).toEqual([]);
    expect(new Set(copiedIds).size).toBe(copiedIds.length);

    // Two pages and two documents were created; the originals' rows and document bytes are what they were.
    const after = await writeCounts();
    expect(after.pagesItems).toBe(before.pagesItems + 2);
    expect(after.docs).toBe(before.docs + 2);
    expect(await storedRows(originals)).toEqual(originalRows);
  });

  it("keeps the original's nested page unchanged when the copy's nested page is edited", async () => {
    const { checklist } = await projectWithChecklist();
    const notes = await subpage(checklist.pageItemId, "Notes");
    await appendBlocks(notes.pageItemId, [{ type: "text", text: "Original note" }]);
    const copy = await duplicate(checklist.pageItemId);
    const nestedCopyId = (await readBlocks(copy.pageItemId))[0]?.pageId;
    if (!nestedCopyId) throw new Error("The copy has no nested page block");
    const originalRows = await storedRows([notes.pageItemId]);

    await runInTenant(tenant, () =>
      createDocStore(runtime).insertPageMarkdown(nestedCopyId, {
        placement: "end",
        markdown: "Written into the copy",
        origin: "user",
      }),
    );

    expect((await readBlocks(nestedCopyId)).map((block) => block.text)).toEqual([
      [{ insert: "Original note" }],
      [{ insert: "Written into the copy" }],
    ]);
    expect((await readBlocks(notes.pageItemId)).map((block) => block.text)).toEqual([[{ insert: "Original note" }]]);
    expect(await storedRows([notes.pageItemId])).toEqual(originalRows);
  });

  it("keeps inline formatting, todo state, types and indent in the copy", async () => {
    const { checklist } = await projectWithChecklist();
    await appendBlocks(checklist.pageItemId, [
      { type: "h1", text: "Heading" },
      {
        type: "text",
        text: [
          { insert: "plain " },
          { insert: "bold", attributes: { bold: true } },
          { insert: " both", attributes: { bold: true, italic: true } },
          { insert: " code", attributes: { code: true } },
          { insert: " link", attributes: { link: { href: "https://example.test/release" } } },
        ],
      },
      { type: "todo", text: "Done step", done: true, indent: 2 },
      { type: "todo", text: "Open step", done: false },
      { type: "bullet", text: "Nested bullet", indent: 1 },
      { type: "number", text: "Numbered", indent: 5 },
      { type: "quote", text: [{ insert: "Quoted", attributes: { italic: true } }] },
      { type: "h2", text: "" },
    ]);
    const original = await readBlocks(checklist.pageItemId);
    expect(original).toHaveLength(8);

    const copy = await duplicate(checklist.pageItemId);

    const copied = await readBlocks(copy.pageItemId);
    expect(copied.map(content)).toEqual(original.map(content));
    expect(copied.map((block) => [block.type, block.indent, block.done])).toEqual([
      ["h1", 0, false],
      ["text", 0, false],
      ["todo", 2, true],
      ["todo", 0, false],
      ["bullet", 1, false],
      ["number", 5, false],
      ["quote", 0, false],
      ["h2", 0, false],
    ]);
    expect(copied[1]?.text).toEqual([
      { insert: "plain " },
      { insert: "bold", attributes: { bold: true } },
      { insert: " both", attributes: { bold: true, italic: true } },
      { insert: " code", attributes: { code: true } },
      { insert: " link", attributes: { link: { href: "https://example.test/release" } } },
    ]);
  });

  it("leaves out the block of a trashed nested page, and of anything that is not a live page", async () => {
    const { project, checklist } = await projectWithChecklist();
    const kept = await subpage(checklist.pageItemId, "Kept");
    const trashed = await subpage(checklist.pageItemId, "Trashed");
    const beforeTrash = await instantAfterWrites();
    await trash(trashed.pageItemId);
    // The trash takes the block of the page out of its parent's document (issue #1723). Restoring that document to
    // its version from before the trash (page.restoreVersion) writes the block again, and the page stays in the Trash.
    expect(await namedPageIds(checklist.pageItemId)).toEqual([kept.pageItemId]);
    await runInTenant(tenant, () => createDocStore(runtime).restoreVersion(checklist.pageItemId, beforeTrash));
    expect(await namedPageIds(checklist.pageItemId)).toEqual([kept.pageItemId, trashed.pageItemId]);
    expect(await isInTrash(trashed.pageItemId)).toBe(true);
    // The sync socket can store any page block: one naming an id no item has (a purged page), one naming a host item,
    // and one whose pageId is not an id at all.
    await appendBlocks(checklist.pageItemId, [
      { type: "page", pageId: randomUUID(), text: "Purged" },
      { type: "page", pageId: project, text: "A host, not a page" },
      { type: "page", pageId: "not-an-id", text: "Malformed" },
      { type: "text", text: "Last line" },
    ]);
    expect((await readBlocks(checklist.pageItemId)).map((block) => block.type)).toEqual([
      "page",
      "page",
      "page",
      "page",
      "page",
      "text",
    ]);
    const before = await writeCounts();

    const copy = await duplicate(checklist.pageItemId);

    const copied = await readBlocks(copy.pageItemId);
    expect(copied.map((block) => [block.type, block.text])).toEqual([
      ["page", [{ insert: "Kept" }]],
      ["text", [{ insert: "Last line" }]],
    ]);
    expect(copied[0]?.pageId).not.toBe(kept.pageItemId);
    // Only the root of the copy and the copy of the one live nested page were created.
    expect((await writeCounts()).pagesItems).toBe(before.pagesItems + 2);
  });

  it("copies a nested page that has no document as an empty page", async () => {
    const { checklist } = await projectWithChecklist();
    const bare = await subpage(checklist.pageItemId, "Without a document");
    // No production write leaves a Pages item without its document; this superuser delete stands in for hand-edited
    // data.
    await admin.query(`DELETE FROM docs WHERE item_id = $1`, [bare.pageItemId]);
    const before = await writeCounts();

    const copy = await duplicate(checklist.pageItemId);

    const copied = await readBlocks(copy.pageItemId);
    expect(copied.map((block) => [block.type, block.text])).toEqual([["page", [{ insert: "Without a document" }]]]);
    const bareCopyId = copied[0]?.pageId;
    if (!bareCopyId) throw new Error("Missing nested copy");
    expect(await propertiesOf(bareCopyId)).toEqual({ title: "Without a document", parentItemId: copy.pageItemId });
    // The copy of the page has a document of its own, without blocks.
    expect(await readBlocks(bareCopyId)).toEqual([]);
    const after = await writeCounts();
    expect(after.pagesItems).toBe(before.pagesItems + 2);
    expect(after.docs).toBe(before.docs + 2);
  });

  it("copies a page named by two blocks once per block, as two independent pages", async () => {
    const { checklist } = await projectWithChecklist();
    const shared = await subpage(checklist.pageItemId, "Shared");
    await appendBlocks(shared.pageItemId, [{ type: "text", text: "Shared text" }]);
    await appendBlocks(checklist.pageItemId, [{ type: "page", pageId: shared.pageItemId, text: "Shared again" }]);
    const before = await writeCounts();

    const copy = await duplicate(checklist.pageItemId);

    const copied = await readBlocks(copy.pageItemId);
    expect(copied.map((block) => [block.type, block.text])).toEqual([
      ["page", [{ insert: "Shared" }]],
      ["page", [{ insert: "Shared again" }]],
    ]);
    const [firstCopyId, secondCopyId] = copied.map((block) => block.pageId);
    if (!firstCopyId || !secondCopyId) throw new Error("Missing nested copies");
    expect(new Set([firstCopyId, secondCopyId, shared.pageItemId]).size).toBe(3);
    for (const nestedCopyId of [firstCopyId, secondCopyId]) {
      expect(await propertiesOf(nestedCopyId)).toEqual({ title: "Shared", parentItemId: copy.pageItemId });
      expect((await readBlocks(nestedCopyId)).map((block) => block.text)).toEqual([[{ insert: "Shared text" }]]);
    }
    expect((await writeCounts()).pagesItems).toBe(before.pagesItems + 3);
  });

  it("ends at a block that names the page itself or one of its ancestors", async () => {
    const { checklist } = await projectWithChecklist();
    const nested = await subpage(checklist.pageItemId, "Nested");
    const deeper = await subpage(nested.pageItemId, "Deeper");
    await appendBlocks(checklist.pageItemId, [{ type: "page", pageId: checklist.pageItemId, text: "Myself" }]);
    await appendBlocks(deeper.pageItemId, [
      { type: "page", pageId: checklist.pageItemId, text: "Back to the root" },
      { type: "page", pageId: nested.pageItemId, text: "Back to my parent" },
      { type: "text", text: "Deep text" },
    ]);
    const before = await writeCounts();

    const copy = await duplicate(checklist.pageItemId);

    const copied = await readBlocks(copy.pageItemId);
    expect(copied.map((block) => block.text)).toEqual([[{ insert: "Nested" }]]);
    const nestedCopyId = copied[0]?.pageId;
    if (!nestedCopyId) throw new Error("Missing nested copy");
    const deeperCopyId = (await readBlocks(nestedCopyId))[0]?.pageId;
    if (!deeperCopyId) throw new Error("Missing deeper copy");
    expect((await readBlocks(deeperCopyId)).map((block) => [block.type, block.text])).toEqual([
      ["text", [{ insert: "Deep text" }]],
    ]);
    expect((await writeCounts()).pagesItems).toBe(before.pagesItems + 3);
  });

  it("refuses a tree of 501 pages with nothing written, and copies a tree of exactly 500", async () => {
    const { project, checklist } = await projectWithChecklist();
    // The root gets 500 text blocks, and conversions make each of them a nested page with its own document, 200 at a
    // time, the most one page.createSubpage call names. The tree is then the root plus 500 pages.
    const blockIds = await appendBlocks(
      checklist.pageItemId,
      Array.from({ length: MAX_DUPLICATE_PAGES }, (_, index) => ({ type: "text", text: `p${index + 1}` })),
    );
    const nested: string[] = [];
    for (let start = 0; start < blockIds.length; start += 200) {
      const converted = await inTenant((client) =>
        createSubpageWithClient(
          client,
          { parent: { itemId: checklist.pageItemId }, fromBlockIds: blockIds.slice(start, start + 200) },
          "user",
        ),
      );
      nested.push(...converted.pages.map((page) => page.pageItemId));
    }
    expect(nested).toHaveLength(MAX_DUPLICATE_PAGES);
    const before = await writeCounts();
    const parentBefore = await readBlocks(project);

    const error = await rejection(duplicate(checklist.pageItemId));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, details: { field: "pageItemId", reason: "too_many_pages" } });
    expect(await writeCounts()).toEqual(before);
    expect(await readBlocks(project)).toEqual(parentBefore);

    // One page fewer is exactly the cap: the root and 499 nested pages, each copied with a document of its own.
    const lastNested = nested.at(-1);
    if (!lastNested) throw new Error("Missing nested page");
    await trash(lastNested);
    const copy = await duplicate(checklist.pageItemId);
    const copiedPageBlocks = (await readBlocks(copy.pageItemId)).filter((block) => block.type === "page");
    expect(copiedPageBlocks.map((block) => block.text)).toEqual(
      Array.from({ length: MAX_DUPLICATE_PAGES - 1 }, (_, index) => [{ insert: `p${index + 1}` }]),
    );
    const after = await writeCounts();
    expect(after.pagesItems).toBe(before.pagesItems + MAX_DUPLICATE_PAGES);
    expect(after.docs).toBe(before.docs + MAX_DUPLICATE_PAGES);
  }, 120_000);

  it("refuses a host item on pageItemId, before and after the tenant has a Pages database", async () => {
    const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
    const refuse = async (): Promise<void> => {
      const before = await writeCounts();
      const error = await rejection(duplicate(project));
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, details: { field: "pageItemId", reason: "not_a_page" } });
      expect(await writeCounts()).toEqual(before);
    };
    await refuse();
    await subpage(project, "The first page creates the Pages database");
    await refuse();
  });

  it("puts the copy of an orphan at the end of the parent", async () => {
    const { project, checklist, firstId, lastId } = await projectWithChecklist();
    const parentDocId = await docIdOf(project);
    await runInTenant(tenant, () =>
      mutateDoc(runtime, parentDocId, "user", (doc) => deleteBlocks(doc, [checklist.blockId])),
    );
    expect((await readBlocks(project)).map((block) => block.id)).toEqual([firstId, lastId]);

    const copy = await duplicate(checklist.pageItemId);

    const parentBlocks = await readBlocks(project);
    expect(parentBlocks.map((block) => block.id)).toEqual([firstId, lastId, copy.blockId]);
    expect(parentBlocks[2]).toMatchObject({ type: "page", indent: 0, pageId: copy.pageItemId });
    expect(await propertiesOf(copy.pageItemId)).toEqual({ title: "Release checklist (kopie)", parentItemId: project });
  });

  it("gives the copy's block the indent of the original's block", async () => {
    const { project, checklist, firstId, lastId } = await projectWithChecklist();
    const parentDocId = await docIdOf(project);
    await runInTenant(tenant, () =>
      mutateDoc(runtime, parentDocId, "user", (doc) => setIndent(doc, [checklist.blockId], 2)),
    );

    const copy = await duplicate(checklist.pageItemId);

    expect((await readBlocks(project)).map((block) => [block.id, block.indent])).toEqual([
      [firstId, 0],
      [checklist.blockId, 2],
      [copy.blockId, 2],
      [lastId, 0],
    ]);
  });

  it("copies a nested subpage under its parent page", async () => {
    const { checklist } = await projectWithChecklist();
    const notes = await subpage(checklist.pageItemId, "Notes");

    const copy = await duplicate(notes.pageItemId);

    expect((await readBlocks(checklist.pageItemId)).map((block) => [block.id, block.pageId])).toEqual([
      [notes.blockId, notes.pageItemId],
      [copy.blockId, copy.pageItemId],
    ]);
    expect(await propertiesOf(copy.pageItemId)).toEqual({ title: "Notes (kopie)", parentItemId: checklist.pageItemId });
  });

  it("titles the copy from the original's block in the parent when the mirrored title lags it", async () => {
    const { project, checklist } = await projectWithChecklist();
    const draft = await subpage(project, "");
    // Both titles were typed in the parent and the mirror job has not run: each block is ahead of its item.
    await retitleInParent(project, checklist, "Release plan");
    await retitleInParent(project, draft, "Typed after creation");
    expect((await propertiesOf(checklist.pageItemId))?.title).toBe("Release checklist");
    expect((await propertiesOf(draft.pageItemId))?.title).toBe("");

    const copy = await duplicate(checklist.pageItemId);
    const draftCopy = await duplicate(draft.pageItemId, { locale: "en" });

    expect(await propertiesOf(copy.pageItemId)).toEqual({ title: "Release plan (kopie)", parentItemId: project });
    expect(await propertiesOf(draftCopy.pageItemId)).toEqual({
      title: "Typed after creation (copy)",
      parentItemId: project,
    });
    const captions = new Map((await readBlocks(project)).map((block) => [block.id, block.text]));
    expect(captions.get(copy.blockId)).toEqual([{ insert: "Release plan (kopie)" }]);
    expect(captions.get(draftCopy.blockId)).toEqual([{ insert: "Typed after creation (copy)" }]);
    // The originals are not written: their blocks keep what was typed and their items wait for the mirror job.
    expect(captions.get(checklist.blockId)).toEqual([{ insert: "Release plan" }]);
    expect(captions.get(draft.blockId)).toEqual([{ insert: "Typed after creation" }]);
    expect((await propertiesOf(checklist.pageItemId))?.title).toBe("Release checklist");
    expect((await propertiesOf(draft.pageItemId))?.title).toBe("");
  });

  it("takes the title and the place from the first of two blocks that name the original", async () => {
    const { project, checklist, firstId, lastId } = await projectWithChecklist();
    await retitleInParent(project, checklist, "Release plan");
    const [secondBlockId] = await appendBlocks(project, [
      { type: "page", pageId: checklist.pageItemId, text: "Another caption" },
    ]);

    const copy = await duplicate(checklist.pageItemId);

    expect((await propertiesOf(copy.pageItemId))?.title).toBe("Release plan (kopie)");
    expect((await readBlocks(project)).map((block) => [block.id, block.text])).toEqual([
      [firstId, [{ insert: "first" }]],
      [checklist.blockId, [{ insert: "Release plan" }]],
      [copy.blockId, [{ insert: "Release plan (kopie)" }]],
      [lastId, [{ insert: "last" }]],
      [secondBlockId, [{ insert: "Another caption" }]],
    ]);
  });

  it("reads a title typed in the parent as the mirror job stores it, line breaks and length limit included", async () => {
    const { project, checklist } = await projectWithChecklist();
    // A sync client can store any text in the block: here a line break and more than a title may hold.
    await retitleInParent(project, checklist, `Line one\r\nline two ${"x".repeat(PAGE_TITLE_MAX_LENGTH)}`);

    const copy = await duplicate(checklist.pageItemId);

    // The mirror job would store the first 500 code points of this; " (kopie)" takes the place of the last eight.
    const mirrored = `Line one line two ${"x".repeat(PAGE_TITLE_MAX_LENGTH)}`;
    const copyTitle = `${mirrored.slice(0, PAGE_TITLE_MAX_LENGTH - 8)} (kopie)`;
    expect(Array.from(copyTitle)).toHaveLength(PAGE_TITLE_MAX_LENGTH);
    expect((await propertiesOf(copy.pageItemId))?.title).toBe(copyTitle);
    const copyBlock = (await readBlocks(project)).find((block) => block.id === copy.blockId);
    expect(copyBlock?.text).toEqual([{ insert: copyTitle }]);
  });

  it.each([
    ["its parent names", false],
    ["no block names", true],
  ])(
    "reads the title of a page %s once it holds the rows, so a rename in flight is in the copy",
    async (_label, orphan) => {
      const { project, checklist } = await projectWithChecklist();
      if (orphan) {
        const parentDocId = await docIdOf(project);
        await runInTenant(tenant, () =>
          mutateDoc(runtime, parentDocId, "user", (doc) => deleteBlocks(doc, [checklist.blockId])),
        );
      }
      const started: Array<Promise<PromiseSettledResult<PageDuplicateOutput>[]>> = [];
      try {
        await inTenant(async (client) => {
          // This transaction has renamed the page and holds the parent's row and the page's row. The duplicate that
          // starts now still finds the old title on the item, and waits for the parent's row.
          await renamePageWithClient(client, { pageItemId: checklist.pageItemId, title: "Release plan" }, "user");
          started.push(Promise.allSettled([duplicate(checklist.pageItemId)]));
          await lockWait();
        });
      } finally {
        // The duplicate is settled before the test goes on, also when the wait failed and rolled the rename back.
        await Promise.all(started);
      }

      const [outcome] = (await Promise.all(started)).flat();
      if (outcome?.status !== "fulfilled") throw new Error("The duplicate failed", { cause: outcome?.reason });
      const copy = outcome.value;
      expect(await propertiesOf(copy.pageItemId)).toEqual({ title: "Release plan (kopie)", parentItemId: project });
      const copyBlock = (await readBlocks(project)).find((block) => block.id === copy.blockId);
      expect(copyBlock?.text).toEqual([{ insert: "Release plan (kopie)" }]);
    },
  );

  it("answers another tenant's page exactly like an unknown id and writes nothing in either tenant", async () => {
    const otherTenant = await createTestTenant(admin);
    const foreignProject = await runInTenant(otherTenant, async () => {
      await seedSystem(runtime);
      return createTestProjectItem(runtime);
    });
    const foreignPage = await subpage(foreignProject, "Private page", undefined, otherTenant);
    const foreignBefore = await writeCounts(otherTenant);

    const foreignError = await expectNotFoundUnchanged(foreignPage.pageItemId);
    const unknownId = randomUUID();
    const unknownError = await expectNotFoundUnchanged(unknownId);

    const shape = (error: NotFoundError, id: string): string =>
      JSON.stringify({
        status: error.status,
        code: error.code,
        message: error.message,
        details: error.details,
      }).replaceAll(id, "<id>");
    expect(shape(foreignError, foreignPage.pageItemId)).toBe(shape(unknownError, unknownId));
    expect(foreignError.status).toBe(404);
    expect(await writeCounts(otherTenant)).toEqual(foreignBefore);
  });

  it("does not find a trashed page, nor a page whose parent is trashed or unusable", async () => {
    const trashedPage = await projectWithChecklist();
    await trash(trashedPage.checklist.pageItemId);
    await expectNotFoundUnchanged(trashedPage.checklist.pageItemId);

    const trashedParent = await projectWithChecklist();
    await trash(trashedParent.project);
    // The project's trash took the page with it (issue #1763). Restored on its own, the page is live below the
    // trashed project.
    const pagesDatabaseId = await databaseIdOf(trashedParent.checklist.pageItemId);
    await runInTenant(tenant, () =>
      createChokePoint(runtime).restoreItem(pagesDatabaseId, trashedParent.checklist.pageItemId),
    );
    expect(await isInTrash(trashedParent.checklist.pageItemId)).toBe(false);
    expect(await isInTrash(trashedParent.project)).toBe(true);
    await expectNotFoundUnchanged(trashedParent.checklist.pageItemId);

    const unusableParent = await projectWithChecklist();
    // No operation removes parentItemId; this superuser write stands in for hand-edited data.
    await admin.query(`UPDATE items SET properties = properties - 'parentItemId' WHERE id = $1`, [
      unusableParent.checklist.pageItemId,
    ]);
    await expectNotFoundUnchanged(unusableParent.checklist.pageItemId);

    const malformedParent = await projectWithChecklist();
    // No operation stores a parentItemId that is not an id; this superuser write stands in for hand-edited data.
    await admin.query(
      `UPDATE items SET properties = jsonb_set(properties, '{parentItemId}', to_jsonb($2::text)) WHERE id = $1`,
      [malformedParent.checklist.pageItemId, "not-an-id"],
    );
    await expectNotFoundUnchanged(malformedParent.checklist.pageItemId);
  });

  it("uses the English suffix for every locale but Czech", async () => {
    const { checklist } = await projectWithChecklist();
    const english = await duplicate(checklist.pageItemId, { locale: "en" });
    const other = await duplicate(checklist.pageItemId, { locale: "de" });
    expect((await propertiesOf(english.pageItemId))?.title).toBe("Release checklist (copy)");
    expect((await propertiesOf(other.pageItemId))?.title).toBe("Release checklist (copy)");
  });

  it("keeps the suffix whole on a title at the length limit, and suffixes an empty or missing title alone", async () => {
    const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
    // " (kopie)" takes eight of the 500 places, so the original's title is cut to 492: once inside a word, once
    // right after a space, which is then dropped as well.
    const cutInWord = await subpage(project, "x".repeat(PAGE_TITLE_MAX_LENGTH));
    const cutAfterSpace = await subpage(project, `${"x".repeat(PAGE_TITLE_MAX_LENGTH - 9)} ${"y".repeat(8)}`);
    const empty = await subpage(project, "");
    // The item's title is read only for a page no block names, so this one loses its block as well as its title.
    const untitled = await subpage(project, "Soon without a title");
    const parentDocId = await docIdOf(project);
    await runInTenant(tenant, () =>
      mutateDoc(runtime, parentDocId, "user", (doc) => deleteBlocks(doc, [untitled.blockId])),
    );
    // No operation removes a title; this superuser write stands in for hand-edited data.
    await admin.query(`UPDATE items SET properties = properties - 'title' WHERE id = $1`, [untitled.pageItemId]);

    const cutInWordCopy = await duplicate(cutInWord.pageItemId);
    const cutAfterSpaceCopy = await duplicate(cutAfterSpace.pageItemId);
    const emptyCopy = await duplicate(empty.pageItemId);
    const untitledCopy = await duplicate(untitled.pageItemId, { locale: "en" });

    const cutInWordTitle = `${"x".repeat(PAGE_TITLE_MAX_LENGTH - 8)} (kopie)`;
    expect(Array.from(cutInWordTitle)).toHaveLength(PAGE_TITLE_MAX_LENGTH);
    expect((await propertiesOf(cutInWordCopy.pageItemId))?.title).toBe(cutInWordTitle);
    expect((await propertiesOf(cutAfterSpaceCopy.pageItemId))?.title).toBe(
      `${"x".repeat(PAGE_TITLE_MAX_LENGTH - 9)} (kopie)`,
    );
    expect((await propertiesOf(emptyCopy.pageItemId))?.title).toBe("(kopie)");
    expect((await propertiesOf(untitledCopy.pageItemId))?.title).toBe("(copy)");
    // The block of each copy carries the same title as its item.
    const parentTexts = (await readBlocks(project)).map((block) => block.text);
    expect(parentTexts).toContainEqual([{ insert: cutInWordTitle }]);
    expect(parentTexts).toContainEqual([{ insert: "(kopie)" }]);
    expect(parentTexts).toContainEqual([{ insert: "(copy)" }]);
  });

  it("authors every document it writes as the caller", async () => {
    const { project, checklist } = await projectWithChecklist();
    const notes = await subpage(checklist.pageItemId, "Notes");
    await appendBlocks(notes.pageItemId, [{ type: "text", text: "A note" }]);

    const copy = await duplicate(checklist.pageItemId, { origin: "ai_agent" });

    const nestedCopyId = (await readBlocks(copy.pageItemId))[0]?.pageId;
    if (!nestedCopyId) throw new Error("Missing nested copy");
    const authors = await inTenant(async (client) => {
      const copies = await client.query<{ created_by: string }>(
        `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = ANY($1::uuid[])`,
        [[copy.pageItemId, nestedCopyId]],
      );
      const parent = await client.query<{ created_by: string }>(
        `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1
         ORDER BY u.id DESC LIMIT 1`,
        [project],
      );
      return { copies: copies.rows.map((row) => row.created_by), parent: parent.rows[0]?.created_by };
    });
    expect(authors.copies).toEqual(["ai_agent", "ai_agent"]);
    expect(authors.parent).toBe("ai_agent");
  });

  it("waits for a trash of the original that is in flight and then refuses, writing nothing", async () => {
    const { checklist } = await projectWithChecklist();
    const before = await writeCounts();
    const databaseId = await databaseIdOf(checklist.pageItemId);
    await withOpenTransaction(async (holder, commit) => {
      // The open transaction has trashed the page and holds its row; the duplicate still reads it as live. The store
      // function runs on the held connection, because the choke point's trash commits in a transaction of its own.
      await softDeleteItem(holder, databaseId, checklist.pageItemId);
      const settled = Promise.allSettled([duplicate(checklist.pageItemId)]);
      await lockWait();
      await commit();
      const [outcome] = await settled;
      expect(outcome?.status).toBe("rejected");
      expect(outcome?.status === "rejected" ? outcome.reason : undefined).toBeInstanceOf(NotFoundError);
    });
    expect(await writeCounts()).toEqual(before);
  });

  it("locks the parent's row before the page's row", async () => {
    const { project, checklist } = await projectWithChecklist();
    const projectDatabaseId = await databaseIdOf(project);
    const pagesDatabaseId = await databaseIdOf(checklist.pageItemId);
    await withOpenTransaction(async (holder, commit) => {
      // The open transaction holds the parent's row, so the duplicate waits at its first lock.
      await lockItemById(holder, projectDatabaseId, project);
      const settled = Promise.allSettled([duplicate(checklist.pageItemId)]);
      await lockWait();
      // While it waits for the parent it holds no lock on the page: another transaction takes that row at once.
      const page = await inTenant((client) => lockItemByIdNowait(client, pagesDatabaseId, checklist.pageItemId));
      expect(page?.id).toBe(checklist.pageItemId);
      await commit();
      const [outcome] = await settled;
      expect(outcome?.status).toBe("fulfilled");
    });
  });
});
