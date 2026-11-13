import type { Pool } from "pg";
import { z } from "zod";
import { readPageBlocks } from "@semprec/block-model";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { getItemsByIds, lockItemById } from "../chokePoint/itemsStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { loadDocWithClient } from "./docPersistence.js";
import { getDocByItemId } from "./docsStore.js";
import { normalizePageTitle } from "./pageTitle.js";
import { PAGES_MODULE_ID } from "./pagesDatabase.js";

const payloadSchema = z.object({ itemId: z.uuid() }).strict();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `pageTitleMirror` task (issue #1715): copies the plain text of the `page` blocks of one item's document onto
 * the `title` of the Pages items they name, in one transaction. The block text is the source and the item title a
 * mirror (`docs/adr/2026-10-29-subpages-are-items-of-a-hidden-pages-database.md`), so the job only ever writes items
 * and never the document. A completed no-op when the item is missing or trashed (checked under a lock on its row),
 * has no page document, or the tenant has no Pages database yet.
 *
 * A block is mirrored only when it names a live Pages item whose `parentItemId` is this document's item: a block that
 * points to a trashed page, to a page of another parent, to an item of another database or to an unknown id is left
 * alone. The mirrored title is the block text through `normalizePageTitle`, cut to the length limit rather than refused.
 * When several blocks name one page the first in document order wins. The `title` is written under the `pages` owner
 * process through the choke point, one row lock per page, taken in id order. Only the pages that name this item as
 * their parent are locked, so a reference to any other page takes no lock of this job.
 * `docs/adr/2026-11-09-page-title-mirror-locks-only-children-it-owns.md` states the premise (only the creation owner
 * sets `parentItemId`, on a fresh row, and it refuses an ancestor cycle) under which that keeps two jobs from waiting on
 * each other's host row, and what it does not claim.
 */
export async function handlePageTitleMirrorTask(pool: Pool, payload: unknown): Promise<void> {
  const { itemId } = payloadSchema.parse(payload);
  await withTransaction(pool, async (client) => {
    // The host row is reserved (blocking `FOR UPDATE`, the lock a trash of the host takes first) and rechecked live
    // before its document is loaded or any child is written: a trash committed earlier makes this a no-op, and a
    // trash that starts later waits until this transaction has written the titles. Lock order: host, document, then
    // the host's own Pages items in id order. The trash or restore of a host that is not a page locks the host first,
    // its subpages after it, and writes the host's document after that (issue #1763); the trash or restore of a page
    // locks that page first, its subpages after it, and writes its parent's document last. See
    // docs/adr/2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position.md and
    // docs/adr/2026-11-12-a-trashed-host-takes-its-subpages-into-its-deletion-epoch.md.
    const [visible] = await getItemsByIds(client, [itemId]);
    const host = visible ? await lockItemById(client, visible.databaseId, itemId) : null;
    if (!host || host.deletedAt !== null) return;
    const docRow = await getDocByItemId(client, itemId);
    if (docRow?.kind !== "page") return;
    const pagesDatabase = await databasesStore.getDatabaseByModuleId(client, PAGES_MODULE_ID);
    if (!pagesDatabase) return;

    const ydoc = await loadDocWithClient(client, docRow.id);
    const titles = new Map<string, string>();
    try {
      for (const block of readPageBlocks(ydoc)) {
        if (block.type !== "page" || block.pageId === null || !UUID_RE.test(block.pageId)) continue;
        const pageId = block.pageId.toLowerCase();
        if (!titles.has(pageId)) {
          titles.set(pageId, normalizePageTitle(block.text.map((run) => run.insert).join(""), { truncate: true }));
        }
      }
    } finally {
      ydoc.destroy();
    }

    // The unlocked read selects the pages that currently name this item as their parent; a page that does not is never
    // locked. The parent is read again under the row lock below, which catches a page trashed or moved since this read.
    const children = (await getItemsByIds(client, [...titles.keys()]))
      .filter((page) => page.databaseId === pagesDatabase.id && page.properties.parentItemId === itemId)
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const page of children) {
      // The row lock makes the live and parent checks below the state this update replaces.
      const locked = await lockItemById(client, page.databaseId, page.id);
      const title = titles.get(page.id);
      if (!locked || locked.deletedAt !== null || locked.properties.parentItemId !== itemId) continue;
      if (title === undefined || locked.properties.title === title) continue;
      await updateItemWithClient(
        client,
        { databaseId: page.databaseId, itemId: page.id, propertiesPatch: { title } },
        { allowedSystemKeys: ["title"], systemOwnerProcess: PAGES_MODULE_ID },
      );
    }
  });
}
