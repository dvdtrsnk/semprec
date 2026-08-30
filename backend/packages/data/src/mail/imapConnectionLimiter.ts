/**
 * Real per-provider IMAP simultaneous-connection ceilings this worker deliberately stays well
 * under (Gmail documents up to 15 per account; other providers are typically stricter) — this
 * worker is never an account's only IMAP client, a user's own Mail app/other device holds
 * connections too, so headroom is left on purpose rather than synced up to the documented max.
 */
const PROVIDER_IMAP_CONNECTION_LIMITS: Record<string, number> = {
  gmail: 5,
  icloud: 3,
  outlook: 3,
};
const DEFAULT_IMAP_CONNECTION_LIMIT = 2;

/** `configuredLimit` (Mailboxes.connectionLimit, owner: 'user') wins when it's a usable positive integer; otherwise falls back to the provider table, then a conservative default. */
export function imapConnectionLimitForProvider(provider: string | undefined, configuredLimit?: unknown): number {
  if (typeof configuredLimit === "number" && Number.isFinite(configuredLimit) && configuredLimit >= 1) {
    return Math.floor(configuredLimit);
  }
  return (provider !== undefined ? PROVIDER_IMAP_CONNECTION_LIMITS[provider] : undefined) ?? DEFAULT_IMAP_CONNECTION_LIMIT;
}

/**
 * How long to wait before this account's IMAP sync is attempted again after a
 * connection-limit rejection — longer than `mailAccountSyncStateStore.ts`'s generic 15-minute
 * `recordSyncError` backoff, since a provider capping simultaneous connections is signalling
 * contention a quick retry is unlikely to have cleared, not a one-off network blip.
 */
const PROVIDER_CONNECTION_LIMIT_BACKOFF_SECONDS: Record<string, number> = {
  gmail: 10 * 60,
  icloud: 5 * 60,
  outlook: 5 * 60,
};
const DEFAULT_CONNECTION_LIMIT_BACKOFF_SECONDS = 5 * 60;

export function connectionLimitBackoffSecondsForProvider(provider: string | undefined): number {
  return (provider !== undefined ? PROVIDER_CONNECTION_LIMIT_BACKOFF_SECONDS[provider] : undefined) ?? DEFAULT_CONNECTION_LIMIT_BACKOFF_SECONDS;
}

/**
 * Bounds concurrent IMAP connection use for one account to `limit` at a time — real IMAP
 * providers enforce a hard simultaneous-connection cap server-side (Gmail's rejection is the
 * acceptance criterion this exists for); queues rather than opens another connection once the
 * limit is reached. Per-process and in-memory, not distributed: the per-account `jobKey`
 * (mailSyncJob.ts's `enqueueMailAccountSync`) already stops two *sync* passes for the same
 * account from running concurrently across processes — this adds the same discipline for any
 * other same-process caller of this module (a future explicit mark-read action, a retry racing
 * an in-flight pass).
 */
export interface ImapConnectionLimiter {
  run<T>(accountId: string, limit: number, task: () => Promise<T>): Promise<T>;
}

/** A stalled IMAP task (a stuck socket that never errors or completes) must not pin every later caller for this account behind it forever — a queued task gives up and rejects instead. */
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
    // Raising the limit can free up slots immediately — without this, a waiter queued under
    // the old (lower) limit would otherwise sit until an unrelated in-flight task happens to
    // finish, even though capacity for it already exists.
    while (this.active < this.limit && this.waiters.length > 0) {
      this.waiters.shift()!.resolve();
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await this.waitForSlot();
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      if (this.active < this.limit) {
        this.waiters.shift()?.resolve();
      }
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
          reject(new Error(`Timed out after ${ACCOUNT_QUEUE_WAIT_TIMEOUT_MS}ms waiting for an IMAP connection slot for this account`));
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

/** Shared across every call in this process — a fresh limiter per call would defeat the point (see interface doc above). */
export const sharedImapConnectionLimiter: ImapConnectionLimiter = createImapConnectionLimiter();
