import type { Pool } from "pg";
import { enqueueMailAccountSync } from "./mailSyncJob.js";
import { sharedImapConnectionLimiter, type ImapConnectionLimiter } from "./imapConnectionLimiter.js";
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
   */
  resolveFolders(mailboxItemId: string, credential: string): Promise<ImapIdleFolderTarget[]>;
  /** Calls `onSignal` on EXISTS/EXPUNGE/flags; rejects if the connection cannot be established. */
  connect(
    mailboxItemId: string,
    credential: string,
    folderPath: string,
    onSignal: () => void,
  ): Promise<ImapIdleConnection>;
}

/** Recycle healthy connections anyway, against slow drift (stuck sessions, leaked listeners) errors never surface. */
const DEFAULT_HARD_CYCLE_DEADLINE_MS = 6 * 60 * 60 * 1000;

/** Capped exponential backoff; retries for as long as the account stays active. */
const DEFAULT_RECONNECT_BASE_DELAY_MS = 5_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5 * 60 * 1000;

export function reconnectBackoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
}

export interface CreateBoundedImapIdleLifecycleFactoryOptions {
  /**
   * Fetched fresh on every `start()`, never cached across restarts. `MailReauthorizationRequiredError` (no credential
   * stored) ends the discovery without a retry: only a restart after the credential was replaced starts it again.
   */
  getCredential: (mailboxItemId: string) => Promise<string>;
  /** Shared with reconcile passes: IDLE and reconcile connections count against one provider budget. */
  getConnectionLimit: (mailboxItemId: string) => Promise<number> | number;
  connectionLimiter?: ImapConnectionLimiter;
  hardCycleDeadlineMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
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

  return (account: MailLiveSyncAccount): MailAccountLifecycle => {
    let stopped = false;
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

    function waitForStop(): Promise<"stop"> {
      return stopPromise;
    }

    async function backoffOrStop(attempt: number): Promise<boolean> {
      return delayOrStop(reconnectBackoffDelayMs(attempt, reconnectBaseDelayMs, reconnectMaxDelayMs));
    }

    /** Runs wholly inside a limiter slot, so an open IDLE session counts against the connection budget. */
    async function runOneIdleRound(
      folderPath: string,
      credential: string,
    ): Promise<{ kind: "stop" } | { kind: "recycled" } | { kind: "ended"; err: unknown }> {
      const connection = await transport.connect(account.mailboxItemId, credential, folderPath, () => {
        // A signal's only effect: the deduplicated reconcile job, never a parallel ingestion path.
        if (stopped) return;
        const task = enqueueMailAccountSync(pool, account.mailboxItemId)
          .catch((err: unknown) => {
            if (stopped) ownedFailures.push(err);
            report(folderPath, err);
          })
          .finally(() => signals.delete(task));
        signals.add(task);
      });
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
      let attempt = 0;
      while (!stopped) {
        let result: { kind: "stop" } | { kind: "recycled" } | { kind: "ended"; err: unknown };
        try {
          const limit = await options.getConnectionLimit(account.mailboxItemId);
          if (stopped) return;
          result = await limiter.run(account.mailboxItemId, limit, () =>
            stopped ? Promise.resolve({ kind: "stop" as const }) : runOneIdleRound(folderPath, credential),
          );
        } catch (err) {
          if (stopped) ownedFailures.push(err);
          report(folderPath, err);
          if (stopped) return;
          if (ownedFailures.length > 0) return;
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
          if (stopped) ownedFailures.push(result.err);
          report(folderPath, result.err);
          if (await backoffOrStop(1)) return;
        }
        // A clean server close reconnects immediately.
      }
    }

    return {
      async start() {
        if (discovery !== undefined) return;
        stopped = false;
        stopPromise = new Promise((resolve) => {
          stopResolve = resolve;
        });
        discovery = (async () => {
          let attempt = 0;
          while (!stopped) {
            try {
              await enqueueMailAccountSync(pool, account.mailboxItemId);
              if (stopped) return;
              const credential = await options.getCredential(account.mailboxItemId);
              if (stopped) return;
              const folders = await transport.resolveFolders(account.mailboxItemId, credential);
              if (stopped) return;
              folderLoops = folders.map((folder) =>
                runFolderLoop(folder.path, credential).catch((error: unknown) => {
                  ownedFailures.push(error);
                }),
              );
              return;
            } catch (err) {
              if (stopped) ownedFailures.push(err);
              report("", err);
              if (stopped) return;
              if (ownedFailures.length > 0) return;
              if (err instanceof MailReauthorizationRequiredError) return;
              attempt++;
              if (await backoffOrStop(attempt)) return;
            }
          }
        })().catch((error: unknown) => {
          ownedFailures.push(error);
        });
      },
      async stop() {
        stopped = true;
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
