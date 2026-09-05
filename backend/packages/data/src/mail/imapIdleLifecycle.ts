import type { Pool } from "pg";
import { enqueueMailAccountSync } from "./mailSyncJob.js";
import { sharedImapConnectionLimiter, type ImapConnectionLimiter } from "./imapConnectionLimiter.js";
import type { MailAccountLifecycle, MailLiveSyncAccount, MailLiveSyncLifecycleFactory } from "./mailLiveSyncRoot.js";

export interface ImapIdleFolderTarget {
  path: string;
}

/**
 * One bounded IMAP connection dedicated to a single folder, already IDLE-ing. What a real
 * transport (imapIdleClient.ts's imapflow-backed one, or a fake in tests) must provide —
 * `connect` on `ImapIdleTransport` below returns this once the connection is up and IDLE has
 * started; everything from then on is either a signal (delivered through the `onSignal`
 * callback `connect` was given, never through this interface) or the connection ending.
 */
export interface ImapIdleConnection {
  /**
   * Resolves once this connection has ended, for any reason (server closed it, a socket or
   * protocol error) — with the error if there was one, `undefined` otherwise. Never rejects:
   * the caller races this against its own hard-cycle-deadline and stop() timers with
   * `Promise.race`, and a rejection here would need its own try/catch just for this half of
   * the race for no benefit, since "the connection ended" is exactly the event being waited
   * for either way.
   */
  waitForEnd(): Promise<unknown>;
  /** Idempotent — safe to call after the connection has already ended on its own. */
  close(): Promise<void>;
}

/**
 * What a real IMAP-IDLE transport must provide. Deliberately narrower than `ImapMailClient`
 * (imapReconcile.ts): this module never fetches, ingests, or mutates a message — the only
 * thing a signal observed while idling is allowed to do is ask the existing idempotent
 * `enqueueMailAccountSync` job path (mailSyncJob.ts) to reconcile, per issue #196's explicit
 * "No direct Email mutation in callback". `onSignal` is wired to that call inside this file,
 * not exposed for a transport or caller to override.
 */
export interface ImapIdleTransport {
  /**
   * Discovers the folder paths this account keeps under IDLE — Inbox and an All-Mail-
   * equivalent folder (issue #196's Task) when the server has one, Inbox alone otherwise
   * (plain IMAP/iCloud has no such folder). Called once per `start()` and again for whichever
   * folder is reconnecting after a hard-cycle recycle or an error — a folder renamed between
   * rounds is picked up the same way any other config drift is, by re-resolving rather than
   * trusting a cached path.
   */
  resolveFolders(mailboxItemId: string, credential: string): Promise<ImapIdleFolderTarget[]>;
  /**
   * Opens one bounded connection dedicated to `folderPath` and starts IDLE, invoking
   * `onSignal` for every EXISTS/EXPUNGE/flags notification observed while idling. Rejects if
   * the connection itself could not be established — the caller applies bounded reconnect
   * backoff in that case.
   */
  connect(mailboxItemId: string, credential: string, folderPath: string, onSignal: () => void): Promise<ImapIdleConnection>;
}

/**
 * A live connection is deliberately recycled on this cadence regardless of health — defends
 * against slow state drift a years-long-lived socket could otherwise accumulate (a stuck
 * server-side session, a leaked listener) that a purely error-driven reconnect would never
 * catch. Independent of `maxIdleTime`'s much shorter IDLE-renewal cadence (imapIdleClient.ts),
 * which keeps the same connection alive across many IDLE rounds; this instead tears the whole
 * connection down and opens a fresh one.
 */
const DEFAULT_HARD_CYCLE_DEADLINE_MS = 6 * 60 * 60 * 1000;

/** Bounded reconnect: capped exponential backoff, not a tight retry loop and not a permanent give-up — an account stays active until deactivated, so this keeps trying for as long as that's true. */
const DEFAULT_RECONNECT_BASE_DELAY_MS = 5_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5 * 60 * 1000;

export function reconnectBackoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CreateBoundedImapIdleLifecycleFactoryOptions {
  /** Decrypted per-account IMAP credential, fetched fresh on every `start()` — never cached across a stop/restart. */
  getCredential: (mailboxItemId: string) => Promise<string>;
  /** Per-account simultaneous-IMAP-connection ceiling (`imapConnectionLimiter.ts`'s provider table) — shared with `mailSyncJob.ts`'s reconcile passes so IDLE connections and reconcile connections both count against the one budget a provider actually enforces (issue #196: "under account connection budget about 15"). */
  getConnectionLimit: (mailboxItemId: string) => Promise<number> | number;
  connectionLimiter?: ImapConnectionLimiter;
  hardCycleDeadlineMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  onError?: (mailboxItemId: string, folderPath: string, err: unknown) => void;
}

/**
 * Builds the bounded-IMAP-IDLE `MailAccountLifecycle` for one account (issue #196) — the piece
 * `mailLiveSyncRoot.ts`'s doc comment anticipates a real transport supplying for the `"imap"`
 * sync mode. `start()` hosts one long-lived, self-healing loop per folder `transport`
 * resolves; `stop()` tears every one of them down and waits for them to actually finish before
 * returning, so a caller can rely on no further `enqueueMailAccountSync` call happening after
 * `stop()` resolves.
 */
