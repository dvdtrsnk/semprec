import type { ImapFlow } from "imapflow";
import type { ImapIdleConnection, ImapIdleFolderTarget, ImapIdleTransport } from "./imapIdleLifecycle.js";
import { logger } from "./logger.js";

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

function endPromiseFor(client: ImapFlow): {
  promise: Promise<unknown>;
  closed: Promise<void>;
  secondary: unknown[];
  claimEnd: () => Promise<unknown>;
  unclaimedError: () => { value: unknown } | undefined;
  dispose: () => void;
} {
  let resolveEnd!: (error: unknown) => void;
  let resolveClose!: () => void;
  let endSettled = false;
  let closeSettled = false;
  let claimed = false;
  let firstError: { value: unknown } | undefined;
  const secondary: unknown[] = [];
  const promise = new Promise<unknown>((resolve) => {
    resolveEnd = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const onError = (error: unknown) => {
    if (endSettled) secondary.push(error);
    else {
      firstError = { value: error };
      endSettled = true;
      resolveEnd(error === undefined ? { failure: undefined } : error);
    }
  };
  const onClose = () => {
    if (!endSettled) {
      endSettled = true;
      resolveEnd(undefined);
    }
    if (!closeSettled) {
      closeSettled = true;
      resolveClose();
    }
  };
  client.on("error", onError);
  client.on("close", onClose);
  return {
    promise,
    closed,
    secondary,
    claimEnd: () => {
      claimed = true;
      return promise;
    },
    unclaimedError: () => (claimed ? undefined : firstError),
    dispose: () => {
      client.off("error", onError);
      client.off("close", onClose);
    },
  };
}

const IDLE_LOGOUT_TIMEOUT_MS = 10_000;

async function closeClient(client: ImapFlow, ended: ReturnType<typeof endPromiseFor>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let logout: Promise<{ kind: "done"; value: unknown } | { kind: "failed"; error: unknown }>;
  try {
    logout = client.logout().then(
      (value: unknown) => ({ kind: "done" as const, value }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
  } catch (error) {
    logout = Promise.resolve({ kind: "failed", error });
  }
  const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), IDLE_LOGOUT_TIMEOUT_MS);
  });
  const failures = ended.secondary;
  let closeRequested = false;
  const requestClose = () => {
    if (closeRequested) return;
    closeRequested = true;
    try {
      client.close();
    } catch (error) {
      failures.push(error);
    }
  };
  const diagnose = (category: "ambiguous" | "unresolved") => {
    try {
      logger.warn({ stage: "logout", category }, "IMAP IDLE provider cleanup observation");
    } catch (error) {
      failures.push(error);
    }
  };
  try {
    const outcome = await Promise.race([logout, deadline]);
    if (outcome.kind === "failed") failures.push(outcome.error);
    if (outcome.kind === "done" && outcome.value === false) diagnose("ambiguous");
    if (outcome.kind === "failed" || (outcome.kind === "done" && outcome.value === false)) requestClose();
    if (outcome.kind === "timeout") {
      failures.push(new Error("IMAP IDLE logout timed out"));
      diagnose("unresolved");
      requestClose();
      const settled = await logout;
      if (settled.kind === "failed") failures.unshift(settled.error);
      else if (settled.value === false) diagnose("ambiguous");
      await ended.closed;
    } else {
      const closeResult = await Promise.race([
        ended.closed.then(() => "closed" as const),
        deadline.then(() => "timeout" as const),
      ]);
      if (closeResult === "timeout") {
        failures.push(new Error("IMAP IDLE close observation timed out"));
        diagnose("unresolved");
        requestClose();
        await ended.closed;
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const unclaimed = ended.unclaimedError();
  if (unclaimed) failures.unshift(unclaimed.value);
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, "IMAP IDLE connection cleanup failed", { cause: failures[0] });
}

async function closeAfterFailure(
  client: ImapFlow,
  ended: ReturnType<typeof endPromiseFor>,
  original: unknown,
): Promise<never> {
  try {
    await closeClient(client, ended);
  } catch (secondary) {
    // Keep the operation failure first and retain the cleanup failure as a secondary.
    // eslint-disable-next-line preserve-caught-error
    throw new AggregateError([original, secondary], "IMAP IDLE operation and cleanup failed", { cause: original });
  } finally {
    ended.dispose();
  }
  throw original;
}

class ImapFlowIdleConnection implements ImapIdleConnection {
  constructor(
    private readonly client: ImapFlow,
    private readonly detachSignalListeners: () => void,
    private readonly ended: ReturnType<typeof endPromiseFor>,
  ) {}

  waitForEnd(): Promise<unknown> {
    return this.ended.claimEnd();
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
      await closeClient(this.client, this.ended);
    } catch (error) {
      failures.push(error);
    } finally {
      this.ended.dispose();
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
      const ended = endPromiseFor(client);
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
        return closeAfterFailure(client, ended, error);
      }
      try {
        await closeClient(client, ended);
      } finally {
        ended.dispose();
      }
      return targets.length > 0 ? targets : [{ path: "INBOX" }];
    },

    async connect(mailboxItemId, credential, folderPath, onSignal): Promise<ImapIdleConnection> {
      const client = await createClient(mailboxItemId, credential, {
        maxIdleTime: IMAP_IDLE_MAX_IDLE_TIME_MS,
        socketTimeout: IMAP_IDLE_SOCKET_TIMEOUT_MS,
      });
      const ended = endPromiseFor(client);
      try {
        await client.mailboxOpen(folderPath);
      } catch (err) {
        return closeAfterFailure(client, ended, err);
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
      return new ImapFlowIdleConnection(client, detachSignalListeners, ended);
    },
  };
}
