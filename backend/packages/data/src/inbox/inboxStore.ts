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
  /** ISO date, e.g. '2026-08-28' — client-supplied, never derived as "today" on the server. */
  date: string;
  /** ISO time, e.g. '14:30' — client-supplied, same reason as `date`. */
  time: string;
  text?: string;
  /** How the item was captured; omitted, the item has no channel (an item created outside the capture route). */
  captureChannel?: CaptureChannel;
  /** The displayed name of the app a share came from, already trimmed and length-checked by the caller. */
  sourceApp?: string;
  /** An Inbox item type's id, or omitted — an untyped item is valid (issue #100's `needsClarification`). */
  type?: string;
  /** Attachments appended to the new item in this order, or omitted; the caller has already validated the blobs. */
  attachments?: NewInboxAttachment[];
  idempotencyKey?: string;
  /** Queue affinity to route the `semprec.tick` onItemEvent heartbeat-fire job to (issue #103). */
  queueAffinity?: ActionQueueAffinity;
}

async function getRelationProperty(client: PoolClient, databaseId: string, key: string) {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
  if (!property) throw new NotFoundError(`Inbox database ${databaseId} has no '${key}' relation property`);
  return property;
}

/**
 * Creates an Inbox item and, when the caller names one, its optional `type` edge. The `date` and
 * `time` are passed through verbatim, never replaced with the server's current date/time: delayed,
 * offline-captured batches must keep the moment the user actually meant. Validating them, and
 * linking the item to its Journal day (`journalDay`), happen in the item-create hook
 * (`inboxCreateHook.ts`, issue #1432), which runs inside `createItemWithClient` for every writer,
 * so this helper does not repeat either. It also writes `addedAt`, the moment the server accepted the item, read from
 * the server clock and independent of the supplied `date` and `time`; the property is system-owned by the Inbox module,
 * so the write names it in `allowedSystemKeys` and runs as that owner process. With an `idempotencyKey` that already
 * reserved an item, that item is returned as it is: the `type` edge and the attachments are written only by the call that created the item, so a replay adds
 * no second edge and no second set of attachments. Each new attachment gets its `inboxAttachmentMetadata` job in the
 * same transaction (issue gh-1965).
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
    // Issue gh-1965: one metadata job per new attachment, in the transaction that creates the row.
    for (const attachmentId of attachmentIds) await enqueueInboxAttachmentMetadata(client, attachmentId);
  }

  return item;
}
