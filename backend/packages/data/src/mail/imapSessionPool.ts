import { createHash } from "node:crypto";
import type { ImapFetchedMessage, ImapMailClient } from "./imapReconcile.js";
import {
  sharedImapConnectionLimiter,
  type ImapConnectionLease,
  type ImapConnectionLimiter,
} from "./imapConnectionLimiter.js";
import { logger } from "./logger.js";

/**
 * How long a sync session stays open unused. Below the idle cutoff of common servers (RFC 9051 asks for at least 30
 * minutes; some providers cut earlier), so a kept session is still signed in when the next pass, a flag write-back or
 * the sweep comes; a busier account keeps one login for many passes.
 */
export const IMAP_SESSION_IDLE_TIMEOUT_MS = 4 * 60 * 1000;

export interface ImapSessionRequest {
  mailboxItemId: string;
  /** The account's connection budget (`imapConnectionLimitForProvider`). */
  accountLimit: number;
  /** The server host the connection dials. */
  host: string;
  /**
   * Everything the connection signed in with (server settings, user name, credential); a kept session opened with
   * another value is closed instead of reused. Only its digest is kept.
   */
  signIn: string;
  /** Opens and signs in a new connection; called only when no kept session can be used. */
  connect(): Promise<ImapMailClient>;
}

/**
 * One IMAP sync connection per account kept open between uses in this process. A checked-out client belongs to its
 * caller alone until its `close()`, which hands the connection back. A connection that is open counts against the
 * account and host limits of the limiter whether it is checked out or kept, because the provider counts an open
 * connection whatever it is doing; a kept one gives its slot up as soon as another caller has to wait for it.
 */
export interface ImapSessionPool {
  /**
   * The account's kept session when it was opened with the same `signIn`, answers a NOOP and is not checked out
   * already; otherwise a new connection under a limiter slot. The client's `close()` keeps the connection when it is
   * still reusable (`ImapMailClient.isReusable`) and the account keeps none yet, and closes it otherwise; any rejected
   * operation of the client makes it unusable.
   */
  checkout(request: ImapSessionRequest): Promise<ImapMailClient>;
  /** Closes the account's kept session; a checked-out one is closed when it is handed back. */
  closeAccount(mailboxItemId: string): Promise<void>;
  /** Closes every kept session and refuses later checkouts; checked-out ones close when handed back. */
  close(): Promise<void>;
}

interface Session {
  mailboxItemId: string;
  signIn: string;
  client: ImapMailClient;
  lease: ImapConnectionLease;
  /** A provider operation of this checkout failed, or the account was closed while it was checked out. */
  discard: boolean;
  idleTimer: NodeJS.Timeout | undefined;
}

function digestOf(signIn: string): string {
  return createHash("sha256").update(signIn).digest("hex");
}

