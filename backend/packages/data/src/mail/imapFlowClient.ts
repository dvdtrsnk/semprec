import { executeImapMoveStep, type SafeImapMoveStepResult } from "./mailMoveProviderAdapters.js";
import type { ImapFlow, FetchMessageObject, MessageAddressObject, MessageStructureObject } from "imapflow";
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

// This is deliberately the same order of magnitude as imapflow's default download chunk.
// The fallback makes at most MAX_ATTACHMENT_BYTES / IMAP_PARTIAL_FETCH_BYTES requests, plus
// one EOF probe at the cap, so neither a broken server nor a failed stream can create an
// unbounded retry loop.
const IMAP_PARTIAL_FETCH_BYTES = 64 * 1024;

// imapflow's FetchOptions has no per-call timeout/signal of its own (unlike the REST adapters'
// fetch() calls elsewhere in this module, which pass AbortSignal.timeout()), so the bounded
// partial-fetch loop below races each fetchOne() against this timer itself — otherwise a server
// that stops responding mid-response, rather than closing the socket, could hang the sync
// worker indefinitely on this one request.
const IMAP_PARTIAL_FETCH_TIMEOUT_MS = 30_000;

// Without CONDSTORE, fetchFlagsChangedSince below has no server-side way to scope itself to
// "what changed" and fetches every UID in the mailbox — this bounds how much of that response
// it will hold in memory at once, the same backstop role MAX_ATTACHMENT_BYTES plays for a
// single part. Chosen generously above any real mailbox's message count.
const MAX_FLAG_FETCH_RESULTS = 100_000;

// close() waits this long for the server to answer LOGOUT, then releases the socket without it, so a
// server that stops responding cannot hold a finished sync pass open.
const IMAP_LOGOUT_TIMEOUT_MS = 10_000;

// Same rationale as IMAP_PARTIAL_FETCH_TIMEOUT_MS above, applied per iteration step of the
// flag-fetch response stream rather than to a single fetchOne() call, since a full-mailbox
// flag fetch is itself a long-lived `for await` rather than one bounded request.
const IMAP_FLAG_FETCH_STEP_TIMEOUT_MS = 30_000;

// APPEND sends a whole message in one command. A minute is twice the SMTP send deadline (smtpClient.ts), and it bounds a
// copy of a sent message that a server never acknowledges (issue #1641).
const IMAP_APPEND_TIMEOUT_MS = 60_000;

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

function optionalReplyTo(replyTo: MailEnvelopeAddress[]): { replyTo?: MailEnvelopeAddress[] } {
  return replyTo.length > 0 ? { replyTo } : {};
}

function toEnvelopeAddressList(list: MessageAddressObject[] | undefined): MailEnvelopeAddress[] {
  return (list ?? []).map(toEnvelopeAddress).filter((a): a is MailEnvelopeAddress => Boolean(a));
}

/**
 * Unfolds and splits a raw multi-header-name Buffer (imapflow's `headers: [...]` fetch
 * concatenates every requested header's raw lines into one Buffer, in the message's own
 * top-to-bottom order) into individual `{name, value}` lines, preserving every repeated
 * occurrence — needed for "highest Delivered-To occurrence" (mail/deliveredTo.ts), since a
 * forwarded/relayed message can carry several.
 */
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

