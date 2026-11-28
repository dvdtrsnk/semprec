import type { Readable } from "node:stream";
import type { ImapFetchedRange, ImapFolderRef, ImapFolderSelection, ImapSnippetPart } from "./imapReconcile.js";
import type { SafeImapMoveStepResult } from "./mailMoveProviderAdapters.js";
import type { MailSearchTerms } from "./mailSearchTerms.js";
import type { WritableImapFlag } from "./messageFlags.js";

/** The body parts of a message fetched on demand. */
export interface ImapMessageBody {
  bodyText?: string;
  bodyHtml?: string;
}

export interface ImapMailClient {
  prepareMove?(
    path: string,
    uid: number,
  ): Promise<{ uidValidity: string; capabilities: Set<string>; found: boolean } | null>;
  executeMoveStep?(
    step: "move" | "copy" | "mark_deleted" | "expunge",
    sourcePath: string,
    uid: number,
    uidValidity: string,
    targetPath: string,
  ): Promise<SafeImapMoveStepResult>;
  getCapabilities(): Promise<Set<string>>;
  listFolders(): Promise<ImapFolderRef[]>;
  selectFolder(path: string): Promise<ImapFolderSelection>;
  /** The light fetch of the lowest `limit` UIDs from `sinceUid` up, lowest first. */
  fetchMessagesSince(path: string, sinceUid: number, limit: number): Promise<ImapFetchedRange>;
  /** The light fetch of the highest `limit` UIDs below `beforeUid`, highest first. */
  fetchMessagesBefore(path: string, beforeUid: number, limit: number): Promise<ImapFetchedRange>;
  /** The plain text of the first `IMAP_SNIPPET_BYTES` octets of each message's snippet part, by UID. */
  fetchSnippets(
    path: string,
    requests: ReadonlyArray<{ uid: number; part: ImapSnippetPart }>,
  ): Promise<Map<number, string>>;
  /**
   * QRESYNC: the flags changed and the UIDs expunged since `sinceModSeq`, in one fetch. `null` when QRESYNC is not
   * enabled on the connection; the caller then uses `fetchFlagsChangedSince` and the message count.
   */
  fetchChangesSince(
    path: string,
    sinceModSeq: number,
  ): Promise<{ flags: Array<{ uid: number; flags: string[] }>; vanished: number[] } | null>;
  /** Every UID the folder holds, for a full UID diff when the message count does not account for the folder. */
  fetchAllUids(path: string): Promise<number[]>;
  /** Observes provider-side flag changes on known UIDs; `null` modseq fetches every UID's flags. */
  fetchFlagsChangedSince(path: string, sinceModSeq: number | null): Promise<Array<{ uid: number; flags: string[] }>>;
  /** The only flag write; every fetch above must stay peek-only so reads never mark mail as seen. */
  setMessageFlag(path: string, uid: number, flag: WritableImapFlag, value: boolean): Promise<void>;
  /** Used only to keep a sent message's copy in the Sent folder. */
  appendMessage(path: string, raw: Buffer, flags: readonly WritableImapFlag[]): Promise<void>;
  /** Never rejects: callers invoke it during cleanup, possibly after a failure. */
  close(): Promise<void>;
  /**
   * `true` while the connection is open and nothing it ran failed or was left in doubt, so a later caller can use it
   * again (a pooled sync session, the next move of a drain). Absent: the client cannot tell, and is never reused.
   */
  isReusable?(): boolean;
  /** One round trip (NOOP) proving a connection kept open between uses still answers; `false` if it does not. */
  ping?(): Promise<boolean>;
  // The reads of the on-demand content fetch; only a client that can serve them (the production client and the
  // session pool's wrapper of one) offers them.
  /**
   * The body parts of the message at `uid`, chosen as the full ingest chooses them, each cut at
   * `IMAP_CONTENT_MAX_PART_BYTES`; `null` when the folder holds no message with that UID.
   */
  fetchMessageBody?(path: string, uid: number): Promise<ImapMessageBody | null>;
  /** The UIDs of the messages in `path` whose Message-ID header contains `messageId` (`UID SEARCH HEADER`). */
  searchMessageId?(path: string, messageId: string): Promise<number[]>;
  /**
   * The UIDs of the messages in `path` whose header or body holds every included term and no excluded one
   * (`UID SEARCH TEXT`), with `CHARSET UTF-8` for a non-ASCII term and, when the server refuses that, again with the
   * terms folded to US-ASCII. Rejects when the server refuses the search.
   */
  searchText?(path: string, terms: MailSearchTerms): Promise<number[]>;
  /**
   * The decoded bytes of the leaf body part `part` of the message at `uid`, capped at `MAX_ATTACHMENT_BYTES`; `null`
   * when the folder holds no message with that UID or the message has no such leaf. The stream reads the connection,
   * so it is consumed before the client is closed.
   */
  downloadPart?(path: string, uid: number, part: string): Promise<Readable | null>;
}
