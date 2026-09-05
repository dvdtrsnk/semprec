import type { Pool } from "pg";
import { enqueueMailAccountSync } from "./mailSyncJob.js";
import { recordGmailWatchExpiry } from "./mailAccountSyncStateStore.js";
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
   * One pull request against the account's Cloud Pub/Sub subscription — an empty array is an
   * ordinary empty poll, not an error. A subscription may be shared by more than one watched
   * account (Google: typically one topic per GCP project, with `emailAddress` in each
   * notification's payload disambiguating which account it belongs to), so a returned
   * notification is not guaranteed to belong to this account; the caller filters, and never
   * acknowledges a notification it has not durably handed off.
   */
  pull(mailboxItemId: string): Promise<GmailPubSubNotification[]>;
  /** Acknowledges exactly the notifications this account's caller has durably handed off to `enqueueMailAccountSync` — never called for one still in flight or belonging to another account. */
  acknowledge(mailboxItemId: string, ackIds: string[]): Promise<void>;
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
  /** This account's own Gmail address — the account-validation check a shared subscription's notification is matched against before it is ever allowed to trigger a reconcile or be acknowledged. */
  getAccountEmailAddress: (mailboxItemId: string) => Promise<string>;
  renewalIntervalMs?: number;
  pullEmptyBackoffMs?: number;
  pullErrorBaseDelayMs?: number;
  pullErrorMaxDelayMs?: number;
  onError?: (mailboxItemId: string, phase: "watch" | "pull", err: unknown) => void;
}

/**
 * Builds the Gmail Pub/Sub `MailAccountLifecycle` for one account (issue #197) — the Gmail-mode
 * analogue of `createBoundedImapIdleLifecycleFactory` (issue #196). `start()` hosts two
 * independent long-lived loops:
 *
 * - a renewal loop that registers/renews the `users.watch` subscription daily and persists its
 *   expiry via `recordGmailWatchExpiry` (`gmail_watch_expires_at` only — never
 *   `gmail_history_id`, which stays the reconcile pass's alone). Renewal survives a restart by
 *   construction, not by any explicit "is it due yet" check: a fresh `start()` always
 *   re-registers immediately rather than trusting an in-memory timer that a restart would lose.
 * - a pull loop that turns each notification into a call to the existing idempotent
 *   `enqueueMailAccountSync` job — never a direct `history.list` call or message mutation of its
 *   own (that happens inside `reconcileGmailAccount`, driven by the job this only enqueues), and
 *   never acknowledges a notification until that call has resolved: the job row's insert is the
 *   durable handoff, so a crash between the two leaves the notification unacked and safely
 *   redelivered rather than lost. Because every notification — first delivery or a Pub/Sub
 *   redelivery of the same one — only ever re-enqueues through `enqueueMailAccountSync`'s own
 *   `jobKey` dedup, and the reconcile pass itself always resumes from whatever `gmailHistoryId`
 *   is already persisted (never from a value carried on the notification), a duplicate or
 *   out-of-order notification can trigger an extra no-op reconcile but can never regress or
 *   duplicate the account's synced state.
 */
export function createGmailWatchLifecycleFactory(
  pool: Pool,
  transport: GmailWatchTransport,
  options: CreateGmailWatchLifecycleFactoryOptions,
): MailLiveSyncLifecycleFactory {
  const renewalIntervalMs = options.renewalIntervalMs ?? DEFAULT_RENEWAL_INTERVAL_MS;
  const pullEmptyBackoffMs = options.pullEmptyBackoffMs ?? DEFAULT_PULL_EMPTY_BACKOFF_MS;
  const pullErrorBaseDelayMs = options.pullErrorBaseDelayMs ?? DEFAULT_PULL_ERROR_BASE_DELAY_MS;
  const pullErrorMaxDelayMs = options.pullErrorMaxDelayMs ?? DEFAULT_PULL_ERROR_MAX_DELAY_MS;

  return (account: MailLiveSyncAccount): MailAccountLifecycle => {
    let stopped = false;
    let stopResolve: (value: "stop") => void = () => {};
    // A single promise shared by every in-flight wait (rather than one per call) so `stop()`
    // only ever needs to resolve one thing, regardless of how many loops happen to be waiting.
    let stopPromise = new Promise<"stop">((resolve) => {
      stopResolve = resolve;
    });
    let renewalLoop: Promise<void> = Promise.resolve();
    let pullLoop: Promise<void> = Promise.resolve();

    function waitForStop(): Promise<"stop"> {
      return stopPromise;
    }

    async function sleepOrStop(ms: number): Promise<boolean> {
      const outcome = await Promise.race([sleep(ms).then(() => "slept" as const), waitForStop()]);
      return outcome === "stop";
    }

    async function runRenewalLoop(credential: string): Promise<void> {
      while (!stopped) {
        try {
          const registration = await transport.registerWatch(account.mailboxItemId, credential);
          await recordGmailWatchExpiry(pool, account.mailboxItemId, registration.expiresAt);
        } catch (err) {
          options.onError?.(account.mailboxItemId, "watch", err);
        }
        if (await sleepOrStop(renewalIntervalMs)) return;
      }
    }

    async function runPullLoop(expectedEmailAddress: string): Promise<void> {
      let attempt = 0;
      while (!stopped) {
        let notifications: GmailPubSubNotification[];
        try {
          notifications = await transport.pull(account.mailboxItemId);
        } catch (err) {
          options.onError?.(account.mailboxItemId, "pull", err);
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
          // A subscription shared by more than one watched account (transport.pull's own doc
          // comment) must never let one account's puller reconcile — or acknowledge — a
          // notification meant for another; left unacknowledged, Pub/Sub redelivers it (to
          // whichever puller's `expectedEmailAddress` actually matches) instead of losing it.
          if (notification.emailAddress !== expectedEmailAddress) continue;
          try {
            await enqueueMailAccountSync(pool, account.mailboxItemId);
            ackIds.push(notification.ackId);
          } catch (err) {
            options.onError?.(account.mailboxItemId, "pull", err);
          }
        }
        if (ackIds.length > 0) {
          await transport.acknowledge(account.mailboxItemId, ackIds).catch((err) => options.onError?.(account.mailboxItemId, "pull", err));
        }
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

        const [credential, expectedEmailAddress] = await Promise.all([
          options.getCredential(account.mailboxItemId),
          options.getAccountEmailAddress(account.mailboxItemId),
        ]);
        renewalLoop = runRenewalLoop(credential);
        pullLoop = runPullLoop(expectedEmailAddress);
      },
      async stop() {
        stopped = true;
        stopResolve("stop");
        await Promise.all([renewalLoop, pullLoop]);
      },
    };
  };
}
