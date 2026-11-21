import type { ImapFlow } from "imapflow";
import type { ImapIdleConnection, ImapIdleFolderTarget, ImapIdleTransport } from "./imapIdleLifecycle.js";
import { logger } from "./logger.js";

/**
 * imapflow's `maxIdleTime`: IDLE is reissued on the same socket before the ~30-minute point at
 * which servers drop it. Unrelated to the lifecycle's connection-recycling deadline.
 */
export const IMAP_IDLE_MAX_IDLE_TIME_MS = 25 * 60 * 1000;

/** Longer than `IMAP_IDLE_MAX_IDLE_TIME_MS` so a renewal never trips it; imapflow's 5-minute default is too short. */
export const IMAP_IDLE_SOCKET_TIMEOUT_MS = 35 * 60 * 1000;

/**
 * imapflow's `autoIdleDelay` (15 s by default) on the IDLE connection: a server reports a new message only while
 * IDLE runs, so the connection, which issues no command after its SELECT, starts IDLE at once instead of leaving a
 * blind window after every connect.
 */
export const IMAP_IDLE_AUTO_IDLE_DELAY_MS = 0;

// TCP keepalive needs no configuration: imapflow always enables it on its sockets.

export interface ImapIdleFlowOptions {
  maxIdleTime: number;
  socketTimeout: number;
  autoIdleDelay: number;
}

/**
 * Returns a connected, authenticated client built by the composition root with the IDLE options;
 * the transport never connects a client itself (see
 * docs/architecture/domain-mail-and-inbox.md#server-settings-and-outbound-connections). `signal`
 * aborts once the lifecycle stops and ends a wait for the login admission.
 */
export type CreateIdleTunedImapFlowClient = (
  mailboxItemId: string,
  credential: string,
  idleOptions: ImapIdleFlowOptions,
  signal: AbortSignal,
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
    // Detach listeners before logout so a push during BYE cannot reach onSignal after close.
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

export function createImapFlowIdleTransport(createClient: CreateIdleTunedImapFlowClient): ImapIdleTransport {
  return {
    async resolveFolders(mailboxItemId, credential, signal): Promise<ImapIdleFolderTarget[]> {
      const client = await createClient(
        mailboxItemId,
        credential,
        {
          maxIdleTime: IMAP_IDLE_MAX_IDLE_TIME_MS,
          socketTimeout: IMAP_IDLE_SOCKET_TIMEOUT_MS,
          autoIdleDelay: IMAP_IDLE_AUTO_IDLE_DELAY_MS,
        },
        signal,
      );
      const ended = endPromiseFor(client);
      let targets: ImapIdleFolderTarget[];
      try {
        const list = await client.list();
        const inbox = list.find((f) => f.specialUse === SPECIAL_USE_INBOX);
        const allMail = list.find((f) => f.specialUse === SPECIAL_USE_ALL);
        targets = [inbox, allMail].filter((f): f is NonNullable<typeof f> => Boolean(f)).map((f) => ({ path: f.path }));
        // Without RFC 6154 special-use attributes, INBOX still exists (fallback below).
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

    async connect(mailboxItemId, credential, folderPath, onSignal, signal): Promise<ImapIdleConnection> {
      const client = await createClient(
        mailboxItemId,
        credential,
        {
          maxIdleTime: IMAP_IDLE_MAX_IDLE_TIME_MS,
          socketTimeout: IMAP_IDLE_SOCKET_TIMEOUT_MS,
          autoIdleDelay: IMAP_IDLE_AUTO_IDLE_DELAY_MS,
        },
        signal,
      );
      const ended = endPromiseFor(client);
      try {
        await client.mailboxOpen(folderPath);
      } catch (err) {
        return closeAfterFailure(client, ended, err);
      }
      // imapflow's default auto-IDLE keeps emitting these; no explicit IDLE command is needed.
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
