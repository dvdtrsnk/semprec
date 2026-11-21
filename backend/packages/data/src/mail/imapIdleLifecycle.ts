import type { Pool } from "pg";
import { enqueueMailAccountSync } from "./mailSyncJob.js";
import {
  sharedImapConnectionLimiter,
  type ImapConnectionLimiter,
  type ImapConnectionTarget,
} from "./imapConnectionLimiter.js";
import { decorrelatedJitterDelayMs, type RandomSource } from "./mailBackoff.js";
import type { MailAccountLifecycle, MailLiveSyncAccount, MailLiveSyncLifecycleFactory } from "./mailLiveSyncRoot.js";
import { MailReauthorizationRequiredError } from "./providerTypes.js";

export interface ImapIdleFolderTarget {
  path: string;
}

/** One connection dedicated to a single folder, already IDLE-ing; signals arrive via `onSignal`. */
export interface ImapIdleConnection {
  /** Resolves with the error (or `undefined`) when the connection ends; never rejects, as it is raced. */
  waitForEnd(): Promise<unknown>;
  /** Idempotent. */
  close(): Promise<void>;
}

/** IDLE never touches messages; a signal only enqueues the idempotent sync job (wired in this file). */
export interface ImapIdleTransport {
  /**
   * Inbox plus an All-Mail folder when present. Resolved once per `start()` (retried until it
   * succeeds or stops) and reused across recycles; folder changes are picked up on restart.
   * `signal` aborts once the lifecycle stops, ending a wait for a login admission.
   */
  resolveFolders(mailboxItemId: string, credential: string, signal: AbortSignal): Promise<ImapIdleFolderTarget[]>;
  /** Calls `onSignal` on EXISTS/EXPUNGE/flags; rejects if the connection cannot be established. */
  connect(
    mailboxItemId: string,
    credential: string,
    folderPath: string,
    onSignal: () => void,
    signal: AbortSignal,
  ): Promise<ImapIdleConnection>;
}

/** Recycle healthy connections anyway, against slow drift (stuck sessions, leaked listeners) errors never surface. */
const DEFAULT_HARD_CYCLE_DEADLINE_MS = 6 * 60 * 60 * 1000;

/** Jittered capped backoff (`decorrelatedJitterDelayMs`); retries for as long as the account stays active. */
const DEFAULT_RECONNECT_BASE_DELAY_MS = 5_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5 * 60 * 1000;

export interface CreateBoundedImapIdleLifecycleFactoryOptions {
  /**
   * Fetched fresh on every `start()`, never cached across restarts. `MailReauthorizationRequiredError` here (no
   * credential stored) or from the transport (the server refused the login) ends the discovery or the folder's loop
   * after one report and without a retry: only a restart after the credential was replaced starts it again.
   */
  getCredential: (mailboxItemId: string) => Promise<string>;
  /**
   * The account's connection budget and server host. Shared with reconcile passes: IDLE and sync connections count
   * against one provider budget.
   */
  getConnectionTarget: (
    mailboxItemId: string,
  ) =>
    Promise<Pick<ImapConnectionTarget, "accountLimit" | "host">> | Pick<ImapConnectionTarget, "accountLimit" | "host">;
  connectionLimiter?: ImapConnectionLimiter;
  hardCycleDeadlineMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /** Jitters the reconnect backoff. */
  random?: RandomSource;
  onError?: (mailboxItemId: string, folderPath: string, err: unknown) => void;
}

