import { executeImapMoveStep, type SafeImapMoveStepResult } from "./mailMoveProviderAdapters.js";
import type {
  ImapFlow,
  FetchMessageObject,
  MessageAddressObject,
  MessageStructureObject,
  StatusObject,
} from "imapflow";
import { Readable } from "node:stream";
import type { ImapFetchedMessage, ImapFolderRef, ImapFolderSelection, ImapMailClient } from "./imapReconcile.js";
import {
  AttachmentCapExceededError,
  FlagFetchCapExceededError,
  MAX_ATTACHMENT_BYTES,
  type FetchedMessage,
} from "./providerTypes.js";
import type { ClassifiedAttachment } from "./attachments.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";
import { isDeliveryStatusReport } from "./dsn.js";
import type { WritableImapFlag } from "./messageFlags.js";
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

  constructor(private readonly client: ImapFlow) {}

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
      const contentId = node.id ? node.id.replace(/^<|>$/g, "") : null;
      const disposition: "attachment" | "inline" = node.disposition === "inline" ? "inline" : "attachment";
      const partId = node.part ?? "1";
      return {
        filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? "attachment",
        contentType: node.type,
        contentId,
        disposition,
        // Lazy and streamed from the socket into storage, never buffered whole.
        openStream: () => this.openAttachmentStream(uid, partId),
      };
    });
    // An inline part referenced via cid: in the HTML is a rendering asset, not a document.
    return candidates.filter(
      (a) => !(a.disposition === "inline" && a.contentId !== null && Boolean(html?.includes(`cid:${a.contentId}`))),
    );
  }

  private async parseFetchedMessage(raw: FetchMessageObject): Promise<FetchedMessage> {
    const envelope = raw.envelope;
    const tree = raw.bodyStructure
      ? walkBodyStructure(raw.bodyStructure)
      : { attachmentParts: [] as MessageStructureObject[] };
    const headerList = parseHeaderBlock(raw.headers);

    // A single-part root may have no `.part`; `download()` special-cases "1" for that.
    const bodyText = tree.textPlainPart ? await this.downloadText(raw.uid, tree.textPlainPart.part ?? "1") : undefined;
    const bodyHtml = tree.textHtmlPart ? await this.downloadText(raw.uid, tree.textHtmlPart.part ?? "1") : undefined;

    return {
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
      bodyText,
      bodyHtml,
      date: envelope?.date,
      attachments: this.classifyAttachmentParts(raw.uid, tree.attachmentParts, bodyHtml),
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
    };
  }

  async fetchMessagesSince(path: string, sinceUid: number, limit: number): Promise<ImapFetchedMessage[]> {
    await this.ensureSelected(path);
    // "*" in a range can include one message below sinceUid on an empty-range edge case.
    const found = await this.providerCall(() => this.client.search({ uid: `${sinceUid}:*` }, { uid: true }));
    const uids = (found === false ? [] : found)
      .filter((uid) => uid >= sinceUid)
      .sort((a, b) => a - b)
      .slice(0, limit);
    const [first] = uids;
    if (first === undefined) return [];
    // The batch is a prefix of every UID from sinceUid up, so the range holds exactly these messages.
    const range = `${first}:${uids[uids.length - 1]}`;
    const raws: FetchMessageObject[] = [];
    // No `source: true` (see walkBodyStructure); only bounded metadata is fetched here.
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
    // Parsed after the FETCH ends: imapflow keeps it open until every response is read, so a
    // body download inside the loop would queue behind it forever. Buffered responses are small.
    const results: ImapFetchedMessage[] = [];
    for (const raw of raws) results.push({ uid: raw.uid, message: await this.parseFetchedMessage(raw) });
    return results;
  }

  async fetchVanishedSince(path: string, sinceModSeq: number): Promise<number[] | null> {
    if (!this.client.capabilities.has("QRESYNC")) return null;
    await this.ensureSelected(path);
    const vanished: number[] = [];
    const onExpunge = (event: { vanished: boolean; uid?: number }) => {
      if (event.vanished && event.uid !== undefined) vanished.push(event.uid);
    };
    this.client.on("expunge", onExpunge);
    try {
      // QRESYNC reports VANISHED via 'expunge' events; the fetch is drained only to collect them.
      for await (const _raw of this.providerStream(() =>
        this.client.fetch("1:*", { uid: true }, { uid: true, changedSince: BigInt(sinceModSeq) }),
      )) {
        // draining only
      }
    } finally {
      this.client.off("expunge", onExpunge);
    }
    return vanished;
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
    await this.ensureSelected(path);
    const results: Array<{ uid: number; flags: string[] }> = [];
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
        if (results.length >= MAX_FLAG_FETCH_RESULTS) {
          throw new FlagFetchCapExceededError(`IMAP flag fetch exceeded the ${MAX_FLAG_FETCH_RESULTS}-message cap`);
        }
        results.push({ uid: step.value.uid, flags: step.value.flags ? [...step.value.flags] : [] });
      }
    } catch (error) {
      primary = { value: error };
      throw error;
    } finally {
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
