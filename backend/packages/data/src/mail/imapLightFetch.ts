import type { FetchMessageObject, MessageAddressObject, MessageStructureObject } from "imapflow";
import type { MailAttachmentPart } from "./attachments.js";
import { isDeliveryStatusReport } from "./dsn.js";
import type { ImapFetchedMessage } from "./imapReconcile.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";

/**
 * The longest Message-ID, In-Reply-To, reference, provider message id or address stored, in UTF-8 bytes: a header line's
 * limit (RFC 5322), well inside the row a btree index takes (Message-IDs and provider ids are indexed, addresses are
 * lookup keys). The server's own sync leaves a longer value out, as if the message had none; a native client's upload
 * of one is refused (`parseImapFetchResponse`).
 */
export const MAIL_HEADER_VALUE_MAX_BYTES = 998;

function fits(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= MAIL_HEADER_VALUE_MAX_BYTES;
}

function bounded(value: string | undefined): string | undefined {
  return value !== undefined && fits(value) ? value : undefined;
}

function toEnvelopeAddress(value: MessageAddressObject | undefined): MailEnvelopeAddress | undefined {
  const address = bounded(value?.address);
  return address ? { name: value?.name || undefined, address } : undefined;
}

function optionalReplyTo(replyTo: MailEnvelopeAddress[]): { replyTo?: MailEnvelopeAddress[] } {
  return replyTo.length > 0 ? { replyTo } : {};
}

function toEnvelopeAddressList(list: MessageAddressObject[] | undefined): MailEnvelopeAddress[] {
  return (list ?? []).map(toEnvelopeAddress).filter((a): a is MailEnvelopeAddress => Boolean(a));
}

/** Unfolds imapflow's concatenated header buffer into lines, keeping order and repeats (Delivered-To needs them). */
export function parseHeaderBlock(headerBuffer: Buffer | undefined): Array<{ name: string; value: string }> {
  if (!headerBuffer) return [];
  const lines = headerBuffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
  const headers: Array<{ name: string; value: string }> = [];
  for (const line of lines) {
    // A leading space or tab continues the previous header's value (RFC 5322 folding).
    const previous = headers[headers.length - 1];
    if (/^[ \t]/.test(line) && previous !== undefined) {
      previous.value += ` ${line.trim()}`;
      continue;
    }
    const match = line.match(/^([^:\s]+):\s*(.*)$/);
    if (match) {
      const [, name = "", value = ""] = match;
      headers.push({ name, value });
    }
  }
  return headers;
}

export function headerValues(headers: Array<{ name: string; value: string }>, name: string): string[] {
  return headers.filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value.trim());
}

/** Every `<...>` token across all `References:` headers, in order, but one too long to store. */
function parseReferences(headers: Array<{ name: string; value: string }>): string[] {
  return headerValues(headers, "references")
    .flatMap((value) => value.match(/<[^<>]+>/g) ?? [])
    .filter(fits);
}

/** What BODYSTRUCTURE tells of an attachment part. */
export function attachmentPartOf(node: MessageStructureObject): MailAttachmentPart {
  return {
    filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? "attachment",
    contentType: node.type,
    contentId: node.id ? node.id.replace(/^<|>$/g, "") : null,
    disposition: node.disposition === "inline" ? "inline" : "attachment",
  };
}

/**
 * A part's decoded size from its encoded one: base64 carries 3 bytes in 4 characters, with a CRLF after every 76. A size
 * that is no count of octets (a fraction, a negative or an unsafe number from a broken server) is unknown, 0.
 */
function decodedSizeOf(node: MessageStructureObject): number {
  const size = node.size !== undefined && Number.isSafeInteger(node.size) && node.size >= 0 ? node.size : 0;
  return node.encoding?.toLowerCase() === "base64" ? Math.floor(((size * 76) / 78) * 0.75) : size;
}

/** The header fields the light fetch reads (`BODY.PEEK[HEADER.FIELDS (...)]`): threading, delivery and bulk headers. */
export const IMAP_LIGHT_FETCH_HEADERS = [
  "references",
  "delivered-to",
  "x-original-to",
  "envelope-to",
  "list-unsubscribe",
  "list-id",
  "precedence",
  "auto-submitted",
] as const;

export interface MimeTree {
  textPlainPart?: MessageStructureObject;
  textHtmlPart?: MessageStructureObject;
  attachmentParts: MessageStructureObject[];
}

