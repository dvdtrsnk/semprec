import type { Readable } from "node:stream";
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import type { ClassifiedAttachment } from "./attachments.js";
import type { ImapFetchedMessage, ImapFlagChange, ImapFolderRef, ImapFolderSelection, ImapMailClient } from "./imapReconcile.js";
import { normalizeMessageId, type FetchedMessage } from "./providerTypes.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";

function flattenImapAddresses(list: { name?: string; address?: string }[] | undefined): MailEnvelopeAddress[] {
  return (list ?? []).filter((a): a is { name?: string; address: string } => Boolean(a.address)).map((a) => ({ name: a.name || undefined, address: a.address }));
}

/** IMAP's ENVELOPE message-id/in-reply-to fields are copied verbatim from the header, angle brackets included — same format `mailparser`/Gmail/Graph already produce, so dedup-by-`Message-ID` across adapters (see mail/ingest.ts) sees the same string regardless of which adapter observed a given message. */
function stripAngleBrackets(id: string | undefined): string | null {
  if (!id) return null;
  return id.replace(/^</, "").replace(/>$/, "");
}

/** `BODY[HEADER.FIELDS (References)]` comes back as raw header lines, folded per RFC 5322 (a continuation line starts with whitespace) — unfolded here before extracting the `<id>` tokens. */
function parseReferencesHeader(headers: Buffer | undefined): string[] {
  if (!headers) return [];
  const unfolded = headers.toString("utf8").replace(/\r\n[ \t]+/g, " ").replace(/\n[ \t]+/g, " ");
  const match = unfolded.match(/^references:\s*(.+)$/im);
  if (!match) return [];
  return match[1].match(/<[^<>]+>/g) ?? [];
}

function collectLeaves(node: MessageStructureObject, acc: MessageStructureObject[] = []): MessageStructureObject[] {
  if (node.childNodes && node.childNodes.length > 0) {
    for (const child of node.childNodes) collectLeaves(child, acc);
  } else {
    acc.push(node);
  }
  return acc;
}

function extractFilename(node: MessageStructureObject): string | undefined {
  return node.dispositionParameters?.filename ?? node.parameters?.name;
}

/** A pathological body (not a real attachment, which streams separately — see openAttachmentStream) has no business being this large; caps memory use the same way httpJson.ts caps a REST response instead of trusting a text/plain or text/html part to be small just because it usually is. */
const MAX_BODY_TEXT_BYTES = 10 * 1024 * 1024;

