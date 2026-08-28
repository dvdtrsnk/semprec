import type { ImapFlow, FetchMessageObject, MessageAddressObject, MessageStructureObject } from "imapflow";
import type { ImapFetchedMessage, ImapFolderRef, ImapFolderSelection, ImapMailClient } from "./imapReconcile.js";
import { MAX_ATTACHMENT_BYTES, type FetchedMessage } from "./providerTypes.js";
import type { ClassifiedAttachment } from "./attachments.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";

/**
 * `MAX_ATTACHMENT_BYTES` (providerTypes.ts, shared with the Gmail/Graph adapters) is passed to
 * `download()`'s own `maxBytes` below, enforced by the streaming decoder pipeline itself (not
 * a post-hoc buffer check) — a pathological or malicious part can never grow the process's
 * memory past this regardless of what the server claims its size is.
 *
 * iCloud Mail Drop (issue #26: "the attachment is then sent as a download link, not a real
 * MIME part") needs no special-case detection here: Mail Drop is Apple Mail's own client-side
 * substitution — the message iCloud's IMAP server actually stores and serves to any client
 * (Mail.app included) already has the large file replaced by a normal, small download-link
 * body; there is no oversized or placeholder MIME part on the wire for a generic IMAP client
 * to mistakenly try to fetch. `walkBodyStructure` below only ever downloads a part BODYSTRUCTURE
 * actually reports, so "try to download a non-existent attachment" cannot happen by
 * construction. `MAX_ATTACHMENT_BYTES` is a separate, general safety net (any
 * oversized/malicious part, not specifically Mail Drop).
 */

function toEnvelopeAddress(value: MessageAddressObject | undefined): MailEnvelopeAddress | undefined {
  return value?.address ? { name: value.name || undefined, address: value.address } : undefined;
}

function toEnvelopeAddressList(list: MessageAddressObject[] | undefined): MailEnvelopeAddress[] {
  return (list ?? []).map(toEnvelopeAddress).filter((a): a is MailEnvelopeAddress => Boolean(a));
}

/** Every `<...>` token in the raw (possibly folded) `References:` header line(s) — the ancestor chain, order preserved, same as mailparser's own splitting rule. */
function parseReferencesHeader(headerBuffer: Buffer | undefined): string[] {
  if (!headerBuffer) return [];
  return headerBuffer.toString("utf8").match(/<[^<>]+>/g) ?? [];
}

export interface MimeTree {
  textPlainPart?: MessageStructureObject;
  textHtmlPart?: MessageStructureObject;
  attachmentParts: MessageStructureObject[];
}

/**
 * Walks BODYSTRUCTURE to find the message's body parts and candidate attachment parts —
 * without ever fetching a part's actual bytes. This is the load-bearing reason
 * `fetchMessagesSince` below never does a `source: true`/whole-message fetch: imapflow types
 * that field as a fully-materialized `Buffer` (attachments included), which is exactly the
 * OOM risk the issue names ("a large attachment entirely into memory before writing it to
 * disk"). BODYSTRUCTURE + ENVELOPE + a small headers fetch are all bounded by header/structure
 * size, never by attachment size — only the two text-body leaves and the surviving attachment
 * leaves are ever downloaded, each through its own streamed `download()` call.
 * multipart/alternative and multipart/related both fall out of plain recursion (no special
 * case needed): a related part's inline image leaves are simply non-text leaves like any
 * other, and an alternative's text/plain + text/html leaves are captured by type as they're
 * visited, wherever they are nested.
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
 * Real `ImapMailClient` (imapReconcile.ts) backed by `imapflow`. Not exercised by this
 * issue's test suite (no live IMAP server in CI) — `imapReconcile.ts`'s reconcile logic is
 * what is actually tested, against a fake client; this class is the composition-root piece a
 * real deployment supplies, the same relationship `LibraryMetadataFetcher`'s real
 * implementation would have to `noopLibraryMetadataFetcher` in issue #25.
 */
export class ImapFlowMailClient implements ImapMailClient {
  constructor(private readonly client: ImapFlow) {}

  async getCapabilities(): Promise<Set<string>> {
    return new Set(this.client.capabilities.keys());
  }

  async listFolders(): Promise<ImapFolderRef[]> {
    const list = await this.client.list();
    return list.map((f) => ({ path: f.path, specialUse: f.specialUse }));
  }

  async selectFolder(path: string): Promise<ImapFolderSelection> {
    const mailbox = await this.client.mailboxOpen(path);
    return {
      uidvalidity: Number(mailbox.uidValidity),
      uidnext: mailbox.uidNext,
      highestModSeq: mailbox.highestModseq !== undefined && !mailbox.noModseq ? Number(mailbox.highestModseq) : null,
    };
  }

