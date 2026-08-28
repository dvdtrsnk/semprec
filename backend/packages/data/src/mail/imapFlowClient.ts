import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { classifyAttachments } from "./attachments.js";
import type { ImapFetchedMessage, ImapFolderRef, ImapFolderSelection, ImapMailClient } from "./imapReconcile.js";
import type { FetchedMessage } from "./providerTypes.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";

function flattenAddresses(value: AddressObject | AddressObject[] | undefined): MailEnvelopeAddress[] {
  const objects = Array.isArray(value) ? value : value ? [value] : [];
  return objects.flatMap((obj) => obj.value).filter((addr): addr is { name: string; address: string } => Boolean(addr.address)).map((addr) => ({ name: addr.name || undefined, address: addr.address }));
}

/**
 * `keepCidLinks: true` is required, not cosmetic: mailparser's default behavior rewrites
 * every `cid:` reference in the HTML body into a `data:` URI, which would make
 * `classifyAttachments`'s "is this inline part actually referenced via `cid:`" check (see
 * attachments.ts) never match, misclassifying every inline image as a real Files attachment.
 */
async function parseFetchedMessage(raw: FetchMessageObject): Promise<FetchedMessage> {
  if (!raw.source) throw new Error(`IMAP FETCH for UID ${raw.uid} did not include a message source`);
  const parsed = await simpleParser(raw.source, { keepCidLinks: true });

  const fromValue = parsed.from?.value[0];
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];

  return {
    messageId: parsed.messageId ?? `<no-message-id-uid-${raw.uid}@generated>`,
    inReplyTo: parsed.inReplyTo ?? null,
    references,
    subject: parsed.subject,
    envelope: {
      from: fromValue?.address ? { name: fromValue.name || undefined, address: fromValue.address } : undefined,
      to: flattenAddresses(parsed.to),
      cc: flattenAddresses(parsed.cc),
      bcc: flattenAddresses(parsed.bcc),
    },
    bodyText: parsed.text,
    bodyHtml: typeof parsed.html === "string" ? parsed.html : undefined,
    date: parsed.date,
    attachments: classifyAttachments(parsed),
  };
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

  async fetchMessagesSince(path: string, sinceUid: number): Promise<ImapFetchedMessage[]> {
    await this.client.mailboxOpen(path);
    const results: ImapFetchedMessage[] = [];
    for await (const raw of this.client.fetch(`${sinceUid}:*`, { uid: true, source: true, flags: true }, { uid: true })) {
      if (raw.uid < sinceUid) continue; // "*" in a range can include one message below sinceUid on an empty-range edge case
      results.push({ uid: raw.uid, message: await parseFetchedMessage(raw) });
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
