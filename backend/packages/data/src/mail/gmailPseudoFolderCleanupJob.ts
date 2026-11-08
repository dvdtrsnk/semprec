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
import {
  GMAIL_ARCHIVE_PROVIDER_ID,
  GMAIL_PLACEMENT_LABEL_IDS,
  lockGmailFolderState,
  type GmailLabelRef,
} from "./gmailReconcile.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";

const PAGE_SIZE = 200;
const CLEANUP_JOB_KEY = "mail-gmail-pseudo-folder-cleanup";

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
async function listPseudoFolderIds(
  client: PoolClient,
  context: CleanupContext,
  mailboxItemId: string,
  ids: string[],
  afterId: string | null,
) {
  const { rows } = await client.query<{ id: string }>(
    `SELECT DISTINCT i.id FROM items i
       JOIN item_relations r ON (r.item_a = i.id OR r.item_b = i.id)
      WHERE i.database_id = $1 AND i.deleted_at IS NULL AND i.properties ->> 'providerId' = ANY($2::text[])
        AND r.relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $3 OR property_id_b = $3)
        AND (r.item_a = $4 OR r.item_b = $4)
        AND ($5::uuid IS NULL OR i.id > $5)
      ORDER BY i.id LIMIT $6`,
    [context.foldersDatabaseId, ids, context.mailboxFolderRelationPropertyId, mailboxItemId, afterId, PAGE_SIZE],
  );
  return rows.map((row) => row.id);
}

async function folderStillEligible(
  client: PoolClient,
  context: CleanupContext,
  mailboxItemId: string,
  folderItemId: string,
  ids: string[],
): Promise<boolean> {
  const { rows } = await client.query<{ eligible: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM items i JOIN item_relations r ON (r.item_a = i.id OR r.item_b = i.id)
        WHERE i.id = $1 AND i.database_id = $2 AND i.deleted_at IS NULL
          AND i.properties ->> 'providerId' = ANY($3::text[])
          AND r.relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $4 OR property_id_b = $4)
          AND (r.item_a = $5 OR r.item_b = $5)
     ) AS eligible`,
    [folderItemId, context.foldersDatabaseId, ids, context.mailboxFolderRelationPropertyId, mailboxItemId],
  );
  return rows[0]?.eligible === true;
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
 * Removes provider-confirmed non-placement system label folders for every Gmail API mailbox.
 * Unknown ids and user labels remain. A message that is left
 * without INBOX/SPAM/TRASH/SENT/DRAFT gets the Archive edge so it stays visible. Per pseudo-folder it
 * walks the folder's message edges in keyset pages, one transaction per page
 * (docs/adr/2026-09-28-chunked-transactions-for-large-background-sweeps.md); the folder item
 * itself is removed in a last transaction once its edges are gone. Idempotent: a second run finds no
 * pseudo-folder.
 */
export async function handleMailGmailPseudoFolderCleanupTask(
  pool: Pool,
  loadLabels: ((mailboxItemId: string) => Promise<GmailLabelRef[]>) | undefined,
): Promise<void> {
  await forEachActiveTenant(pool, async () => {
    const { context, mailboxItemIds } = await loadContext(pool);
    for (const mailboxItemId of mailboxItemIds) {
      if (!loadLabels) throw new Error("Gmail label loader is not configured");
      const labels = await loadLabels(mailboxItemId);
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const label of labels) {
        if (
          !label ||
          typeof label.id !== "string" ||
          !label.id ||
          typeof label.name !== "string" ||
          (label.type !== "user" && label.type !== "system") ||
          seen.has(label.id)
        ) {
          throw new Error("Gmail label inventory is invalid or contains duplicate ids");
        }
        seen.add(label.id);
        if (
          label.type === "system" &&
          label.id !== GMAIL_ARCHIVE_PROVIDER_ID &&
          !GMAIL_PLACEMENT_LABEL_IDS.includes(label.id)
        )
          ids.push(label.id);
      }
      let afterFolderId: string | null = null;
      for (;;) {
        const pseudoFolderIds = await withTransaction(pool, (client) =>
          listPseudoFolderIds(client, context, mailboxItemId, ids, afterFolderId),
        );
        for (const folderItemId of pseudoFolderIds) {
          let afterMessageId: string | null = null;
          for (;;) {
            const lastMessageId: string | null = await withTransaction(pool, async (client) => {
              await lockGmailFolderState(client, mailboxItemId);
              if (!(await folderStillEligible(client, context, mailboxItemId, folderItemId, ids))) return null;
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
            await lockGmailFolderState(client, mailboxItemId);
            if (!(await folderStillEligible(client, context, mailboxItemId, folderItemId, ids))) return;
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
        if (pseudoFolderIds.length < PAGE_SIZE) break;
        afterFolderId = pseudoFolderIds[pseudoFolderIds.length - 1] ?? null;
      }
    }
  });
}