  /** Decoded (transfer-encoding + charset, per `download()`'s own pipeline) text content of one bounded body part — never the attachment path, so never subject to `MAX_ATTACHMENT_BYTES`. */
  private async downloadText(uid: number, part: string): Promise<string> {
    const { content } = await this.client.download(String(uid), part, { uid: true });
    const chunks: Buffer[] = [];
    for await (const chunk of content) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  private classifyAttachmentParts(uid: number, parts: MessageStructureObject[], html: string | undefined): ClassifiedAttachment[] {
    const candidates = parts.map((node): ClassifiedAttachment => {
      const contentId = node.id ? node.id.replace(/^<|>$/g, "") : null;
      const disposition: "attachment" | "inline" = node.disposition === "inline" ? "inline" : "attachment";
      const partId = node.part ?? "1";
      return {
        filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? "attachment",
        contentType: node.type,
        contentId,
        disposition,
        // Lazy: bytes only flow once `ingestAttachments` (mail/attachments.ts) actually calls
        // this, streamed straight from the socket through `download()`'s decoder pipeline into
        // `blobStorage.ts`'s `pipeline()` — never buffered whole in between.
        openStream: async () => {
          const { content } = await this.client.download(String(uid), partId, { uid: true, maxBytes: MAX_ATTACHMENT_BYTES });
          return content;
        },
      };
    });
    // An inline part actually referenced via `cid:` inside the HTML body is a rendering asset
    // (a signature logo), not a document — excluded here, same rule the other two adapters
    // apply over their own provider-specific part trees (see attachments.ts's header note).
    return candidates.filter((a) => !(a.disposition === "inline" && a.contentId !== null && Boolean(html?.includes(`cid:${a.contentId}`))));
  }

  private async parseFetchedMessage(raw: FetchMessageObject): Promise<FetchedMessage> {
    const envelope = raw.envelope;
    const tree = raw.bodyStructure ? walkBodyStructure(raw.bodyStructure) : { attachmentParts: [] as MessageStructureObject[] };

    // A single-part message's root BODYSTRUCTURE node sometimes carries no `.part` of its
    // own — `download()` special-cases part id "1" (checking bodyStructure.childNodes itself
    // to pick TEXT vs part 1), so "1" is always a safe fallback for a body leaf we found.
    const bodyText = tree.textPlainPart ? await this.downloadText(raw.uid, tree.textPlainPart.part ?? "1") : undefined;
    const bodyHtml = tree.textHtmlPart ? await this.downloadText(raw.uid, tree.textHtmlPart.part ?? "1") : undefined;

    return {
      messageId: envelope?.messageId ?? `<no-message-id-uid-${raw.uid}@generated>`,
      inReplyTo: envelope?.inReplyTo ?? null,
      references: parseReferencesHeader(raw.headers),
      subject: envelope?.subject,
      envelope: {
        from: toEnvelopeAddress(envelope?.from?.[0]),
        to: toEnvelopeAddressList(envelope?.to),
        cc: toEnvelopeAddressList(envelope?.cc),
        bcc: toEnvelopeAddressList(envelope?.bcc),
      },
      bodyText,
      bodyHtml,
      date: envelope?.date,
      attachments: this.classifyAttachmentParts(raw.uid, tree.attachmentParts, bodyHtml),
    };
  }

  async fetchMessagesSince(path: string, sinceUid: number): Promise<ImapFetchedMessage[]> {
    await this.client.mailboxOpen(path);
    const results: ImapFetchedMessage[] = [];
    // Deliberately no `source: true`: that field is a fully-materialized `Buffer` of the whole
    // raw message, attachments included — see walkBodyStructure's header note. BODYSTRUCTURE +
    // ENVELOPE + the References header are all cheap, bounded fetches; the actual body/
    // attachment bytes are fetched separately, lazily, per part.
    for await (const raw of this.client.fetch(
      `${sinceUid}:*`,
      { uid: true, envelope: true, bodyStructure: true, flags: true, headers: ["references"] },
      { uid: true },
    )) {
      if (raw.uid < sinceUid) continue; // "*" in a range can include one message below sinceUid on an empty-range edge case
      results.push({ uid: raw.uid, message: await this.parseFetchedMessage(raw) });
    }
    return results;
  }

  async fetchVanishedSince(path: string, sinceModSeq: number): Promise<number[] | null> {
    if (!this.client.capabilities.has("QRESYNC")) return null;
    await this.client.mailboxOpen(path);
    const vanished: number[] = [];
    const onExpunge = (event: { vanished: boolean; uid?: number }) => {
      if (event.vanished && event.uid !== undefined) vanished.push(event.uid);
    };
    this.client.on("expunge", onExpunge);
    try {
      // A QRESYNC-enabled fetch with changedSince surfaces VANISHED via the 'expunge' event,
      // not as a return value — this drains that event stream for the duration of the call.
      for await (const _raw of this.client.fetch("1:*", { uid: true }, { uid: true, changedSince: BigInt(sinceModSeq) })) {
        // draining only — flags themselves are picked up by fetchMessagesSince's next pass.
      }
    } finally {
      this.client.off("expunge", onExpunge);
    }
    return vanished;
  }

  async fetchAllUids(path: string): Promise<number[]> {
    await this.client.mailboxOpen(path);
    const uids = await this.client.search({ all: true }, { uid: true });
    return uids === false ? [] : uids;
  }
}