export function createBoundedImapIdleLifecycleFactory(
  pool: Pool,
  transport: ImapIdleTransport,
  options: CreateBoundedImapIdleLifecycleFactoryOptions,
): MailLiveSyncLifecycleFactory {
  const hardCycleDeadlineMs = options.hardCycleDeadlineMs ?? DEFAULT_HARD_CYCLE_DEADLINE_MS;
  const reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  const limiter = options.connectionLimiter ?? sharedImapConnectionLimiter;

  return (account: MailLiveSyncAccount): MailAccountLifecycle => {
    let stopped = false;
    let stopResolve: (value: "stop") => void = () => {};
    // A single promise shared by every in-flight wait (rather than one per call) so `stop()`
    // only ever needs to resolve one thing, regardless of how many folder loops or reconnect
    // backoffs happen to be waiting at that moment.
    let stopPromise = new Promise<"stop">((resolve) => {
      stopResolve = resolve;
    });
    let folderLoops: Promise<void>[] = [];

    function waitForStop(): Promise<"stop"> {
      return stopPromise;
    }

    async function backoffOrStop(attempt: number): Promise<boolean> {
      const outcome = await Promise.race([
        sleep(reconnectBackoffDelayMs(attempt, reconnectBaseDelayMs, reconnectMaxDelayMs)).then(() => "slept" as const),
        waitForStop(),
      ]);
      return outcome === "stop";
    }

    /**
     * One connect-idle-close round for one folder, run entirely inside the connection
     * limiter's slot (`limiter.run` below) — not just the `connect()` call — so a held-open
     * IDLE session counts against the account's connection budget for as long as it is
     * actually open, the same budget `mailSyncJob.ts`'s reconcile passes already share
     * (issue #196: "under account connection budget about 15").
     */
    async function runOneIdleRound(folderPath: string, credential: string): Promise<{ kind: "stop" } | { kind: "recycled" } | { kind: "ended"; err: unknown }> {
      const connection = await transport.connect(account.mailboxItemId, credential, folderPath, () => {
        // The only effect a signal is ever allowed to have (issue #196: "No direct Email
        // mutation in callback") — the existing idempotent, per-account-deduplicated reconcile
        // path, same one the periodic sweep and the account-discovery restart already use, so
        // a signal can never race ahead of it into a second, parallel ingestion path.
        enqueueMailAccountSync(pool, account.mailboxItemId).catch((err) => options.onError?.(account.mailboxItemId, folderPath, err));
      });
      const outcome = await Promise.race([
        connection.waitForEnd().then((err): { kind: "ended"; err: unknown } => ({ kind: "ended", err })),
        sleep(hardCycleDeadlineMs).then((): { kind: "recycled" } => ({ kind: "recycled" })),
        waitForStop().then((): { kind: "stop" } => ({ kind: "stop" })),
      ]);
      await connection.close().catch(() => {});
      return outcome;
    }

    async function runFolderLoop(folderPath: string, credential: string): Promise<void> {
      let attempt = 0;
      while (!stopped) {
        const limit = await options.getConnectionLimit(account.mailboxItemId);

        let result: { kind: "stop" } | { kind: "recycled" } | { kind: "ended"; err: unknown };
        try {
          result = await limiter.run(account.mailboxItemId, limit, () => runOneIdleRound(folderPath, credential));
        } catch (err) {
          if (stopped) return;
          options.onError?.(account.mailboxItemId, folderPath, err);
          attempt++;
          if (await backoffOrStop(attempt)) return;
          continue;
        }

        if (result.kind === "stop") return;
        if (result.kind === "recycled") {
          attempt = 0; // hard-cycle deadline: fresh connection, no backoff.
          continue;
        }

        attempt = 0; // a round that actually opened a connection clears any prior connect-failure streak.
        if (result.err !== undefined) {
          options.onError?.(account.mailboxItemId, folderPath, result.err);
          if (await backoffOrStop(1)) return;
        }
        // A clean end with no error (the server closed the connection normally) reconnects immediately, same as a recycle.
      }
    }

    return {
      async start() {
        stopped = false;
        stopPromise = new Promise((resolve) => {
          stopResolve = resolve;
        });
        // A newly (re)activated account gets an immediate reconcile rather than waiting on its
        // first IDLE signal or the periodic sweep — same rationale as the noop factory
        // (mailLiveSyncRoot.ts's `createNoopMailLiveSyncLifecycleFactory`).
        await enqueueMailAccountSync(pool, account.mailboxItemId);

        const credential = await options.getCredential(account.mailboxItemId);
        const folders = await transport.resolveFolders(account.mailboxItemId, credential);
        folderLoops = folders.map((folder) => runFolderLoop(folder.path, credential));
      },
      async stop() {
        stopped = true;
        stopResolve("stop");
        await Promise.all(folderLoops);
        folderLoops = [];
      },
    };
  };
}
