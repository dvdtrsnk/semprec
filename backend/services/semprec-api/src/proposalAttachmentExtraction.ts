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

export interface AttachmentExtractionPorts {
  gateway: AiGatewayClientPort;
  openBlob: (storageKey: string) => Promise<Readable | null>;
}

/** In the order of the attachments' positions. */
export interface AttachmentDocument {
  attachmentId: string;
  extraction: AttachmentExtraction;
}

type PlannedAttachment =
  | { attachmentId: string; stored: AttachmentExtraction }
  | { attachmentId: string; stored: null; image: ExtractionImage };

function textProperty(item: ItemRow, key: string): string {
  const value: unknown = item.properties[key];
  return typeof value === "string" ? value : "";
}

/**
 * At most `MAX_EXTRACTED_ATTACHMENTS` take part: the first images by position with a reduced copy;
 * PDFs, audio and unreadable images take none. A stored extraction is returned without a gateway
 * call; otherwise the image is read through the gateway and stored once (concurrent runs keep the
 * first stored value).
 *
 * Attachments are listed by the Inbox item's id in the tenant in scope. The plan is read in one
 * short transaction, each gateway call runs with no transaction open, and each answer is stored in
 * its own transaction. A failed call throws: later attachments are not read, earlier extractions
 * stay for the next run. An attachment deleted during the call is left out.
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
