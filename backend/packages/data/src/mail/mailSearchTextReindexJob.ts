import type { Pool } from "pg";
import { openBlobFromRoots } from "../blobs/openBlobFromRoots.js";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { extractAttachmentText, isTextExtractableContentType } from "./attachmentTextExtraction.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import { logger } from "./logger.js";
import { buildMailSearchText } from "./mailSearchText.js";
import { MAX_ATTACHMENT_BYTES } from "./providerTypes.js";
import { reindexItemSearch } from "./search.js";

const PAGE_SIZE = 50;
const JOB_KEY = "mail-search-text-reindex";

/** A fixed key coalesces pending rebuilds; the named queue serializes a running job and its successor. */
export async function enqueueMailSearchTextReindex(pool: Pool): Promise<void> {
  await enqueueJob(
    pool,
    CORE_TASK_NAMES.MAIL_SEARCH_TEXT_REINDEX,
    {},
    {
      jobKey: JOB_KEY,
      queueName: JOB_KEY,
      maxAttempts: 3,
    },
  );
}

interface MessageRow {
  id: string;
  subject: string | null;
  body: string | null;
  sender_name: string | null;
  sender_address: string | null;
}
interface AttachmentRow {
  storage_key: string;
  content_type: string;
}

async function attachmentText(
  storage: BlobStorageWriter,
  alternate: BlobStorageWriter,
  attachment: AttachmentRow,
): Promise<string | null> {
  if (!isTextExtractableContentType(attachment.content_type)) return null;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = await openBlobFromRoots({ primary: storage, alternate, storageKey: attachment.storage_key });
    if (!stream) {
      logger.warn("Mail attachment search extraction could not find stored bytes");
      return null;
    }
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Attachment stream returned a non-buffer chunk");
      size += chunk.length;
      if (size > MAX_ATTACHMENT_BYTES) throw new Error("Attachment exceeds extraction limit");
      chunks.push(chunk);
    }
    return await extractAttachmentText(attachment.content_type, Buffer.concat(chunks));
  } catch (error) {
    // Attachment read and extraction failures are best-effort; diagnostics exclude content and paths.
    logger.warn(
      { errorName: error instanceof Error ? error.name : typeof error },
      "Mail attachment search extraction failed",
    );
    return null;
  }
}

/** Rebuilds active tenants' live messages in independently committed keyset pages. */
export async function handleMailSearchTextReindexTask(
  pool: Pool,
  storage: BlobStorageWriter,
  alternate: BlobStorageWriter,
): Promise<void> {
  await forEachActiveTenant(pool, async () => {
    let after: string | null = null;
    for (;;) {
      const next: string | null = await withTransaction(pool, async (client) => {
        const database = await getDatabaseByModuleId(client, EMAILS_MODULE_ID);
        if (!database) return null;
        const { rows } = await client.query<MessageRow>(
          `SELECT i.id, i.properties ->> 'name' AS subject, i.properties ->> 'body' AS body,
                  m.envelope -> 'from' ->> 'name' AS sender_name,
                  m.envelope -> 'from' ->> 'address' AS sender_address
           FROM items i LEFT JOIN mail_message_meta m ON m.item_id = i.id
           WHERE i.database_id = $1 AND i.deleted_at IS NULL AND ($2::uuid IS NULL OR i.id > $2)
           ORDER BY i.id LIMIT $3 FOR UPDATE OF i`,
          [database.id, after, PAGE_SIZE],
        );
        for (const row of rows) {
          const attachments = await client.query<AttachmentRow>(
            `SELECT b.storage_key, a.content_type FROM mail_attachments a JOIN blobs b ON b.id = a.blob_id
             WHERE a.message_item_id = $1 ORDER BY a.id`,
            [row.id],
          );
          const extractedTexts: string[] = [];
          for (const attachment of attachments.rows) {
            const text = await attachmentText(storage, alternate, attachment);
            if (text) extractedTexts.push(text);
          }
          await reindexItemSearch(client, {
            itemId: row.id,
            databaseId: database.id,
            text: buildMailSearchText({
              subject: row.subject,
              senderName: row.sender_name,
              senderAddress: row.sender_address,
              bodyHtml: row.body,
              extractedTexts,
            }),
          });
        }
        return rows.length === PAGE_SIZE ? (rows.at(-1)?.id ?? null) : null;
      });
      if (next === null) break;
      after = next;
    }
  });
}
