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
 * Copies `page` block text onto the `title` of the Pages items they name. The block is the source and the title a
 * mirror, so this never writes the document. Only live pages whose parent is this item are written (first block
 * wins). Locking only own children keeps two jobs from waiting on each other's rows, given that only the creation
 * owner sets `parentItemId` (on a fresh row) and it refuses ancestor cycles.
 */
export async function handlePageTitleMirrorTask(pool: Pool, payload: unknown): Promise<void> {
  const { itemId } = payloadSchema.parse(payload);
  await withTransaction(pool, async (client) => {
    // Lock order: host row (the lock a trash takes first), document, then own Pages items in id order. An earlier
    // trash makes this a no-op; a later one waits until the titles are written.
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

    // Unlocked preselect so foreign pages are never locked; rechecked under the row lock below.
    const children = (await getItemsByIds(client, [...titles.keys()]))
      .filter((page) => page.databaseId === pagesDatabase.id && page.properties.parentItemId === itemId)
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const page of children) {
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
