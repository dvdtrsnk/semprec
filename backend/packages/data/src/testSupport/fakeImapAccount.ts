import { Readable } from "node:stream";
import { simpleParser, type AddressObject, type EmailAddress } from "mailparser";
import type { ImapFetchedMessage, ImapFolderRef, ImapMailClient } from "../mail/imapReconcile.js";
import { IMAP_SNIPPET_BYTES } from "../mail/imapSnippet.js";
import { fakeFetchedMessage } from "./fakeImapMessages.js";
import type { MailEnvelopeAddress } from "../mail/mailMessageMetaStore.js";
import type { FetchedMessage } from "../mail/providerTypes.js";
import type { WritableImapFlag } from "../mail/messageFlags.js";

interface FakeImapMessage {
  uid: number;
  raw: Buffer;
  flags: Set<string>;
  modseq: number;
}

interface FakeImapFolder {
  specialUse?: string;
  uidValidity: number;
  uidNext: number;
  highestModSeq: number;
  messages: FakeImapMessage[];
}

export interface FakeImapAccountOptions {
  /** Offer CONDSTORE: mod-sequences on SELECT and the folder list's STATUS, and flag fetches scoped by them. */
  condstore?: boolean;
  /** Delay of every client call, standing in for the round trips of the command behind it. */
  latencyMs?: number;
}

/** One client call the account answered, or a message content it gave (`fetchContent`), in order. */
export interface FakeImapCall {
  method: string;
  path?: string;
}

/** One `STORE` the account received, in order. */
export interface FakeImapStore {
  path: string;
  uid: number;
  flag: WritableImapFlag;
  value: boolean;
}

function addressesOf(value: AddressObject | AddressObject[] | undefined): MailEnvelopeAddress[] {
  const groups = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return groups
    .flatMap((group) => group.value)
    .flatMap((entry: EmailAddress) =>
      entry.address === undefined ? [] : [{ name: entry.name, address: entry.address }],
    );
}

function referencesOf(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : value.split(/\s+/).filter(Boolean);
}

/**
 * An in-memory IMAP account behind the `ImapMailClient` the sync pass and the move drain use: folders with UIDs and
 * flags, messages parsed from their raw bytes, MOVE support and a log of every `STORE`. It holds what the provider
 * holds; tests deliver to it and append to it the way a server and the Sent-copy saver would.
 */
export class FakeImapAccount {
  readonly stores: FakeImapStore[] = [];
  readonly calls: FakeImapCall[] = [];
  /** Awaited before every call is answered; a test sets it to hold a pass at a chosen point. */
  gate: ((call: FakeImapCall) => Promise<void>) | undefined;
  private readonly folders = new Map<string, FakeImapFolder>();

  constructor(
    folders: ImapFolderRef[],
    private readonly options: FakeImapAccountOptions = {},
  ) {
    for (const folder of folders) {
      this.folders.set(folder.path, {
        ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
        uidValidity: 1,
        uidNext: 1,
        highestModSeq: 1,
        messages: [],
      });
    }
  }

  /** Files `raw` in `path` under the next UID, as a server delivers or appends it. */
  deliver(path: string, raw: Buffer, flags: readonly string[] = []): number {
    const folder = this.folder(path);
    const uid = folder.uidNext++;
    folder.messages.push({ uid, raw, flags: new Set(flags), modseq: ++folder.highestModSeq });
    return uid;
  }

  /** The flags of every message in `path`, by UID. */
  flagsIn(path: string): Map<number, string[]> {
    return new Map(this.folder(path).messages.map((message) => [message.uid, [...message.flags].sort()]));
  }

  /** How many messages `path` holds. */
  countIn(path: string): number {
    return this.folder(path).messages.length;
  }

  /** The calls since `from` (an index into `calls`) as `method path` strings. */
  callsSince(from: number): string[] {
    return this.calls
      .slice(from)
      .map((call) => (call.path === undefined ? call.method : `${call.method} ${call.path}`));
  }