/**
 * `start()` runs one self-healing loop per resolved folder. `stop()` waits for all of them, so no
 * `enqueueMailAccountSync` call happens after it resolves.
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
  const random = options.random ?? Math.random;

  return (account: MailLiveSyncAccount): MailAccountLifecycle => {
    let stopped = false;
    // Aborted by `stop()`: ends a wait for a connection slot or a login admission.
    let stopController = new AbortController();
    let stopResolve: (value: "stop") => void = () => {};
    let stopPromise = new Promise<"stop">((resolve) => {
      stopResolve = resolve;
    });
    let folderLoops: Promise<void>[] = [];
    let discovery: Promise<void> | undefined;
    const signals = new Set<Promise<void>>();
    let ownedFailures: unknown[] = [];

    function report(folderPath: string, error: unknown): void {
      const failures: unknown[] = [error];
      try {
        options.onError?.(account.mailboxItemId, folderPath, error);
      } catch (diagnosticFailure) {
        failures.push(diagnosticFailure);
        ownedFailures.push(diagnosticFailure);
      }
    }

    async function delayOrStop(ms: number): Promise<boolean> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), ms);
          }),
          waitForStop().then(() => true),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    /** The abort `stop()` sends to a wait it ends; not a failure. */
    function isStopAbort(error: unknown): boolean {
      return stopController.signal.aborted && error === stopController.signal.reason;
    }

    function waitForStop(): Promise<"stop"> {
      return stopPromise;
    }

    /** Waits the next delay of a streak whose previous delay was `previousMs` (`null` at its start). */
    async function backoffOrStop(previousMs: number | null): Promise<{ stopped: boolean; delayMs: number }> {
      const delayMs = decorrelatedJitterDelayMs(previousMs, reconnectBaseDelayMs, reconnectMaxDelayMs, random);
      return { stopped: await delayOrStop(delayMs), delayMs };
    }

    async function connectionTarget(kind: ImapConnectionTarget["kind"]): Promise<ImapConnectionTarget> {
      const target = await options.getConnectionTarget(account.mailboxItemId);
      return { accountId: account.mailboxItemId, accountLimit: target.accountLimit, host: target.host, kind };
    }

    /** Runs wholly inside a limiter slot, so an open IDLE session counts against the connection budget. */
    async function runOneIdleRound(
      folderPath: string,
      credential: string,
    ): Promise<{ kind: "stop" } | { kind: "recycled" } | { kind: "ended"; err: unknown }> {
      const connection = await transport.connect(
        account.mailboxItemId,
        credential,
        folderPath,
        () => {
          // A signal's only effect: the deduplicated reconcile job, never a parallel ingestion path.
          if (stopped) return;
          const task = enqueueMailAccountSync(pool, account.mailboxItemId)
            .catch((err: unknown) => {
              if (stopped) ownedFailures.push(err);
              report(folderPath, err);
            })
            .finally(() => signals.delete(task));
          signals.add(task);
        },
        stopController.signal,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let outcome: { kind: "stop" } | { kind: "recycled" } | { kind: "ended"; err: unknown } | undefined;
      let primary: { value: unknown } | undefined;
      let ended: { value: unknown } | undefined;
      let endFailure: { value: unknown } | undefined;
      try {
        outcome = await Promise.race([
          connection.waitForEnd().then(
            (err): { kind: "ended"; err: unknown } => {
              ended = { value: err };
              return { kind: "ended", err };
            },
            (error: unknown): never => {
              endFailure = { value: error };
              throw error;
            },
          ),
          new Promise<{ kind: "recycled" }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: "recycled" }), hardCycleDeadlineMs);
          }),
          waitForStop().then((): { kind: "stop" } => ({ kind: "stop" })),
        ]);
      } catch (error) {
        primary = { value: error };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      try {
        await connection.close();
      } catch (error) {
        const original = primary ?? endFailure ?? (ended?.value !== undefined ? ended : undefined);
        const failure = original
          ? new AggregateError([original.value, error], "IMAP IDLE round and cleanup failed", {
              cause: original.value,
            })
          : error;
        ownedFailures.push(failure);
        throw failure;
      }
      if (primary) throw primary.value;
      if (!outcome) throw new Error("IMAP IDLE round ended without an outcome");
      if (endFailure) {
        if (stopped) ownedFailures.push(endFailure.value);
        report(folderPath, endFailure.value);
      }
      if (outcome.kind !== "ended" && ended?.value !== undefined) {
        if (stopped) ownedFailures.push(ended.value);
        report(folderPath, ended.value);
      }
      return outcome;
    }

    async function runFolderLoop(folderPath: string, credential: string): Promise<void> {
      // The previous delay of the current connect-failure streak; `null` outside one.
      let previousDelayMs: number | null = null;
      while (!stopped) {
        let result: { kind: "stop" } | { kind: "recycled" } | { kind: "ended"; err: unknown };
        try {
          const target = await connectionTarget("idle");
          if (stopped) return;
          result = await limiter.run(
            target,
            () => (stopped ? Promise.resolve({ kind: "stop" as const }) : runOneIdleRound(folderPath, credential)),
            stopController.signal,
          );
        } catch (err) {
          if (isStopAbort(err)) return;
          if (stopped) ownedFailures.push(err);
          report(folderPath, err);
          if (stopped) return;
          if (ownedFailures.length > 0) return;
          // The server refused the login: every retry would be refused too.
          if (err instanceof MailReauthorizationRequiredError) return;
          const backoff = await backoffOrStop(previousDelayMs);
          if (backoff.stopped) return;
          previousDelayMs = backoff.delayMs;
          continue;
        }

        if (result.kind === "stop") return;
        if (result.kind === "recycled") {
          previousDelayMs = null; // hard-cycle deadline: fresh connection, no backoff.
          continue;
        }

        previousDelayMs = null; // a round that actually opened a connection clears any prior connect-failure streak.
        if (result.err !== undefined) {
          if (stopped) ownedFailures.push(result.err);
          report(folderPath, result.err);
          if ((await backoffOrStop(null)).stopped) return;
        }
        // A clean server close reconnects immediately.
      }
    }

    return {
      async start() {
        if (discovery !== undefined) return;
        stopped = false;
        stopController = new AbortController();
        stopPromise = new Promise((resolve) => {
          stopResolve = resolve;
        });
        discovery = (async () => {
          let previousDelayMs: number | null = null;
          // One pass per start: a retry of the discovery below must not queue another login each time.
          let enqueued = false;
          while (!stopped) {
            try {
              if (!enqueued) {
                await enqueueMailAccountSync(pool, account.mailboxItemId);
                enqueued = true;
              }
              if (stopped) return;
              const credential = await options.getCredential(account.mailboxItemId);
              if (stopped) return;
              const target = await connectionTarget("work");
              if (stopped) return;
              const folders = await limiter.run(
                target,
                () => transport.resolveFolders(account.mailboxItemId, credential, stopController.signal),
                stopController.signal,
              );
              if (stopped) return;
              folderLoops = folders.map((folder) =>
                runFolderLoop(folder.path, credential).catch((error: unknown) => {
                  ownedFailures.push(error);
                }),
              );
              return;
            } catch (err) {
              if (isStopAbort(err)) return;
              if (stopped) ownedFailures.push(err);
              report("", err);
              if (stopped) return;
              if (ownedFailures.length > 0) return;
              if (err instanceof MailReauthorizationRequiredError) return;
              const backoff = await backoffOrStop(previousDelayMs);
              if (backoff.stopped) return;
              previousDelayMs = backoff.delayMs;
            }
          }
        })().catch((error: unknown) => {
          ownedFailures.push(error);
        });
      },
      async stop() {
        stopped = true;
        stopController.abort(new Error("The IMAP IDLE lifecycle stopped"));
        stopResolve("stop");
        const settled = await Promise.allSettled([...(discovery === undefined ? [] : [discovery]), ...folderLoops]);
        const signalResults = await Promise.allSettled(signals);
        for (const result of [...settled, ...signalResults]) {
          if (result.status === "rejected") ownedFailures.push(result.reason);
        }
        folderLoops = [];
        discovery = undefined;
        const failed = ownedFailures.length > 0;
        ownedFailures = [];
        if (failed) throw new Error("IMAP IDLE lifecycle failed unexpectedly");
      },
    };
  };
}
