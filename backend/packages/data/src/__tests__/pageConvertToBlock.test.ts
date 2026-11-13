import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import type * as Y from "yjs";
import { BLOCK_TYPES, insertBlocks, readPageBlocks, setIndent, writeBlock } from "@semprec/block-model";
import {
  PAGE_CONVERT_TARGET_TYPES,
  runInTenant,
  type PageConvertToBlockInput,
  type PageConvertToBlockOutput,
} from "@semprec/shared";
import "../domainWriteHooks.js";
import { setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import type { AgentDatabaseAccess } from "../agentGrants/agentDatabaseGrantsStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { registerItemDeleteHook } from "../chokePoint/hooks.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { loadDocWithClient, mutateDoc, mutateDocWithClient } from "../docs/docPersistence.js";
import { getDocByItemId, getOrCreateDoc } from "../docs/docsStore.js";
import {
  convertPageToBlockWithClient,
  createSubpageWithClient,
  type ConvertPageToBlockOptions,
} from "../docs/pageOperations.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
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
import { createActionQueueAffinity } from "../scheduler/actions.js";
import type { CreatedBy } from "../types.js";

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let tenant: string;

/**
 * Armed by the tests that need a trash which leaves the recorded position of the page unusable. Hooks cannot be
 * unregistered, so this one runs for every trash of the file and does nothing unless a test armed it. It is registered
 * after the domain hooks, so the position `pageItemDeleteHook` recorded exists when it runs.
 */
let tamperWithRecordedPosition: ((doc: Y.Doc, pageId: string) => void) | null = null;
registerItemDeleteHook(async ({ client, item }) => {
  const tamper = tamperWithRecordedPosition;
  if (tamper === null) return;
  const parentItemId: unknown = item.properties.parentItemId;
  if (typeof parentItemId !== "string") return;
  const parentDoc = await getDocByItemId(client, parentItemId);
  if (!parentDoc) return;
  await mutateDocWithClient(client, parentDoc.id, "system", (doc) => tamper(doc, item.id));
});

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  chokePoint = createChokePoint(runtime);
});
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  tamperWithRecordedPosition = null;
  await runInTenant(tenant, () => seedSystem(runtime));
});
afterEach(async () => {
  tamperWithRecordedPosition = null;
  await admin.query("DROP TRIGGER IF EXISTS fail_page_convert_test ON doc_updates");
  await admin.query("DROP FUNCTION IF EXISTS fail_page_convert_test()");
  await admin.query("DROP TABLE IF EXISTS fail_page_convert_test_docs");
});
afterAll(async () => {
  const results = await Promise.allSettled([runtime?.end(), admin?.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
});

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

/** A plain item of a database of its own: the host whose notes hold the subpages under test. */
async function createHost(tenantId = tenant): Promise<{ itemId: string; databaseId: string }> {
  return runInTenant(tenantId, async () => {
    const database = await chokePoint.createDatabase({ name: `Hosts ${randomUUID()}` });
    const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
    return { itemId: item.id, databaseId: database.id };
  });
}

interface Subpage {
  pageItemId: string;
  blockId: string;
}

async function createSubpage(parentItemId: string, title: string, afterBlockId?: string): Promise<Subpage> {
  const created = await inTenant((client) =>
    createSubpageWithClient(client, { parent: { itemId: parentItemId }, title, afterBlockId }, "user"),
  );
  const page = created.pages[0];
  if (!page) throw new Error("Missing created page");
  return page;
}

interface BlockView {
  id: string | null;
  type: string;
  pageId: string | null;
  indent: number;
  done: boolean;
  text: string;
}

interface DocumentView {
  blocks: BlockView[];
  trashedPages: Record<string, unknown>;
}

async function docIdOf(itemId: string): Promise<string> {
  const doc = await inTenant((client) => getDocByItemId(client, itemId));
  if (!doc) throw new Error(`Item ${itemId} has no document`);
  return doc.id;
}

/** The stored blocks of an item's page in document order, and its `trashedPages` map. */
async function readDocument(itemId: string): Promise<DocumentView> {
  const docId = await docIdOf(itemId);
  return inTenant(async (client) => {
    const doc = await loadDocWithClient(client, docId);
    try {
      return {
        blocks: readPageBlocks(doc)
          .filter((block) => !block.synthetic)
          .map(({ id, type, pageId, indent, done, text }) => ({
            id,
            type,
            pageId,
            indent,
            done,
            text: text.map((run) => run.insert).join(""),
          })),
        trashedPages: doc.getMap<unknown>("trashedPages").toJSON(),
      };
    } finally {
      doc.destroy();
    }
  });
}

/** An edit of an item's page as an editor makes it over the sync socket, outside the page operations. */
async function editDocument(itemId: string, edit: (doc: Y.Doc) => void): Promise<void> {
  const docId = await docIdOf(itemId);
  await runInTenant(tenant, () => mutateDoc(runtime, docId, "user", edit));
}

/** The authors of the stored updates of an item's page, oldest first. */
async function updateAuthors(itemId: string): Promise<string[]> {
  const docId = await docIdOf(itemId);
  const { rows } = await inTenant((client) =>
    client.query<{ created_by: string }>(`SELECT created_by FROM doc_updates WHERE doc_id = $1 ORDER BY id`, [docId]),
  );
  return rows.map((row) => row.created_by);
}

/** Whether each item is live, in the order given; a missing row fails the test. */
async function liveStates(...itemIds: string[]): Promise<boolean[]> {
  return runInTenant(tenant, async () => {
    const states: boolean[] = [];
    for (const itemId of itemIds) {
      const item = await chokePoint.findItemIncludingDeleted(itemId);
      if (!item) throw new Error(`Item ${itemId} does not exist`);
      states.push(item.deletedAt === null);
    }
    return states;
  });
}

async function titleOf(itemId: string): Promise<unknown> {
  const { rows } = await inTenant((client) =>
    client.query<{ title: unknown }>(`SELECT properties->'title' AS title FROM items WHERE id = $1`, [itemId]),
  );
  return rows[0]?.title;
}

function convert(
  input: Omit<PageConvertToBlockInput, "type"> & { type?: PageConvertToBlockInput["type"] },
  options: Partial<ConvertPageToBlockOptions> = {},
): Promise<PageConvertToBlockOutput> {
  return inTenant((client) =>
    convertPageToBlockWithClient(
      client,
      { type: "text", ...input },
      { origin: "user", writer: { writerKind: "user" }, ...options },
    ),
  );
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to be rejected");
}

/** Everything a refused conversion must leave as it was: the live states and the parent's document with its updates. */
async function snapshotOf(parentItemId: string, pageItemIds: string[]): Promise<unknown> {
  return {
    live: await liveStates(...pageItemIds),
    document: await readDocument(parentItemId),
    authors: await updateAuthors(parentItemId),
  };
}

/** A host whose notes hold the text blocks `first` and `second`, with the ids of both. */
async function hostWithTwoBlocks(): Promise<{ host: string; first: string; second: string; databaseId: string }> {
  const { itemId: host, databaseId } = await createHost();
  await runInTenant(tenant, () => writePageTextBlocks(runtime, host, ["first", "second"]));
  const [first, second] = (await readDocument(host)).blocks.map((block) => block.id);
  if (!first || !second) throw new Error("Missing seed blocks");
  return { host, first, second, databaseId };
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
    if (Date.now() > deadline) throw new Error("The conversion never waited for a lock");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Makes the later stored updates of `itemId`'s page that `author` writes fail inside the database. */
async function failDocumentWritesOf(itemId: string, author: CreatedBy): Promise<void> {
  const docId = await docIdOf(itemId);
  // Fault injection inside the document write itself: no production input makes the append fail. The document id and
  // the author reach the trigger through a scratch table, not interpolated into its body.
  await admin.query("CREATE TABLE fail_page_convert_test_docs (doc_id uuid PRIMARY KEY, created_by text NOT NULL)");
  await admin.query("INSERT INTO fail_page_convert_test_docs (doc_id, created_by) VALUES ($1, $2)", [docId, author]);
  await admin.query("GRANT SELECT ON fail_page_convert_test_docs TO PUBLIC");
  await admin.query(`CREATE FUNCTION fail_page_convert_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM fail_page_convert_test_docs WHERE doc_id = NEW.doc_id AND created_by = NEW.created_by::text
      ) THEN
        RAISE EXCEPTION 'page document write failure';
      END IF;
      RETURN NEW;
    END $$`);
  await admin.query(`CREATE TRIGGER fail_page_convert_test BEFORE INSERT ON doc_updates
    FOR EACH ROW EXECUTE FUNCTION fail_page_convert_test()`);
}

describe("page.convertToBlock (issue #1876)", () => {
  it("trashes the page with its nested page and puts a text block with the title where the page block stood", async () => {
    const { host, first, second } = await hostWithTwoBlocks();
    const checklist = await createSubpage(host, "Release checklist", first);
    const notes = await createSubpage(checklist.pageItemId, "Notes for version 0.4");
    await editDocument(host, (doc) => setIndent(doc, [checklist.blockId], 2));

    const converted = await convert({ parentItemId: host, blockId: checklist.blockId, confirmedPageCount: 2 });

    expect(converted.trashedPageCount).toBe(2);
    expect(await liveStates(checklist.pageItemId, notes.pageItemId, host)).toEqual([false, false, true]);
    const document = await readDocument(host);
    // The new block has a new id, the page block's indent and the title as its text, and stands in the page block's place.
    expect(converted.blockId).not.toBe(checklist.blockId);
    expect(document.blocks).toEqual([
      { id: first, type: "text", pageId: null, indent: 0, done: false, text: "first" },
      { id: converted.blockId, type: "text", pageId: null, indent: 2, done: false, text: "Release checklist" },
      { id: second, type: "text", pageId: null, indent: 0, done: false, text: "second" },
    ]);
    // The page's place stays recorded, so restoring the page can put its block back.
    expect(document.trashedPages).toEqual({
      [checklist.pageItemId]: { blockId: checklist.blockId, afterBlockId: first, indent: 2 },
    });
  });

  it("stands in for the first page block of a document as its first block", async () => {
    const { host, first, second } = await hostWithTwoBlocks();
    const checklist = await createSubpage(host, "Release checklist");
    await editDocument(host, (doc) => {
      // Move the page block to the start of the document: the new block has no neighbor to follow.
      const order = doc.getArray<string>("order");
      const index = order.toArray().indexOf(checklist.blockId);
      order.delete(index, 1);
      order.insert(0, [checklist.blockId]);
    });
    expect((await readDocument(host)).blocks.map((block) => block.id)).toEqual([checklist.blockId, first, second]);

    const converted = await convert({ parentItemId: host, blockId: checklist.blockId, confirmedPageCount: 1 });

    expect((await readDocument(host)).blocks.map((block) => block.id)).toEqual([converted.blockId, first, second]);
  });

  it.each([...PAGE_CONVERT_TARGET_TYPES])("creates a block of the type %s", async (type) => {
    const { host } = await hostWithTwoBlocks();
    const page = await createSubpage(host, "Typed");

    const converted = await convert({ parentItemId: host, blockId: page.blockId, type, confirmedPageCount: 1 });

    const block = (await readDocument(host)).blocks.find((candidate) => candidate.id === converted.blockId);
    expect(block).toMatchObject({ type, text: "Typed", pageId: null, done: false });
  });

  it("offers every block type of the block model except page as a target", () => {
    expect([...PAGE_CONVERT_TARGET_TYPES].sort()).toEqual(BLOCK_TYPES.filter((type) => type !== "page").sort());
  });

  it("takes the title the page block shows, not the title a lagging mirror still holds", async () => {
    const { host } = await hostWithTwoBlocks();
    const page = await createSubpage(host, "Old title");
    await editDocument(host, (doc) =>
      writeBlock(doc, { id: page.blockId, type: "page", indent: 0, pageId: page.pageItemId, text: "Fresh title" }),
    );
    expect(await titleOf(page.pageItemId)).toBe("Old title");

    const converted = await convert({ parentItemId: host, blockId: page.blockId, confirmedPageCount: 1 });

    const block = (await readDocument(host)).blocks.find((candidate) => candidate.id === converted.blockId);
    expect(block?.text).toBe("Fresh title");
  });

  it("answers 409 with the current count and changes nothing when the confirmed count is stale", async () => {
    const { host } = await hostWithTwoBlocks();
    const checklist = await createSubpage(host, "Release checklist");
    const notes = await createSubpage(checklist.pageItemId, "Notes");
    const deeper = await createSubpage(notes.pageItemId, "Deeper");
    const pages = [checklist.pageItemId, notes.pageItemId, deeper.pageItemId];
    const before = await snapshotOf(host, pages);

    // The user was shown one page less than there are now, and one page more.
    for (const confirmedPageCount of [2, 4]) {
      const error = await rejection(convert({ parentItemId: host, blockId: checklist.blockId, confirmedPageCount }));
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({
        status: 409,
        details: { reason: "page_count_mismatch", currentPageCount: 3 },
      });
      expect(await snapshotOf(host, pages)).toEqual(before);
    }
  });

  it("counts pages by the live tree, so a nested page that is already in the Trash is not counted", async () => {
    const { host } = await hostWithTwoBlocks();
    const checklist = await createSubpage(host, "Release checklist");
    const notes = await createSubpage(checklist.pageItemId, "Notes");
    await runInTenant(tenant, async () => {
      const item = await chokePoint.findItem(notes.pageItemId);
      if (!item) throw new Error("Missing notes page");
      await chokePoint.softDeleteItem(item.databaseId, notes.pageItemId);
    });

    const converted = await convert({ parentItemId: host, blockId: checklist.blockId, confirmedPageCount: 1 });

    expect(converted.trashedPageCount).toBe(1);
  });

  describe("refusals", () => {
    it("rejects a block that is not a page block", async () => {
      const { host, first } = await hostWithTwoBlocks();
      const page = await createSubpage(host, "Release checklist");
      const before = await snapshotOf(host, [page.pageItemId]);

      const error = await rejection(convert({ parentItemId: host, blockId: first, confirmedPageCount: 1 }));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, details: { field: "blockId", reason: "not_a_page_block" } });
      expect(await snapshotOf(host, [page.pageItemId])).toEqual(before);
    });

    it("rejects a block id that no block of the parent's document has", async () => {
      const { host } = await hostWithTwoBlocks();
      const page = await createSubpage(host, "Release checklist");
      const before = await snapshotOf(host, [page.pageItemId]);

      const error = await rejection(convert({ parentItemId: host, blockId: randomUUID(), confirmedPageCount: 1 }));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, details: { field: "blockId" } });
      expect(await snapshotOf(host, [page.pageItemId])).toEqual(before);
    });

    it("rejects the page block of another document, a host with no document and a host whose document is not a page", async () => {
      const first = await hostWithTwoBlocks();
      const second = await hostWithTwoBlocks();
      const firstPage = await createSubpage(first.host, "Page of the first host");
      const secondPage = await createSubpage(second.host, "Page of the second host");
      const withoutDocument = await createHost();
      const withCanvas = await createHost();
      await inTenant((client) => getOrCreateDoc(client, withCanvas.itemId, "canvas"));
      const before = await snapshotOf(second.host, [secondPage.pageItemId]);

      const ofAnotherDocument = await rejection(
        convert({ parentItemId: first.host, blockId: secondPage.blockId, confirmedPageCount: 1 }),
      );
      const noDocument = await rejection(
        convert({ parentItemId: withoutDocument.itemId, blockId: firstPage.blockId, confirmedPageCount: 1 }),
      );

      const canvasDocument = await rejection(
        convert({ parentItemId: withCanvas.itemId, blockId: firstPage.blockId, confirmedPageCount: 1 }),
      );

      for (const error of [ofAnotherDocument, noDocument, canvasDocument]) {
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ status: 400, details: { field: "blockId" } });
      }
      expect(await snapshotOf(second.host, [secondPage.pageItemId])).toEqual(before);
      expect(await liveStates(firstPage.pageItemId)).toEqual([true]);
    });

    it("rejects a page block that names no live subpage of the parent", async () => {
      const { host } = await hostWithTwoBlocks();
      const other = await hostWithTwoBlocks();
      const live = await createSubpage(host, "Live page");
      const elsewhere = await createSubpage(other.host, "Page of another parent");
      const trashed = await createSubpage(host, "Trashed page");
      await runInTenant(tenant, async () => {
        const item = await chokePoint.findItem(trashed.pageItemId);
        if (!item) throw new Error("Missing page");
        await chokePoint.softDeleteItem(item.databaseId, trashed.pageItemId);
      });
      // A page block over the names the page page operations cannot make: an editor can store any `pageId`.
      const named = {
        inTrash: trashed.pageItemId,
        ofAnotherParent: elsewhere.pageItemId,
        aHost: other.host,
        unknown: randomUUID(),
        notAnId: "not-an-id",
      };
      const blockIds: Record<keyof typeof named, string> = {
        inTrash: randomUUID(),
        ofAnotherParent: randomUUID(),
        aHost: randomUUID(),
        unknown: randomUUID(),
        notAnId: randomUUID(),
      };
      await editDocument(host, (doc) => {
        for (const key of Object.keys(named) as Array<keyof typeof named>) {
          insertBlocks(doc, null, [{ id: blockIds[key], type: "page", pageId: named[key], text: key }]);
        }
      });
      const before = await snapshotOf(host, [live.pageItemId, elsewhere.pageItemId]);

      for (const key of Object.keys(named) as Array<keyof typeof named>) {
        const error = await rejection(convert({ parentItemId: host, blockId: blockIds[key], confirmedPageCount: 1 }));
        expect(error, key).toBeInstanceOf(ValidationError);
        expect(error, key).toMatchObject({ status: 400, details: { field: "blockId", reason: "not_a_subpage" } });
      }
      expect(await snapshotOf(host, [live.pageItemId, elsewhere.pageItemId])).toEqual(before);
    });

    it("rejects a second block that names a page the first block names, because only the first block is removed with the page", async () => {
      const { host } = await hostWithTwoBlocks();
      const page = await createSubpage(host, "Release checklist");
      const second = randomUUID();
      await editDocument(host, (doc) =>
        insertBlocks(doc, page.blockId, [{ id: second, type: "page", pageId: page.pageItemId, text: "Again" }]),
      );
      const before = await snapshotOf(host, [page.pageItemId]);

      const error = await rejection(convert({ parentItemId: host, blockId: second, confirmedPageCount: 1 }));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ details: { field: "blockId", reason: "not_a_subpage" } });
      expect(await snapshotOf(host, [page.pageItemId])).toEqual(before);
      // The first block converts: it is the one the trash removes.
      const converted = await convert({ parentItemId: host, blockId: page.blockId, confirmedPageCount: 1 });
      expect(converted.trashedPageCount).toBe(1);
    });

    it("answers a trashed, an unknown and a foreign parent as one not found", async () => {
      const { host, databaseId } = await hostWithTwoBlocks();
      const page = await createSubpage(host, "Release checklist");
      const otherTenant = await createTestTenant(admin);
      const foreign = await createHost(otherTenant);
      await runInTenant(tenant, () => chokePoint.softDeleteItem(databaseId, host));

      for (const parentItemId of [host, randomUUID(), foreign.itemId]) {
        const error = await rejection(convert({ parentItemId, blockId: page.blockId, confirmedPageCount: 1 }));
        expect(error).toBeInstanceOf(NotFoundError);
        expect(error).toMatchObject({ status: 404, message: "Item not found" });
      }
    });

    it("rejects a block whose recorded place is not the block's, and a trash that recorded none, and rolls both back", async () => {
      const { host, first } = await hostWithTwoBlocks();
      const page = await createSubpage(host, "Release checklist", first);
      const before = await snapshotOf(host, [page.pageItemId]);

      // The document changed between the plan and the trash: the recorded block is another one, or nothing is recorded.
      tamperWithRecordedPosition = (doc, pageId) =>
        doc.getMap<unknown>("trashedPages").set(pageId, { blockId: "another-block", afterBlockId: null, indent: 0 });
      const other = await rejection(convert({ parentItemId: host, blockId: page.blockId, confirmedPageCount: 1 }));
      tamperWithRecordedPosition = (doc, pageId) => doc.getMap<unknown>("trashedPages").delete(pageId);
      const none = await rejection(convert({ parentItemId: host, blockId: page.blockId, confirmedPageCount: 1 }));

      for (const error of [other, none]) {
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ details: { field: "blockId", reason: "block_changed" } });
      }
      tamperWithRecordedPosition = null;
      expect(await snapshotOf(host, [page.pageItemId])).toEqual(before);
    });
  });

  it("rolls the trash back when the document write of the new block fails", async () => {
    const { host, first } = await hostWithTwoBlocks();
    const checklist = await createSubpage(host, "Release checklist", first);
    const notes = await createSubpage(checklist.pageItemId, "Notes");
    const pages = [checklist.pageItemId, notes.pageItemId];
    const before = await snapshotOf(host, pages);
    // The trash's own update of the document is authored as the writer (`ai_agent`) and goes through; the update of the
    // new block is authored `user` and fails.
    await failDocumentWritesOf(host, "user");

    const error = await rejection(
      convert(
        { parentItemId: host, blockId: checklist.blockId, confirmedPageCount: 2 },
        { origin: "user", writer: { writerKind: "agent" } },
      ),
    );

    expect(String(error)).toContain("page document write failure");
    expect(await snapshotOf(host, pages)).toEqual(before);
    expect((await readDocument(host)).trashedPages).toEqual({});
  });

  it("restores the page and its block later while the converted block stays", async () => {
    const { host, first, second } = await hostWithTwoBlocks();
    const checklist = await createSubpage(host, "Release checklist", first);
    const notes = await createSubpage(checklist.pageItemId, "Notes");
    const converted = await convert({ parentItemId: host, blockId: checklist.blockId, confirmedPageCount: 2 });

    await runInTenant(tenant, async () => {
      const item = await chokePoint.findItemIncludingDeleted(checklist.pageItemId);
      if (!item) throw new Error("Missing page");
      await chokePoint.restoreItem(item.databaseId, checklist.pageItemId);
    });

    expect(await liveStates(checklist.pageItemId, notes.pageItemId)).toEqual([true, true]);
    const document = await readDocument(host);
    // The page block comes back at its recorded place, after the block it followed; the converted block is still there.
    expect(document.blocks.map(({ id, type, text }) => ({ id, type, text }))).toEqual([
      { id: first, type: "text", text: "first" },
      { id: checklist.blockId, type: "page", text: "Release checklist" },
      { id: converted.blockId, type: "text", text: "Release checklist" },
      { id: second, type: "text", text: "second" },
    ]);
    expect(document.trashedPages).toEqual({});
  });

  it("authors the trash as the writer and the new block as the origin, and runs the trash hooks as that writer", async () => {
    const { host, first } = await hostWithTwoBlocks();
    const page = await createSubpage(host, "Release checklist", first);
    const before = await updateAuthors(host);

    await convert(
      { parentItemId: host, blockId: page.blockId, confirmedPageCount: 1 },
      { origin: "user", writer: { writerKind: "agent" } },
    );

    // The hook removing the page block is authored by the writer kind (`ai_agent`); the new block by the origin.
    expect(await updateAuthors(host)).toEqual([...before, "ai_agent", "user"]);
  });

  describe("an agent's project", () => {
    async function agentFixture(access: AgentDatabaseAccess): Promise<{
      host: string;
      page: Subpage;
      writer: WriterIdentity;
    }> {
      const { host, databaseId } = await hostWithTwoBlocks();
      const page = await createSubpage(host, "Release checklist");
      const projectItemId = await runInTenant(tenant, () => createTestProjectItem(runtime));
      await inTenant((client) => setAgentDatabaseGrant(client, { projectItemId, databaseId, access }));
      return { host, page, writer: { writerKind: "agent", agentProjectItemId: projectItemId } };
    }

    it.each<AgentDatabaseAccess>(["none", "read"])(
      "needs write access to the database that owns the parent page: %s is refused and changes nothing",
      async (access) => {
        const { host, page, writer } = await agentFixture(access);
        const before = await snapshotOf(host, [page.pageItemId]);

        const error = await rejection(
          convert({ parentItemId: host, blockId: page.blockId, confirmedPageCount: 1 }, { writer }),
        );

        expect(error).toBeInstanceOf(ForbiddenError);
        expect(await snapshotOf(host, [page.pageItemId])).toEqual(before);
      },
    );

    it("converts with write access", async () => {
      const { host, page, writer } = await agentFixture("write");

      const converted = await convert({ parentItemId: host, blockId: page.blockId, confirmedPageCount: 1 }, { writer });

      expect(converted.trashedPageCount).toBe(1);
      expect(await liveStates(page.pageItemId)).toEqual([false]);
    });
  });

  it("refuses a page that another transaction trashed after the block was read, once that transaction commits", async () => {
    const { host, first } = await hostWithTwoBlocks();
    const page = await createSubpage(host, "Release checklist", first);
    const pagesDatabaseId = await inTenant(async (client) => {
      const { rows } = await client.query<{ database_id: string }>(`SELECT database_id FROM items WHERE id = $1`, [
        page.pageItemId,
      ]);
      return rows[0]?.database_id ?? "";
    });
    let converting: Promise<unknown> = Promise.resolve(null);
    try {
      await runInTenant(tenant, () =>
        withTransaction(runtime, async (holder) => {
          // The open transaction trashes the page and holds its row; the page is still live to everyone else.
          await itemDeleteWithClient(holder, pagesDatabaseId, page.pageItemId, {
            queueAffinity: createActionQueueAffinity(),
            writer: { writerKind: "user" },
          });
          converting = convert({ parentItemId: host, blockId: page.blockId, confirmedPageCount: 1 }).then(
            () => null,
            (error: unknown) => error,
          );
          await lockWait();
        }),
      );
    } finally {
      await converting;
    }

    const error = await converting;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ details: { field: "blockId", reason: "not_a_subpage" } });
    // The page stays in the Trash once, and the document holds neither the page block nor a converted block.
    expect(await liveStates(page.pageItemId)).toEqual([false]);
    expect((await readDocument(host)).blocks.map((block) => block.type)).toEqual(["text", "text"]);
  });

  it("locks the pages below the page before it counts them, so a page created meanwhile is counted", async () => {
    const { host } = await hostWithTwoBlocks();
    const checklist = await createSubpage(host, "Release checklist");
    const notes = await createSubpage(checklist.pageItemId, "Notes");
    const pagesDatabaseId = await inTenant(async (client) => {
      const { rows } = await client.query<{ database_id: string }>(`SELECT database_id FROM items WHERE id = $1`, [
        notes.pageItemId,
      ]);
      return rows[0]?.database_id ?? "";
    });
    let converting: Promise<unknown> = Promise.resolve(null);
    try {
      // An open transaction creates a page below the nested page: it holds that page's row, and the page it creates is
      // not visible to anyone else before it commits.
      await runInTenant(tenant, () =>
        withTransaction(runtime, async (holder) => {
          await createSubpageWithClient(
            holder,
            { parent: { itemId: notes.pageItemId }, title: "Created meanwhile" },
            "user",
          );
          // The user was shown two pages: the page and the nested one.
          converting = convert({ parentItemId: host, blockId: checklist.blockId, confirmedPageCount: 2 }).then(
            () => null,
            (error: unknown) => error,
          );
          await lockWait();
        }),
      );
    } finally {
      await converting;
    }

    const error = await converting;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ details: { currentPageCount: 3 } });
    // Nothing was trashed, and the row lock of the nested page is free again.
    expect(await liveStates(checklist.pageItemId, notes.pageItemId)).toEqual([true, true]);
    expect(
      await inTenant((client) => lockItemById(client, pagesDatabaseId, notes.pageItemId).then((row) => row?.id)),
    ).toBe(notes.pageItemId);
  });
});
