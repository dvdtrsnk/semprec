import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { convergeObservedEmailFlagsWithClient } from "../chokePoint/itemWrites.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { DRAFTS_AND_SENT_SPECIAL_PURPOSES, READ_PROPERTY_KEY } from "./messageFlags.js";

const PAGE_SIZE = 200;

/**
 * One keyset page of Emails items that are not read and sit in a Drafts or Sent folder, in id order.
 * `FOR UPDATE OF i` locks the page in the same transaction that writes it, so the `read` check decides
 * the write under a row lock (state-writes: a read that decides a write locks the row it reads). The
 * folder check is per edge, like the unread search's.
 */
async function listUnreadDraftsAndSentPage(
  client: PoolClient,
  input: { emailsDatabaseId: string; foldersDatabaseId: string; afterItemId: string | null; limit: number },
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT i.id FROM items i
     WHERE i.database_id = $1 AND i.deleted_at IS NULL
       AND ($2::uuid IS NULL OR i.id > $2)
       AND coalesce((i.properties ->> '${READ_PROPERTY_KEY}')::boolean, false) = false
       AND EXISTS (
         SELECT 1 FROM item_relations r
         JOIN items f ON f.id = CASE WHEN r.item_a = i.id THEN r.item_b ELSE r.item_a END
         WHERE (r.item_a = i.id OR r.item_b = i.id)
           AND f.database_id = $3 AND f.deleted_at IS NULL
           AND f.properties ->> 'specialPurpose' = ANY($4::text[])
       )
     ORDER BY i.id LIMIT $5
     FOR UPDATE OF i`,
    [input.emailsDatabaseId, input.afterItemId, input.foldersDatabaseId, DRAFTS_AND_SENT_SPECIAL_PURPOSES, input.limit],
  );
  return rows.map((row) => row.id);
}

/**
 * One-time populated-upgrade backfill for issue #1461. A draft is created read from now on (`draft.ts`),
 * but Emails items written before that rule can be unread while sitting in the Drafts or Sent folder,
 * and they then count as unread. This writes only the `read` property of those items.
 *
 * Each write goes through `convergeObservedEmailFlagsWithClient`, not `updateItemWithClient`, so the change
 * is not recorded as a desired write-back in `mail_message_flag_sync_state`: a local rule is not pushed to
 * the provider. Runs once per tenant, in that tenant's scope, via `runTenantCutoverMigrations`. A tenant
 * without an Emails or a Folders database is skipped: without a Folders database no folder can hold a draft.
 *
 * Idempotent: an item already read is not selected, so a second run changes no row. Keyset pages, one
 * transaction per page (see docs/adr/2026-09-28-chunked-transactions-for-large-background-sweeps.md).
 */
export async function runMailDraftsAndSentReadBackfill(pool: Pool): Promise<void> {
  const databases = await withTransaction(pool, async (client) => {
    const emails = await getDatabaseByModuleId(client, EMAILS_MODULE_ID);
    const folders = await getDatabaseByModuleId(client, FOLDERS_MODULE_ID);
    return emails && folders ? { emailsDatabaseId: emails.id, foldersDatabaseId: folders.id } : null;
  });
  if (!databases) return; // not seeded yet; a fresh seed creates drafts as read

  let afterItemId: string | null = null;
  for (;;) {
    const lastItemId: string | null = await withTransaction(pool, async (client) => {
      const itemIds = await listUnreadDraftsAndSentPage(client, {
        ...databases,
        afterItemId,
        limit: PAGE_SIZE,
      });
      for (const itemId of itemIds) {
        await convergeObservedEmailFlagsWithClient(client, {
          databaseId: databases.emailsDatabaseId,
          itemId,
          propertiesPatch: { [READ_PROPERTY_KEY]: true },
        });
      }
      return itemIds.length === PAGE_SIZE ? (itemIds[itemIds.length - 1] ?? null) : null;
    });
    if (lastItemId === null) return;
    afterItemId = lastItemId;
  }
}
