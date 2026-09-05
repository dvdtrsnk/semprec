import type { ImapFlow } from "imapflow";
import type { ImapIdleConnection, ImapIdleFolderTarget, ImapIdleTransport } from "./imapIdleLifecycle.js";

/**
 * Renewed well under the ~30-minute point most IMAP servers close an idle IDLE command at
 * (issue #196: "Renew before 29 minutes") — passed as imapflow's own `maxIdleTime`, which
 * breaks and reissues IDLE on this cadence internally without ever tearing down the
 * connection, so the same socket (and its TLS session) survives across many renewals. This is
 * intentionally shorter than `DEFAULT_HARD_CYCLE_DEADLINE_MS` (imapIdleLifecycle.ts), which
 * recycles the whole connection on a much longer, unrelated cadence.
 */
export const IMAP_IDLE_MAX_IDLE_TIME_MS = 25 * 60 * 1000;

/**
 * How long the socket may sit with no data at all (not even a renewed IDLE's tagged response)
 * before imapflow gives up on it — comfortably longer than `IMAP_IDLE_MAX_IDLE_TIME_MS` so a
 * normal renewal round-trip never itself trips this, but still bounded rather than left at
 * imapflow's 5-minute default, which is far shorter than how long this connection is meant to
 * sit quiet between renewals.
 */
export const IMAP_IDLE_SOCKET_TIMEOUT_MS = 35 * 60 * 1000;

/**
 * TCP keepalive is not configured here: imapflow enables it unconditionally on every socket it
 * opens (`socket.setKeepAlive(true, 5_000)` in its own connection setup), so there is nothing
 * this module needs to request — a silently-dead connection (a dropped Wi-Fi network, a
 * NAT/firewall that drops idle mappings) is still detected without a full protocol timeout.
 */

export interface ImapIdleFlowOptions {
  maxIdleTime: number;
  socketTimeout: number;
}

/**
 * Builds a connected, authenticated `ImapFlow` client — real host/auth resolution (the
 * mailbox's server settings, decrypting `credential`) is the composition root's job, same
 * delegation `MailSyncAdapterFactory.createImapClient` (mailSyncJob.ts) already uses; this
 * module only ever asks for the IDLE-specific options (`maxIdleTime`, `socketTimeout`) to be
 * applied on top of whatever connection options the composition root otherwise supplies.
 */
export type CreateIdleTunedImapFlowClient = (mailboxItemId: string, credential: string, idleOptions: ImapIdleFlowOptions) => Promise<ImapFlow>;

const SPECIAL_USE_INBOX = "\\Inbox";
const SPECIAL_USE_ALL = "\\All";

function endPromiseFor(client: ImapFlow): Promise<unknown> {
  return new Promise((resolve) => {
    const cleanup = () => {
      client.off("error", onError);
      client.off("close", onClose);
    };
    const onError = (err: unknown) => {
      cleanup();
      resolve(err);
    };
    const onClose = () => {
      cleanup();
      resolve(undefined);
    };
    client.on("error", onError);
    client.on("close", onClose);
  });
}

async function closeQuietly(client: ImapFlow): Promise<void> {
  try {
    await client.logout();
  } catch {
    try {
      client.close();
    } catch {
      // Already gone — nothing left to release.
    }
  }
}

class ImapFlowIdleConnection implements ImapIdleConnection {
  private readonly ended: Promise<unknown>;

  constructor(private readonly client: ImapFlow) {
    this.ended = endPromiseFor(client);
  }

  waitForEnd(): Promise<unknown> {
    return this.ended;
  }

  close(): Promise<void> {
    return closeQuietly(this.client);
  }
}

/**
 * imapflow-backed `ImapIdleTransport` (issue #196). Not exercised against a live IMAP server in
 * CI, same relationship `ImapFlowMailClient` (imapFlowClient.ts) has to `imapReconcile.ts` —
 * the orchestration this depends on (bounded reconnect, hard-cycle recycling,
 * `imapIdleLifecycle.ts`) is what is actually unit-tested, against a fake transport.
 */
export function createImapFlowIdleTransport(createClient: CreateIdleTunedImapFlowClient): ImapIdleTransport {
  return {
    async resolveFolders(mailboxItemId, credential): Promise<ImapIdleFolderTarget[]> {
      const client = await createClient(mailboxItemId, credential, { maxIdleTime: IMAP_IDLE_MAX_IDLE_TIME_MS, socketTimeout: IMAP_IDLE_SOCKET_TIMEOUT_MS });
      try {
        await client.connect();
        const list = await client.list();
        const inbox = list.find((f) => f.specialUse === SPECIAL_USE_INBOX);
        const allMail = list.find((f) => f.specialUse === SPECIAL_USE_ALL);
        const targets = [inbox, allMail].filter((f): f is NonNullable<typeof f> => Boolean(f)).map((f) => ({ path: f.path }));
        // A server with neither special-use attribute (plain IMAP without RFC 6154) still has
        // an INBOX by definition — falling back to it keeps this account under some IDLE
        // coverage instead of none.
        return targets.length > 0 ? targets : [{ path: "INBOX" }];
      } finally {
        await closeQuietly(client);
      }
    },

    async connect(mailboxItemId, credential, folderPath, onSignal): Promise<ImapIdleConnection> {
      const client = await createClient(mailboxItemId, credential, { maxIdleTime: IMAP_IDLE_MAX_IDLE_TIME_MS, socketTimeout: IMAP_IDLE_SOCKET_TIMEOUT_MS });
      try {
        await client.connect();
        await client.mailboxOpen(folderPath);
      } catch (err) {
        await closeQuietly(client);
        throw err;
      }
      // EXISTS (new message), EXPUNGE (deletion), and flags (read/flagged toggled from another
      // client) are exactly the three signal kinds issue #196's Task names; imapflow keeps
      // emitting all three on this client while its own internal auto-IDLE is active, which it
      // is by default (`disableAutoIdle` is left unset) for as long as no other command is
      // in flight — never something this module has to issue an explicit `IDLE` command for.
      client.on("exists", onSignal);
      client.on("expunge", onSignal);
      client.on("flags", onSignal);
      return new ImapFlowIdleConnection(client);
    },
  };
}
