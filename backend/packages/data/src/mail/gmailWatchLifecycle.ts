import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { enqueueMailAccountSync } from "./mailSyncJob.js";
import { recordGmailWatchRegistration, routeGmailAddress, type GmailRouteTarget } from "./mailAccountSyncStateStore.js";
import { normalizeEmailAddress } from "./personEmailIndexStore.js";
import type { MailAccountLifecycle, MailLiveSyncAccount, MailLiveSyncLifecycleFactory } from "./mailLiveSyncRoot.js";

export interface GmailWatchRegistration {
  historyId: string;
  expiresAt: Date;
}

export interface GmailPubSubNotification {
  ackId: string;
  emailAddress: string;
  historyId: string;
}

/**
 * Gmail watch + Pub/Sub pull transport. A notification never mutates mail directly; it only
 * enqueues the idempotent `enqueueMailAccountSync` reconcile.
 */
export interface GmailWatchTransport {
  /** Idempotent: a repeat `users.watch` call resets the up-to-seven-day expiry, not a second watch. */
  registerWatch(mailboxItemId: string, credential: string): Promise<GmailWatchRegistration>;
  /**
   * One pull from the deployment-wide subscription carrying every watched account's notifications;
   * an empty array is an ordinary empty poll.
   */
  pull(): Promise<GmailPubSubNotification[]>;
  /** Only ids durably handed off to every matching mailbox are acknowledged. */
  acknowledge(ackIds: string[]): Promise<void>;
}

/** Daily, well inside the seven-day watch validity, so a missed renewal never races the expiry. */
const DEFAULT_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PULL_EMPTY_BACKOFF_MS = 5_000;
/** Capped exponential backoff for a failing pull. */
const DEFAULT_PULL_ERROR_BASE_DELAY_MS = 5_000;
const DEFAULT_PULL_ERROR_MAX_DELAY_MS = 5 * 60 * 1000;

export function pullErrorBackoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CreateGmailWatchLifecycleFactoryOptions {
  /** Fetched fresh on every `start()`, never cached across restarts. */
  getCredential: (mailboxItemId: string) => Promise<string>;
  /**
   * The authenticated Google account's address, which the dispatcher routes on. Never
   * `Mailboxes.addresses`: it is user-editable, so one tenant could claim another's pushes.
   */
  getAccountEmailAddress: (mailboxItemId: string) => Promise<string>;
  renewalIntervalMs?: number;
  onError?: (mailboxItemId: string, phase: "watch", err: unknown) => void;
}

/**
 * `start()` enqueues an immediate reconcile and runs a renewal loop that re-registers the watch
 * right away and then daily, persisting expiry and routing address. Pulling is done by the single
 * `createGmailPubSubDispatcher`, not here.
 */
export function createGmailWatchLifecycleFactory(
  pool: Pool,
  transport: GmailWatchTransport,
  options: CreateGmailWatchLifecycleFactoryOptions,
): MailLiveSyncLifecycleFactory {
  const renewalIntervalMs = options.renewalIntervalMs ?? DEFAULT_RENEWAL_INTERVAL_MS;

  return (account: MailLiveSyncAccount): MailAccountLifecycle => {
    let stopped = false;
    let stopResolve: (value: "stop") => void = () => {};
    let stopPromise = new Promise<"stop">((resolve) => {
      stopResolve = resolve;
    });
    let renewalLoop: Promise<void> = Promise.resolve();

    function waitForStop(): Promise<"stop"> {
      return stopPromise;
    }

    async function sleepOrStop(ms: number): Promise<boolean> {
      const outcome = await Promise.race([sleep(ms).then(() => "slept" as const), waitForStop()]);
      return outcome === "stop";
    }

    async function runRenewalLoop(credential: string, emailAddress: string): Promise<void> {
      while (!stopped) {
        try {
          const registration = await transport.registerWatch(account.mailboxItemId, credential);
          await recordGmailWatchRegistration(pool, account.mailboxItemId, { ...registration, emailAddress });
        } catch (err) {
          options.onError?.(account.mailboxItemId, "watch", err);
        }
        if (await sleepOrStop(renewalIntervalMs)) return;
      }
    }

    return {
      async start() {
        stopped = false;
        stopPromise = new Promise((resolve) => {
          stopResolve = resolve;
        });
        await enqueueMailAccountSync(pool, account.mailboxItemId);

        const [credential, accountEmailAddress] = await Promise.all([
          options.getCredential(account.mailboxItemId),
          options.getAccountEmailAddress(account.mailboxItemId),
        ]);
        renewalLoop = runRenewalLoop(credential, normalizeEmailAddress(accountEmailAddress));
      },
      async stop() {
        stopped = true;
        stopResolve("stop");
        await renewalLoop;
      },
    };
  };
}

