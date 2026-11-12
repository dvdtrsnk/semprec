import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import type * as Y from "yjs";
import {
  deleteBlocks,
  getBlocksMap,
  getOrderArray,
  moveBlocks,
  readPageBlocks,
  setIndent,
  writeBlock,
} from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { registerItemDeleteHook, registerItemRestoreHook } from "../chokePoint/hooks.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { loadDocWithClient, mutateDoc } from "../docs/docPersistence.js";
import { createDocStore } from "../docs/docStore.js";
import { getDocByItemId } from "../docs/docsStore.js";
import { createSubpageWithClient } from "../docs/pageOperations.js";
import { ensurePagesDatabase, PAGES_MODULE_ID } from "../docs/pagesDatabase.js";
import { collectSubpageTree } from "../docs/pageTrash.js";
import { createActionQueueAffinity, type ActionQueueAffinity } from "../scheduler/actions.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  writePageTextBlocks,
} from "../testSupport/testDb.js";
import type { ItemRow } from "../types.js";

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let tenant: string;

interface RecordedHookRun {
  itemId: string;
  rootItemId: string;
  writerKind: string;
  agentRunId: string | undefined;
  actingUserId: string | undefined;
  queueAffinity?: ActionQueueAffinity;
}

// Hooks cannot be unregistered; these recorders are emptied before each test. They are registered after the domain
// hooks, so they see every row a nested trash or restore of the page hooks reaches.
const deleteRuns: RecordedHookRun[] = [];
const restoreRuns: RecordedHookRun[] = [];
registerItemDeleteHook(async ({ item, rootItemId, writerKind, agentRunId, actingUserId }) => {
  deleteRuns.push({ itemId: item.id, rootItemId, writerKind, agentRunId, actingUserId });
});
registerItemRestoreHook(async ({ item, rootItemId, writerKind, agentRunId, actingUserId, queueAffinity }) => {
  restoreRuns.push({ itemId: item.id, rootItemId, writerKind, agentRunId, actingUserId, queueAffinity });
});

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  chokePoint = createChokePoint(runtime);
});
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  deleteRuns.length = 0;
  restoreRuns.length = 0;
});
afterEach(async () => {
  await admin.query("DROP TRIGGER IF EXISTS fail_page_trash_test ON doc_updates");
  await admin.query("DROP FUNCTION IF EXISTS fail_page_trash_test()");
  await admin.query("DROP TABLE IF EXISTS fail_page_trash_test_docs");
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
async function createHost(tenantId = tenant): Promise<string> {
  return runInTenant(tenantId, async () => {
    const database = await chokePoint.createDatabase({ name: `Hosts ${randomUUID()}` });
    return (await chokePoint.createItem({ databaseId: database.id, properties: {} })).id;
  });
}

interface Subpage {
  pageItemId: string;
  blockId: string;
}

async function createSubpage(
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
  if (!page) throw new Error("Missing created page");
  return page;
}

interface TrashOptions {
  writer?: WriterIdentity;
  actingUserId?: string;
  via?: ChokePoint;
}

/** Trashes an item the way the application service does: resolve its database, then the choke point's cascade. */
async function trash(itemId: string, options: TrashOptions = {}): Promise<ItemRow | null> {
  const via = options.via ?? chokePoint;
  return runInTenant(tenant, async () => {
    const item = await via.findItemIncludingDeleted(itemId);
    if (!item) throw new Error(`Item ${itemId} does not exist`);
    return via.softDeleteItem(item.databaseId, itemId, options.actingUserId, options.writer);
  });
}

async function restore(itemId: string, options: TrashOptions = {}): Promise<ItemRow | null> {
  const via = options.via ?? chokePoint;
  return runInTenant(tenant, async () => {
    const item = await via.findItemIncludingDeleted(itemId);
    if (!item) throw new Error(`Item ${itemId} does not exist`);
    return via.restoreItem(item.databaseId, itemId, options.actingUserId, options.writer);
  });
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

/** `deleted_at` of an item as Postgres renders it, with its full precision; `null` for a live item. */
async function deletedAtExact(itemId: string): Promise<string | null> {
  const { rows } = await inTenant((client) =>
    client.query<{ deleted_at: string | null }>(`SELECT deleted_at::text AS deleted_at FROM items WHERE id = $1`, [
      itemId,
    ]),
  );
  const row = rows[0];
  if (!row) throw new Error(`Item ${itemId} does not exist`);
  return row.deleted_at;
}

interface BlockView {
  id: string | null;
  type: string;
  pageId: string | null;
  indent: number;
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
      const trashedPages: Record<string, unknown> = doc.getMap<unknown>("trashedPages").toJSON();
      return {
        blocks: readPageBlocks(doc)
          .filter((block) => !block.synthetic)
          .map(({ id, type, pageId, indent, text }) => ({
            id,
            type,
            pageId,
            indent,
            text: text.map((run) => run.insert).join(""),
          })),
        trashedPages,
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

/** A host whose notes hold the text blocks `first` and `second`, with the ids of both. */
async function hostWithTwoBlocks(): Promise<{ host: string; first: string; second: string }> {
  const host = await createHost();
  await runInTenant(tenant, () => writePageTextBlocks(runtime, host, ["first", "second"]));
  const [first, second] = (await readDocument(host)).blocks.map((block) => block.id);
  if (!first || !second) throw new Error("Missing seed blocks");
  return { host, first, second };
}

/**
 * Two subpages of `parentItemId`. `lower` is the one with the lower item id, which a trash of the parent reaches first.
 * Canonical UUID strings compare like the `uuid` values Postgres orders by.
 */
async function twoSubpagesOf(parentItemId: string): Promise<{ lower: Subpage; higher: Subpage }> {
  const a = await createSubpage(parentItemId, "Subpage A");
  const b = await createSubpage(parentItemId, "Subpage B");
  const [lower, higher] = a.pageItemId < b.pageItemId ? [a, b] : [b, a];
  return { lower, higher };
}

/** How long a test waits for a step of a concurrent scenario before it fails instead of hanging. */
const WAIT_MS = 15_000;

function withinWait<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not happen within ${WAIT_MS} ms`)), WAIT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Rejects as soon as `write` settles: a write that should still be in flight has finished, or it failed. */
function settledEarly(write: Promise<unknown>, label: string): Promise<never> {
  return write.then((): never => {
    throw new Error(`${label} finished before it was expected to`);
  });
}

/** Makes every later stored update of `itemId`'s page fail inside the database. */
async function failDocumentWritesOf(itemId: string): Promise<void> {
  const docId = await docIdOf(itemId);
  // Fault injection inside the document write itself: no production input makes the append fail. The document id
  // reaches the trigger through a scratch table, not interpolated into its body.
  await admin.query("CREATE TABLE fail_page_trash_test_docs (doc_id uuid PRIMARY KEY)");
  await admin.query("INSERT INTO fail_page_trash_test_docs (doc_id) VALUES ($1)", [docId]);
  await admin.query("GRANT SELECT ON fail_page_trash_test_docs TO PUBLIC");
  await admin.query(`CREATE FUNCTION fail_page_trash_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM fail_page_trash_test_docs WHERE doc_id = NEW.doc_id) THEN
        RAISE EXCEPTION 'page document write failure';
      END IF;
      RETURN NEW;
    END $$`);
  await admin.query(`CREATE TRIGGER fail_page_trash_test BEFORE INSERT ON doc_updates
    FOR EACH ROW EXECUTE FUNCTION fail_page_trash_test()`);
}

describe("page trash and restore hooks (issue #1723)", () => {
  it("trashes a subpage with its nested page, takes its block out of the host's notes and records where it stood", async () => {
    const { host, first, second } = await hostWithTwoBlocks();
    const checklist = await createSubpage(host, "Release checklist", first);
    const notes = await createSubpage(checklist.pageItemId, "Notes for version 0.4");

    const trashed = await trash(checklist.pageItemId);

    expect(trashed).toMatchObject({ id: checklist.pageItemId });
    expect(await liveStates(checklist.pageItemId, notes.pageItemId, host)).toEqual([false, false, true]);
    // One transaction, so both pages carry one timestamp at the column's full precision.
    const epoch = await deletedAtExact(checklist.pageItemId);
    expect(epoch).not.toBeNull();
    expect(await deletedAtExact(notes.pageItemId)).toBe(epoch);

    const hostNotes = await readDocument(host);
    expect(hostNotes.blocks.map((block) => block.id)).toEqual([first, second]);
    expect(hostNotes.trashedPages).toEqual({
      [checklist.pageItemId]: { blockId: checklist.blockId, afterBlockId: first, indent: 0 },
    });
    // The nested page's block was the only block of its parent, so that document keeps one empty text block.
    const checklistPage = await readDocument(checklist.pageItemId);
    expect(checklistPage.blocks.map(({ type, pageId, text }) => ({ type, pageId, text }))).toEqual([
      { type: "text", pageId: null, text: "" },
    ]);
    expect(checklistPage.trashedPages).toEqual({
      [notes.pageItemId]: { blockId: notes.blockId, afterBlockId: null, indent: 0 },
    });
  });

  it("restores the subpage with its nested page and puts both blocks back where they stood", async () => {
    const { host, first, second } = await hostWithTwoBlocks();
    const checklist = await createSubpage(host, "Release checklist", first);
    const notes = await createSubpage(checklist.pageItemId, "Notes for version 0.4");
    await editDocument(host, (doc) => setIndent(doc, [checklist.blockId], 2));
    await trash(checklist.pageItemId);

    const restored = await restore(checklist.pageItemId);

    expect(restored).toMatchObject({ id: checklist.pageItemId, deletedAt: null });
    expect(await liveStates(checklist.pageItemId, notes.pageItemId)).toEqual([true, true]);
    const hostNotes = await readDocument(host);
    expect(hostNotes.blocks).toEqual([
      { id: first, type: "text", pageId: null, indent: 0, text: "first" },
      { id: checklist.blockId, type: "page", pageId: checklist.pageItemId, indent: 2, text: "Release checklist" },
      { id: second, type: "text", pageId: null, indent: 0, text: "second" },
    ]);
    expect(hostNotes.trashedPages).toEqual({});
    const checklistPage = await readDocument(checklist.pageItemId);
    expect(checklistPage.blocks.filter((block) => block.type === "page")).toEqual([
      { id: notes.blockId, type: "page", pageId: notes.pageItemId, indent: 0, text: "Notes for version 0.4" },
    ]);
    expect(checklistPage.trashedPages).toEqual({});
  });

  it("puts a block that stood first back at the start of the parent document", async () => {
    const host = await createHost();
    const page = await createSubpage(host, "Opening page");
    await editDocument(host, (doc) => writeBlock(doc, { id: "tail", type: "text", text: "tail" }));
    await trash(page.pageItemId);
    expect((await readDocument(host)).blocks.map((block) => block.id)).toEqual(["tail"]);

    await restore(page.pageItemId);

    expect((await readDocument(host)).blocks.map((block) => block.id)).toEqual([page.blockId, "tail"]);
  });

  it("puts the block at the end of the parent document when its recorded neighbor is gone", async () => {
    const { host, first, second } = await hostWithTwoBlocks();
    const page = await createSubpage(host, "Release checklist", first);
    await trash(page.pageItemId);
    await editDocument(host, (doc) => deleteBlocks(doc, [first]));

    await restore(page.pageItemId);

    const hostNotes = await readDocument(host);
    expect(hostNotes.blocks.map((block) => block.id)).toEqual([second, page.blockId]);
    expect(hostNotes.blocks[1]).toMatchObject({ type: "page", pageId: page.pageItemId, text: "Release checklist" });
    expect(hostNotes.trashedPages).toEqual({});
  });

  it.each([
    { name: "in the order of their ids", lowerIdFirst: true },
    { name: "against the order of their ids", lowerIdFirst: false },
  ])(
    "puts two adjacent subpage blocks that stand $name back where they stood when their page is restored",
    async ({ lowerIdFirst }) => {
      const host = await createHost();
      const page = await createSubpage(host, "Release checklist");
      const { lower, higher } = await twoSubpagesOf(page.pageItemId);
      await runInTenant(tenant, () => writePageTextBlocks(runtime, page.pageItemId, ["intro", "outro"]));
      const [intro, outro] = (await readDocument(page.pageItemId)).blocks
        .filter((block) => block.type === "text")
        .map((block) => block.id);
      if (!intro || !outro) throw new Error("Missing seed blocks");
      const [one, other] = lowerIdFirst ? [lower, higher] : [higher, lower];
      // The editor drags both page blocks between the two text blocks.
      await editDocument(page.pageItemId, (doc) => {
        moveBlocks(doc, [one.blockId], intro);
        moveBlocks(doc, [other.blockId], one.blockId);
      });
      const before = await readDocument(page.pageItemId);
      expect(before.blocks.map((block) => block.id)).toEqual([intro, one.blockId, other.blockId, outro]);

      await trash(page.pageItemId);

      const trashedPage = await readDocument(page.pageItemId);
      expect(trashedPage.blocks.map((block) => block.id)).toEqual([intro, outro]);
      expect(Object.keys(trashedPage.trashedPages).sort()).toEqual([lower.pageItemId, higher.pageItemId]);

      await restore(page.pageItemId);

      expect(await liveStates(page.pageItemId, lower.pageItemId, higher.pageItemId)).toEqual([true, true, true]);
      expect(await readDocument(page.pageItemId)).toEqual(before);
    },
  );

  it.each([
    { name: "the trashed page", nested: false },
    { name: "a subpage of the trashed page", nested: true },
  ])(
    "trashes a page while the later of two subpages of $name is being trashed on its own, and both trashes finish",
    async ({ nested }) => {
      const host = await createHost();
      const root = await createSubpage(host, "Release checklist");
      // The page whose two subpages are under test: the trashed page itself, or its only subpage.
      const parent = nested ? await createSubpage(root.pageItemId, "Chapter") : root;
      const { lower, higher } = await twoSubpagesOf(parent.pageItemId);
      const pagesDatabaseId = (await runInTenant(tenant, () => chokePoint.findItem(higher.pageItemId)))?.databaseId;
      if (!pagesDatabaseId) throw new Error("Missing Pages database");

      let rowLocked: (pid: number) => void = () => undefined;
      const lockedBy = new Promise<number>((resolve) => {
        rowLocked = resolve;
      });
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The trash of the later subpage on its own, held right after the first lock it takes, the one on its own row.
      const subpageTrash = inTenant(async (client) => {
        await lockItemById(client, pagesDatabaseId, higher.pageItemId);
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = rows[0]?.pid;
        if (pid === undefined) throw new Error("No backend pid");
        rowLocked(pid);
        await released;
        return itemDeleteWithClient(client, pagesDatabaseId, higher.pageItemId, {
          queueAffinity: createActionQueueAffinity(),
          writer: { writerKind: "user" },
        });
      });
      let pageTrash: Promise<ItemRow | null> | undefined;
      try {
        const holder = await withinWait(
          Promise.race([lockedBy, settledEarly(subpageTrash, "The trash of the subpage")]),
          "The row lock of the subpage",
        );
        const started = trash(root.pageItemId);
        pageTrash = started;
        // The trash of the page has reached the subpage's row and waits for the transaction that holds it.
        await Promise.race([
          vi.waitFor(
            async () => {
              const { rows } = await admin.query<{ waiting: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
                [holder],
              );
              expect(rows[0]?.waiting).toBe(true);
            },
            { timeout: WAIT_MS, interval: 20 },
          ),
          settledEarly(started, "The trash of the page"),
        ]);
        release();
        // A wait cycle between the two ends with PostgreSQL aborting one of them (40P01, deadlock detected).
        await withinWait(Promise.all([subpageTrash, started]), "The end of both trashes");
      } finally {
        release();
        await Promise.allSettled([subpageTrash, pageTrash]);
      }

      expect(await liveStates(root.pageItemId, parent.pageItemId, lower.pageItemId, higher.pageItemId)).toEqual([
        false,
        false,
        false,
        false,
      ]);
      // The subpage trashed on its own committed first and keeps its own epoch; the page's trash left it out.
      const epoch = await deletedAtExact(root.pageItemId);
      expect(await deletedAtExact(parent.pageItemId)).toBe(epoch);
      expect(await deletedAtExact(lower.pageItemId)).toBe(epoch);
      expect(await deletedAtExact(higher.pageItemId)).not.toBe(epoch);
      const parentPage = await readDocument(parent.pageItemId);
      expect(parentPage.blocks.filter((block) => block.type === "page")).toEqual([]);
      expect(Object.keys(parentPage.trashedPages).sort()).toEqual([lower.pageItemId, higher.pageItemId]);
    },
  );

  it("leaves a nested page in the Trash when it was trashed earlier on its own", async () => {
    const host = await createHost();
    const parent = await createSubpage(host, "Release checklist");
    const nested = await createSubpage(parent.pageItemId, "Old notes");
    await trash(nested.pageItemId);
    const nestedEpoch = await deletedAtExact(nested.pageItemId);
    await trash(parent.pageItemId);
    expect(await deletedAtExact(parent.pageItemId)).not.toBe(nestedEpoch);

    await restore(parent.pageItemId);

    expect(await liveStates(parent.pageItemId, nested.pageItemId)).toEqual([true, false]);
    expect(await deletedAtExact(nested.pageItemId)).toBe(nestedEpoch);
    const parentPage = await readDocument(parent.pageItemId);
    expect(parentPage.blocks.filter((block) => block.type === "page")).toEqual([]);
    expect(Object.keys(parentPage.trashedPages)).toEqual([nested.pageItemId]);
    const hostPages = (await readDocument(host)).blocks.filter((block) => block.type === "page");
    expect(hostPages.map((block) => block.pageId)).toEqual([parent.pageItemId]);
  });

  it("puts a nested page restored on its own back into its trashed parent, and the parent's restore adds no second block", async () => {
    const host = await createHost();
    const parent = await createSubpage(host, "Release checklist");
    const nested = await createSubpage(parent.pageItemId, "Notes");
    await trash(parent.pageItemId);

    await restore(nested.pageItemId);

    expect(await liveStates(parent.pageItemId, nested.pageItemId)).toEqual([false, true]);
    const pagesOf = async (itemId: string) =>
      (await readDocument(itemId)).blocks.filter((block) => block.type === "page").map((block) => block.id);
    expect(await pagesOf(parent.pageItemId)).toEqual([nested.blockId]);
    expect(await pagesOf(host)).toEqual([]);

    await restore(parent.pageItemId);

    expect(await liveStates(parent.pageItemId, nested.pageItemId)).toEqual([true, true]);
    expect(await pagesOf(parent.pageItemId)).toEqual([nested.blockId]);
    expect(await pagesOf(host)).toEqual([parent.blockId]);
  });

  it("rolls the whole trash back when a document write fails: every page stays live and every block stays", async () => {
    const { host, first } = await hostWithTwoBlocks();
    const parent = await createSubpage(host, "Release checklist", first);
    const nested = await createSubpage(parent.pageItemId, "Notes");
    const before = {
      host: await readDocument(host),
      parent: await readDocument(parent.pageItemId),
      hostUpdates: await updateAuthors(host),
      parentUpdates: await updateAuthors(parent.pageItemId),
    };
    // The host's document is written last, after the nested page was trashed and taken out of its parent.
    await failDocumentWritesOf(host);

    await expect(trash(parent.pageItemId)).rejects.toThrow("page document write failure");

    expect(await liveStates(parent.pageItemId, nested.pageItemId)).toEqual([true, true]);
    expect({
      host: await readDocument(host),
      parent: await readDocument(parent.pageItemId),
      hostUpdates: await updateAuthors(host),
      parentUpdates: await updateAuthors(parent.pageItemId),
    }).toEqual(before);
  });

  it("rolls the whole restore back when a document write fails: every page stays in the Trash", async () => {
    const host = await createHost();
    const parent = await createSubpage(host, "Release checklist");
    const nested = await createSubpage(parent.pageItemId, "Notes");
    await trash(parent.pageItemId);
    const before = {
      epochs: [await deletedAtExact(parent.pageItemId), await deletedAtExact(nested.pageItemId)],
      host: await readDocument(host),
      parent: await readDocument(parent.pageItemId),
    };
    await failDocumentWritesOf(host);

    await expect(restore(parent.pageItemId)).rejects.toThrow("page document write failure");

    expect({
      epochs: [await deletedAtExact(parent.pageItemId), await deletedAtExact(nested.pageItemId)],
      host: await readDocument(host),
      parent: await readDocument(parent.pageItemId),
    }).toEqual(before);
    expect(before.epochs[0]).not.toBeNull();
  });

  it.each([
    { name: "a user", writer: { writerKind: "user" } satisfies WriterIdentity, author: "user" },
    { name: "an agent", writer: { writerKind: "agent" } satisfies WriterIdentity, author: "ai_agent" },
    { name: "no named writer", writer: undefined, author: "system" },
  ])("authors the document updates of a trash and a restore by $name as $author", async ({ writer, author }) => {
    const host = await createHost();
    const parent = await createSubpage(host, "Release checklist");
    await createSubpage(parent.pageItemId, "Notes");

    await trash(parent.pageItemId, { writer });

    // Each page was created by one `user` update; the trash appended one update to each parent document.
    expect(await updateAuthors(host)).toEqual(["user", author]);
    expect(await updateAuthors(parent.pageItemId)).toEqual(["user", author]);

    await restore(parent.pageItemId, { writer });

    expect(await updateAuthors(host)).toEqual(["user", author, author]);
    expect(await updateAuthors(parent.pageItemId)).toEqual(["user", author, author]);
  });

  it("trashes and restores the nested page as the same writer and acting user, and restores it with the caller's queue routing", async () => {
    const queueAffinity: ActionQueueAffinity = new Map();
    const via = createChokePoint(runtime, undefined, undefined, queueAffinity);
    const writer: WriterIdentity = { writerKind: "agent", agentRunId: randomUUID() };
    const actingUserId = randomUUID();
    const host = await createHost();
    const parent = await createSubpage(host, "Release checklist");
    const nested = await createSubpage(parent.pageItemId, "Notes");

    await trash(parent.pageItemId, { via, writer, actingUserId });

    expect(deleteRuns.find((run) => run.itemId === nested.pageItemId)).toEqual({
      itemId: nested.pageItemId,
      rootItemId: nested.pageItemId,
      writerKind: "agent",
      agentRunId: writer.agentRunId,
      actingUserId,
    });

    await restore(parent.pageItemId, { via, writer, actingUserId });

    const nestedRestore = restoreRuns.find((run) => run.itemId === nested.pageItemId);
    expect(nestedRestore).toMatchObject({
      rootItemId: nested.pageItemId,
      writerKind: "agent",
      agentRunId: writer.agentRunId,
      actingUserId,
    });
    expect(nestedRestore?.queueAffinity).toBe(queueAffinity);
  });

  it("writes nothing to a parent document that holds no block for the page, and a restore then adds the block", async () => {
    const host = await createHost();
    const page = await createSubpage(host, "Orphan");
    // The editor removed the block over the sync socket, which leaves the page without a block and the document empty.
    await editDocument(host, (doc) => {
      getBlocksMap(doc).delete(page.blockId);
      const order = getOrderArray(doc);
      order.delete(0, order.length);
    });
    const updatesBefore = await updateAuthors(host);

    await trash(page.pageItemId);

    expect(await liveStates(page.pageItemId)).toEqual([false]);
    expect(await updateAuthors(host)).toEqual(updatesBefore);
    expect((await readDocument(host)).trashedPages).toEqual({});

    await restore(page.pageItemId);

    const hostNotes = await readDocument(host);
    expect(hostNotes.blocks).toEqual([
      { id: expect.any(String), type: "page", pageId: page.pageItemId, indent: 0, text: "Orphan" },
    ]);
    expect(hostNotes.blocks[0]?.id).not.toBe(page.blockId);
  });

  it("inserts no second block when the parent document already holds one for the page", async () => {
    const { host, first, second } = await hostWithTwoBlocks();
    const page = await createSubpage(host, "Release checklist", first);
    await trash(page.pageItemId);
    await editDocument(host, (doc) =>
      writeBlock(doc, { id: "by-hand", type: "page", pageId: page.pageItemId, text: "Put back by hand" }),
    );

    await restore(page.pageItemId);

    const hostNotes = await readDocument(host);
    expect(hostNotes.blocks.map((block) => block.id)).toEqual([first, second, "by-hand"]);
    expect(hostNotes.trashedPages).toEqual({});
    expect(await liveStates(page.pageItemId)).toEqual([true]);
  });

  it("removes and records only the first of several blocks that name the page, and a restore then adds none", async () => {
    const { host, first, second } = await hostWithTwoBlocks();
    const page = await createSubpage(host, "Release checklist", first);
    await editDocument(host, (doc) =>
      writeBlock(doc, { id: "copy", type: "page", pageId: page.pageItemId, text: "Pasted copy" }),
    );
    expect((await readDocument(host)).blocks.map((block) => block.id)).toEqual([first, page.blockId, second, "copy"]);

    await trash(page.pageItemId);

    const trashedNotes = await readDocument(host);
    expect(trashedNotes.blocks.map((block) => block.id)).toEqual([first, second, "copy"]);
    expect(trashedNotes.trashedPages).toEqual({
      [page.pageItemId]: { blockId: page.blockId, afterBlockId: first, indent: 0 },
    });

    await restore(page.pageItemId);

    const restoredNotes = await readDocument(host);
    expect(restoredNotes.blocks.map((block) => block.id)).toEqual([first, second, "copy"]);
    expect(restoredNotes.trashedPages).toEqual({});
  });

  it("gives the restored block a new id when another block has taken the recorded one", async () => {
    const { host, first, second } = await hostWithTwoBlocks();
    const page = await createSubpage(host, "Release checklist", first);
    await trash(page.pageItemId);
    await editDocument(host, (doc) => writeBlock(doc, { id: page.blockId, type: "text", text: "reused id" }));

    await restore(page.pageItemId);

    const blocks = (await readDocument(host)).blocks;
    expect(blocks.map(({ id, type }) => (type === "page" ? "page" : id))).toEqual([
      first,
      "page",
      second,
      page.blockId,
    ]);
    expect(blocks[1]).toMatchObject({ pageId: page.pageItemId, text: "Release checklist" });
    expect(blocks[1]?.id).not.toBe(page.blockId);
  });

  it.each<{ name: string; entry: (recorded: { blockId: string; first: string }) => unknown }>([
    { name: "a block id that is not a string", entry: ({ first }) => ({ blockId: 7, afterBlockId: first, indent: 3 }) },
    { name: "an empty block id", entry: ({ first }) => ({ blockId: "", afterBlockId: first, indent: 3 }) },
    {
      name: "a neighbor that is neither a string nor null",
      entry: ({ blockId }) => ({ blockId, afterBlockId: 5, indent: 3 }),
    },
    {
      name: "an indent outside the allowed range",
      entry: ({ blockId, first }) => ({ blockId, afterBlockId: first, indent: 9 }),
    },
    {
      name: "a negative indent",
      entry: ({ blockId, first }) => ({ blockId, afterBlockId: first, indent: -1 }),
    },
    {
      name: "an indent that is not an integer",
      entry: ({ blockId, first }) => ({ blockId, afterBlockId: first, indent: 1.5 }),
    },
    { name: "a value that is not an object", entry: () => "first" },
  ])(
    "treats a trashedPages entry with $name as no record: the block goes to the end with a new id and no indent",
    async ({ entry }) => {
      const { host, first, second } = await hostWithTwoBlocks();
      const page = await createSubpage(host, "Release checklist", first);
      await editDocument(host, (doc) => setIndent(doc, [page.blockId], 3));
      await trash(page.pageItemId);
      // A synced document can hold anything under this key; the editor's write stands in for such a client.
      await editDocument(host, (doc) =>
        doc.getMap<unknown>("trashedPages").set(page.pageItemId, entry({ blockId: page.blockId, first })),
      );

      await restore(page.pageItemId);

      const hostNotes = await readDocument(host);
      expect(hostNotes.blocks).toEqual([
        { id: first, type: "text", pageId: null, indent: 0, text: "first" },
        { id: second, type: "text", pageId: null, indent: 0, text: "second" },
        { id: expect.any(String), type: "page", pageId: page.pageItemId, indent: 0, text: "Release checklist" },
      ]);
      expect(hostNotes.blocks[2]?.id).not.toBe(page.blockId);
      expect(hostNotes.trashedPages).toEqual({});
    },
  );

  it("trashes and restores a page whose parent was purged with its document", async () => {
    const host = await createHost();
    const page = await createSubpage(host, "Survivor");
    await runInTenant(tenant, async () => {
      const hostItem = await chokePoint.findItem(host);
      if (!hostItem) throw new Error("Missing host");
      await chokePoint.softDeleteItem(hostItem.databaseId, host);
      // A cutoff far in the future makes the host just trashed eligible for the purge.
      const purged = await chokePoint.purgeExpiredTrashSubtree(host, new Date("2999-01-01T00:00:00Z"));
      expect(purged.purgedItemIds).toEqual([host]);
    });
    expect(await inTenant((client) => getDocByItemId(client, host))).toBeNull();
    // The host's trash took the page with it (issue #1763), and the purge of the host left the page in the Trash.
    expect(await liveStates(page.pageItemId)).toEqual([false]);

    expect(await restore(page.pageItemId)).toMatchObject({ id: page.pageItemId, deletedAt: null });
    expect(await liveStates(page.pageItemId)).toEqual([true]);

    expect(await trash(page.pageItemId)).toMatchObject({ id: page.pageItemId });
    expect(await liveStates(page.pageItemId)).toEqual([false]);

    expect(await restore(page.pageItemId)).toMatchObject({ id: page.pageItemId, deletedAt: null });
    expect(await inTenant((client) => getDocByItemId(client, host))).toBeNull();
  });

  it("leaves a canvas document of the parent alone", async () => {
    const host = await createHost();
    await runInTenant(tenant, () =>
      createDocStore(runtime).putCanvasElement(
        host,
        { id: "shape-1", type: "shape", xywh: [0, 0, 10, 10], index: "a0" },
        "user",
      ),
    );
    // Page operations refuse a parent with a canvas document, so this page is written through the choke point as the
    // `pages` owner; it stands for a parent whose document is not a page.
    const page = await inTenant(async (client) => {
      const pagesDatabase = await ensurePagesDatabase(client);
      return createItemWithClient(
        client,
        { databaseId: pagesDatabase.id, properties: { title: "On a canvas", parentItemId: host } },
        { allowedSystemKeys: ["title", "parentItemId"], systemOwnerProcess: PAGES_MODULE_ID },
      );
    });
    const updatesBefore = await updateAuthors(host);

    await trash(page.id);
    await restore(page.id);

    expect(await liveStates(page.id)).toEqual([true]);
    expect(await updateAuthors(host)).toEqual(updatesBefore);
    expect(await runInTenant(tenant, () => createDocStore(runtime).listCanvasElements(host))).toHaveLength(1);
  });

  it("trashes and restores a page whose stored parentItemId is not an item id without touching a document", async () => {
    const host = await createHost();
    const page = await createSubpage(host, "Detached");
    // No operation reparents a page; this superuser write stands in for corrupted data the hooks must survive.
    await admin.query(
      `UPDATE items SET properties = jsonb_set(properties, '{parentItemId}', to_jsonb($2::text)) WHERE id = $1`,
      [page.pageItemId, "not-an-item-id"],
    );
    const before = { notes: await readDocument(host), updates: await updateAuthors(host) };

    await trash(page.pageItemId);
    expect(await liveStates(page.pageItemId)).toEqual([false]);
    await restore(page.pageItemId);

    expect(await liveStates(page.pageItemId)).toEqual([true]);
    expect({ notes: await readDocument(host), updates: await updateAuthors(host) }).toEqual(before);
  });

  it("puts the block back with empty text when the stored title is not a string", async () => {
    const host = await createHost();
    const page = await createSubpage(host, "Release checklist");
    await trash(page.pageItemId);
    // The choke point stores a title as text; this superuser write stands in for corrupted data.
    await admin.query(`UPDATE items SET properties = jsonb_set(properties, '{title}', '42'::jsonb) WHERE id = $1`, [
      page.pageItemId,
    ]);

    await restore(page.pageItemId);

    expect((await readDocument(host)).blocks[0]).toMatchObject({
      id: page.blockId,
      type: "page",
      pageId: page.pageItemId,
      text: "",
    });
  });

  it("does not act on an item of another database: its trash keeps a block that names it and its restore adds none", async () => {
    const host = await createHost();
    const other = await runInTenant(tenant, async () => {
      const database = await chokePoint.createDatabase({ name: "Not pages" });
      await chokePoint.createProperty({
        databaseId: database.id,
        key: "parentItemId",
        name: "Parent",
        type: "text",
      });
      return chokePoint.createItem({ databaseId: database.id, properties: { parentItemId: host } });
    });
    await runInTenant(tenant, () => writePageTextBlocks(runtime, host, ["first"]));
    await editDocument(host, (doc) =>
      writeBlock(doc, { id: "link", type: "page", pageId: other.id, text: "Not a subpage" }),
    );
    const withLink = { notes: await readDocument(host), updates: await updateAuthors(host) };

    await trash(other.id);

    expect(await liveStates(other.id)).toEqual([false]);
    expect({ notes: await readDocument(host), updates: await updateAuthors(host) }).toEqual(withLink);

    // With the block gone, a restore hook that acted on this item would put a block back.
    await editDocument(host, (doc) => deleteBlocks(doc, ["link"]));
    const withoutLink = { notes: await readDocument(host), updates: await updateAuthors(host) };

    await restore(other.id);

    expect(await liveStates(other.id)).toEqual([true]);
    expect({ notes: await readDocument(host), updates: await updateAuthors(host) }).toEqual(withoutLink);
  });
});

describe("collectSubpageTree (issue #1723)", () => {
  function tree(rootItemId: string, tenantId = tenant): Promise<string[]> {
    return inTenant((client) => collectSubpageTree(client, rootItemId), tenantId);
  }

  it("returns all three pages below a page with two subpages, one of which has a nested page", async () => {
    const host = await createHost();
    const root = await createSubpage(host, "Release checklist");
    const a = await createSubpage(root.pageItemId, "A");
    const b = await createSubpage(root.pageItemId, "B");
    const nested = await createSubpage(a.pageItemId, "Nested under A");

    const pages = await tree(root.pageItemId);

    // Breadth first: both direct subpages (in id order) before the nested page.
    expect(pages).toEqual([...[a.pageItemId, b.pageItemId].sort(), nested.pageItemId]);
    // Below the host it also counts the root page itself.
    expect(new Set(await tree(host))).toEqual(
      new Set([root.pageItemId, a.pageItemId, b.pageItemId, nested.pageItemId]),
    );
    expect(await tree(nested.pageItemId)).toEqual([]);
  });

  it("returns nested pages at every depth of a chain", async () => {
    const host = await createHost();
    const chain: string[] = [];
    let parent = host;
    for (const title of ["Level 1", "Level 2", "Level 3", "Level 4"]) {
      parent = (await createSubpage(parent, title)).pageItemId;
      chain.push(parent);
    }

    expect(await tree(host)).toEqual(chain);
  });

  it("follows live pages only: a trashed page and a live page below it are left out", async () => {
    const host = await createHost();
    const kept = await createSubpage(host, "Kept");
    const trashedPage = await createSubpage(host, "Trashed");
    const below = await createSubpage(trashedPage.pageItemId, "Restored on its own");
    await trash(trashedPage.pageItemId);
    await restore(below.pageItemId);
    expect(await liveStates(trashedPage.pageItemId, below.pageItemId)).toEqual([false, true]);

    expect(await tree(host)).toEqual([kept.pageItemId]);
  });

  it("ends the walk on a stored parentItemId cycle, returning each page once", async () => {
    const host = await createHost();
    const first = await createSubpage(host, "First");
    const second = await createSubpage(first.pageItemId, "Second");
    // The API never reparents a page, so a cycle cannot be built through it; this superuser write stands in for
    // corrupted data the walk must survive.
    await admin.query(
      `UPDATE items SET properties = jsonb_set(properties, '{parentItemId}', to_jsonb($2::text)) WHERE id = $1`,
      [first.pageItemId, second.pageItemId],
    );

    expect(await tree(first.pageItemId)).toEqual([second.pageItemId]);
    expect(await tree(second.pageItemId)).toEqual([first.pageItemId]);
  });

  it("returns no page for a tenant that has no Pages database", async () => {
    const host = await createHost();

    expect(await tree(host)).toEqual([]);
  });

  it("does not see another tenant's pages", async () => {
    const otherTenant = await createTestTenant(admin);
    const host = await createHost();
    const page = await createSubpage(host, "Private");
    // The other tenant has pages of its own, so its Pages database exists and the walk really runs.
    const otherHost = await createHost(otherTenant);
    const otherPage = await createSubpage(otherHost, "Theirs", undefined, otherTenant);

    expect(await tree(host)).toEqual([page.pageItemId]);
    expect(await tree(host, otherTenant)).toEqual([]);
    expect(await tree(otherHost, otherTenant)).toEqual([otherPage.pageItemId]);
  });
});
