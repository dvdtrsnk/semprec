// Daily sweep: a Pages item whose parent's document holds no `page` block for it is trashed through the choke point,
// so it stays restorable.
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

const PAGE_ORPHAN_SWEEP_CHUNK_SIZE = 200;

/** A page is left alone while its parent's document was edited more recently than this. */
const PAGE_ORPHAN_MIN_IDLE_SECONDS = 60 * 60;

export interface PageOrphanSweepResult {
  /** Excludes the subpages that went with them. */
  trashed: number;
  /** Retried by the next run. */
  failed: number;
}

interface Cursor {
  parentItemId: string;
  pageId: string;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** Ordered by parent so one parent's pages arrive together. Unlocked; `trashOrphans` decides again under locks. */
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

/** The idle time is read after loading (and so locking) the document, so an edit committed before the lock is seen. */
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
 * Page rows are locked in id order before any document, matching a single-page trash (page, then parent document).
 * Trashing through the choke point lets the `pageTrash.ts` hooks take subpages along.
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
 * One transaction per chunk; a failed chunk is retried one page per transaction so a single bad page (logged without
 * content) does not stop the others.
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
 * A page block moved into another document leaves `parentItemId` unchanged (the server does not follow the move), so
 * that page is an orphan of its old parent and is trashed.
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
