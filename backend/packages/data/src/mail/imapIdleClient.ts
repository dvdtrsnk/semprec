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
 * Builds a connected, authenticated `ImapFlow` client: the composition root's `createClient`
 * returns `openImapFlow`'s result (mailServerConnections.ts), built with the mailbox's stored
 * settings and the IDLE options (`maxIdleTime`, `socketTimeout`). Host and auth resolution is the
 * composition root's job, same delegation `MailSyncAdapterFactory.createImapClient` (mailSyncJob.ts)
 * already uses. The transport never connects a client it receives: it arrives connected
 * (docs/adr/2026-10-29-imap-idle-connections-through-the-shared-imap-connect-step.md).
 */
export type CreateIdleTunedImapFlowClient = (
  mailboxItemId: string,
  credential: string,
  idleOptions: ImapIdleFlowOptions,
) => Promise<ImapFlow>;

const SPECIAL_USE_INBOX = "\\Inbox";
const SPECIAL_USE_ALL = "\\All";

function endPromiseFor(client: ImapFlow): { promise: Promise<unknown>; settle: (error: unknown) => void } {
  let settle: (error: unknown) => void = () => {};
  const promise = new Promise<unknown>((resolve) => {
    let settled = false;
    const onError = (error: unknown) => finish(error === undefined ? { failure: undefined } : error);
    const onClose = () => finish(undefined);
    const finish = (error: unknown) => {
      if (settled) return;
      settled = true;
      client.off("error", onError);
      client.off("close", onClose);
      resolve(error);
    };
    settle = finish;
    client.on("error", onError);
    client.on("close", onClose);
  });
  return { promise, settle };
}

const IDLE_LOGOUT_TIMEOUT_MS = 10_000;

async function closeClient(client: ImapFlow): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let logout: Promise<{ kind: "done" } | { kind: "failed"; error: unknown }>;
  try {
    logout = client.logout().then(
      () => ({ kind: "done" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
  } catch (error) {
    logout = Promise.resolve({ kind: "failed", error });
  }
  let outcome: { kind: "done" } | { kind: "failed"; error: unknown } | { kind: "timeout" };
  try {
    outcome = await Promise.race([
      logout,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), IDLE_LOGOUT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (outcome.kind === "done") return;
  const failures: unknown[] = [outcome.kind === "failed" ? outcome.error : new Error("IMAP IDLE logout timed out")];
  try {
    client.close();
  } catch (error) {
    failures.push(error);
  }
  if (outcome.kind === "timeout") {
    const settled = await logout;
    if (settled.kind === "failed") failures.push(settled.error);
  }
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, "IMAP IDLE connection cleanup failed", { cause: failures[0] });
}

async function closeAfterFailure(client: ImapFlow, original: unknown): Promise<never> {
  try {
    await closeClient(client);
  } catch (secondary) {
    // Keep the operation failure first and retain the cleanup failure as a secondary.
    // eslint-disable-next-line preserve-caught-error
    throw new AggregateError([original, secondary], "IMAP IDLE operation and cleanup failed", { cause: original });
  }
  throw original;
}

class ImapFlowIdleConnection implements ImapIdleConnection {
  private readonly ended: ReturnType<typeof endPromiseFor>;

  constructor(
    private readonly client: ImapFlow,
    private readonly detachSignalListeners: () => void,
  ) {
    this.ended = endPromiseFor(client);
  }

  waitForEnd(): Promise<unknown> {
    return this.ended.promise;
  }

  async close(): Promise<void> {
    // Detach exists/expunge/flags before logout so a final server push during BYE can't still
    // reach onSignal after the caller considers this connection closed.
    const failures: unknown[] = [];
    try {
      this.detachSignalListeners();
    } catch (error) {
      failures.push(error);
    }
    try {
      await closeClient(this.client);
    } catch (error) {
      failures.push(error);
    } finally {
      this.ended.settle(undefined);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "IMAP IDLE cleanup failed");
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
      const client = await createClient(mailboxItemId, credential, {
        maxIdleTime: IMAP_IDLE_MAX_IDLE_TIME_MS,
        socketTimeout: IMAP_IDLE_SOCKET_TIMEOUT_MS,
      });
      let targets: ImapIdleFolderTarget[];
      try {
        const list = await client.list();
        const inbox = list.find((f) => f.specialUse === SPECIAL_USE_INBOX);
        const allMail = list.find((f) => f.specialUse === SPECIAL_USE_ALL);
        targets = [inbox, allMail].filter((f): f is NonNullable<typeof f> => Boolean(f)).map((f) => ({ path: f.path }));
        // A server with neither special-use attribute (plain IMAP without RFC 6154) still has
        // an INBOX by definition — falling back to it keeps this account under some IDLE
        // coverage instead of none.
      } catch (error) {
        return closeAfterFailure(client, error);
      }
      await closeClient(client);
      return targets.length > 0 ? targets : [{ path: "INBOX" }];
    },

    async connect(mailboxItemId, credential, folderPath, onSignal): Promise<ImapIdleConnection> {
      const client = await createClient(mailboxItemId, credential, {
        maxIdleTime: IMAP_IDLE_MAX_IDLE_TIME_MS,
        socketTimeout: IMAP_IDLE_SOCKET_TIMEOUT_MS,
      });
      try {
        await client.mailboxOpen(folderPath);
      } catch (err) {
        return closeAfterFailure(client, err);
      }
      // EXISTS (new message), EXPUNGE (deletion), and flags (read/flagged toggled from another
      // client) are exactly the three signal kinds issue #196's Task names; imapflow keeps
      // emitting all three on this client while its own internal auto-IDLE is active, which it
      // is by default (`disableAutoIdle` is left unset) for as long as no other command is
      // in flight — never something this module has to issue an explicit `IDLE` command for.
      client.on("exists", onSignal);
      client.on("expunge", onSignal);
      client.on("flags", onSignal);
      const detachSignalListeners = () => {
        client.off("exists", onSignal);
        client.off("expunge", onSignal);
        client.off("flags", onSignal);
      };
      return new ImapFlowIdleConnection(client, detachSignalListeners);
    },
  };
}
