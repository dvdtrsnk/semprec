import { executeImapMoveStep, type SafeImapMoveStepResult } from "./mailMoveProviderAdapters.js";
import type {
  ImapFlow,
  FetchMessageObject,
  MessageAddressObject,
  MessageStructureObject,
  SearchObject,
  StatusObject,
} from "imapflow";
import { Readable } from "node:stream";
import type {
  ImapFetchedMessage,
  ImapFolderRef,
  ImapFolderSelection,
  ImapMailClient,
  ImapMessageBody,
  ImapMessageContent,
  ImapSnippetPart,
} from "./imapReconcile.js";
import { AttachmentCapExceededError, FlagFetchCapExceededError, MAX_ATTACHMENT_BYTES } from "./providerTypes.js";
import type { ClassifiedAttachment, MailAttachmentPart } from "./attachments.js";
import { decodeBodyPartPrefix, IMAP_SNIPPET_BYTES } from "./imapSnippet.js";
import { htmlToPlainText } from "./mailPlainText.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";
import { isDeliveryStatusReport } from "./dsn.js";
import type { WritableImapFlag } from "./messageFlags.js";
import { searchTextUntilAccepted, type MailSearchTerms } from "./mailSearchTerms.js";
import { logger } from "./logger.js";

// The fallback makes at most MAX_ATTACHMENT_BYTES / IMAP_PARTIAL_FETCH_BYTES requests plus one
// EOF probe, so a broken server cannot cause an unbounded retry loop.
const IMAP_PARTIAL_FETCH_BYTES = 64 * 1024;

// imapflow's fetch has no timeout/signal, so each fetchOne() is raced against this timer; a
// server that stalls mid-response would otherwise hang the sync worker.
const IMAP_PARTIAL_FETCH_TIMEOUT_MS = 30_000;

// Without CONDSTORE the flag fetch covers every UID; this bounds the result held in memory.
const MAX_FLAG_FETCH_RESULTS = 100_000;

// A silent server cannot hold a finished pass open waiting for LOGOUT.
const IMAP_LOGOUT_TIMEOUT_MS = 10_000;

// Per step of the long-lived flag-fetch stream, for the same reason as above.
const IMAP_FLAG_FETCH_STEP_TIMEOUT_MS = 30_000;

// APPEND sends a whole message in one command; bounds a Sent copy the server never acknowledges.
const IMAP_APPEND_TIMEOUT_MS = 60_000;

// A connection kept open between passes that does not answer a NOOP within this is given up and replaced.
const IMAP_PING_TIMEOUT_MS = 10_000;

/** How much of one body part an on-demand content fetch reads; the rest of a larger part is cut off. */
export const IMAP_CONTENT_MAX_PART_BYTES = 16 * 1024 * 1024;

// One body part's whole download, and one SEARCH, of an on-demand fetch; a stalled server fails the request instead.
const IMAP_CONTENT_DOWNLOAD_TIMEOUT_MS = 60_000;
const IMAP_SEARCH_TIMEOUT_MS = 30_000;

// iCloud Mail Drop needs no special case: the server already stores a small download-link body,
// with no placeholder MIME part to fetch.

