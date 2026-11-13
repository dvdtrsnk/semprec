// The daily sweep of orphaned subpages (issue #1749): a Pages item whose parent's document holds no `page` block for it
// is sent to the Trash through the choke point's item delete, so it can be restored like any deleted item.
// Constrained by: docs/adr/2026-10-06-system-work-fans-out-per-tenant.md,
// docs/adr/2026-09-28-chunked-transactions-for-large-background-sweeps.md,
// docs/adr/2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position.md
import type { Pool, PoolClient } from "pg";
import { readPageBlocks } from "@semprec/block-model";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemsByIds, lockItemById } from "../chokePoint/itemsStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { withTransaction } from "../db/pool.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { loadDocWithClient } from "./docPersistence.js";
import { getDocByItemId } from "./docsStore.js";
import { logger } from "./logger.js";
import { PAGES_MODULE_ID } from "./pagesDatabase.js";
import { assertSweepNotFailedEntirely, type SweepOutcome } from "./sweepOutcome.js";

/** Most pages one transaction of the sweep examines. */
const PAGE_ORPHAN_SWEEP_CHUNK_SIZE = 200;

/** A page is left alone while the document of its parent was edited less than this many seconds ago. */
const PAGE_ORPHAN_MIN_IDLE_SECONDS = 60 * 60;

/** What the sweep did across all tenants. */
export interface PageOrphanSweepResult {
  /** Pages the sweep itself sent to the Trash; the pages that went with them are not counted. */
  trashed: number;
  /** Pages whose examination or trash failed and was rolled back; they are tried again by the next run. */
  failed: number;
}

/** Position of the last page of a chunk: the listing order is the parent's item id, then the page's item id. */
interface Cursor {
  parentItemId: string;
  pageId: string;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * The next chunk of live Pages items after `cursor`, ordered by parent and then id, so the pages of one parent are
 * listed together. Only pages whose parent item has a `page` document that has been idle for the minimum time are
 * listed; every other page is not an orphan candidate. Whether the parent is live is not read here. A read without
 * locks: `trashOrphans` decides again under locks, so a row that changed since this read is judged on its current
 * state.
 */
async function listCandidatePages(
  client: PoolClient,
  pagesDatabaseId: string,
  cursor: Cursor | null,
): Promise<Array<{ id: string; parentItemId: string }>> {
  const { rows } = await client.query<{ id: string; parent_item_id: string }>(
    `SELECT pg.id, pg.properties->>'parentItemId' AS parent_item_id
       FROM items pg
       JOIN docs d ON d.item_id::text = pg.properties->>'parentItemId' AND d.kind = 'page'
      WHERE pg.database_id = $1 AND pg.deleted_at IS NULL
        AND COALESCE(d.last_edited_at, d.created_at) <= now() - make_interval(secs => $2::int)
        AND ($3::text IS NULL OR (pg.properties->>'parentItemId', pg.id) > ($3::text, $4::uuid))
      ORDER BY pg.properties->>'parentItemId', pg.id
      LIMIT $5`,
    [
      pagesDatabaseId,
      PAGE_ORPHAN_MIN_IDLE_SECONDS,
      cursor?.parentItemId ?? null,
      cursor?.pageId ?? null,
      PAGE_ORPHAN_SWEEP_CHUNK_SIZE,
    ],
  );
  return rows.map((row) => ({ id: row.id, parentItemId: row.parent_item_id }));
}

/**
 * The ids of the pages among `pageIds` that are orphans of the parent `parentItemId`: the parent is live and has a
 * `page` document that has been idle for the minimum time, and the document holds no `page` block with the page's id.
 * Loading the document locks it, and the idle time is read after that, so an edit committed before the lock is seen.
 * Returns no page when the parent is trashed or has no `page` document, or when the document was edited too recently.
 */
async function orphansOfParent(
  client: PoolClient,
  parentItemId: string,
  pageIds: readonly string[],
): Promise<string[]> {
  const [parent] = await getItemsByIds(client, [parentItemId]);
  if (!parent) return [];
  const docRow = await getDocByItemId(client, parentItemId);
  if (docRow?.kind !== "page") return [];
  const doc = await loadDocWithClient(client, docRow.id);
  try {
    const { rows } = await client.query<{ idle: boolean }>(
      `SELECT COALESCE(last_edited_at, created_at) <= now() - make_interval(secs => $2::int) AS idle
         FROM docs WHERE id = $1`,
      [docRow.id, PAGE_ORPHAN_MIN_IDLE_SECONDS],
    );
    if (rows[0]?.idle !== true) return [];
    const referenced = new Set<string>();
    for (const block of readPageBlocks(doc)) {
      if (block.type === "page" && block.pageId !== null) referenced.add(block.pageId.toLowerCase());
    }
    return pageIds.filter((pageId) => !referenced.has(pageId));
  } finally {
    doc.destroy();
  }
}

/**
 * Sends the orphans among the pages `pageIds` to the Trash, in the caller's transaction, and returns how many pages it
 * trashed itself. The rows of the pages that are still live are locked `FOR UPDATE` in id order before any document
 * is loaded, the order a trash of a single page takes them in (the page, then the document of its parent); each
 * parent's document is then loaded once and judged by `orphansOfParent`. An orphan is trashed with the choke point's
 * `itemDeleteWithClient` as the `system` writer, so the hooks of `pageTrash.ts` trash the pages below it too. An
 * orphan that an earlier trash of this call already took along is not trashed again. A failure rolls the whole call
 * back.
 */
async function trashOrphans(client: PoolClient, pagesDatabaseId: string, pageIds: readonly string[]): Promise<number> {
  const { rows } = await client.query<{ id: string; parent_item_id: string | null }>(
    `SELECT id, properties->>'parentItemId' AS parent_item_id FROM items
      WHERE database_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL
      ORDER BY id
      FOR UPDATE`,
    [pagesDatabaseId, pageIds],
  );
  const byParent = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parent_item_id === null) continue;
    byParent.set(row.parent_item_id, [...(byParent.get(row.parent_item_id) ?? []), row.id]);
  }
  const orphanIds: string[] = [];
  for (const parentItemId of [...byParent.keys()].sort()) {
    orphanIds.push(...(await orphansOfParent(client, parentItemId, byParent.get(parentItemId) ?? [])));
  }
  let trashed = 0;
  for (const pageId of orphanIds.sort()) {
    // The trash of an earlier orphan of this call trashes the pages below it, which may be orphans themselves.
    const page = await lockItemById(client, pagesDatabaseId, pageId);
    if (!page || page.deletedAt !== null) continue;
    await itemDeleteWithClient(client, pagesDatabaseId, pageId, {
      queueAffinity: createActionQueueAffinity(),
      writer: { writerKind: "system" },
    });
    trashed += 1;
  }
  return trashed;
}