/** Every `<...>` token across every `References:` occurrence — the ancestor chain, order preserved, same as mailparser's own splitting rule. */
function parseReferences(headers: Array<{ name: string; value: string }>): string[] {
  return headerValues(headers, "references").flatMap((value) => value.match(/<[^<>]+>/g) ?? []);
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
 * `ImapMailClient` (imapReconcile.ts) backed by `imapflow`; the production composition root
 * supplies this client after opening a policy-checked connection.
 */
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

  async listFolders(): Promise<ImapFolderRef[]> {
    const list = await this.providerCall(() => this.client.list());
    return list.map((f) => ({ path: f.path, specialUse: f.specialUse }));
  }

  async selectFolder(path: string): Promise<ImapFolderSelection> {
    const mailbox = await this.providerCall(() => this.client.mailboxOpen(path));
    return {
      uidvalidity: Number(mailbox.uidValidity),
      uidnext: mailbox.uidNext,
      highestModSeq: mailbox.highestModseq !== undefined && !mailbox.noModseq ? Number(mailbox.highestModseq) : null,
    };
  }

  /** Decoded (transfer-encoding + charset, per `download()`'s own pipeline) text content of one bounded body part — never the attachment path, so never subject to `MAX_ATTACHMENT_BYTES`. */
  private async downloadText(uid: number, part: string): Promise<string> {
    const { content } = await this.providerCall(() => this.client.download(String(uid), part, { uid: true }));
    const chunks: Buffer[] = [];
    for await (const chunk of this.providerStream(() => content)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  /**
   * Streams a body part through imapflow's normal decoder first. If that stream fails after
   * yielding bytes, continue at that decoded-byte offset with bounded BINARY body ranges. A
   * BINARY range is already transfer-decoded by the server, so it can join the normal decoded
   * stream without changing the attachment bytes seen by storage.
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
      const result = await this.client.download(String(uid), part, {
        uid: true,
        maxBytes: MAX_ATTACHMENT_BYTES,
      });
      content = result.content;
      for await (const chunk of content) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        offset = this.nextAttachmentOffset(offset, bytes.length);
        yield bytes;
      }
      completed = true;
      return;
    } catch (err) {
      observed.push(err);
      // A cap violation is a policy decision already made by nextAttachmentOffset, not a
      // stream failure — rethrow it so it reaches the caller instead of being masked by the
      // fallback below, which would silently re-run into the very same cap.
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
      // A replacement source below is the specified recovery path. The original stream is
      // destroyed in finally so a failed or abandoned download cannot keep its socket alive.
      // Logged here (not just swallowed) since this is the only place that ever sees the
      // original stream failure — the fallback path below has no way to report it itself.
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

  /** Races a single `fetchOne()` call against a timer, since imapflow's `FetchOptions` has no timeout/signal of its own — see `IMAP_PARTIAL_FETCH_TIMEOUT_MS`'s comment. */
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
        // Lazy: bytes only flow once `ingestAttachments` (mail/attachments.ts) actually calls
        // this, streamed straight from the socket through `download()`'s decoder pipeline into
        // `blobStorage.ts`'s `pipeline()` — never buffered whole in between.
        openStream: () => this.openAttachmentStream(uid, partId),
      };
    });
    // An inline part actually referenced via `cid:` inside the HTML body is a rendering asset
    // (a signature logo), not a document — excluded here, same rule the other two adapters
    // apply over their own provider-specific part trees (see attachments.ts's header note).
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

    // A single-part message's root BODYSTRUCTURE node sometimes carries no `.part` of its
    // own — `download()` special-cases part id "1" (checking bodyStructure.childNodes itself
    // to pick TEXT vs part 1), so "1" is always a safe fallback for a body leaf we found.
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
      // Both undefined on any server that doesn't advertise X-GM-EXT-1 (every non-Gmail
      // server) — imapReconcile.ts only acts on `gmailLabels` when it's actually present.
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
      // The `\Seen`/`\Flagged` state a message already has on the server — mail/ingest.ts
      // seeds a newly ingested message's read/flag properties from it (mail/messageFlags.ts).
      flags: raw.flags ? [...raw.flags] : undefined,
    };
  }

  async fetchMessagesSince(path: string, sinceUid: number): Promise<ImapFetchedMessage[]> {
    await this.providerCall(() => this.client.mailboxOpen(path));
    const raws: FetchMessageObject[] = [];
    // Deliberately no `source: true`: that field is a fully-materialized `Buffer` of the whole
    // raw message, attachments included — see walkBodyStructure's header note. BODYSTRUCTURE +
    // ENVELOPE + a handful of cheap headers are all bounded fetches; the actual body/
    // attachment bytes are fetched separately, lazily, per part. `labels: true` is a no-op on
    // a non-Gmail server (imapReconcile.ts's "Gmail in IMAP fallback mode" support) and costs
    // nothing extra on one that doesn't support X-GM-EXT-1. `delivered-to`/`x-original-to`/
    // `envelope-to` feed deliveredToAddress's precedence rule (mail/deliveredTo.ts, issue #93).
    for await (const raw of this.providerStream(() =>
      this.client.fetch(
        `${sinceUid}:*`,
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
      if (raw.uid < sinceUid) continue; // "*" in a range can include one message below sinceUid on an empty-range edge case
      raws.push(raw);
    }
    // Parsed only once the FETCH has ended (issue #1510). imapflow keeps a FETCH command open until its consumer has
    // read every untagged response, so a body download issued inside the loop above queued behind that command and
    // never ran. The raw responses hold no body bytes (see above), so buffering them adds only header-sized memory.
    const results: ImapFetchedMessage[] = [];
    for (const raw of raws) results.push({ uid: raw.uid, message: await this.parseFetchedMessage(raw) });
    return results;
  }

  async fetchVanishedSince(path: string, sinceModSeq: number): Promise<number[] | null> {
    if (!this.client.capabilities.has("QRESYNC")) return null;
    await this.providerCall(() => this.client.mailboxOpen(path));
    const vanished: number[] = [];
    const onExpunge = (event: { vanished: boolean; uid?: number }) => {
      if (event.vanished && event.uid !== undefined) vanished.push(event.uid);
    };
    this.client.on("expunge", onExpunge);
    try {
      // A QRESYNC-enabled fetch with changedSince surfaces VANISHED via the 'expunge' event,
      // not as a return value — this drains that event stream for the duration of the call.
      // Flag changes on UIDs that didn't vanish are not picked up here; they are a known-UID
      // reconcile concern handled separately by fetchFlagsChangedSince below.
      for await (const _raw of this.providerStream(() =>
        this.client.fetch("1:*", { uid: true }, { uid: true, changedSince: BigInt(sinceModSeq) }),
      )) {
        // draining only — see fetchFlagsChangedSince for the flags themselves.
      }
    } finally {
      this.client.off("expunge", onExpunge);
    }
    return vanished;
  }

  async fetchAllUids(path: string): Promise<number[]> {
    await this.providerCall(() => this.client.mailboxOpen(path));
    const uids = await this.providerCall(() => this.client.search({ all: true }, { uid: true }));
    return uids === false ? [] : uids;
  }

  /**
   * Peek-only flag re-fetch for UIDs the folder already knows about (imapReconcile.ts's
   * known-UID pass) — the same bounded `fetch` call `fetchMessagesSince`/`fetchVanishedSince`
   * already make, just for `flags` instead of envelope/body data. `sinceModSeq` given (CONDSTORE
   * and a stored modseq) scopes the fetch with `changedSince`; `null` (no CONDSTORE, or the
   * first pass after a UIDVALIDITY reset) fetches every UID's current flags.
   */
  async fetchFlagsChangedSince(
    path: string,
    sinceModSeq: number | null,
  ): Promise<Array<{ uid: number; flags: string[] }>> {
    await this.providerCall(() => this.client.mailboxOpen(path));
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
      // A manual `.next()` loop, not `for await`, so a step that never resolves (a server
      // that stops responding mid-stream) can be raced against a timer the same way
      // fetchOneWithTimeout races a single fetchOne() — a bare `for await` has no such hook.
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
      // Best-effort close on the cap/timeout/error paths above — imapflow has no abort signal
      // for an in-flight fetch (see FetchOptions), so this only stops local consumption of
      // whatever the server keeps streaming, same limitation fetchOneWithTimeout has.
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

  /**
   * `STORE ... +FLAGS/-FLAGS (<flag>)` — the only call anywhere in this class that writes a
   * flag, and in particular the only one that can mark a message read; every fetch/download
   * above is peek-only (imapflow builds `BODY.PEEK[...]` internally and has no non-peek
   * option). The flags the mailbox actually sets are `\Seen` and `\Flagged`
   * (mail/messageFlags.ts).
   */
  async setMessageFlag(path: string, uid: number, flag: WritableImapFlag, value: boolean): Promise<void> {
    await this.providerCall(() => this.client.mailboxOpen(path));
    if (value) await this.providerCall(() => this.client.messageFlagsAdd(String(uid), [flag], { uid: true }));
    else await this.providerCall(() => this.client.messageFlagsRemove(String(uid), [flag], { uid: true }));
  }

  /**
   * IMAP APPEND of one complete message with its flags (issue #1641): the copy of a sent message that mailTransport.ts
   * keeps in the Sent folder. The whole message travels in one command, so the call races a timer, the same way
   * `fetchOneWithTimeout` does. A timeout rejects while the command may still be in flight on the socket; the caller's
   * `close()` ends it. An unknown server refusal rejects with a fixed safe provider error.
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

  /**
   * Logs out and requests socket closure. Existing read callers retain their fixed diagnostic
   * behavior; a move-owned connection joins logout and reports cleanup failure with a safe error.
   */
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
 * Detects a provider's simultaneous-connection rejection (Gmail: "Too many simultaneous
 * connections", similar wording from other IMAP servers) from imapflow's `connect()`-failure
 * shape — an untagged `BYE` closing the socket before/without ever reaching login, not an
 * ordinary network error. The composition root's `createImapClient` (mailSyncJob.ts's
 * `MailSyncAdapterFactory`) is expected to catch its own `ImapFlow.connect()` rejection, check
 * this, and throw `MailConnectionLimitError` (providerTypes.ts) instead when it matches, so
 * mailSyncJob.ts backs off rather than retrying immediately.
 *
 * The reason text must match (imapflow's `ClosedAfterConnectTLS`/`ClosedAfterConnectText`
 * codes cover *any* pre-auth server closure — a TLS certificate failure or a suspended-account
 * BYE included — so the code alone would misclassify those as connection-limit contention);
 * `code`, when present, only narrows further to imapflow's own connect-failure codes rather
 * than matching on message text from some other, later failure that happens to reuse the word
 * "connections".
 */
export function isImapConnectionLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  const reason = (err as { reason?: string }).reason ?? err.message;
  if (!CONNECTION_LIMIT_REASON_PATTERN.test(reason ?? "")) return false;
  return code === undefined || CONNECTION_LIMIT_ERROR_CODES.has(code);
}