export interface CreateGmailPubSubDispatcherOptions {
  pullEmptyBackoffMs?: number;
  pullErrorBaseDelayMs?: number;
  pullErrorMaxDelayMs?: number;
  /** `target` is `null` for failures not tied to one mailbox. */
  onError?: (
    target: GmailRouteTarget | null,
    phase: "pull" | "route" | "enqueue" | "acknowledge",
    err: unknown,
  ) => void;
}

export interface GmailPubSubDispatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The one process-wide puller of the shared subscription, run in system scope (see
 * docs/architecture/tenancy-and-security.md#cross-tenant-router-functions). Each notification is
 * routed to every watching `(tenant, mailbox)` and enqueued inside that tenant. It is acknowledged
 * only after every target was handed off, so failures are redelivered (jobKey dedup makes repeats
 * harmless); unwatched notifications are acknowledged too.
 */
export function createGmailPubSubDispatcher(
  pool: Pool,
  transport: GmailWatchTransport,
  options: CreateGmailPubSubDispatcherOptions = {},
): GmailPubSubDispatcher {
  const pullEmptyBackoffMs = options.pullEmptyBackoffMs ?? DEFAULT_PULL_EMPTY_BACKOFF_MS;
  const pullErrorBaseDelayMs = options.pullErrorBaseDelayMs ?? DEFAULT_PULL_ERROR_BASE_DELAY_MS;
  const pullErrorMaxDelayMs = options.pullErrorMaxDelayMs ?? DEFAULT_PULL_ERROR_MAX_DELAY_MS;

  let stopped = false;
  let stopResolve: (value: "stop") => void = () => {};
  let stopPromise = new Promise<"stop">((resolve) => {
    stopResolve = resolve;
  });
  let loop: Promise<void> = Promise.resolve();

  async function sleepOrStop(ms: number): Promise<boolean> {
    const outcome = await Promise.race([sleep(ms).then(() => "slept" as const), stopPromise]);
    return outcome === "stop";
  }

  /** True when the notification was handed off to every target it routes to (vacuously so for none). */
  async function dispatch(notification: GmailPubSubNotification): Promise<boolean> {
    let targets: GmailRouteTarget[];
    try {
      targets = await withTransaction(pool, (client) => routeGmailAddress(client, notification.emailAddress));
    } catch (err) {
      options.onError?.(null, "route", err);
      return false;
    }
    let handedOff = true;
    for (const target of targets) {
      let reported = false;
      try {
        await runInTenant(target.tenantId, async () => {
          try {
            await enqueueMailAccountSync(pool, target.mailboxItemId);
          } catch (err) {
            reported = true;
            options.onError?.(target, "enqueue", err);
            throw err;
          }
        });
      } catch (err) {
        // Report only failures not already reported inside the tenant scope; other targets still run.
        if (!reported) options.onError?.(target, "enqueue", err);
        handedOff = false;
      }
    }
    return handedOff;
  }

  async function runLoop(): Promise<void> {
    let attempt = 0;
    while (!stopped) {
      let notifications: GmailPubSubNotification[];
      try {
        notifications = await transport.pull();
      } catch (err) {
        options.onError?.(null, "pull", err);
        attempt++;
        if (await sleepOrStop(pullErrorBackoffDelayMs(attempt, pullErrorBaseDelayMs, pullErrorMaxDelayMs))) return;
        continue;
      }
      attempt = 0;

      if (notifications.length === 0) {
        if (await sleepOrStop(pullEmptyBackoffMs)) return;
        continue;
      }

      const ackIds: string[] = [];
      for (const notification of notifications) {
        if (stopped) return;
        if (await dispatch(notification)) ackIds.push(notification.ackId);
      }
      if (ackIds.length > 0) {
        await transport.acknowledge(ackIds).catch((err) => options.onError?.(null, "acknowledge", err));
      }
    }
  }

  return {
    async start() {
      stopped = false;
      stopPromise = new Promise((resolve) => {
        stopResolve = resolve;
      });
      loop = runAsSystem("mail:gmailPubSubDispatcher", runLoop);
    },
    async stop() {
      stopped = true;
      stopResolve("stop");
      await loop;
    },
  };
}
