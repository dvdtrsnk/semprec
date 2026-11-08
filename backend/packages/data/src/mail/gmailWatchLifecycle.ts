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
 * What a real Gmail Pub/Sub transport (a `users.watch()`-backed registrar plus a Cloud Pub/Sub
 * pull-subscription client) must provide (issue #197). Deliberately narrower than
 * `GmailMailClient` (gmailReconcile.ts): this module never calls `history.list` or ingests a
 * message itself — the only thing a notification is allowed to do is ask the existing
 * idempotent `enqueueMailAccountSync` job path to reconcile, the same "no direct Email mutation
 * in callback" discipline issue #196 established for IMAP IDLE.
 */
export interface GmailWatchTransport {
  /**
   * Calls Gmail's `users.watch` for this account against the already-provisioned topic (GCP
   * topic/subscription creation is explicitly out of scope for this issue) and returns its
   * `historyId`/`expiration`. Safe to call repeatedly — Google's own semantics: a fresh call
   * simply resets the (up to) seven-day expiry clock, it does not create a second watch.
   */
  registerWatch(mailboxItemId: string, credential: string): Promise<GmailWatchRegistration>;
  /**
   * One pull request against the deployment's shared Cloud Pub/Sub subscription — an empty array is
   * an ordinary empty poll, not an error. The subscription belongs to the deployment, not to a
   * mailbox: it carries every watched account's notifications, with `emailAddress` in each payload
   * naming the account, and the one `createGmailPubSubDispatcher` routes each to its mailboxes.
   */
  pull(): Promise<GmailPubSubNotification[]>;
  /** Acknowledges exactly the notifications the dispatcher has durably handed off to `enqueueMailAccountSync` for every matching mailbox — never one still in flight or partly handed off. */
  acknowledge(ackIds: string[]): Promise<void>;
}

/** Renewed daily (issue #197's Task), well inside Google's up-to-seven-day watch validity — not tied to the actual remaining validity so a missed renewal never has to race the expiry itself. */
const DEFAULT_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How long an empty pull backs off before trying again — bounded so this loop never hot-spins against an idle subscription. */
const DEFAULT_PULL_EMPTY_BACKOFF_MS = 5_000;
/** Bounded reconnect for a failing pull/watch call: capped exponential backoff, not a tight retry loop and not a permanent give-up — mirrors imapIdleLifecycle.ts's `reconnectBackoffDelayMs`. */
const DEFAULT_PULL_ERROR_BASE_DELAY_MS = 5_000;
const DEFAULT_PULL_ERROR_MAX_DELAY_MS = 5 * 60 * 1000;

export function pullErrorBackoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CreateGmailWatchLifecycleFactoryOptions {
  /** Decrypted per-account Gmail OAuth credential, fetched fresh on every `start()` — never cached across a stop/restart, same discipline as imapIdleLifecycle.ts's `getCredential`. */
  getCredential: (mailboxItemId: string) => Promise<string>;
  /**
   * The address of the Google account the credential authenticates — the address Gmail puts in
   * each notification for this watch, and what the dispatcher routes on. Never `Mailboxes.addresses`:
   * that property is user-editable, so routing on it would let one tenant claim another's pushes.
   */
  getAccountEmailAddress: (mailboxItemId: string) => Promise<string>;
  renewalIntervalMs?: number;
  onError?: (mailboxItemId: string, phase: "watch", err: unknown) => void;
}

/**
 * Builds the Gmail Pub/Sub `MailAccountLifecycle` for one account (issue #197) — the Gmail-mode
 * analogue of `createBoundedImapIdleLifecycleFactory` (issue #196). `start()` enqueues an immediate
 * reconcile and hosts one long-lived renewal loop that registers/renews the `users.watch`
 * subscription daily and persists its expiry, the watched account's normalized address
 * (`gmail_watch_email_address`, the routing key) and — only when the account had no cursor yet —
 * its history cursor via `recordGmailWatchRegistration`. Renewal survives a restart by
 * construction: a fresh `start()` always re-registers immediately rather than trusting an
 * in-memory timer that a restart would lose.
 *
 * Pulling the shared subscription is not done here: `createGmailPubSubDispatcher` runs one puller
 * for the whole deployment and routes each notification to every mailbox watching its address.
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
    // A single promise shared by every in-flight wait (rather than one per call) so `stop()`
    // only ever needs to resolve one thing, regardless of how many loops happen to be waiting.
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
        // A newly (re)activated account gets an immediate reconcile rather than waiting on its
        // first notification or the periodic sweep — same rationale as the noop factory
        // (mailLiveSyncRoot.ts) and the bounded IMAP IDLE lifecycle (imapIdleLifecycle.ts).
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
  /** `target` is `null` for a failure that belongs to no one mailbox (the pull, the routing lookup, the acknowledge). */
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
 * The one process-wide puller of the deployment's shared Gmail Pub/Sub subscription
 * (docs/adr/2026-10-07-cross-tenant-router-functions.md). `start()` launches the loop in system
 * scope (`runAsSystem`, so it must be called with no scope or from a system scope) and returns;
 * `stop()` ends the wait the loop is in and awaits it.
 *
 * For each notification the address goes through `routeGmailAddress` (its own transaction) to every
 * `(tenant, mailbox)` watching it, and each target's `enqueueMailAccountSync` runs inside that
 * target's tenant, so the job envelope carries it. The enqueue is the durable hand-off: a
 * notification is acknowledged only once every target was handed off, so a failed routing lookup or
 * enqueue leaves it for Pub/Sub to redeliver (the job's own `jobKey` dedup makes the repeat for
 * the targets that already succeeded harmless). A notification no mailbox watches is acknowledged
 * too — redelivering it forever helps no one. All ack ids of one pull go out in one `acknowledge`
 * call. A failing pull backs off with a capped exponential delay that resets after a success.
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
        // An enqueue failure was already reported inside the target's tenant scope; anything else
        // (the tenant scope itself failing to open) was not. The other targets still run.
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
