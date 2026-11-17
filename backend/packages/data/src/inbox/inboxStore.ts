import type { PoolClient } from "pg";
import { createItemReportingReplay } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { NotFoundError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { enqueueInboxAttachmentMetadata } from "./inboxAttachmentMetadata.js";
import { insertInboxAttachments, type NewInboxAttachment } from "./inboxAttachmentsStore.js";
import type { CaptureChannel } from "./captureSource.js";

export interface CreateInboxItemInput {
  inboxDatabaseId: string;
  /** Client-supplied, never derived as "today" on the server. */
  date: string;
  /** Client-supplied, as `date`. */
  time: string;
  text?: string;
  /** Omitted for items created outside the capture route. */
  captureChannel?: CaptureChannel;
  /** Already trimmed and length-checked by the caller. */
  sourceApp?: string;
  /** An untyped item is valid. */
  type?: string;
  /** The caller has already validated the blobs. */
  attachments?: NewInboxAttachment[];
  idempotencyKey?: string;
  queueAffinity?: ActionQueueAffinity;
}

async function getRelationProperty(client: PoolClient, databaseId: string, key: string) {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
  if (!property) throw new NotFoundError(`Inbox database ${databaseId} has no '${key}' relation property`);
  return property;
}

/**
 * `date` and `time` pass through verbatim: delayed, offline-captured batches must keep the moment the user meant.
 * Validation and Journal day linking happen in the item-create hook for every writer. `addedAt` is the server's receive
 * time; it is system-owned by the Inbox module, so the write names it in `allowedSystemKeys`. On an idempotency replay
 * the existing item is returned and no second edge or attachment set is written.
 */
export async function createInboxItemWithClient(client: PoolClient, input: CreateInboxItemInput): Promise<ItemRow> {
  const { item, created } = await createItemReportingReplay(
    client,
    {
      databaseId: input.inboxDatabaseId,
      properties: {
        date: input.date,
        time: input.time,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.captureChannel !== undefined ? { captureChannel: input.captureChannel } : {}),
        ...(input.sourceApp !== undefined ? { sourceApp: input.sourceApp } : {}),
        addedAt: new Date().toISOString(),
      },
      idempotencyKey: input.idempotencyKey,
    },
    { queueAffinity: input.queueAffinity, allowedSystemKeys: ["addedAt"], systemOwnerProcess: INBOX_MODULE_ID },
  );

  if (created && input.type) {
    const typeProperty = await getRelationProperty(client, input.inboxDatabaseId, "type");
    await createRelationWithClient(client, {
      relationPropertyId: typeProperty.id,
      callerItemId: item.id,
      targetItemId: input.type,
    });
  }

  if (created && input.attachments && input.attachments.length > 0) {
    const attachmentIds = await insertInboxAttachments(client, item.id, input.attachments);
    // One metadata job per new attachment, in the transaction that creates the row.
    for (const attachmentId of attachmentIds) await enqueueInboxAttachmentMetadata(client, attachmentId);
  }

  return item;
}
