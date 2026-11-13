import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import type * as Y from "yjs";
import { deleteBlocks, insertBlocks, readPageBlocks } from "@semprec/block-model";
import { runAsSystem, runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { registerItemDeleteHook } from "../chokePoint/hooks.js";
import { withTransaction } from "../db/pool.js";
import { loadDocWithClient, mutateDoc, mutateDocWithClient } from "../docs/docPersistence.js";
import { getDocByItemId } from "../docs/docsStore.js";
import { createSubpageWithClient } from "../docs/pageOperations.js";
import { sweepOrphanedPages } from "../docs/pageOrphanSweep.js";
import { PAGES_MODULE_ID } from "../docs/pagesDatabase.js";
import { seedSystem } from "../seed/seedSystem.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { logger } from "../docs/logger.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let tenant: string;

interface RecordedDelete {
  itemId: string;
  rootItemId: string;
  writerKind: string;
  actingUserId: string | undefined;
}

// Hooks cannot be unregistered; this recorder is emptied before each test and registered after the domain hooks.
const deleteRuns: RecordedDelete[] = [];
registerItemDeleteHook(async ({ item, rootItemId, writerKind, actingUserId }) => {
  deleteRuns.push({ itemId: item.id, rootItemId, writerKind, actingUserId });
});

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  chokePoint = createChokePoint(runtime);
});
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  await runInTenant(tenant, () => seedSystem(runtime));
  deleteRuns.length = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await admin.query("DROP TRIGGER IF EXISTS fail_page_orphan_sweep_test ON items");
  await admin.query("DROP FUNCTION IF EXISTS fail_page_orphan_sweep_test()");
  await admin.query("DROP TABLE IF EXISTS fail_page_orphan_sweep_test_items");
});
afterAll(async () => {
  const results = await Promise.allSettled([runtime?.end(), admin?.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
});

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

/** A new Projects item written through the choke point; it hosts the pages of a test. */
async function createProject(name = "Launch", tenantId = tenant): Promise<string> {
  return runInTenant(tenantId, async () => {
    const database = (await chokePoint.listDatabases()).find(
      (candidate) => candidate.system && candidate.ownerModuleId === PROJECTS_MODULE_ID,
    );
    if (!database) throw new Error("Missing the Projects database");
    return (await chokePoint.createItem({ databaseId: database.id, properties: { name } })).id;
  });
}

interface Subpage {
  pageItemId: string;
  blockId: string;
}

/** A subpage of `parentItemId`, created with its block in the parent's document by the page operation. */
async function createSubpage(parentItemId: string, title: string, tenantId = tenant): Promise<Subpage> {
  const created = await inTenant(
    (client) => createSubpageWithClient(client, { parent: { itemId: parentItemId }, title }, "user"),
    tenantId,
  );
  const page = created.pages[0];
  if (!page) throw new Error("Missing created page");
  return page;
}

async function docIdOf(itemId: string, tenantId = tenant): Promise<string> {
  const doc = await inTenant((client) => getDocByItemId(client, itemId), tenantId);
  if (!doc) throw new Error(`Item ${itemId} has no document`);
  return doc.id;
}

/** An edit of an item's page as an editor makes it over the sync socket, outside the page operations. */
async function editDocument(itemId: string, edit: (doc: Y.Doc) => void, tenantId = tenant): Promise<void> {
  const docId = await docIdOf(itemId, tenantId);
  await runInTenant(tenantId, () => mutateDoc(runtime, docId, "user", edit));
}

/** Removes the `page` block of `page` from the document of `parentItemId` the way an editor deletes it. */
function removePageBlock(parentItemId: string, page: Subpage, tenantId = tenant): Promise<void> {
  return editDocument(parentItemId, (doc) => deleteBlocks(doc, [page.blockId]), tenantId);
}

/**
 * Makes every document of `tenantId` look last edited two hours ago. Documents only age in real time and no production
 * writer back-dates them, so the sweep's idle window is passed by a direct update on the admin pool.
 */
async function makeDocumentsIdle(tenantId = tenant): Promise<void> {
  await admin.query("UPDATE docs SET last_edited_at = now() - interval '2 hours' WHERE tenant_id = $1", [tenantId]);
}

function sweep(): ReturnType<typeof sweepOrphanedPages> {
  return runAsSystem("test", () => sweepOrphanedPages(runtime));
}

/** Whether each item is live, in the order given, read inside `tenantId`; a missing row fails the test. */
async function liveStates(tenantId: string, ...itemIds: string[]): Promise<boolean[]> {
  return runInTenant(tenantId, async () => {
    const states: boolean[] = [];
    for (const itemId of itemIds) {
      const item = await chokePoint.findItemIncludingDeleted(itemId);
      if (!item) throw new Error(`Item ${itemId} does not exist`);
      states.push(item.deletedAt === null);
    }
    return states;
  });
}

async function restore(itemId: string, tenantId = tenant): Promise<void> {
  await runInTenant(tenantId, async () => {
    const item = await chokePoint.findItemIncludingDeleted(itemId);
    if (!item) throw new Error(`Item ${itemId} does not exist`);
    await chokePoint.restoreItem(item.databaseId, itemId);
  });
}

/** The `page` blocks of an item's document as `[pageId, text]` pairs in document order. */
async function pageBlocksOf(itemId: string, tenantId = tenant): Promise<Array<[string | null, string]>> {
  const docId = await docIdOf(itemId, tenantId);
  return inTenant(async (client) => {
    const doc = await loadDocWithClient(client, docId);
    try {
      return readPageBlocks(doc)
        .filter((block) => block.type === "page")
        .map((block): [string | null, string] => [block.pageId, block.text.map((run) => run.insert).join("")]);
    } finally {
      doc.destroy();
    }
  }, tenantId);
}

/** Every Pages item of `tenantId` as stored and the number of stored document updates: what a sweep may change. */
async function pagesAndUpdates(tenantId = tenant): Promise<unknown> {
  return inTenant(async (client) => {
    const pages = await client.query<{ row: unknown }>(
      `SELECT to_jsonb(i) AS row FROM items i JOIN databases d ON d.id = i.database_id
        WHERE d.owner_module_id = $1 ORDER BY i.id`,
      [PAGES_MODULE_ID],
    );
    const updates = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM doc_updates`);
    return { pages: pages.rows.map((row) => row.row), updates: updates.rows[0]?.n };
  }, tenantId);
}

/** Makes the trash of the given Pages items fail inside the database. */
async function failTrashOf(...itemIds: string[]): Promise<void> {
  // Fault injection inside the soft delete itself: no production input makes the trash of one page fail. The item ids
  // reach the trigger through a scratch table, not interpolated into its body.
  await admin.query("CREATE TABLE fail_page_orphan_sweep_test_items (item_id uuid PRIMARY KEY)");
  await admin.query("INSERT INTO fail_page_orphan_sweep_test_items (item_id) SELECT unnest($1::uuid[])", [itemIds]);
  await admin.query("GRANT SELECT ON fail_page_orphan_sweep_test_items TO PUBLIC");
  await admin.query(`CREATE FUNCTION fail_page_orphan_sweep_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM fail_page_orphan_sweep_test_items WHERE item_id = NEW.id) THEN
        RAISE EXCEPTION 'page trash failure';
      END IF;
      RETURN NEW;
    END $$`);
  await admin.query(`CREATE TRIGGER fail_page_orphan_sweep_test BEFORE UPDATE ON items
    FOR EACH ROW EXECUTE FUNCTION fail_page_orphan_sweep_test()`);
}

/** Waits until some statement of the database waits for a lock, which is where the sweep under test stops. */
async function waitForPendingLock(): Promise<void> {
  for (let waited = 0; ; waited += 25) {
    const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted");
    if ((rows[0]?.n ?? 0) > 0) return;
    if (waited > 10_000) throw new Error("The sweep never waited for a lock");
    await sleep(25);
  }
}

/**
 * Runs the sweep while a transaction of its own holds the row of `pageItemId`, so the sweep has listed the page and
 * waits for its row. `changeWhileHeld` then runs inside that transaction, which commits afterwards.
 */
async function sweepWhileHoldingPageRow(
  pageItemId: string,
  changeWhileHeld: (holder: PoolClient) => Promise<void>,
): Promise<Awaited<ReturnType<typeof sweep>>> {
  const holder = await admin.connect();
  let swept: ReturnType<typeof sweep> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM items WHERE id = $1 FOR UPDATE", [pageItemId]);
    swept = sweep();
    await waitForPendingLock();
    await changeWhileHeld(holder);
    await holder.query("COMMIT");
  } catch (error) {
    await holder.query("ROLLBACK");
    throw error;
  } finally {
    holder.release();
  }
  return swept;
}

describe("sweepOrphanedPages (issue #1749)", () => {
  it("trashes a page whose block was removed by a document update, with its nested pages, and a restore brings it back", async () => {
    const project = await createProject();
    const orphan = await createSubpage(project, "Release checklist");
    const nested = await createSubpage(orphan.pageItemId, "Notes for version 0.4");
    await removePageBlock(project, orphan);
    await makeDocumentsIdle();

    const result = await sweep();

    expect(result).toEqual({ trashed: 1, failed: 0 });
    expect(await liveStates(tenant, orphan.pageItemId, nested.pageItemId)).toEqual([false, false]);
    // The trash ran as the system writer, once for the page below (the recorder runs after the hook that trashes it,
    // so it is recorded first) and once for the orphan.
    expect(
      deleteRuns.map(({ itemId, rootItemId, writerKind, actingUserId }) => ({
        itemId,
        rootItemId,
        writerKind,
        actingUserId,
      })),
    ).toEqual([
      { itemId: nested.pageItemId, rootItemId: nested.pageItemId, writerKind: "system", actingUserId: undefined },
      { itemId: orphan.pageItemId, rootItemId: orphan.pageItemId, writerKind: "system", actingUserId: undefined },
    ]);

    await restore(orphan.pageItemId);

    expect(await liveStates(tenant, orphan.pageItemId, nested.pageItemId)).toEqual([true, true]);
    // The block returns to the parent's document (at its end, since no position was recorded) and the nested page
    // keeps its own block in the restored page's document.
    expect(await pageBlocksOf(project)).toEqual([[orphan.pageItemId, "Release checklist"]]);
    expect(await pageBlocksOf(orphan.pageItemId)).toEqual([[nested.pageItemId, "Notes for version 0.4"]]);
  });

  it("trashes a page below an orphan once when both lost their blocks", async () => {
    const project = await createProject();
    const orphan = await createSubpage(project, "Parent page");
    const nested = await createSubpage(orphan.pageItemId, "Child page");
    await removePageBlock(project, orphan);
    await removePageBlock(orphan.pageItemId, nested);
    await makeDocumentsIdle();

    const result = await sweep();

    expect(result.failed).toBe(0);
    expect(await liveStates(tenant, orphan.pageItemId, nested.pageItemId)).toEqual([false, false]);
    // Whichever of the two the sweep reached first, each page went through the choke point's delete exactly once.
    expect(deleteRuns.map((run) => run.itemId).sort()).toEqual([orphan.pageItemId, nested.pageItemId].sort());
  });

  it("leaves a page whose block is present untouched and trashes only the orphan next to it", async () => {
    const project = await createProject();
    const kept = await createSubpage(project, "Kept");
    const orphan = await createSubpage(project, "Orphan");
    await removePageBlock(project, orphan);
    await makeDocumentsIdle();

    const result = await sweep();

    expect(result.trashed).toBe(1);
    expect(await liveStates(tenant, kept.pageItemId, orphan.pageItemId)).toEqual([true, false]);
    expect(await pageBlocksOf(project)).toEqual([[kept.pageItemId, "Kept"]]);
  });

  it("leaves a page alone while the document of its parent was edited less than an hour ago", async () => {
    const project = await createProject();
    const orphan = await createSubpage(project, "Orphan");
    await removePageBlock(project, orphan);
    // The removal above is the latest edit of the parent's document: seconds old.
    const before = await pagesAndUpdates();

    expect(await sweep()).toEqual({ trashed: 0, failed: 0 });

    expect(await liveStates(tenant, orphan.pageItemId)).toEqual([true]);
    expect(await pagesAndUpdates()).toEqual(before);

    await makeDocumentsIdle();
    expect(await sweep()).toEqual({ trashed: 1, failed: 0 });
    expect(await liveStates(tenant, orphan.pageItemId)).toEqual([false]);
  });

  it("leaves a page alone whose parent has no document", async () => {
    const project = await createProject();
    const orphan = await createSubpage(project, "Orphan");
    // No production write removes a document; the page keeps its `parentItemId` but its parent has no document.
    await admin.query("DELETE FROM docs WHERE item_id = $1", [project]);
    await makeDocumentsIdle();
    const before = await pagesAndUpdates();

    expect(await sweep()).toEqual({ trashed: 0, failed: 0 });

    expect(await liveStates(tenant, orphan.pageItemId)).toEqual([true]);
    expect(await pagesAndUpdates()).toEqual(before);
  });

  it("leaves a page alone whose parent is in the Trash", async () => {
    const project = await createProject();
    const parentPage = await createSubpage(project, "Parent page");
    const child = await createSubpage(parentPage.pageItemId, "Child page");
    await runInTenant(tenant, async () => {
      const item = await chokePoint.findItem(parentPage.pageItemId);
      if (!item) throw new Error("Missing page");
      await chokePoint.softDeleteItem(item.databaseId, parentPage.pageItemId);
    });
    // The child is restored on its own while its parent stays in the Trash, and its block then leaves the document.
    await restore(child.pageItemId);
    await removePageBlock(parentPage.pageItemId, child);
    await makeDocumentsIdle();
    expect(await liveStates(tenant, parentPage.pageItemId, child.pageItemId)).toEqual([false, true]);
    const before = await pagesAndUpdates();

    expect(await sweep()).toEqual({ trashed: 0, failed: 0 });

    expect(await liveStates(tenant, parentPage.pageItemId, child.pageItemId)).toEqual([false, true]);
    expect(await pagesAndUpdates()).toEqual(before);
  });

  it("changes nothing on a second run", async () => {
    const project = await createProject();
    const kept = await createSubpage(project, "Kept");
    const orphan = await createSubpage(project, "Orphan");
    await removePageBlock(project, orphan);
    await makeDocumentsIdle();

    expect(await sweep()).toEqual({ trashed: 1, failed: 0 });
    const afterFirst = await pagesAndUpdates();
    const deletesAfterFirst = deleteRuns.length;

    expect(await sweep()).toEqual({ trashed: 0, failed: 0 });

    expect(await pagesAndUpdates()).toEqual(afterFirst);
    expect(deleteRuns).toHaveLength(deletesAfterFirst);
    expect(await liveStates(tenant, kept.pageItemId, orphan.pageItemId)).toEqual([true, false]);
  });

  it("works through more orphans than one chunk holds", async () => {
    const project = await createProject();
    const pages: Subpage[] = [];
    await inTenant(async (client) => {
      for (let i = 0; i < 201; i += 1) {
        const created = await createSubpageWithClient(
          client,
          { parent: { itemId: project }, title: `Page ${i}` },
          "user",
        );
        const page = created.pages[0];
        if (!page) throw new Error("Missing created page");
        pages.push(page);
      }
    });
    const blockIds = pages.map((page) => page.blockId);
    await editDocument(project, (doc) => deleteBlocks(doc, blockIds));
    await makeDocumentsIdle();

    const result = await sweep();

    expect(result).toEqual({ trashed: 201, failed: 0 });
    const live = await liveStates(tenant, ...pages.map((page) => page.pageItemId));
    expect(live.filter(Boolean)).toEqual([]);
  });

  it("continues in the next parent when a chunk ends inside the parent that sorts first", async () => {
    // The sweep lists pages ordered by (parent, id) and resumes after the last page of the previous chunk, so a chunk
    // that ends inside the first parent must still reach every page of the later parents, whose ids may be lower than
    // the cursor's page id. The parent whose id sorts first gets more pages than one chunk holds.
    const [firstParent, secondParent] = [await createProject("Alpha"), await createProject("Beta")].sort((a, b) =>
      a < b ? -1 : 1,
    ) as [string, string];
    const createMany = async (parentItemId: string, count: number): Promise<Subpage[]> => {
      const pages: Subpage[] = [];
      await inTenant(async (client) => {
        for (let i = 0; i < count; i += 1) {
          const created = await createSubpageWithClient(
            client,
            { parent: { itemId: parentItemId }, title: `Page ${i}` },
            "user",
          );
          const page = created.pages[0];
          if (!page) throw new Error("Missing created page");
          pages.push(page);
        }
      });
      return pages;
    };
    const firstPages = await createMany(firstParent, 201);
    const secondPages = await createMany(secondParent, 40);
    await editDocument(firstParent, (doc) =>
      deleteBlocks(
        doc,
        firstPages.map((page) => page.blockId),
      ),
    );
    await editDocument(secondParent, (doc) =>
      deleteBlocks(
        doc,
        secondPages.map((page) => page.blockId),
      ),
    );
    await makeDocumentsIdle();

    const result = await sweep();

    expect(result).toEqual({ trashed: 241, failed: 0 });
    const live = await liveStates(tenant, ...[...firstPages, ...secondPages].map((page) => page.pageItemId));
    expect(live.filter(Boolean)).toEqual([]);
  });

  it("trashes only the orphans of the tenant they belong to", async () => {
    const tenantB = await createTestTenant(admin);
    await runInTenant(tenantB, () => seedSystem(runtime));
    const projectA = await createProject("Alpha", tenant);
    const projectB = await createProject("Beta", tenantB);
    const orphanA = await createSubpage(projectA, "Orphan A", tenant);
    const keptA = await createSubpage(projectA, "Kept A", tenant);
    const orphanB = await createSubpage(projectB, "Orphan B", tenantB);
    const keptB = await createSubpage(projectB, "Kept B", tenantB);
    await removePageBlock(projectA, orphanA, tenant);
    await removePageBlock(projectB, orphanB, tenantB);
    await makeDocumentsIdle(tenant);
    await makeDocumentsIdle(tenantB);

    expect(await sweep()).toEqual({ trashed: 2, failed: 0 });

    expect(await liveStates(tenant, orphanA.pageItemId, keptA.pageItemId)).toEqual([false, true]);
    expect(await liveStates(tenantB, orphanB.pageItemId, keptB.pageItemId)).toEqual([false, true]);
    // Each tenant sees only its own pages: another tenant's id reads as missing.
    const visibleToA = await runInTenant(tenant, () => chokePoint.findItemIncludingDeleted(orphanB.pageItemId));
    expect(visibleToA).toBeNull();
    expect(await pageBlocksOf(projectA)).toEqual([[keptA.pageItemId, "Kept A"]]);
    expect(await pageBlocksOf(projectB, tenantB)).toEqual([[keptB.pageItemId, "Kept B"]]);
  });

  it("leaves a tenant alone whose own documents were edited recently while another tenant's orphan is trashed", async () => {
    const tenantB = await createTestTenant(admin);
    await runInTenant(tenantB, () => seedSystem(runtime));
    const projectA = await createProject("Alpha", tenant);
    const projectB = await createProject("Beta", tenantB);
    const orphanA = await createSubpage(projectA, "Orphan A", tenant);
    const orphanB = await createSubpage(projectB, "Orphan B", tenantB);
    await removePageBlock(projectA, orphanA, tenant);
    await removePageBlock(projectB, orphanB, tenantB);
    // Only tenant A's documents are idle; tenant B's were edited seconds ago.
    await makeDocumentsIdle(tenant);

    expect(await sweep()).toEqual({ trashed: 1, failed: 0 });

    expect(await liveStates(tenant, orphanA.pageItemId)).toEqual([false]);
    expect(await liveStates(tenantB, orphanB.pageItemId)).toEqual([true]);
  });

  it("logs a page it cannot trash by id, rolls its chunk back and still trashes the other orphans", async () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
    const project = await createProject();
    const failing = await createSubpage(project, "Failing page with a private title");
    const other = await createSubpage(project, "Other orphan");
    await removePageBlock(project, failing);
    await removePageBlock(project, other);
    await makeDocumentsIdle();
    await failTrashOf(failing.pageItemId);

    const result = await sweep();

    expect(result).toEqual({ trashed: 1, failed: 1 });
    expect(await liveStates(tenant, failing.pageItemId, other.pageItemId)).toEqual([true, false]);
    // The log carries ids, counts and error class names, never content.
    const logged = errorLog.mock.calls.map((call) => JSON.stringify(call));
    expect(logged.some((line) => line.includes(failing.pageItemId))).toBe(true);
    expect(logged.join("\n")).not.toContain("private title");
    expect(logged.join("\n")).not.toContain("page trash failure");
  });

  it("rejects once every tenant was attempted when every page it examined failed", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const project = await createProject();
    const failing = await createSubpage(project, "Failing page");
    await removePageBlock(project, failing);
    await makeDocumentsIdle();
    await failTrashOf(failing.pageItemId);

    const error: unknown = await sweep().then(
      () => null,
      (caught: unknown) => caught,
    );

    if (!(error instanceof AggregateError)) throw new Error("Expected the sweep to reject with an AggregateError");
    expect(error.errors).toEqual([
      expect.objectContaining({ message: "pageOrphanSweep: all 1 attempted doc(s) failed" }),
    ]);
    expect(await liveStates(tenant, failing.pageItemId)).toEqual([true]);
  });

  it.each([
    ["has lost its document", "DELETE FROM docs WHERE item_id = $1"],
    ["holds a canvas instead of a page", "UPDATE docs SET kind = 'canvas' WHERE item_id = $1"],
  ])("trashes nothing when the parent %s while the sweep waits for the page", async (_label, change) => {
    const project = await createProject();
    const orphan = await createSubpage(project, "Orphan");
    await removePageBlock(project, orphan);
    await makeDocumentsIdle();

    // No production write removes a document or changes its kind; this is the state a stale listing could meet.
    const result = await sweepWhileHoldingPageRow(orphan.pageItemId, async (holder) => {
      await holder.query(change, [project]);
    });

    expect(result).toEqual({ trashed: 0, failed: 0 });
    expect(await liveStates(tenant, orphan.pageItemId)).toEqual([true]);
  });

  it("sees an edit committed while it waits for the document of the parent", async () => {
    const project = await createProject();
    const orphan = await createSubpage(project, "Orphan");
    await removePageBlock(project, orphan);
    await makeDocumentsIdle();
    const projectDocId = await docIdOf(project);

    let holding!: () => void;
    const isHolding = new Promise<void>((resolve) => {
      holding = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // An editor that holds the parent's document, as the sync socket does while it applies an update.
    const editor = runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        (await loadDocWithClient(client, projectDocId)).destroy();
        holding();
        await released;
        await mutateDocWithClient(client, projectDocId, "user", (doc) =>
          insertBlocks(doc, null, [{ id: randomUUID(), type: "text", text: "A late edit" }]),
        );
      }),
    );
    let swept: ReturnType<typeof sweep> | undefined;
    try {
      await isHolding;
      swept = sweep();
      // The sweep has examined the page and now waits for the document.
      await waitForPendingLock();
    } finally {
      release();
    }
    await editor;
    const result = await swept;

    // The edit is newer than the idle window, and the sweep read that after it got the document.
    expect(result).toEqual({ trashed: 0, failed: 0 });
    expect(await liveStates(tenant, orphan.pageItemId)).toEqual([true]);
  });
});