/**
 * Sweeps the current tenant, which the caller has scoped, in chunks of at most `PAGE_ORPHAN_SWEEP_CHUNK_SIZE` pages,
 * each examined and trashed in one transaction of its own. When a chunk fails it is rolled back as a whole and its
 * pages are examined again one transaction each, so one page that cannot be trashed is logged by id and error name
 * (no content) and does not stop the others. Returns what the examined pages came to.
 */
async function sweepTenantPages(pool: Pool): Promise<SweepOutcome & { trashed: number }> {
  const pagesDatabase = await withTransaction(pool, (client) => getDatabaseByModuleId(client, PAGES_MODULE_ID));
  const outcome = { succeeded: 0, failed: 0, trashed: 0 };
  if (!pagesDatabase) return outcome;
  let cursor: Cursor | null = null;
  for (;;) {
    const chunk = await withTransaction(pool, (client) => listCandidatePages(client, pagesDatabase.id, cursor));
    const last = chunk.at(-1);
    if (!last) return outcome;
    const ids = chunk.map((page) => page.id);
    try {
      outcome.trashed += await withTransaction(pool, (client) => trashOrphans(client, pagesDatabase.id, ids));
      outcome.succeeded += ids.length;
    } catch (err) {
      logger.error(
        { errorName: errorName(err), pageCount: ids.length },
        "Orphan sweep chunk failed; retrying per page",
      );
      for (const pageId of ids) {
        try {
          outcome.trashed += await withTransaction(pool, (client) => trashOrphans(client, pagesDatabase.id, [pageId]));
          outcome.succeeded += 1;
        } catch (pageErr) {
          outcome.failed += 1;
          logger.error({ errorName: errorName(pageErr), pageId }, "Orphan sweep failed for a page");
        }
      }
    }
    if (chunk.length < PAGE_ORPHAN_SWEEP_CHUNK_SIZE) return outcome;
    cursor = { parentItemId: last.parentItemId, pageId: last.id };
  }
}

/**
 * The `pageOrphanSweep` daily core task (issue #1749): for every active tenant, in that tenant's scope, sends every
 * live Pages item that its parent's document no longer references to the Trash, where it stays recoverable until the
 * normal purge. A page is an orphan when its parent is a live item whose `page` document holds no `page` block with
 * the page's id and was last edited at least `PAGE_ORPHAN_MIN_IDLE_SECONDS` ago. A page is left alone when its parent
 * has no `page` document, is in the Trash, or has a document edited more recently. A page block moved into another
 * document leaves the page's `parentItemId` unchanged (the server does not follow such a move), so its page counts as
 * an orphan of the old parent and is trashed. A page that a run trashed is no longer live, so a later run does not
 * examine it.
 *
 * A tenant in which every examined page failed makes the run reject once all tenants were attempted (see
 * `assertSweepNotFailedEntirely` and `forEachActiveTenant`); a partial failure is logged as a warning.
 */
export async function sweepOrphanedPages(pool: Pool): Promise<PageOrphanSweepResult> {
  const total: PageOrphanSweepResult = { trashed: 0, failed: 0 };
  await forEachActiveTenant(pool, async () => {
    const { trashed, ...outcome } = await sweepTenantPages(pool);
    total.trashed += trashed;
    total.failed += outcome.failed;
    assertSweepNotFailedEntirely("pageOrphanSweep", outcome);
  });
  return total;
}