/**
 * Finds body and attachment parts from BODYSTRUCTURE without fetching bytes. This is why messages
 * are never fetched with `source: true`, which would buffer the whole message (attachments
 * included); each needed part is streamed separately via `download()`.
 */
export function walkBodyStructure(root: MessageStructureObject): MimeTree {
  const tree: MimeTree = { attachmentParts: [] };
  const visit = (node: MessageStructureObject): void => {
    if (node.childNodes && node.childNodes.length > 0) {
      for (const child of node.childNodes) visit(child);
      return;
    }
    const type = (node.type || "").toLowerCase();
    if (!tree.textPlainPart && type === "text/plain" && node.disposition !== "attachment") {
      tree.textPlainPart = node;
      return;
    }
    if (!tree.textHtmlPart && type === "text/html" && node.disposition !== "attachment") {
      tree.textHtmlPart = node;
      return;
    }
    tree.attachmentParts.push(node);
  };
  visit(root);
  return tree;
}

/**
 * The light half of a message: everything a FETCH of its UID, flags, envelope, BODYSTRUCTURE and the
 * `IMAP_LIGHT_FETCH_HEADERS` fields gives, as the sync and a native client's history upload both read it.
 */
export function lightFetchedMessageOf(raw: FetchMessageObject): Omit<ImapFetchedMessage, "fetchContent"> {
  const envelope = raw.envelope;
  const tree = raw.bodyStructure
    ? walkBodyStructure(raw.bodyStructure)
    : { attachmentParts: [] as MessageStructureObject[] };
  const headerList = parseHeaderBlock(raw.headers);
  const snippetNode = tree.textPlainPart ?? tree.textHtmlPart;
  return {
    uid: raw.uid,
    message: {
      messageId: bounded(envelope?.messageId) ?? `<no-message-id-uid-${raw.uid}@generated>`,
      inReplyTo: bounded(envelope?.inReplyTo) ?? null,
      references: parseReferences(headerList),
      subject: envelope?.subject,
      envelope: {
        from: toEnvelopeAddress(envelope?.from?.[0]),
        to: toEnvelopeAddressList(envelope?.to),
        cc: toEnvelopeAddressList(envelope?.cc),
        bcc: toEnvelopeAddressList(envelope?.bcc),
        ...optionalReplyTo(toEnvelopeAddressList(envelope?.replyTo)),
      },
      date: envelope?.date,
      providerMessageId: bounded(raw.emailId) ?? null,
      gmailLabels: raw.labels ? [...raw.labels] : undefined,
      deliveredToHeaders: headerValues(headerList, "delivered-to"),
      xOriginalTo: headerValues(headerList, "x-original-to")[0] ?? null,
      envelopeTo: headerValues(headerList, "envelope-to")[0] ?? null,
      bulkHeaders: {
        listUnsubscribe: headerValues(headerList, "list-unsubscribe")[0] ?? null,
        listId: headerValues(headerList, "list-id")[0] ?? null,
        precedence: headerValues(headerList, "precedence")[0] ?? null,
        autoSubmitted: headerValues(headerList, "auto-submitted")[0] ?? null,
      },
      isDsn: isDeliveryStatusReport(raw.bodyStructure?.type, raw.bodyStructure?.parameters),
      flags: raw.flags ? [...raw.flags] : undefined,
    },
    // Without the HTML no `cid:` reference can be checked, so with an HTML part every inline part that has a
    // Content-ID counts as a rendering asset.
    attachments: tree.attachmentParts
      .filter((node) => !(tree.textHtmlPart && node.disposition === "inline" && node.id))
      .map((node) => ({
        ...attachmentPartOf(node),
        providerPart: node.part ?? "1",
        byteSize: decodedSizeOf(node),
      })),
    ...(snippetNode
      ? {
          snippetPart: {
            // A single-part message's body is its TEXT section; imapflow's download does the same for part "1".
            section: snippetNode.part ?? "TEXT",
            ...(snippetNode.encoding ? { encoding: snippetNode.encoding.toLowerCase() } : {}),
            ...(snippetNode.parameters?.charset ? { charset: snippetNode.parameters.charset } : {}),
            html: snippetNode === tree.textHtmlPart,
          },
        }
      : {}),
  };
}
