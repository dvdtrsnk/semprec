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
 * Work connections (`kind: "work"`) one process keeps open to one IMAP server host across all its accounts. No
 * provider documents a per-address limit, so iCloud, Purelymail and every other host share one value, chosen to keep
 * a burst of passes of many accounts from looking like one client opening dozens of sessions at once.
 */
export const HOST_IMAP_CONNECTION_LIMIT = 10;
/** Logins one process sends to one IMAP server host per minute, every kind of connection together. */
export const HOST_IMAP_LOGINS_PER_MINUTE = 20;
const LOGIN_INTERVAL_MS = 60_000 / HOST_IMAP_LOGINS_PER_MINUTE;

/** A stuck holder must not pin later callers forever; a queued slot or login wait rejects after this. */
const QUEUE_WAIT_TIMEOUT_MS = 3 * 60 * 1000;

/** One connection about to be opened. */
export interface ImapConnectionTarget {
  accountId: string;
  /** The account's budget, from `imapConnectionLimitForProvider`. */
  accountLimit: number;
  /** The server host the connection dials. */
  host: string;
  /**
   * `idle` is an IDLE connection, open for hours, and counts against its account only: counted against the host as
   * well, it would cap how many accounts of one provider can listen at all at `HOST_IMAP_CONNECTION_LIMIT`. `work` (a
   * sync session, a move, a Sent APPEND, the IDLE folder lookup) counts against the account and the host.
   */
  kind: "idle" | "work";
}

/** The slots of one open connection. */
export interface ImapConnectionLease {
  /** Frees the slots; idempotent. */
  release(): void;
  /**
   * The connection stays open but unused (a pooled sync session). A caller that has to wait for one of its slots calls
   * `reclaim` once, so an unused connection gives way to one that is needed; `markBusy` takes the offer back.
   */
  markIdle(reclaim: () => void): void;
  markBusy(): void;
}

/**
 * Bounds the IMAP connections of this process: per account (the provider's budget, which the user's own clients
 * share), per server host for work connections, and the logins per server host. A waiting caller queues instead of
 * opening a connection the provider would reject or count against the address. Per process only: across processes the
 * pass lease (`claimMailSyncPass`) keeps one sync pass per account, and every IMAP connection of the deployment is
 * opened by the one `alldots-api` process.
 */
export interface ImapConnectionLimiter {
  /** Waits for a slot of the account and, for `work`, of the host. Waits longer than 3 minutes reject. */
  acquire(target: ImapConnectionTarget, signal?: AbortSignal): Promise<ImapConnectionLease>;
  /** `acquire`, `task`, then release, also when `task` fails. */
  run<T>(target: ImapConnectionTarget, task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /**
   * Waits for one login to `host` under `HOST_IMAP_LOGINS_PER_MINUTE` (a burst of that many, then one per interval),
   * in arrival order. `openImapFlow` calls it before every login. Waits longer than 3 minutes reject.
   */
  admitLogin(host: string, signal?: AbortSignal): Promise<void>;
}

interface LeaseState {
  held: SlotQueue[];
  reclaim: (() => void) | undefined;
  released: boolean;
}

interface SlotWaiter {
  lease: LeaseState;
  grant: () => void;
}

class SlotQueue {
  active = 0;
  readonly waiters: SlotWaiter[] = [];
  readonly holders = new Set<LeaseState>();
  constructor(public limit: number) {}

  setLimit(limit: number): void {
    this.limit = limit;
    // A raised limit may free slots for existing waiters right away.
    this.grantWaiters();
  }

  /** Grants synchronously, in arrival order; deferring the count to the waiter would over-admit past `limit`. */
  grantWaiters(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      this.hold(waiter.lease);
      waiter.grant();
    }
  }

  take(lease: LeaseState, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.limit && this.waiters.length === 0) {
      this.hold(lease);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(abortReason(signal));
      };
      const waiter: SlotWaiter = {
        lease,
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      this.reclaimOne();
    });
  }

  /** Asks one unused open connection holding a slot here to close, so the waiter just queued gets its slot. */
  reclaimOne(): void {
    for (const holder of this.holders) {
      const reclaim = holder.reclaim;
      if (reclaim === undefined) continue;
      holder.reclaim = undefined;
      reclaim();
      return;
    }
  }

  private hold(lease: LeaseState): void {
    this.active++;
    this.holders.add(lease);
    lease.held.push(this);
  }
}

