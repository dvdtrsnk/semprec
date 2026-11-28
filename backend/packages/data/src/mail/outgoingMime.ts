import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { getBlob } from "../blobs/blobsStore.js";
import { openBlobFromRoots, primaryRootForBlob } from "../blobs/openBlobFromRoots.js";
import type { Queryable } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "alldots.local" : address.slice(at + 1);
}

/** Generated only at send time: a draft has no Message-ID until it is submitted. */
export function generateOutgoingMessageId(fromAddress: string): string {
  return `<${randomUUID()}@${domainOf(fromAddress)}>`;
}

export class OutgoingAttachmentMissingError extends NotFoundError {
  constructor(blobId: string, filename: string) {
    super(`Attachment blob ${blobId} (${filename}) was not found`, { blobId, filename });
    this.name = "OutgoingAttachmentMissingError";
  }
}

export type OutgoingCalendarMethod = "REQUEST" | "CANCEL" | "REPLY";

export interface OutgoingAttachmentInput {
  filename: string;
  contentType: string;
  blobId: string;
}

export interface OutgoingMimeInput {
  from: MailEnvelopeAddress;
  to: MailEnvelopeAddress[];
  cc?: MailEnvelopeAddress[];
  bcc?: MailEnvelopeAddress[];
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: OutgoingAttachmentInput[];
  calendar?: { method: OutgoingCalendarMethod; content: string };
}

export interface OutgoingMimeDeps {
  client: Queryable;
  files: BlobStorageWriter;
  mailAttachments: BlobStorageWriter;
  /** Defaults to 25 MiB. */
  maxAttachmentBytes?: number;
}

export interface OutgoingMime {
  raw: Buffer;
  messageId: string;
  /** Bcc addresses appear here and in no header. */
  envelopeRecipients: string[];
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const CALENDAR_METHODS: readonly string[] = ["REQUEST", "CANCEL", "REPLY"];

function assertHeaderSafe(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new ValidationError(`${field} must not contain line breaks`, { field });
  }
}

function checkAddress(field: string, address: MailEnvelopeAddress): void {
  assertHeaderSafe(`${field}.address`, address.address);
  if (address.name !== undefined) assertHeaderSafe(`${field}.name`, address.name);
}

function toComposerAddress(address: MailEnvelopeAddress): { name: string; address: string } {
  return { name: address.name ?? "", address: address.address };
}

/**
 * Builds the raw RFC 5322 message once for any transport to submit unchanged. Header-bound values with
 * a line break are rejected, so nothing can inject headers.
 */
export async function buildOutgoingMime(input: OutgoingMimeInput, deps: OutgoingMimeDeps): Promise<OutgoingMime> {
  const to = input.to;
  const cc = input.cc ?? [];
  const bcc = input.bcc ?? [];
  const attachments = input.attachments ?? [];

  assertHeaderSafe("subject", input.subject);
  assertHeaderSafe("messageId", input.messageId);
  if (input.inReplyTo !== undefined) assertHeaderSafe("inReplyTo", input.inReplyTo);
  input.references?.forEach((ref, i) => assertHeaderSafe(`references[${i}]`, ref));
  checkAddress("from", input.from);
  to.forEach((a, i) => checkAddress(`to[${i}]`, a));
  cc.forEach((a, i) => checkAddress(`cc[${i}]`, a));
  bcc.forEach((a, i) => checkAddress(`bcc[${i}]`, a));
  attachments.forEach((a, i) => {
    assertHeaderSafe(`attachments[${i}].filename`, a.filename);
    assertHeaderSafe(`attachments[${i}].contentType`, a.contentType);
  });
  if (input.calendar && !CALENDAR_METHODS.includes(input.calendar.method)) {
    throw new ValidationError("calendar.method must be REQUEST, CANCEL or REPLY", { field: "calendar.method" });
  }

  const maxBytes = deps.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  let totalBytes = 0;
  const streams: Readable[] = [];
  try {
    const composerAttachments: { filename: string; contentType: string; content: Readable }[] = [];
    for (const attachment of attachments) {
      const blob = await getBlob(deps.client, attachment.blobId);
      if (!blob) throw new OutgoingAttachmentMissingError(attachment.blobId, attachment.filename);
      totalBytes += Number(blob.byteSize);
      if (totalBytes > maxBytes) {
        throw new ValidationError(`Attachments exceed the ${maxBytes}-byte limit`, { field: "attachments" });
      }
      const fromMail = (await primaryRootForBlob(deps.client, blob.id)) === "mailAttachments";
      const stream = await openBlobFromRoots({
        primary: fromMail ? deps.mailAttachments : deps.files,
        alternate: fromMail ? deps.files : deps.mailAttachments,
        storageKey: blob.storageKey,
      });
      if (!stream) throw new OutgoingAttachmentMissingError(attachment.blobId, attachment.filename);
      streams.push(stream);
      composerAttachments.push({ filename: attachment.filename, contentType: attachment.contentType, content: stream });
    }

    const composer = new MailComposer({
      from: toComposerAddress(input.from),
      to: to.map(toComposerAddress),
      cc: cc.map(toComposerAddress),
      // Bcc never reaches a header: it is returned only through the envelope below.
      subject: input.subject,
      text: input.text,
      html: input.html,
      messageId: input.messageId,
      inReplyTo: input.inReplyTo,
      references: input.references,
      attachments: composerAttachments,
      alternatives: input.calendar
        ? [
            {
              contentType: `text/calendar; method=${input.calendar.method}; charset=utf-8`,
              content: input.calendar.content,
            },
          ]
        : undefined,
    });
    const raw = await new Promise<Buffer>((resolve, reject) => {
      composer.compile().build((err, message) => (err ? reject(err) : resolve(message)));
    });
    return {
      raw,
      messageId: input.messageId,
      envelopeRecipients: [...to, ...cc, ...bcc].map((a) => a.address),
    };
  } finally {
    for (const stream of streams) stream.destroy();
  }
}