export function createImapSessionPool(
  limiter: ImapConnectionLimiter = sharedImapConnectionLimiter,
  idleTimeoutMs: number = IMAP_SESSION_IDLE_TIMEOUT_MS,
): ImapSessionPool {
  const kept = new Map<string, Session>();
  const checkedOut = new Set<Session>();
  const closing = new Set<Promise<void>>();
  let closed = false;

  /** Closes the connection and frees its slots; a close failure reaches the caller. */
  async function closeSession(session: Session): Promise<void> {
    try {
      await session.client.close();
    } finally {
      session.lease.release();
    }
  }

  /** Closes a kept session in the background; its failure is logged, nobody waits on its outcome. */
  function evict(session: Session): Promise<void> {
    if (kept.get(session.mailboxItemId) !== session) return Promise.resolve();
    kept.delete(session.mailboxItemId);
    clearTimeout(session.idleTimer);
    const done = closeSession(session).catch((error: unknown) => {
      logger.warn(
        { mailboxItemId: session.mailboxItemId, errorName: error instanceof Error ? error.name : typeof error },
        "Closing a kept IMAP sync session failed",
      );
    });
    closing.add(done);
    void done.finally(() => closing.delete(done));
    return done;
  }

  async function handBack(session: Session): Promise<void> {
    checkedOut.delete(session);
    const reusable = !closed && !session.discard && session.client.isReusable?.() === true;
    if (!reusable || kept.has(session.mailboxItemId)) {
      await closeSession(session);
      return;
    }
    kept.set(session.mailboxItemId, session);
    session.idleTimer = setTimeout(() => void evict(session), idleTimeoutMs);
    session.idleTimer.unref();
    session.lease.markIdle(() => void evict(session));
  }

  function checkedOutClient(session: Session): ImapMailClient {
    let handedBack = false;
    const use = <T>(operation: (client: ImapMailClient) => Promise<T>): Promise<T> => {
      if (handedBack) return Promise.reject(new Error("The IMAP session was handed back"));
      return operation(session.client).catch((error: unknown) => {
        session.discard = true;
        throw error;
      });
    };
    const { client } = session;
    // A full message's content is downloaded later over the same connection, so it goes through the same guard.
    const guardContent = (messages: ImapFetchedMessage[]): ImapFetchedMessage[] =>
      messages.map((message) => ({ ...message, fetchContent: () => use(() => message.fetchContent()) }));
    const wrapped: ImapMailClient = {
      getCapabilities: () => use((c) => c.getCapabilities()),
      listFolders: () => use((c) => c.listFolders()),
      selectFolder: (path) => use((c) => c.selectFolder(path)),
      fetchMessagesSince: (path, sinceUid, limit) =>
        use((c) => c.fetchMessagesSince(path, sinceUid, limit)).then(guardContent),
      fetchMessagesBefore: (path, beforeUid, limit) =>
        use((c) => c.fetchMessagesBefore(path, beforeUid, limit)).then(guardContent),
      fetchSnippets: (path, requests) => use((c) => c.fetchSnippets(path, requests)),
      fetchChangesSince: (path, sinceModSeq) => use((c) => c.fetchChangesSince(path, sinceModSeq)),
      fetchAllUids: (path) => use((c) => c.fetchAllUids(path)),
      fetchFlagsChangedSince: (path, sinceModSeq) => use((c) => c.fetchFlagsChangedSince(path, sinceModSeq)),
      setMessageFlag: (path, uid, flag, value) => use((c) => c.setMessageFlag(path, uid, flag, value)),
      appendMessage: (path, raw, flags) => use((c) => c.appendMessage(path, raw, flags)),
      isReusable: () => !handedBack && !session.discard && client.isReusable?.() === true,
      async close() {
        if (handedBack) return;
        handedBack = true;
        await handBack(session);
      },
    };
    // Only offered where the client has them: the move drain tells an adapter without moves by their absence.
    if (client.prepareMove) wrapped.prepareMove = (path, uid) => use((c) => c.prepareMove!(path, uid));
    if (client.executeMoveStep) {
      wrapped.executeMoveStep = (step, sourcePath, uid, uidValidity, targetPath) =>
        use((c) => c.executeMoveStep!(step, sourcePath, uid, uidValidity, targetPath));
    }
    // So are the on-demand content reads and the text search. A part's stream is read after `downloadPart` resolved;
    // a failure of it leaves the client itself not reusable.
    if (client.fetchMessageBody) wrapped.fetchMessageBody = (path, uid) => use((c) => c.fetchMessageBody!(path, uid));
    if (client.searchMessageId)
      wrapped.searchMessageId = (path, messageId) => use((c) => c.searchMessageId!(path, messageId));
    if (client.searchText) wrapped.searchText = (path, terms) => use((c) => c.searchText!(path, terms));
    if (client.downloadPart) wrapped.downloadPart = (path, uid, part) => use((c) => c.downloadPart!(path, uid, part));
    return wrapped;
  }

  /** A NOOP round trip; a client without `ping` cannot tell and counts as answering. */
  async function answers(session: Session): Promise<boolean> {
    if (!session.client.ping) return true;
    try {
      return await session.client.ping();
    } catch (error) {
      logger.warn(
        { mailboxItemId: session.mailboxItemId, errorName: error instanceof Error ? error.name : typeof error },
        "A kept IMAP sync session did not answer",
      );
      return false;
    }
  }

  return {
    async checkout(request) {
      if (closed) throw new Error("The IMAP session pool is closed");
      const signIn = digestOf(request.signIn);
      const existing = kept.get(request.mailboxItemId);
      if (existing) {
        kept.delete(request.mailboxItemId);
        clearTimeout(existing.idleTimer);
        existing.lease.markBusy();
        // Checked out while it is pinged, so a `closeAccount` meanwhile marks it.
        checkedOut.add(existing);
        if (existing.signIn === signIn && (await answers(existing)) && !existing.discard && !closed) {
          return checkedOutClient(existing);
        }
        checkedOut.delete(existing);
        // Closed before a new connection is opened, so the two never hold slots at once.
        try {
          await closeSession(existing);
        } catch (error) {
          logger.warn(
            { mailboxItemId: request.mailboxItemId, errorName: error instanceof Error ? error.name : typeof error },
            "Closing a kept IMAP sync session failed",
          );
        }
        if (closed) throw new Error("The IMAP session pool is closed");
      }
      const lease = await limiter.acquire({
        accountId: request.mailboxItemId,
        accountLimit: request.accountLimit,
        host: request.host,
        kind: "work",
      });
      let client: ImapMailClient;
      try {
        client = await request.connect();
      } catch (error) {
        lease.release();
        throw error;
      }
      const session: Session = {
        mailboxItemId: request.mailboxItemId,
        signIn,
        client,
        lease,
        discard: false,
        idleTimer: undefined,
      };
      checkedOut.add(session);
      return checkedOutClient(session);
    },
    async closeAccount(mailboxItemId) {
      for (const session of checkedOut) if (session.mailboxItemId === mailboxItemId) session.discard = true;
      const session = kept.get(mailboxItemId);
      if (session) await evict(session);
    },
    async close() {
      closed = true;
      for (const session of checkedOut) session.discard = true;
      await Promise.all([...kept.values()].map((session) => evict(session)));
      await Promise.all([...closing]);
    },
  };
}

/** Process-wide over the shared limiter, as the sessions count against the limits of every other connection. */
export const sharedImapSessionPool: ImapSessionPool = createImapSessionPool();