  client(): ImapMailClient {
    const answer = async (method: string, path?: string) => {
      const call = path === undefined ? { method } : { method, path };
      this.calls.push(call);
      if (this.options.latencyMs) await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
      await this.gate?.(call);
    };
    const capabilities = ["MOVE", "UIDPLUS", ...(this.options.condstore ? ["CONDSTORE"] : [])];
    const methods = {
      getCapabilities: async () => new Set(capabilities),
      listFolders: async () =>
        [...this.folders].map(([path, folder]) => ({
          path,
          ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
          ...(this.options.condstore ? { status: this.selection(folder) } : {}),
        })),
      selectFolder: async (path) => this.selection(this.folder(path)),
      fetchMessagesSince: async (path, sinceUid, limit) =>
        this.light(
          path,
          this.folder(path)
            .messages.filter((message) => message.uid >= sinceUid)
            .slice(0, limit),
        ),
      fetchMessagesBefore: async (path, beforeUid, limit) =>
        this.light(
          path,
          this.folder(path)
            .messages.filter((message) => message.uid < beforeUid)
            .reverse()
            .slice(0, limit),
        ),
      fetchSnippets: async (path, requests) => {
        const snippets = new Map<number, string>();
        for (const { uid } of requests) {
          const message = this.folder(path).messages.find((candidate) => candidate.uid === uid);
          if (!message) continue;
          const text = (await parsed(message)).bodyText ?? "";
          snippets.set(uid, Buffer.from(text).subarray(0, IMAP_SNIPPET_BYTES).toString("utf8"));
        }
        return snippets;
      },
      fetchChangesSince: async () => null,
      fetchAllUids: async (path) => this.folder(path).messages.map((message) => message.uid),
      fetchFlagsChangedSince: async (path, sinceModSeq) =>
        this.folder(path)
          .messages.filter((message) => sinceModSeq === null || message.modseq > sinceModSeq)
          .map((message) => ({ uid: message.uid, flags: [...message.flags] })),
      setMessageFlag: async (path, uid, flag, value) => {
        const message = this.folder(path).messages.find((candidate) => candidate.uid === uid);
        if (!message) throw new Error(`No message ${uid} in ${path}`);
        if (value) message.flags.add(flag);
        else message.flags.delete(flag);
        message.modseq = ++this.folder(path).highestModSeq;
        this.stores.push({ path, uid, flag, value });
      },
      appendMessage: async (path, raw, flags) => {
        this.deliver(path, raw, flags);
      },
      prepareMove: async (path, uid) => {
        const folder = this.folder(path);
        return {
          uidValidity: String(folder.uidValidity),
          capabilities: new Set(["MOVE", "UIDPLUS"]),
          found: folder.messages.some((message) => message.uid === uid),
        };
      },
      executeMoveStep: async (step, sourcePath, uid, _uidValidity, targetPath) => {
        if (step !== "move") return { kind: "unsupportedCapability" };
        const source = this.folder(sourcePath);
        const index = source.messages.findIndex((message) => message.uid === uid);
        const [moved] = index === -1 ? [] : source.messages.splice(index, 1);
        if (!moved) return { kind: "uncertain" };
        source.highestModSeq++;
        const targetUid = this.deliver(targetPath, moved.raw, [...moved.flags]);
        return {
          kind: "acknowledged",
          targetUid,
          targetUidValidity: String(this.folder(targetPath).uidValidity),
        };
      },
      fetchMessageBody: async (path, uid) => {
        const message = this.folder(path).messages.find((candidate) => candidate.uid === uid);
        if (!message) return null;
        const { bodyText, bodyHtml } = await parsed(message);
        return { bodyText, bodyHtml };
      },
      searchMessageId: async (path, messageId) => {
        const uids: number[] = [];
        for (const message of this.folder(path).messages)
          if ((await parsed(message)).messageId.includes(messageId)) uids.push(message.uid);
        return uids;
      },
      downloadPart: async (path, uid, part) => {
        const message = this.folder(path).messages.find((candidate) => candidate.uid === uid);
        if (!message) return null;
        // As the light fetch numbers them: the attachments from part 2.
        const attachment = (await simpleParser(message.raw)).attachments[Number(part) - 2];
        return attachment ? Readable.from(attachment.content) : null;
      },
    } satisfies Omit<Required<ImapMailClient>, "close" | "isReusable" | "ping">;
    // Every call is logged, delayed and gated before it is answered; `close` never rejects and is not.
    const logged =
      <A extends unknown[], R>(method: string, fn: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        await answer(method, typeof args[0] === "string" ? args[0] : undefined);
        return fn(...args);
      };
    return {
      getCapabilities: logged("getCapabilities", methods.getCapabilities),
      listFolders: logged("listFolders", methods.listFolders),
      selectFolder: logged("selectFolder", methods.selectFolder),
      fetchMessagesSince: logged("fetchMessagesSince", methods.fetchMessagesSince),
      fetchMessagesBefore: logged("fetchMessagesBefore", methods.fetchMessagesBefore),
      fetchSnippets: logged("fetchSnippets", methods.fetchSnippets),
      fetchChangesSince: logged("fetchChangesSince", methods.fetchChangesSince),
      fetchAllUids: logged("fetchAllUids", methods.fetchAllUids),
      fetchFlagsChangedSince: logged("fetchFlagsChangedSince", methods.fetchFlagsChangedSince),
      setMessageFlag: logged("setMessageFlag", methods.setMessageFlag),
      appendMessage: logged("appendMessage", methods.appendMessage),
      prepareMove: logged("prepareMove", methods.prepareMove),
      executeMoveStep: logged("executeMoveStep", methods.executeMoveStep),
      fetchMessageBody: logged("fetchMessageBody", methods.fetchMessageBody),
      searchMessageId: logged("searchMessageId", methods.searchMessageId),
      downloadPart: logged("downloadPart", methods.downloadPart),
      close: async () => {},
    };
  }

  /** The light fetch of `messages`; a message's `fetchContent` is logged as a call too. */
  private async light(path: string, messages: FakeImapMessage[]): Promise<ImapFetchedMessage[]> {
    const fetched: ImapFetchedMessage[] = [];
    for (const message of messages)
      fetched.push(
        fakeFetchedMessage(message.uid, await parsed(message), () => this.calls.push({ method: "fetchContent", path })),
      );
    return fetched;
  }

  private selection(folder: FakeImapFolder) {
    return {
      uidvalidity: folder.uidValidity,
      uidnext: folder.uidNext,
      highestModSeq: this.options.condstore ? folder.highestModSeq : null,
      messages: folder.messages.length,
    };
  }

  private folder(path: string): FakeImapFolder {
    const folder = this.folders.get(path);
    if (!folder) throw new Error(`No folder ${path}`);
    return folder;
  }
}

async function parsed(message: FakeImapMessage): Promise<FetchedMessage> {
  const mail = await simpleParser(message.raw);
  const [from] = addressesOf(mail.from);
  return {
    messageId: mail.messageId ?? `<no-message-id-uid-${message.uid}@generated>`,
    inReplyTo: mail.inReplyTo ?? null,
    references: referencesOf(mail.references),
    subject: mail.subject,
    envelope: { from, to: addressesOf(mail.to), cc: addressesOf(mail.cc) },
    bodyText: mail.text,
    ...(typeof mail.html === "string" ? { bodyHtml: mail.html } : {}),
    date: mail.date,
    attachments: [],
    flags: [...message.flags],
  };
}
