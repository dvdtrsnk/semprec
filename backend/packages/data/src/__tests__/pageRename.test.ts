import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  deleteBlocks,
  insertBlocks,
  readPageBlocks,
  setIndent,
  writeBlock,
  type PageBlock,
} from "@semprec/block-model";
import { runInTenant, type PageRenameOutput } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { lockItemById, lockItemByIdNowait, softDeleteItem } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { loadDocWithClient, mutateDoc } from "../docs/docPersistence.js";
import { createSubpageWithClient, renamePageWithClient } from "../docs/pageOperations.js";
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

function rename(pageItemId: string, title: string, origin: CreatedBy = "user"): Promise<PageRenameOutput> {
  return inTenant((client) => renamePageWithClient(client, { pageItemId, title }, origin));
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

async function databaseIdOf(itemId: string): Promise<string> {
  const { rows } = await inTenant((client) =>
    client.query<{ database_id: string }>(`SELECT database_id FROM items WHERE id = $1`, [itemId]),
  );
  const databaseId = rows[0]?.database_id;
  if (!databaseId) throw new Error(`Item ${itemId} not found`);
  return databaseId;
}

/**
 * Everything a rename may write for a page and its parent, read inside `tenantId`: the stored row of the page's item
 * (its version included) and every update of the parent's document with its author.
 */
async function writtenState(pageItemId: string, parentItemId: string, tenantId = tenant): Promise<unknown> {
  return inTenant(async (client) => {
    const item = await client.query<{ row: unknown }>(`SELECT to_jsonb(i) AS row FROM items i WHERE i.id = $1`, [
      pageItemId,
    ]);
    const updates = await client.query<{ id: string; created_by: string }>(
      `SELECT u.id, u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id`,
      [parentItemId],
    );
    const all = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM doc_updates`);
    return { item: item.rows.map((row) => row.row), parentUpdates: updates.rows, allUpdates: all.rows[0]?.n };
  }, tenantId);
}

async function propertiesOf(itemId: string, tenantId = tenant): Promise<Record<string, unknown> | undefined> {
  const { rows } = await inTenant(
    (client) =>
      client.query<{ properties: Record<string, unknown> }>(`SELECT properties FROM items WHERE id = $1`, [itemId]),
    tenantId,
  );
  return rows[0]?.properties;
}

async function titleOf(itemId: string, tenantId = tenant): Promise<unknown> {
  return (await propertiesOf(itemId, tenantId))?.title;
}

/** How many documents and document updates the tenant has stored, and how many of the documents belong to `itemId`. */
async function documentCounts(itemId: string): Promise<{ docs: number; docUpdates: number; docsOfItem: number }> {
  const { rows } = await inTenant((client) =>
    client.query<{ docs: number; docUpdates: number; docsOfItem: number }>(
      `SELECT (SELECT count(*)::int FROM docs) AS docs,
              (SELECT count(*)::int FROM doc_updates) AS "docUpdates",
              (SELECT count(*)::int FROM docs WHERE item_id = $1) AS "docsOfItem"`,
      [itemId],
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("Missing counts");
  return row;
}

/**
 * Stores `parentItemId` as the parent id of the page. No operation reparents a page, so this superuser write stands in
 * for a purged parent and for hand-edited data.
 */
async function setParentItemId(pageItemId: string, parentItemId: string): Promise<void> {
  await admin.query(
    `UPDATE items SET properties = jsonb_set(properties, '{parentItemId}', to_jsonb($2::text)) WHERE id = $1`,
    [pageItemId, parentItemId],
  );
}

async function parentAuthors(parentItemId: string): Promise<string[]> {
  const { rows } = await inTenant((client) =>
    client.query<{ created_by: string }>(
      `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id`,
      [parentItemId],
    ),
  );
  return rows.map((row) => row.created_by);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to be rejected");
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
    if (Date.now() > deadline) throw new Error("The rename never waited for a lock");
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

describe("page.rename (issue #1725)", () => {
  it("writes the title to the Pages item and to the page block of the parent, as the caller", async () => {
    const { project, checklist, firstId, lastId } = await projectWithChecklist();
    const parentDocId = await docIdOf(project);
    await runInTenant(tenant, () =>
      mutateDoc(runtime, parentDocId, "user", (doc) => setIndent(doc, [checklist.blockId], 2)),
    );
    const blocksBefore = await readBlocks(project);
    const authorsBefore = await parentAuthors(project);

    const renamed = await rename(checklist.pageItemId, "Release plan");

    expect(renamed).toEqual({ pageItemId: checklist.pageItemId, title: "Release plan" });
    expect(await propertiesOf(checklist.pageItemId)).toEqual({ title: "Release plan", parentItemId: project });
    // Only the text of the page block changed: the ids, the order and every other field are what they were.
    const blocks = await readBlocks(project);
    expect(blocks.map((block) => block.id)).toEqual([firstId, checklist.blockId, lastId]);
    expect(blocks).toEqual(
      blocksBefore.map((block) =>
        block.id === checklist.blockId ? { ...block, text: [{ insert: "Release plan" }] } : block,
      ),
    );
    expect(blocks[1]).toMatchObject({ type: "page", indent: 2, pageId: checklist.pageItemId });
    // One update of the parent's document, authored by the caller; the page's own document is not written.
    expect(await parentAuthors(project)).toEqual([...authorsBefore, "user"]);
    expect(await parentAuthors(checklist.pageItemId)).toEqual([]);

    await rename(checklist.pageItemId, "Release plan B", "ai_agent");
    expect(await parentAuthors(project)).toEqual([...authorsBefore, "user", "ai_agent"]);
    expect((await readBlocks(project))[1]?.text).toEqual([{ insert: "Release plan B" }]);
  });

  it("writes once when the same rename is sent twice, and nothing for the title a page already has", async () => {
    const { project, checklist } = await projectWithChecklist();
    const created = await writtenState(checklist.pageItemId, project);

    // The title the page was created with, also when it only differs before normalization.
    expect(await rename(checklist.pageItemId, "Release checklist")).toEqual({
      pageItemId: checklist.pageItemId,
      title: "Release checklist",
    });
    await rename(checklist.pageItemId, "  Release checklist\n");
    expect(await writtenState(checklist.pageItemId, project)).toEqual(created);

    await rename(checklist.pageItemId, "Release plan");
    const afterFirst = await writtenState(checklist.pageItemId, project);
    expect(afterFirst).not.toEqual(created);

    expect(await rename(checklist.pageItemId, "Release plan")).toEqual({
      pageItemId: checklist.pageItemId,
      title: "Release plan",
    });
    expect(await writtenState(checklist.pageItemId, project)).toEqual(afterFirst);
  });

  it("renames only the item of an orphan, a page no block of the parent names", async () => {
    const { project, checklist, firstId, lastId } = await projectWithChecklist();
    const parentDocId = await docIdOf(project);
    await runInTenant(tenant, () =>
      mutateDoc(runtime, parentDocId, "user", (doc) => deleteBlocks(doc, [checklist.blockId])),
    );
    const authorsBefore = await parentAuthors(project);

    const renamed = await rename(checklist.pageItemId, "Release plan");

    expect(renamed).toEqual({ pageItemId: checklist.pageItemId, title: "Release plan" });
    expect(await titleOf(checklist.pageItemId)).toBe("Release plan");
    expect(await parentAuthors(project)).toEqual(authorsBefore);
    expect((await readBlocks(project)).map((block) => block.id)).toEqual([firstId, lastId]);
  });

  it("renames only the item when the parent is gone or its id is unusable", async () => {
    const missingParent = await projectWithChecklist();
    const absentParentId = await projectWithChecklist();
    const malformedParentId = await projectWithChecklist();
    await setParentItemId(missingParent.checklist.pageItemId, randomUUID());
    // No operation removes a parent id; this superuser write stands in for hand-edited data.
    await admin.query(`UPDATE items SET properties = properties - 'parentItemId' WHERE id = $1`, [
      absentParentId.checklist.pageItemId,
    ]);
    await setParentItemId(malformedParentId.checklist.pageItemId, "not-an-id");

    for (const { project, checklist } of [missingParent, absentParentId, malformedParentId]) {
      const authorsBefore = await parentAuthors(project);
      const blocksBefore = await readBlocks(project);
      const countsBefore = await documentCounts(project);

      const renamed = await rename(checklist.pageItemId, "Release plan");

      expect(renamed).toEqual({ pageItemId: checklist.pageItemId, title: "Release plan" });
      expect(await titleOf(checklist.pageItemId)).toBe("Release plan");
      // The former parent still shows the old caption: its document is not this page's parent document any more.
      expect(await parentAuthors(project)).toEqual(authorsBefore);
      expect(await readBlocks(project)).toEqual(blocksBefore);
      expect(await documentCounts(project)).toEqual(countsBefore);
    }
  });

  it("renames only the item when the parent has no document, and creates none for it", async () => {
    const { project, checklist } = await projectWithChecklist();
    // Every parent of a subpage got its document when the subpage was created; this live item never had one.
    const bareParent = await runInTenant(tenant, () => createTestProjectItem(runtime));
    await setParentItemId(checklist.pageItemId, bareParent);
    const countsBefore = await documentCounts(bareParent);
    expect(countsBefore.docsOfItem).toBe(0);
    const authorsBefore = await parentAuthors(project);

    const renamed = await rename(checklist.pageItemId, "Release plan");

    expect(renamed).toEqual({ pageItemId: checklist.pageItemId, title: "Release plan" });
    expect(await propertiesOf(checklist.pageItemId)).toEqual({ title: "Release plan", parentItemId: bareParent });
    // No document was created for the parent and no document of the tenant was written.
    expect(await documentCounts(bareParent)).toEqual(countsBefore);
    expect(await parentAuthors(project)).toEqual(authorsBefore);
  });

  it("stores a title with a line break with a space, on the item and in the block", async () => {
    const { project, checklist } = await projectWithChecklist();

    const renamed = await rename(checklist.pageItemId, " Release\r\nplan for 0.4 ");

    expect(renamed.title).toBe("Release plan for 0.4");
    expect(await titleOf(checklist.pageItemId)).toBe("Release plan for 0.4");
    expect((await readBlocks(project))[1]?.text).toEqual([{ insert: "Release plan for 0.4" }]);
  });

  it("accepts an empty title and a title of exactly the limit", async () => {
    const { project, checklist } = await projectWithChecklist();

    expect((await rename(checklist.pageItemId, "")).title).toBe("");
    expect(await titleOf(checklist.pageItemId)).toBe("");
    expect((await readBlocks(project))[1]?.text).toEqual([]);

    const longest = "x".repeat(PAGE_TITLE_MAX_LENGTH);
    expect((await rename(checklist.pageItemId, longest)).title).toBe(longest);
    expect(await titleOf(checklist.pageItemId)).toBe(longest);
    expect((await readBlocks(project))[1]?.text).toEqual([{ insert: longest }]);
  });

  it("rejects a title one character over the limit on title, with nothing written", async () => {
    const { project, checklist } = await projectWithChecklist();
    const before = await writtenState(checklist.pageItemId, project);

    const error = await rejection(rename(checklist.pageItemId, "x".repeat(PAGE_TITLE_MAX_LENGTH + 1)));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, details: { field: "title" } });
    expect(await writtenState(checklist.pageItemId, project)).toEqual(before);
  });

  it("rolls the item's title back when the write of the parent's document fails", async () => {
    const { project, checklist } = await projectWithChecklist();
    const parentDocId = await docIdOf(project);
    // No production write stores bytes that are not an update; this row makes the parent's document unloadable, so
    // the document write of the rename fails after the item's title was already updated.
    await inTenant((client) =>
      client.query(`INSERT INTO doc_updates (doc_id, update, created_by) VALUES ($1, $2, 'user')`, [
        parentDocId,
        Buffer.from([0x00, 0xff]),
      ]),
    );
    const before = await writtenState(checklist.pageItemId, project);

    const error = await rejection(rename(checklist.pageItemId, "Release plan"));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ValidationError);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect(await titleOf(checklist.pageItemId)).toBe("Release checklist");
    expect(await writtenState(checklist.pageItemId, project)).toEqual(before);
  });

  it("refuses a host item on pageItemId before it looks at the title", async () => {
    const { project, checklist } = await projectWithChecklist();
    const before = await writtenState(checklist.pageItemId, project);

    for (const title of ["Renamed project", "x".repeat(PAGE_TITLE_MAX_LENGTH + 1)]) {
      const error = await rejection(rename(project, title));
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, details: { field: "pageItemId", reason: "not_a_page" } });
    }
    expect(await writtenState(checklist.pageItemId, project)).toEqual(before);
  });

  it("answers another tenant's page exactly like an unknown id and leaves it untouched", async () => {
    const otherTenant = await createTestTenant(admin);
    const foreignProject = await runInTenant(otherTenant, async () => {
      await seedSystem(runtime);
      return createTestProjectItem(runtime);
    });
    const foreignPage = await subpage(foreignProject, "Private page", undefined, otherTenant);
    const foreignBefore = await writtenState(foreignPage.pageItemId, foreignProject, otherTenant);
    const unknownId = randomUUID();

    const foreignError = await rejection(rename(foreignPage.pageItemId, "Taken over"));
    const unknownError = await rejection(rename(unknownId, "Taken over"));

    const shape = (error: unknown, id: string): string => {
      if (!(error instanceof NotFoundError)) throw new Error(`Expected a NotFoundError, got ${String(error)}`);
      return JSON.stringify({
        status: error.status,
        code: error.code,
        message: error.message,
        details: error.details,
      }).replaceAll(id, "<id>");
    };
    expect(shape(foreignError, foreignPage.pageItemId)).toBe(shape(unknownError, unknownId));
    expect(foreignError).toMatchObject({ status: 404 });
    expect(await titleOf(foreignPage.pageItemId, otherTenant)).toBe("Private page");
    expect(await writtenState(foreignPage.pageItemId, foreignProject, otherTenant)).toEqual(foreignBefore);
  });

  it("does not find a page that is in the trash", async () => {
    const { project, checklist } = await projectWithChecklist();
    const pagesDatabaseId = await databaseIdOf(checklist.pageItemId);
    const trashed = await runInTenant(tenant, () =>
      createChokePoint(runtime).softDeleteItem(pagesDatabaseId, checklist.pageItemId),
    );
    expect(trashed).not.toBeNull();
    const before = await writtenState(checklist.pageItemId, project);

    expect(await rejection(rename(checklist.pageItemId, "Release plan"))).toBeInstanceOf(NotFoundError);
    expect(await writtenState(checklist.pageItemId, project)).toEqual(before);
  });

  it("leaves the parent's document alone when its block already reads the new title", async () => {
    const { project, checklist } = await projectWithChecklist();
    const parentDocId = await docIdOf(project);
    // The title was edited in the parent and the mirror job has not run: the block is ahead of the item.
    await runInTenant(tenant, () =>
      mutateDoc(runtime, parentDocId, "user", (doc) =>
        writeBlock(doc, {
          id: checklist.blockId,
          type: "page",
          pageId: checklist.pageItemId,
          text: "Edited in the parent",
        }),
      ),
    );
    const authorsBefore = await parentAuthors(project);
    expect(await titleOf(checklist.pageItemId)).toBe("Release checklist");

    const renamed = await rename(checklist.pageItemId, "Edited in the parent", "ai_agent");

    expect(renamed.title).toBe("Edited in the parent");
    expect(await titleOf(checklist.pageItemId)).toBe("Edited in the parent");
    expect(await parentAuthors(project)).toEqual(authorsBefore);
  });

  it("retitles the first of two blocks that name the page and keeps the caption of the other", async () => {
    const { project, checklist, lastId } = await projectWithChecklist();
    const parentDocId = await docIdOf(project);
    const [secondBlockId] = await runInTenant(tenant, () =>
      mutateDoc(runtime, parentDocId, "user", (doc) =>
        insertBlocks(doc, lastId, [{ type: "page", pageId: checklist.pageItemId, text: "Another caption" }]),
      ),
    );

    await rename(checklist.pageItemId, "Release plan");

    const blocks = await readBlocks(project);
    expect(blocks.filter((block) => block.type === "page").map((block) => [block.id, block.text])).toEqual([
      [checklist.blockId, [{ insert: "Release plan" }]],
      [secondBlockId, [{ insert: "Another caption" }]],
    ]);
  });

  it("writes the block of a parent that is in the trash, so the titles agree when it is restored", async () => {
    const { project, checklist } = await projectWithChecklist();
    const projectDatabaseId = await databaseIdOf(project);
    const pagesDatabaseId = await databaseIdOf(checklist.pageItemId);
    const trashed = await runInTenant(tenant, () =>
      createChokePoint(runtime).softDeleteItem(projectDatabaseId, project),
    );
    expect(trashed).not.toBeNull();
    // The project's trash took the page with it (issue #1763). Restored on its own, the page is live below the
    // trashed project, with its block back in the project's notes.
    const restored = await runInTenant(tenant, () =>
      createChokePoint(runtime).restoreItem(pagesDatabaseId, checklist.pageItemId),
    );
    expect(restored?.deletedAt).toBeNull();
    const { rows } = await inTenant((client) =>
      client.query<{ trashed: boolean }>(`SELECT deleted_at IS NOT NULL AS trashed FROM items WHERE id = $1`, [
        project,
      ]),
    );
    expect(rows[0]?.trashed).toBe(true);

    const renamed = await rename(checklist.pageItemId, "Release plan");

    expect(renamed.title).toBe("Release plan");
    expect(await titleOf(checklist.pageItemId)).toBe("Release plan");
    expect((await readBlocks(project))[1]?.text).toEqual([{ insert: "Release plan" }]);
  });

  it.each([
    ["a new title", "Release plan"],
    ["the title the page already has", "Release checklist"],
  ])("waits for a trash of the page that is in flight and then refuses %s, writing nothing", async (_label, title) => {
    const { project, checklist } = await projectWithChecklist();
    const pagesDatabaseId = await databaseIdOf(checklist.pageItemId);
    const authorsBefore = await parentAuthors(project);
    await withOpenTransaction(async (holder, commit) => {
      // The open transaction has trashed the page and holds its row; the rename still reads it as live. The store
      // function runs on the held connection, because the choke point's trash commits in a transaction of its own.
      await softDeleteItem(holder, pagesDatabaseId, checklist.pageItemId);
      const settled = Promise.allSettled([rename(checklist.pageItemId, title)]);
      await lockWait();
      await commit();
      const [outcome] = await settled;
      expect(outcome?.status).toBe("rejected");
      expect(outcome?.status === "rejected" ? outcome.reason : undefined).toBeInstanceOf(NotFoundError);
    });
    expect(await titleOf(checklist.pageItemId)).toBe("Release checklist");
    expect(await parentAuthors(project)).toEqual(authorsBefore);
  });

  it("locks the parent's row before the page's row", async () => {
    const { project, checklist } = await projectWithChecklist();
    const projectDatabaseId = await databaseIdOf(project);
    const pagesDatabaseId = await databaseIdOf(checklist.pageItemId);
    await withOpenTransaction(async (holder, commit) => {
      // The open transaction holds the parent's row, so the rename waits at its first lock.
      await lockItemById(holder, projectDatabaseId, project);
      const settled = Promise.allSettled([rename(checklist.pageItemId, "Release plan")]);
      await lockWait();
      // While it waits for the parent it holds no lock on the page: another transaction takes that row at once.
      const page = await inTenant((client) => lockItemByIdNowait(client, pagesDatabaseId, checklist.pageItemId));
      expect(page?.id).toBe(checklist.pageItemId);
      await commit();
      const [outcome] = await settled;
      expect(outcome?.status).toBe("fulfilled");
    });
    expect(await titleOf(checklist.pageItemId)).toBe("Release plan");
  });
});
