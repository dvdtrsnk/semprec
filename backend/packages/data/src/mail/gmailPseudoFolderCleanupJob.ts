import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { withTransaction } from "../db/pool.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { FOLDERS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { ensureFolderItem } from "./folderDiscovery.js";
import { GMAIL_ARCHIVE_PROVIDER_ID, GMAIL_PLACEMENT_LABEL_IDS } from "./gmailReconcile.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";

const PAGE_SIZE = 200;
const CLEANUP_JOB_KEY = "mail-gmail-pseudo-folder-cleanup";

/**
 * Gmail system labels that were wrongly turned into folders. Matched by provider id because the
 * job has no Gmail client; user labels (`Label_*`), the five system folders and the Archive folder
 * never match.
 */
const PSEUDO_LABEL_ID_PATTERN = "^(UNREAD|STARRED|IMPORTANT|CHAT|CATEGORY_[A-Z_]+)$";

/** Enqueues the one-off cleanup under a fixed job key, so repeated deploys collapse into one job. */
export async function enqueueMailGmailPseudoFolderCleanup(pool: Pool): Promise<void> {
  await enqueueJob(
    pool,
    CORE_TASK_NAMES.MAIL_GMAIL_PSEUDO_FOLDER_CLEANUP,
    {},
    { jobKey: CLEANUP_JOB_KEY, maxAttempts: 3 },
  );
}

interface CleanupContext {
  foldersDatabaseId: string;
  folderRelationPropertyId: string;
  folderRelationDefinitionId: string;
  mailboxFolderRelationPropertyId: string;
}

async function loadContext(pool: Pool): Promise<{ context: CleanupContext; mailboxItemIds: string[] }> {
  return withTransaction(pool, async (client) => {
    const moduleIds = await resolveMailModuleIds(client);
    const [folderProperty, mailboxFolderProperty] = await Promise.all([
      getPropertyByKey(client, moduleIds.emailsDatabaseId, "folder"),
      getPropertyByKey(client, moduleIds.foldersDatabaseId, "mailbox"),
    ]);
    if (!folderProperty || !mailboxFolderProperty)
      throw new Error("Email module schema is missing an expected relation property");
    const definition = await getRelationDefinitionByPropertyId(client, folderProperty.id);
    if (!definition) throw new Error(`Folder relation property ${folderProperty.id} has no relation definition`);
    const { rows } = await client.query<{ item_id: string }>(
      `SELECT item_id FROM mail_account_sync_state WHERE sync_mode = 'gmail_api' ORDER BY item_id`,
    );
    return {
      context: {
        foldersDatabaseId: moduleIds.foldersDatabaseId,
        folderRelationPropertyId: folderProperty.id,
        folderRelationDefinitionId: definition.id,
        mailboxFolderRelationPropertyId: mailboxFolderProperty.id,
      },
      mailboxItemIds: rows.map((row) => row.item_id),
    };
  });
}

/** Folder items of this mailbox whose provider id is one of the removed pseudo-labels. */
async function listPseudoFolderIds(client: PoolClient, context: CleanupContext, mailboxItemId: string) {
  const { rows } = await client.query<{ id: string }>(
    `SELECT i.id FROM items i
       JOIN item_relations r ON (r.item_a = i.id OR r.item_b = i.id)
      WHERE i.database_id = $1 AND i.deleted_at IS NULL AND i.properties ->> 'providerId' ~ $2
        AND r.relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $3 OR property_id_b = $3)
        AND (r.item_a = $4 OR r.item_b = $4)
      ORDER BY i.id`,
    [context.foldersDatabaseId, PSEUDO_LABEL_ID_PATTERN, context.mailboxFolderRelationPropertyId, mailboxItemId],
  );
  return rows.map((row) => row.id);
}