function toEnvelopeAddress(value: MessageAddressObject | undefined): MailEnvelopeAddress | undefined {
  return value?.address ? { name: value.name || undefined, address: value.address } : undefined;
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

/** Every `<...>` token across all `References:` headers, in order. */
function parseReferences(headers: Array<{ name: string; value: string }>): string[] {
  return headerValues(headers, "references").flatMap((value) => value.match(/<[^<>]+>/g) ?? []);
}

/** What BODYSTRUCTURE tells of an attachment part. */
function attachmentPartOf(node: MessageStructureObject): MailAttachmentPart {
  return {
    filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? "attachment",
    contentType: node.type,
    contentId: node.id ? node.id.replace(/^<|>$/g, "") : null,
    disposition: node.disposition === "inline" ? "inline" : "attachment",
  };
}

/** A part's decoded size from its encoded one: base64 carries 3 bytes in 4 characters, with a CRLF after every 76. */
function decodedSizeOf(node: MessageStructureObject): number {
  const size = node.size ?? 0;
  return node.encoding?.toLowerCase() === "base64" ? Math.floor(((size * 76) / 78) * 0.75) : size;
}

/** UIDs as an IMAP sequence set (`1:3,7`). */
function uidSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    ranges.push(i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  return ranges.join(",");
}

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

/** `ImapMailClient` over an already-opened, policy-checked `imapflow` connection. */
export class ImapFlowMailClient implements ImapMailClient {
  private readonly moveObserved: unknown[] = [];
  private moveConnectionUsed = false;
  private moveExpired = false;
  private moveFailureRecorded = false;
  private moveCleanupFailed = false;
  /** Set by any failed or timed-out provider operation: the connection's state is then unknown. */
  private failed = false;

  constructor(private readonly client: ImapFlow) {}

  /** Moves count only when nothing of theirs was observed: a late or unexpected answer leaves the connection in doubt. */
  isReusable(): boolean {
    return (
      this.client.usable === true &&
      !this.failed &&
      !this.moveExpired &&
      !this.moveCleanupFailed &&
      this.moveObserved.length === 0
    );
  }

  async ping(): Promise<boolean> {
    if (!this.isReusable()) return false;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.client.noop(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`IMAP NOOP timed out after ${IMAP_PING_TIMEOUT_MS}ms`)),
            IMAP_PING_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.failed = true;
      imapDiagnostic("operation", [error]);
      return false;
    } finally {
      clearTimeout(timer);
    }
    return this.client.usable === true;
  }

  private async ownedMoveOperation<T>(operation: () => Promise<T>): Promise<{ expired: boolean; value: T }> {
    if (this.moveExpired) throw new Error("IMAP move connection is closed");
    this.moveFailureRecorded = false;
    const closeFailures: unknown[] = [];
    const timer = setTimeout(() => {
      this.moveExpired = true;
      try {
        this.client.close();
      } catch (error) {
        this.moveCleanupFailed = true;
        closeFailures.push(error);
      }
      imapDiagnostic("operation", closeFailures);
    }, 30_000);
    try {
      const value = await operation();
      if (this.moveExpired) this.moveObserved.push(value);
      return { expired: this.moveExpired, value };
    } catch (error) {
      this.moveFailureRecorded = true;
      this.moveObserved.push(error);
      throw error;
    } finally {
      clearTimeout(timer);
      this.moveObserved.push(...closeFailures);
    }
  }

  async prepareMove(
    path: string,
    uid: number,
  ): Promise<{ uidValidity: string; capabilities: Set<string>; found: boolean } | null> {
    if (!Number.isSafeInteger(uid) || uid < 1 || uid > 4_294_967_295) throw new Error("Invalid IMAP source UID");
    this.moveConnectionUsed = true;
    try {
      const result = await this.ownedMoveOperation(async () => {
        const mailbox = await this.client.mailboxOpen(path);
        if (this.moveExpired) return null;
        const matches = await this.client.search({ uid: String(uid) }, { uid: true });
        return { mailbox, matches };
      });
      if (result.expired || !result.value) return null;
      const { mailbox, matches } = result.value;
      const valid = Array.isArray(matches) && matches.every((value) => value === uid) && matches.length <= 1;
      if (!valid || matches.length === 0) this.moveObserved.push(matches);
      return {
        uidValidity: String(mailbox.uidValidity),
        capabilities: new Set(this.client.capabilities.keys()),
        found: valid && matches.length === 1,
      };
    } catch (error) {
      if (!this.moveFailureRecorded) this.moveObserved.push(error);
      return null;
    }
  }

  async executeMoveStep(
    step: "move" | "copy" | "mark_deleted" | "expunge",
    sourcePath: string,
    uid: number,
    uidValidity: string,
    targetPath: string,
  ): Promise<SafeImapMoveStepResult> {
    this.moveConnectionUsed = true;
    try {
      const owned = await this.ownedMoveOperation(() =>
        executeImapMoveStep(this.client, step, sourcePath, uid, uidValidity, targetPath),
      );
      if (owned.expired) return { kind: "uncertain" };
      const result = owned.value;
      if (result.kind === "uncertain") {
        this.moveObserved.push(result.observed);
        return { kind: "uncertain" };
      }
      return result;
    } catch (error) {
      if (!this.moveFailureRecorded) this.moveObserved.push(error);
      return { kind: "uncertain" };
    }
  }

  private async providerCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.failed = true;
      const observed: unknown[] = [error];
      imapDiagnostic("operation", observed);
      void observed;
      // The private provider boundary cannot expose a secret-bearing cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("IMAP provider operation failed unexpectedly");
    }
  }

  private async *providerStream<T>(source: () => AsyncIterable<T>): AsyncGenerator<T> {
    let iterator: AsyncIterator<T>;
    const observed: unknown[] = [];
    try {
      iterator = source()[Symbol.asyncIterator]();
    } catch (error) {
      this.failed = true;
      observed.push(error);
      imapDiagnostic("operation", observed);
      // The private provider boundary cannot expose a secret-bearing cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("IMAP provider operation failed unexpectedly");
    }
    let primary: { value: unknown } | undefined;
    let completed = false;
    try {
      for (;;) {
        let step: IteratorResult<T>;
        try {
          step = await iterator.next();
        } catch (error) {
          this.failed = true;
          observed.push(error);
          imapDiagnostic("operation", observed);
          // The original is retained until iterator cleanup; it cannot cross the privacy boundary.
          // eslint-disable-next-line preserve-caught-error
          throw new Error("IMAP provider operation failed unexpectedly");
        }
        if (step.done) {
          completed = true;
          return;
        }
        yield step.value;
      }
    } catch (error) {
      primary = { value: error };
      throw error;
    } finally {
      try {
        if (!completed) await iterator.return?.();
      } catch (cleanupError) {
        this.failed = true;
        observed.push(cleanupError);
        imapDiagnostic("stream_close", observed);
        if (!primary) {
          // There is no primary to replace; cleanup failure is projected without its raw cause.
          // eslint-disable-next-line no-unsafe-finally, preserve-caught-error
          throw new Error("IMAP provider operation failed unexpectedly");
        }
      }
      void observed;
    }
  }

  async getCapabilities(): Promise<Set<string>> {
    return new Set(this.client.capabilities.keys());
  }

  /**
   * With CONDSTORE each folder's STATUS comes with it: inline on a LIST-STATUS server, else one STATUS per folder,
   * which imapflow sends. Without CONDSTORE a STATUS cannot show a flag change, so none is asked for.
   */
  async listFolders(): Promise<ImapFolderRef[]> {
    const withStatus = this.client.capabilities.has("CONDSTORE");
    const list = await this.providerCall(() =>
      withStatus
        ? this.client.list({ statusQuery: { uidValidity: true, uidNext: true, highestModseq: true, messages: true } })
        : this.client.list(),
    );
    return list.map((f) => {
      const status = withStatus ? listedStatus(f.status) : undefined;
      return { path: f.path, specialUse: f.specialUse, ...(status ? { status } : {}) };
    });
  }

  async selectFolder(path: string): Promise<ImapFolderSelection> {
    const mailbox = await this.providerCall(() => this.client.mailboxOpen(path));
    return {
      uidvalidity: Number(mailbox.uidValidity),
      uidnext: mailbox.uidNext,
      highestModSeq: mailbox.highestModseq !== undefined && !mailbox.noModseq ? Number(mailbox.highestModseq) : null,
      messages: mailbox.exists,
    };
  }

  /** imapflow sends SELECT on every `mailboxOpen`; the fetches and STOREs after a selection reuse it. */
  private async ensureSelected(path: string): Promise<void> {
    const current = this.client.mailbox;
    if (current && current.path === path) return;
    await this.providerCall(() => this.client.mailboxOpen(path));
  }

  private async downloadText(uid: number, part: string): Promise<string> {
    // imapflow answers an empty part (a 0-byte body, as iCloud stores some) without a `content` stream.
    const { content }: { content?: Readable } = await this.providerCall(() =>
      this.client.download(String(uid), part, { uid: true }),
    );
    if (content === undefined) return "";
    const chunks: Buffer[] = [];
    for await (const chunk of this.providerStream(() => content)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  /**
   * If the normal decoded stream fails midway, resumes at that offset with bounded BINARY ranges,
   * which the server already transfer-decodes, so storage sees identical bytes.
   */
  private openAttachmentStream(uid: number, part: string): Readable {
    return Readable.from(this.streamAttachment(uid, part));
  }

  private async *streamAttachment(uid: number, part: string): AsyncGenerator<Buffer> {
    let offset = 0;
    let completed = false;
    let content: Readable | undefined;

    let primary: { value: unknown } | undefined;
    const observed: unknown[] = [];
    try {
      const result: { content?: Readable } = await this.client.download(String(uid), part, {
        uid: true,
        maxBytes: MAX_ATTACHMENT_BYTES,
      });
      content = result.content;
      // An empty part comes without a stream; it is a complete, empty attachment.
      if (content === undefined) {
        completed = true;
        return;
      }
      for await (const chunk of content) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        offset = this.nextAttachmentOffset(offset, bytes.length);
        yield bytes;
      }
      completed = true;
      return;
    } catch (err) {
      this.failed = true;
      observed.push(err);
      // A cap violation is rethrown, not retried by the fallback (it would hit the same cap).
      let capExceeded = false;
      try {
        capExceeded = err instanceof AttachmentCapExceededError;
      } catch (classificationError) {
        observed.push(classificationError);
        imapDiagnostic("operation", observed);
      }
      if (capExceeded) {
        primary = { value: err };
        throw err;
      }
      // The original stream is destroyed in finally so it cannot keep its socket alive. Logged
      // here because only this point sees the original failure.
      imapDiagnostic("attachment_fallback", observed);
    } finally {
      if (!completed && content !== undefined && !content.destroyed) {
        try {
          content.destroy();
        } catch (error) {
          observed.push(error);
          imapDiagnostic("stream_close", observed);
          // Only a cleanup failure with no primary becomes the fixed outward failure.
          // eslint-disable-next-line no-unsafe-finally, preserve-caught-error
          if (!primary) throw new Error("IMAP provider operation failed unexpectedly");
        }
      }
      void observed;
    }

    yield* this.fetchAttachmentRanges(uid, part, offset);
  }

  private nextAttachmentOffset(offset: number, length: number): number {
    if (length === 0) {
      throw new Error("IMAP attachment stream yielded an empty chunk without making progress");
    }
    if (offset + length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentCapExceededError(`IMAP attachment exceeded the ${MAX_ATTACHMENT_BYTES}-byte cap`);
    }
    return offset + length;
  }

  private async fetchOneWithTimeout(...args: Parameters<ImapFlow["fetchOne"]>): ReturnType<ImapFlow["fetchOne"]> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.providerCall(() => this.client.fetchOne(...args)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`IMAP partial fetch timed out after ${IMAP_PARTIAL_FETCH_TIMEOUT_MS}ms`)),
            IMAP_PARTIAL_FETCH_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async *fetchAttachmentRanges(uid: number, part: string, offset: number): AsyncGenerator<Buffer> {
    const key = part.toLowerCase().trim();
    let needsEofProbe = offset === MAX_ATTACHMENT_BYTES;

    while (offset < MAX_ATTACHMENT_BYTES || needsEofProbe) {
      const maxLength = needsEofProbe ? 1 : Math.min(IMAP_PARTIAL_FETCH_BYTES, MAX_ATTACHMENT_BYTES - offset);
      needsEofProbe = false;
      const response = await this.fetchOneWithTimeout(
        String(uid),
        { bodyParts: [{ key, start: offset, maxLength }] },
        { uid: true, binary: true },
      );
      const chunk = response === false ? undefined : response.bodyParts?.get(key);

      if (chunk === undefined || chunk.length === 0) {
        if (offset === MAX_ATTACHMENT_BYTES) return;
        throw new Error("IMAP attachment partial fetch made no progress");
      }
      if (chunk.length > maxLength) {
        throw new Error("IMAP attachment partial fetch exceeded its requested range");
      }
      if (offset === MAX_ATTACHMENT_BYTES) {
        throw new AttachmentCapExceededError(`IMAP attachment exceeded the ${MAX_ATTACHMENT_BYTES}-byte cap`);
      }

      offset = this.nextAttachmentOffset(offset, chunk.length);
      yield chunk;
      if (chunk.length < maxLength) return;
      if (offset === MAX_ATTACHMENT_BYTES) needsEofProbe = true;
    }
  }

  private classifyAttachmentParts(
    uid: number,
    parts: MessageStructureObject[],
    html: string | undefined,
  ): ClassifiedAttachment[] {
    const candidates = parts.map((node): ClassifiedAttachment => {
      const partId = node.part ?? "1";
      return {
        ...attachmentPartOf(node),
        providerPart: partId,
        // Lazy and streamed from the socket into storage, never buffered whole.
        openStream: () => this.openAttachmentStream(uid, partId),
      };
    });
    // An inline part referenced via cid: in the HTML is a rendering asset, not a document.
    return candidates.filter(
      (a) => !(a.disposition === "inline" && a.contentId !== null && Boolean(html?.includes(`cid:${a.contentId}`))),
    );
  }

  /** Races `operation` against `timeoutMs`; a timeout leaves the connection's state unknown, so it is not reused. */
  private async withDeadline<T>(operation: () => Promise<T>, timeoutMs: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`IMAP ${what} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The message's BODYSTRUCTURE, or `null` when the selected folder holds no message with the UID. */
  private async bodyStructureOf(path: string, uid: number): Promise<MessageStructureObject | null> {
    if (!Number.isSafeInteger(uid) || uid < 1 || uid > 4_294_967_295) throw new Error("Invalid IMAP UID");
    await this.ensureSelected(path);
    const raw = await this.fetchOneWithTimeout(String(uid), { uid: true, bodyStructure: true }, { uid: true });
    return raw === false || raw.bodyStructure === undefined ? null : raw.bodyStructure;
  }

  /** At most `IMAP_CONTENT_MAX_PART_BYTES` of the decoded part, under one deadline for the whole download. */
  private async downloadCappedText(uid: number, part: string): Promise<string> {
    let content: Readable | undefined;
    try {
      return await this.withDeadline(
        async () => {
          const result: { content?: Readable } = await this.providerCall(() =>
            this.client.download(String(uid), part, { uid: true, maxBytes: IMAP_CONTENT_MAX_PART_BYTES }),
          );
          content = result.content;
          if (content === undefined) return "";
          const source = content;
          const chunks: Buffer[] = [];
          for await (const chunk of this.providerStream(() => source)) chunks.push(chunk as Buffer);
          return Buffer.concat(chunks).toString("utf8");
        },
        IMAP_CONTENT_DOWNLOAD_TIMEOUT_MS,
        "content download",
      );
    } catch (error) {
      if (content !== undefined && !content.destroyed) content.destroy();
      throw error;
    }
  }

  async fetchMessageBody(path: string, uid: number): Promise<ImapMessageBody | null> {
    const structure = await this.bodyStructureOf(path, uid);
    if (structure === null) return null;
    const tree = walkBodyStructure(structure);
    // A single-part root may have no `.part`; `download()` special-cases "1" for that.
    const bodyText = tree.textPlainPart
      ? await this.downloadCappedText(uid, tree.textPlainPart.part ?? "1")
      : undefined;
    const bodyHtml = tree.textHtmlPart ? await this.downloadCappedText(uid, tree.textHtmlPart.part ?? "1") : undefined;
    return { bodyText, bodyHtml };
  }

  /** `UID SEARCH` under the search deadline; `false` when the server refuses the command. */
  private searchUids(query: SearchObject): Promise<number[] | false> {
    return this.withDeadline(
      () => this.providerCall(() => this.client.search(query, { uid: true })),
      IMAP_SEARCH_TIMEOUT_MS,
      "search",
    );
  }

  async searchMessageId(path: string, messageId: string): Promise<number[]> {
    await this.ensureSelected(path);
    const found = await this.searchUids({ header: { "message-id": messageId } });
    return found === false ? [] : found;
  }

  async searchText(path: string, terms: MailSearchTerms): Promise<number[]> {
    await this.ensureSelected(path);
    return searchTextUntilAccepted(terms, (query) => this.searchUids(query));
  }

  async downloadPart(path: string, uid: number, part: string): Promise<Readable | null> {
    const structure = await this.bodyStructureOf(path, uid);
    if (structure === null || !hasLeafPart(structure, part)) return null;
    const stream = this.openAttachmentStream(uid, part);
    // A consumer that gives up before the end leaves the download's command in flight.
    stream.once("close", () => {
      if (!stream.readableEnded) this.failed = true;
    });
    return stream;
  }

  /** The light half of a message: everything a FETCH of its envelope, flags, headers and BODYSTRUCTURE gives. */
  private parseFetchedMessage(path: string, raw: FetchMessageObject): ImapFetchedMessage {
    const envelope = raw.envelope;
    const tree = raw.bodyStructure
      ? walkBodyStructure(raw.bodyStructure)
      : { attachmentParts: [] as MessageStructureObject[] };
    const headerList = parseHeaderBlock(raw.headers);
    const snippetNode = tree.textPlainPart ?? tree.textHtmlPart;
    return {
      uid: raw.uid,
      message: {
        messageId: envelope?.messageId ?? `<no-message-id-uid-${raw.uid}@generated>`,
        inReplyTo: envelope?.inReplyTo ?? null,
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
        providerMessageId: raw.emailId ?? null,
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
      fetchContent: () => this.fetchMessageContent(path, raw.uid, tree),
    };
  }

  private async fetchMessageContent(path: string, uid: number, tree: MimeTree): Promise<ImapMessageContent> {
    await this.ensureSelected(path);
    // A single-part root may have no `.part`; `download()` special-cases "1" for that.
    const bodyText = tree.textPlainPart ? await this.downloadText(uid, tree.textPlainPart.part ?? "1") : undefined;
    const bodyHtml = tree.textHtmlPart ? await this.downloadText(uid, tree.textHtmlPart.part ?? "1") : undefined;
    return { bodyText, bodyHtml, attachments: this.classifyAttachmentParts(uid, tree.attachmentParts, bodyHtml) };
  }

  /** Light FETCH of `uids`, which must be every UID of the folder between the lowest and the highest of them. */
  private async fetchLight(path: string, uids: number[]): Promise<ImapFetchedMessage[]> {
    if (uids.length === 0) return [];
    const range = `${Math.min(...uids)}:${Math.max(...uids)}`;
    const raws: FetchMessageObject[] = [];
    // No `source: true` and no body section (see walkBodyStructure); only bounded metadata is fetched here.
    // `labels: true` is a no-op on non-Gmail servers.
    for await (const raw of this.providerStream(() =>
      this.client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          bodyStructure: true,
          flags: true,
          headers: [
            "references",
            "delivered-to",
            "x-original-to",
            "envelope-to",
            "list-unsubscribe",
            "list-id",
            "precedence",
            "auto-submitted",
          ],
          labels: true,
        },
        { uid: true },
      ),
    )) {
      raws.push(raw);
    }
    return raws.map((raw) => this.parseFetchedMessage(path, raw));
  }

  async fetchMessagesSince(path: string, sinceUid: number, limit: number): Promise<ImapFetchedMessage[]> {
    await this.ensureSelected(path);
    // "*" in a range can include one message below sinceUid on an empty-range edge case.
    const found = await this.providerCall(() => this.client.search({ uid: `${sinceUid}:*` }, { uid: true }));
    // A prefix of every UID from sinceUid up, so the range between its ends holds exactly these messages.
    const uids = (found === false ? [] : found)
      .filter((uid) => uid >= sinceUid)
      .sort((a, b) => a - b)
      .slice(0, limit);
    return (await this.fetchLight(path, uids)).sort((a, b) => a.uid - b.uid);
  }

  async fetchMessagesBefore(path: string, beforeUid: number, limit: number): Promise<ImapFetchedMessage[]> {
    if (beforeUid <= 1) return [];
    await this.ensureSelected(path);
    const found = await this.providerCall(() => this.client.search({ uid: `1:${beforeUid - 1}` }, { uid: true }));
    // The highest UIDs below beforeUid; no UID between their ends is missing from them, and none is added later.
    const uids = (found === false ? [] : found)
      .filter((uid) => uid < beforeUid)
      .sort((a, b) => b - a)
      .slice(0, limit);
    return (await this.fetchLight(path, uids)).sort((a, b) => b.uid - a.uid);
  }

  /** One partial FETCH per distinct section, of the first `IMAP_SNIPPET_BYTES` octets only. */
  async fetchSnippets(
    path: string,
    requests: ReadonlyArray<{ uid: number; part: ImapSnippetPart }>,
  ): Promise<Map<number, string>> {
    const snippets = new Map<number, string>();
    if (requests.length === 0) return snippets;
    await this.ensureSelected(path);
    const bySection = new Map<string, Map<number, ImapSnippetPart>>();
    for (const { uid, part } of requests) {
      const group = bySection.get(part.section) ?? new Map<number, ImapSnippetPart>();
      group.set(uid, part);
      bySection.set(part.section, group);
    }
    for (const [section, parts] of bySection) {
      const key = section.toLowerCase();
      for await (const raw of this.providerStream(() =>
        this.client.fetch(
          uidSet([...parts.keys()]),
          { uid: true, bodyParts: [{ key, start: 0, maxLength: IMAP_SNIPPET_BYTES }] },
          { uid: true },
        ),
      )) {
        const part = parts.get(raw.uid);
        const bytes = raw.bodyParts?.get(key);
        if (!part || !bytes) continue;
        const text = decodeBodyPartPrefix(bytes.subarray(0, IMAP_SNIPPET_BYTES), part.encoding, part.charset);
        snippets.set(raw.uid, part.html ? htmlToPlainText(text) : text);
      }
    }
    return snippets;
  }

  /**
   * With QRESYNC enabled on this connection, imapflow adds `VANISHED` to a UID FETCH with `CHANGEDSINCE`, so one
   * command returns the changed flags and the expunged UIDs, which imapflow reports as `expunge` events.
   */
  async fetchChangesSince(
    path: string,
    sinceModSeq: number,
  ): Promise<{ flags: Array<{ uid: number; flags: string[] }>; vanished: number[] } | null> {
    if (!this.client.enabled.has("QRESYNC")) return null;
    const vanished: number[] = [];
    const flags = await this.fetchFlags(path, sinceModSeq, vanished);
    return { flags, vanished };
  }

  async fetchAllUids(path: string): Promise<number[]> {
    await this.ensureSelected(path);
    const uids = await this.providerCall(() => this.client.search({ all: true }, { uid: true }));
    return uids === false ? [] : uids;
  }

  /** Peek-only; `sinceModSeq` scopes via `changedSince`, `null` fetches every UID's flags. */
  async fetchFlagsChangedSince(
    path: string,
    sinceModSeq: number | null,
  ): Promise<Array<{ uid: number; flags: string[] }>> {
    return this.fetchFlags(path, sinceModSeq);
  }

  /**
   * The flag fetch, collecting into `vanished` every UID a VANISHED response names for `path` while it runs. The
   * vanished UIDs count against the same result cap as the flags.
   */
  private async fetchFlags(
    path: string,
    sinceModSeq: number | null,
    vanished?: number[],
  ): Promise<Array<{ uid: number; flags: string[] }>> {
    await this.ensureSelected(path);
    const results: Array<{ uid: number; flags: string[] }> = [];
    let vanishedOverCap = false;
    const onExpunge = (event: { path: string; vanished: boolean; uid?: number }) => {
      if (!vanished || !event.vanished || event.uid === undefined || event.path !== path) return;
      if (results.length + vanished.length >= MAX_FLAG_FETCH_RESULTS) vanishedOverCap = true;
      else vanished.push(event.uid);
    };
    if (vanished) this.client.on("expunge", onExpunge);
    const iterator = this.providerStream(() =>
      this.client.fetch(
        "1:*",
        { uid: true, flags: true },
        sinceModSeq !== null ? { uid: true, changedSince: BigInt(sinceModSeq) } : { uid: true },
      ),
    )[Symbol.asyncIterator]();
    let primary: { value: unknown } | undefined;
    try {
      // Manual `.next()` so each step can be raced against a timer.
      for (;;) {
        let timer: NodeJS.Timeout | undefined;
        let step: IteratorResult<FetchMessageObject>;
        try {
          step = await Promise.race([
            iterator.next(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`IMAP flag fetch timed out after ${IMAP_FLAG_FETCH_STEP_TIMEOUT_MS}ms`)),
                IMAP_FLAG_FETCH_STEP_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (step.done) break;
        if (vanishedOverCap || results.length + (vanished?.length ?? 0) >= MAX_FLAG_FETCH_RESULTS) {
          throw new FlagFetchCapExceededError(`IMAP flag fetch exceeded the ${MAX_FLAG_FETCH_RESULTS}-message cap`);
        }
        results.push({ uid: step.value.uid, flags: step.value.flags ? [...step.value.flags] : [] });
      }
      // VANISHED (EARLIER) may be the whole response, with no FETCH line after it.
      if (vanishedOverCap) {
        throw new FlagFetchCapExceededError(`IMAP flag fetch exceeded the ${MAX_FLAG_FETCH_RESULTS}-message cap`);
      }
    } catch (error) {
      this.failed = true;
      primary = { value: error };
      throw error;
    } finally {
      if (vanished) this.client.off("expunge", onExpunge);
      // Best effort: with no abort signal this only stops local consumption.
      try {
        await iterator.return?.(undefined);
      } catch (error) {
        // A cleanup-only failure is already sanitized by providerStream.
        // eslint-disable-next-line no-unsafe-finally
        if (!primary) throw error;
        imapDiagnostic("stream_close");
      }
    }
    return results;
  }

  /** The only flag write in this class; every fetch/download uses `BODY.PEEK`, so reads never mark mail read. */
  async setMessageFlag(path: string, uid: number, flag: WritableImapFlag, value: boolean): Promise<void> {
    await this.ensureSelected(path);
    if (value) await this.providerCall(() => this.client.messageFlagsAdd(String(uid), [flag], { uid: true }));
    else await this.providerCall(() => this.client.messageFlagsRemove(String(uid), [flag], { uid: true }));
  }

  /**
   * Keeps a sent message's copy in Sent. Raced against a timer; on timeout the command may still be
   * in flight until the caller's `close()`. Unknown refusals become a fixed safe error.
   */
  async appendMessage(path: string, raw: Buffer, flags: readonly WritableImapFlag[]): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.providerCall(async () => {
          const result = await this.client.append(path, raw, [...flags]);
          if (result === false) throw new Error("IMAP append did not run");
          return result;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`IMAP append timed out after ${IMAP_APPEND_TIMEOUT_MS}ms`)),
            IMAP_APPEND_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A move-owned connection awaits logout and reports cleanup failure with a safe error. */
  async close(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const observed: unknown[] = this.moveObserved;
    if (this.moveConnectionUsed) {
      if (!this.moveExpired) {
        let timedOut = false;
        const deadline = setTimeout(() => {
          timedOut = true;
          this.moveCleanupFailed = true;
          try {
            this.client.close();
          } catch (error) {
            observed.push(error);
          }
          imapDiagnostic("logout", observed);
        }, IMAP_LOGOUT_TIMEOUT_MS);
        try {
          const logout: Promise<unknown> = this.client.logout();
          const result: unknown = await logout;
          if (result === false || timedOut) observed.push(result);
        } catch (error) {
          this.moveCleanupFailed = true;
          observed.push(error);
        } finally {
          clearTimeout(deadline);
          if (!timedOut) {
            try {
              this.client.close();
            } catch (error) {
              this.moveCleanupFailed = true;
              observed.push(error);
            }
          }
        }
      }
      if (observed.length > 0) imapDiagnostic("operation", observed);
      if (this.moveCleanupFailed) throw new Error("IMAP move provider cleanup failed unexpectedly");
      return;
    }
    try {
      await Promise.race([
        this.client.logout(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`IMAP logout timed out after ${IMAP_LOGOUT_TIMEOUT_MS}ms`)),
            IMAP_LOGOUT_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      observed.push(error);
      imapDiagnostic("logout", observed);
    } finally {
      clearTimeout(timer);
      try {
        this.client.close();
      } catch (error) {
        observed.push(error);
        imapDiagnostic("close", observed);
      }
    }
    if (observed.length > 0) imapDiagnostic("operation", observed);
    void observed;
  }
}

/** Whether `part` names a leaf of the structure (a single-part root is part "1"). */
function hasLeafPart(root: MessageStructureObject, part: string): boolean {
  const visit = (node: MessageStructureObject): boolean =>
    node.childNodes && node.childNodes.length > 0 ? node.childNodes.some(visit) : (node.part ?? "1") === part;
  return visit(root);
}

/** A listed STATUS with every cursor a pass compares, as numbers; anything less (a refused STATUS) is no status. */
function listedStatus(status: StatusObject | undefined): ImapFolderSelection | undefined {
  if (
    status?.uidValidity === undefined ||
    status.uidNext === undefined ||
    status.highestModseq === undefined ||
    status.messages === undefined
  )
    return undefined;
  return {
    uidvalidity: Number(status.uidValidity),
    uidnext: status.uidNext,
    highestModSeq: Number(status.highestModseq),
    messages: status.messages,
  };
}

function imapDiagnostic(
  stage: "operation" | "attachment_fallback" | "stream_close" | "logout" | "close",
  observed: unknown[] = [],
): void {
  try {
    logger.warn({ stage }, "IMAP provider operation reported a failure");
  } catch (error) {
    observed.push(error);
    // Diagnostic failure cannot change the provider operation or quiet cleanup outcome.
  }
}

const CONNECTION_LIMIT_ERROR_CODES = new Set(["ClosedAfterConnectTLS", "ClosedAfterConnectText"]);
const CONNECTION_LIMIT_REASON_PATTERN = /too many (simultaneous|concurrent) connections|connection limit exceeded/i;

/**
 * Detects a pre-login `BYE` for too many simultaneous connections, so callers can throw
 * `MailConnectionLimitError` and back off. The reason text must match because imapflow's
 * `ClosedAfterConnect*` codes cover any pre-auth closure (TLS failure, suspended account);
 * `code`, when present, only narrows the match.
 */
export function isImapConnectionLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  const reason = (err as { reason?: string }).reason ?? err.message;
  if (!CONNECTION_LIMIT_REASON_PATTERN.test(reason ?? "")) return false;
  return code === undefined || CONNECTION_LIMIT_ERROR_CODES.has(code);
}