class LoginBucket {
  private tokens = HOST_IMAP_LOGINS_PER_MINUTE;
  private refilledAt = Date.now();
  private readonly waiters: Array<{ grant: () => void }> = [];
  private timer: NodeJS.Timeout | undefined;

  admit(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    this.refill();
    if (this.waiters.length === 0 && this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        if (this.waiters.length === 0 && this.timer !== undefined) {
          clearTimeout(this.timer);
          this.timer = undefined;
        }
        reject(abortReason(signal));
      };
      const waiter = {
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      this.schedule();
    });
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(HOST_IMAP_LOGINS_PER_MINUTE, this.tokens + (now - this.refilledAt) / LOGIN_INTERVAL_MS);
    this.refilledAt = now;
  }

  private schedule(): void {
    if (this.timer !== undefined || this.waiters.length === 0) return;
    this.refill();
    const waitMs = Math.max(1, Math.ceil((1 - this.tokens) * LOGIN_INTERVAL_MS));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refill();
      while (this.waiters.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        this.waiters.shift()!.grant();
      }
      this.schedule();
    }, waitMs);
  }
}

/** What a wait ended by `signal` rejects with; the reasons this module and its callers abort with are errors. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("The wait for an IMAP connection was abandoned");
}

/** The caller's signal combined with the queue wait deadline; `dispose` drops both once the wait is over. */
function queueWaitSignal(what: string, signal: AbortSignal | undefined): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Timed out after ${QUEUE_WAIT_TIMEOUT_MS}ms waiting for ${what}`)),
    QUEUE_WAIT_TIMEOUT_MS,
  );
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function releaseLease(lease: LeaseState): void {
  if (lease.released) return;
  lease.released = true;
  lease.reclaim = undefined;
  const held = lease.held;
  lease.held = [];
  for (const queue of held) {
    queue.active--;
    queue.holders.delete(lease);
  }
  for (const queue of held) queue.grantWaiters();
}

function leaseHandle(lease: LeaseState): ImapConnectionLease {
  return {
    release: () => releaseLease(lease),
    markIdle(reclaim) {
      if (lease.released) return;
      if (lease.held.some((queue) => queue.waiters.length > 0)) {
        reclaim();
        return;
      }
      lease.reclaim = reclaim;
    },
    markBusy() {
      lease.reclaim = undefined;
    },
  };
}

export function createImapConnectionLimiter(): ImapConnectionLimiter {
  const accounts = new Map<string, SlotQueue>();
  const hosts = new Map<string, SlotQueue>();
  const logins = new Map<string, LoginBucket>();

  const accountQueue = (accountId: string, limit: number): SlotQueue => {
    const existing = accounts.get(accountId);
    if (existing) {
      existing.setLimit(limit);
      return existing;
    }
    const created = new SlotQueue(limit);
    accounts.set(accountId, created);
    return created;
  };
  const hostQueue = (host: string): SlotQueue => {
    let queue = hosts.get(host);
    if (!queue) {
      queue = new SlotQueue(HOST_IMAP_CONNECTION_LIMIT);
      hosts.set(host, queue);
    }
    return queue;
  };

  const acquire: ImapConnectionLimiter["acquire"] = async (target, signal) => {
    const lease: LeaseState = { held: [], reclaim: undefined, released: false };
    const wait = queueWaitSignal("an IMAP connection slot", signal);
    try {
      // Always the account first, then the host: a lease waiting for a host slot holds its account slot, and no lease
      // ever waits for an account slot while holding a host slot, so the two queues cannot deadlock.
      await accountQueue(target.accountId, target.accountLimit).take(lease, wait.signal);
      if (target.kind === "work") await hostQueue(target.host).take(lease, wait.signal);
    } catch (error) {
      releaseLease(lease);
      throw error;
    } finally {
      wait.dispose();
    }
    return leaseHandle(lease);
  };

  return {
    acquire,
    async run(target, task, signal) {
      const lease = await acquire(target, signal);
      try {
        return await task();
      } finally {
        lease.release();
      }
    },
    async admitLogin(host, signal) {
      let bucket = logins.get(host);
      if (!bucket) {
        bucket = new LoginBucket();
        logins.set(host, bucket);
      }
      const wait = queueWaitSignal("an IMAP login slot of the server", signal);
      try {
        await bucket.admit(wait.signal);
      } finally {
        wait.dispose();
      }
    },
  };
}

/** Process-wide; a limiter per call would bound nothing. */
export const sharedImapConnectionLimiter: ImapConnectionLimiter = createImapConnectionLimiter();