async function streamToUtf8(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

interface ImapAttachmentCandidate {
  part: string;
  contentType: string;
  filename: string;
  contentId: string | null;
  disposition: "attachment" | "inline";
}

/** Structural split of a message's MIME tree: which leaf is the plain-text body, which is the HTML body, and which leaves are attachment-like (everything else) — mirrors `attachments.ts`'s `classifyAttachments`, just over `bodyStructure` nodes instead of a `mailparser` result, since parsing the full raw source (as `mailparser` requires) is exactly the per-message buffering this client avoids. */
function planParts(structure: MessageStructureObject | undefined): { textPlainPart?: string; textHtmlPart?: string; attachmentCandidates: ImapAttachmentCandidate[] } {
  if (!structure) return { attachmentCandidates: [] };
  const leaves = collectLeaves(structure);
  const textPlain = leaves.find((n) => n.type?.toLowerCase() === "text/plain" && n.disposition !== "attachment" && !extractFilename(n));
  const textHtml = leaves.find((n) => n.type?.toLowerCase() === "text/html" && n.disposition !== "attachment" && !extractFilename(n));
  const attachmentCandidates = leaves
    .filter((n) => n !== textPlain && n !== textHtml)
    .map((n) => ({
      part: n.part ?? "1",
      contentType: n.type,
      filename: extractFilename(n) ?? "attachment",
      contentId: stripAngleBrackets(n.id),
      disposition: (n.disposition === "inline" ? "inline" : "attachment") as "attachment" | "inline",
    }));
  return { textPlainPart: textPlain?.part ?? (textPlain ? "1" : undefined), textHtmlPart: textHtml?.part ?? (textHtml ? "1" : undefined), attachmentCandidates };
}

/**
 * Real `ImapMailClient` (imapReconcile.ts) backed by `imapflow`. Not exercised by this
 * issue's test suite (no live IMAP server in CI) — `imapReconcile.ts`'s reconcile logic is
 * what is actually tested, against a fake client; this class is the composition-root piece a
 * real deployment supplies, the same relationship `LibraryMetadataFetcher`'s real
 * implementation would have to `noopLibraryMetadataFetcher` in issue #25.
 *
 * Deliberately never fetches `source: true` (the whole RFC822 message, attachments
 * included, as one in-memory Buffer): only `envelope`/`bodyStructure`/the three threading
 * headers are pulled per message, body text/html is downloaded part-by-part (small), and
 * attachment bytes are streamed lazily via `client.download(uid, part, opts)` only when
 * `ingestAttachments` (attachments.ts) is actually ready to pipe them to storage — the
 * "direct answer" to large-attachment memory safety the issue calls for.
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

  private async downloadTextPart(uid: number, part: string | undefined): Promise<string | undefined> {
    if (!part) return undefined;
    const { content } = await this.client.download(uid, part, { uid: true, maxBytes: MAX_BODY_TEXT_BYTES });
    return streamToUtf8(content);
  }

  /** Opens the attachment's content stream lazily, at the moment `ingestAttachments` is ready to consume it — never before, and never more than one at a time (the same single IMAP connection can't have two in-flight FETCH literals), which `ingestAttachments`'s sequential `for` loop over attachments already guarantees. */
  private openAttachmentStream(uid: number, part: string): () => Promise<Readable> {
    return async () => (await this.client.download(uid, part, { uid: true })).content;
  }

  private async buildFetchedMessage(raw: FetchMessageObject): Promise<FetchedMessage> {
    const { textPlainPart, textHtmlPart, attachmentCandidates } = planParts(raw.bodyStructure);
    const bodyHtml = await this.downloadTextPart(raw.uid, textHtmlPart);
    const bodyText = await this.downloadTextPart(raw.uid, textPlainPart);

    const attachments: ClassifiedAttachment[] = [];
    for (const candidate of attachmentCandidates) {
      const referencedInline = candidate.disposition === "inline" && candidate.contentId !== null && (bodyHtml ?? "").includes(`cid:${candidate.contentId}`);
      if (referencedInline) continue;
      attachments.push({
        filename: candidate.filename,
        contentType: candidate.contentType,
        contentId: candidate.contentId,
        disposition: candidate.disposition,
        content: { kind: "stream", open: this.openAttachmentStream(raw.uid, candidate.part) },
      });
    }

    return {
      messageId: normalizeMessageId(raw.envelope?.messageId ?? `<no-message-id-uid-${raw.uid}@generated>`),
      inReplyTo: raw.envelope?.inReplyTo ? normalizeMessageId(raw.envelope.inReplyTo) : null,
      references: parseReferencesHeader(raw.headers).map(normalizeMessageId),
      subject: raw.envelope?.subject,
      envelope: {
        from: raw.envelope?.from?.[0]?.address ? { name: raw.envelope.from[0].name || undefined, address: raw.envelope.from[0].address } : undefined,
        to: flattenImapAddresses(raw.envelope?.to),
        cc: flattenImapAddresses(raw.envelope?.cc),
        bcc: flattenImapAddresses(raw.envelope?.bcc),
      },
      bodyText,
      bodyHtml,
      date: raw.envelope?.date,
      attachments,
    };
  }

  async fetchMessagesSince(path: string, sinceUid: number): Promise<ImapFetchedMessage[]> {
    await this.client.mailboxOpen(path);
    const results: ImapFetchedMessage[] = [];
    for await (const raw of this.client.fetch(
      `${sinceUid}:*`,
      { uid: true, flags: true, envelope: true, bodyStructure: true, headers: ["references"] },
      { uid: true },
    )) {
      if (raw.uid < sinceUid) continue; // "*" in a range can include one message below sinceUid on an empty-range edge case
      results.push({ uid: raw.uid, message: await this.buildFetchedMessage(raw) });
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

  async fetchFlagsChangedSince(path: string, sinceModSeq: number): Promise<ImapFlagChange[]> {
    await this.client.mailboxOpen(path);
    const changes: ImapFlagChange[] = [];
    for await (const raw of this.client.fetch("1:*", { uid: true, flags: true }, { uid: true, changedSince: BigInt(sinceModSeq) })) {
      changes.push({ uid: raw.uid, flags: [...(raw.flags ?? [])] });
    }
    return changes;
  }
}
