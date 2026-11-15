import type { Readable } from "node:stream";
import type { Pool } from "pg";
import {
  MAX_EXTRACTED_ATTACHMENTS,
  classifyForExtraction,
  extractAttachmentDocument,
  getBlob,
  getSystemTimezone,
  listInboxAttachments,
  recordInboxAttachmentExtraction,
  withTransaction,
  type AttachmentCaptureContext,
  type AttachmentExtraction,
  type ExtractionImage,
  type ItemRow,
} from "@semprec/data";
import type { AiGatewayClientPort } from "@semprec/shared";

/** What the extraction needs besides the pool: the gateway and the way to open the stored bytes of a blob. */
export interface AttachmentExtractionPorts {
  gateway: AiGatewayClientPort;
  openBlob: (storageKey: string) => Promise<Readable | null>;
}

/** The extraction of one attachment of the Inbox item, in the order of the attachments' positions. */
export interface AttachmentDocument {
  attachmentId: string;
  extraction: AttachmentExtraction;
}

/** An attachment of the plan: its stored extraction, or the reduced copy to read. */
type PlannedAttachment =
  | { attachmentId: string; stored: AttachmentExtraction }
  | { attachmentId: string; stored: null; image: ExtractionImage };

function textProperty(item: ItemRow, key: string): string {
  const value: unknown = item.properties[key];
  return typeof value === "string" ? value : "";
}

/**
 * The document data of the image attachments of an Inbox item (issue gh-1970), for the proposal computation to hand to
 * its model call. At most `MAX_EXTRACTED_ATTACHMENTS` attachments take part: the first ones, by position, that are
 * images with a reduced copy (`classifyForExtraction`); a PDF, audio and an image the metadata job could not read take
 * none. An attachment with a stored extraction is returned as stored and makes no gateway call. Another one is read
 * through the gateway and stored once; two runs that started together keep the first stored value.
 *
 * The attachments are listed by the Inbox item's id in the tenant in scope, so an attachment of another tenant or of
 * another item is not reachable. The plan is read in one short transaction, each gateway call runs with no transaction
 * open, and each answer is stored in a transaction of its own. A failure of a call throws, so nothing of the later
 * attachments is read and nothing is stored for the failed one; the extractions stored before it stay, and the next run
 * reuses them. An attachment deleted while the model was reading it is left out of the result.
 */
export async function resolveAttachmentDocuments(
  pool: Pool,
  ports: AttachmentExtractionPorts,
  sourceItem: ItemRow,
  projectItemId: string,
): Promise<AttachmentDocument[]> {
  const { planned, timezone } = await withTransaction(pool, async (client) => {
    const planned: PlannedAttachment[] = [];
    for (const attachment of await listInboxAttachments(client, [sourceItem.id])) {
      if (planned.length === MAX_EXTRACTED_ATTACHMENTS) break;
      if (classifyForExtraction(attachment) !== "extract" || attachment.reducedBlobId === null) continue;
      if (attachment.extraction) {
        planned.push({ attachmentId: attachment.attachmentId, stored: attachment.extraction });
        continue;
      }
      const reduced = await getBlob(client, attachment.reducedBlobId);
      if (!reduced) throw new Error(`The reduced copy of attachment ${attachment.attachmentId} has no blob row`);
      planned.push({
        attachmentId: attachment.attachmentId,
        stored: null,
        image: { attachmentId: attachment.attachmentId, storageKey: reduced.storageKey, mimeType: reduced.mimeType },
      });
    }
    return { planned, timezone: await getSystemTimezone(client) };
  });

  const captureContext: AttachmentCaptureContext = {
    captureDate: textProperty(sourceItem, "date"),
    captureTime: textProperty(sourceItem, "time"),
    timezone,
  };
  const deps = { gateway: ports.gateway, openBlob: ports.openBlob, projectItemId };
  const documents: AttachmentDocument[] = [];
  for (const entry of planned) {
    if (entry.stored !== null) {
      documents.push({ attachmentId: entry.attachmentId, extraction: entry.stored });
      continue;
    }
    const answer = await extractAttachmentDocument(deps, entry.image, textProperty(sourceItem, "text"), captureContext);
    const extraction = await withTransaction(pool, (client) =>
      recordInboxAttachmentExtraction(client, {
        attachmentId: entry.attachmentId,
        inboxItemId: sourceItem.id,
        extraction: answer,
      }),
    );
    if (extraction) documents.push({ attachmentId: entry.attachmentId, extraction });
  }
  return documents;
}