/** Whether the message still has an edge to INBOX/SPAM/TRASH/SENT/DRAFT of this mailbox. */
async function hasPlacementFolder(
  client: PoolClient,
  context: CleanupContext,
  messageItemId: string,
  mailboxItemId: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM item_relations r
       JOIN items f ON f.id = CASE WHEN r.item_a = $2 THEN r.item_b ELSE r.item_a END
      WHERE r.relation_definition_id = $1 AND (r.item_a = $2 OR r.item_b = $2)
        AND f.deleted_at IS NULL AND f.properties ->> 'providerId' = ANY($3::text[])
        AND EXISTS (
          SELECT 1 FROM item_relations m
           WHERE m.relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $5 OR property_id_b = $5)
             AND (m.item_a = f.id OR m.item_b = f.id) AND (m.item_a = $4 OR m.item_b = $4))
      LIMIT 1`,
    [
      context.folderRelationDefinitionId,
      messageItemId,
      GMAIL_PLACEMENT_LABEL_IDS,
      mailboxItemId,
      context.mailboxFolderRelationPropertyId,
    ],
  );
  return rows.length > 0;
}

/**
 * Removes the Gmail pseudo-label folders (UNREAD, STARRED, IMPORTANT, CHAT, CATEGORY_*) that
 * earlier syncs created, for every Gmail API mailbox of every tenant. A message that is left
 * without INBOX/SPAM/TRASH/SENT/DRAFT gets the Archive edge so it stays visible. Per pseudo-folder it
 * walks the folder's message edges in keyset pages, one transaction per page
 * (docs/adr/2026-09-28-chunked-transactions-for-large-background-sweeps.md); the folder item
 * itself is removed in a last transaction once its edges are gone. Idempotent: a second run finds no
 * pseudo-folder.
 */
export async function handleMailGmailPseudoFolderCleanupTask(pool: Pool): Promise<void> {
  await forEachActiveTenant(pool, async () => {
    const { context, mailboxItemIds } = await loadContext(pool);
    for (const mailboxItemId of mailboxItemIds) {
      const pseudoFolderIds = await withTransaction(pool, (client) =>
        listPseudoFolderIds(client, context, mailboxItemId),
      );
      for (const folderItemId of pseudoFolderIds) {
        let afterMessageId: string | null = null;
        for (;;) {
          const lastMessageId: string | null = await withTransaction(pool, async (client) => {
            const archiveFolderItemId = await ensureFolderItem(client, {
              foldersDatabaseId: context.foldersDatabaseId,
              mailboxItemId,
              mailboxRelationPropertyId: context.mailboxFolderRelationPropertyId,
              providerId: GMAIL_ARCHIVE_PROVIDER_ID,
              name: "Archive",
              behavior: "label",
              specialPurpose: "archive",
            });
            const { rows } = await client.query<{ message_id: string }>(
              `SELECT message_id FROM (
                 SELECT CASE WHEN item_a = $2 THEN item_b ELSE item_a END AS message_id
                   FROM item_relations
                  WHERE relation_definition_id = $1 AND (item_a = $2 OR item_b = $2)) edges
                WHERE ($3::uuid IS NULL OR message_id > $3)
                ORDER BY message_id
                LIMIT $4`,
              [context.folderRelationDefinitionId, folderItemId, afterMessageId, PAGE_SIZE],
            );
            for (const { message_id: messageItemId } of rows) {
              await deleteRelationWithClient(
                client,
                {
                  relationPropertyId: context.folderRelationPropertyId,
                  callerItemId: messageItemId,
                  targetItemId: folderItemId,
                },
                EMAILS_RELATION_CONTEXT,
              );
              if (await hasPlacementFolder(client, context, messageItemId, mailboxItemId)) continue;
              const edges = await listRelationsForItem(client, context.folderRelationDefinitionId, messageItemId);
              if (edges.some((edge) => otherSide(edge, messageItemId) === archiveFolderItemId)) continue;
              await createRelationWithClient(
                client,
                {
                  relationPropertyId: context.folderRelationPropertyId,
                  callerItemId: messageItemId,
                  targetItemId: archiveFolderItemId,
                },
                EMAILS_RELATION_CONTEXT,
              );
            }
            return rows.length === PAGE_SIZE ? (rows[rows.length - 1]?.message_id ?? null) : null;
          });
          if (lastMessageId === null) break;
          afterMessageId = lastMessageId;
        }
        await withTransaction(pool, async (client) => {
          await deleteRelationWithClient(
            client,
            {
              relationPropertyId: context.mailboxFolderRelationPropertyId,
              callerItemId: folderItemId,
              targetItemId: mailboxItemId,
            },
            { ownerProcess: FOLDERS_MODULE_ID },
          );
          await itemDeleteWithClient(client, context.foldersDatabaseId, folderItemId, {
            queueAffinity: createActionQueueAffinity(),
          });
        });
      }
    }
  });
}
