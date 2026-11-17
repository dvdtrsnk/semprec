/**
 * Deliberately well under provider caps (Gmail allows 15): the user's own clients hold
 * connections to the same account too.
 */
const PROVIDER_IMAP_CONNECTION_LIMITS: Record<string, number> = {
  gmail: 5,
  icloud: 3,
  outlook: 3,
};
const DEFAULT_IMAP_CONNECTION_LIMIT = 2;

/** A usable user-configured limit wins over the provider table and default. */
export function imapConnectionLimitForProvider(provider: string | undefined, configuredLimit?: unknown): number {
  if (typeof configuredLimit === "number" && Number.isFinite(configuredLimit) && configuredLimit >= 1) {
    return Math.floor(configuredLimit);
  }
  return (
    (provider !== undefined ? PROVIDER_IMAP_CONNECTION_LIMITS[provider] : undefined) ?? DEFAULT_IMAP_CONNECTION_LIMIT
  );
}

/** Retry delay after a connection-limit rejection: contention a quick retry is unlikely to clear. */
const PROVIDER_CONNECTION_LIMIT_BACKOFF_SECONDS: Record<string, number> = {
  gmail: 10 * 60,
  icloud: 5 * 60,
  outlook: 5 * 60,
};
const DEFAULT_CONNECTION_LIMIT_BACKOFF_SECONDS = 5 * 60;

export function connectionLimitBackoffSecondsForProvider(provider: string | undefined): number {
  return (
    (provider !== undefined ? PROVIDER_CONNECTION_LIMIT_BACKOFF_SECONDS[provider] : undefined) ??
    DEFAULT_CONNECTION_LIMIT_BACKOFF_SECONDS
  );
}

/**
 * Queues per-account IMAP work beyond `limit` instead of opening another connection that the
 * provider would reject. Per-process only: across processes the sync jobKey already serializes
 * passes for one account.
 */
export interface ImapConnectionLimiter {
  run<T>(accountId: string, limit: number, task: () => Promise<T>): Promise<T>;
}

/** A stuck task must not pin later callers forever; a queued task rejects after this. */
const ACCOUNT_QUEUE_WAIT_TIMEOUT_MS = 3 * 60 * 1000;

interface Waiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

class AccountQueue {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  constructor(private limit: number) {}

  setLimit(limit: number): void {
    this.limit = limit;
    // A raised limit may free slots for existing waiters right away.
    this.wakeWaiters();
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) {
      this.active++;
    } else {
      // `wakeWaiters` already incremented `active` for this slot.
      await this.waitForSlot();
    }
    try {
      return await task();
    } finally {
      this.active--;
      this.wakeWaiters();
    }
  }

  /** Increments `active` synchronously on grant; deferring it to the waiter would over-admit past `limit`. */
  private wakeWaiters(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      this.active++;
      this.waiters.shift()!.resolve();
    }
  }

  private waitForSlot(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(
            new Error(
              `Timed out after ${ACCOUNT_QUEUE_WAIT_TIMEOUT_MS}ms waiting for an IMAP connection slot for this account`,
            ),
          );
        }, ACCOUNT_QUEUE_WAIT_TIMEOUT_MS),
      };
      this.waiters.push(waiter);
    });
  }
}

export function createImapConnectionLimiter(): ImapConnectionLimiter {
  const queues = new Map<string, AccountQueue>();
  return {
    run(accountId, limit, task) {
      let queue = queues.get(accountId);
      if (!queue) {
        queue = new AccountQueue(limit);
        queues.set(accountId, queue);
      } else {
        queue.setLimit(limit);
      }
      return queue.run(task);
    },
  };
}

/** Process-wide; a limiter per call would bound nothing. */
export const sharedImapConnectionLimiter: ImapConnectionLimiter = createImapConnectionLimiter();
