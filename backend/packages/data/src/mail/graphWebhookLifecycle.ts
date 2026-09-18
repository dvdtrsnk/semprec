import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { enqueueMailAccountSync } from "./mailSyncJob.js";
import {
  getMailAccountSyncState,
  recordGraphSubscriptionRegistration,
  recordGraphSubscriptionRenewal,
} from "./mailAccountSyncStateStore.js";
import type { MailAccountLifecycle, MailLiveSyncAccount, MailLiveSyncLifecycleFactory } from "./mailLiveSyncRoot.js";

export interface GraphSubscriptionRegistration {
  subscriptionId: string;
  expiresAt: Date;
}

/** Thrown by `renewSubscription` when Graph reports the subscription id no longer exists (a 404) — the one case the renewal loop treats as "register a fresh one" rather than a transient failure to retry. */
export class GraphSubscriptionNotFoundError extends Error {}

/**
 * What a real Microsoft Graph subscriptions transport must provide (issue #198). Deliberately
 * narrower than `GraphMailClient` (graphReconcile.ts): this module never calls `/messages/delta`
 * or ingests a message itself — a notification only ever asks the existing idempotent
 * `enqueueMailAccountSync` job path to reconcile (graphWebhookNotifications.ts), the same
 * "no direct Email mutation in callback" discipline issue #196/#197 established for IMAP IDLE
 * and Gmail Pub/Sub.
 */
export interface GraphSubscriptionTransport {
  /** Creates a brand-new subscription against `notificationUrl`/`clientState` and returns its id/expiry. */
  createSubscription(
    mailboxItemId: string,
    credential: string,
    params: { notificationUrl: string; clientState: string },
  ): Promise<GraphSubscriptionRegistration>;
  /** Extends an already-registered subscription's expiry in place — same id, same `clientState`. Throws `GraphSubscriptionNotFoundError` if Graph no longer has it (expired past recovery, or removed out of band). */
  renewSubscription(
    mailboxItemId: string,
    credential: string,
    subscriptionId: string,
  ): Promise<GraphSubscriptionRegistration>;
}

/**
 * Well inside Graph's own maximum subscription lifetime for the `/me/messages` resource this
 * module watches (4230 minutes, ~2.94 days) — renewing daily leaves multiple days of slack even
 * if one renewal attempt fails and only succeeds on a later retry, mirroring
 * `gmailWatchLifecycle.ts`'s "not tied to the actual remaining validity" reasoning for its own
 * 24h cadence.
 */
const DEFAULT_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CreateGraphWebhookLifecycleFactoryOptions {
  /** Decrypted per-account Graph OAuth credential, fetched fresh on every `start()` — never cached across a stop/restart, same discipline as `imapIdleLifecycle.ts`'s `getCredential`. */
  getCredential: (mailboxItemId: string) => Promise<string>;
  /** The one public HTTPS URL every account's subscription points at — `POST /api/mail/graph/webhook` (issue #198's "expose validation/notification through public HTTPS"), not per-account. */
  notificationUrl: string;
  renewalIntervalMs?: number;
  onError?: (mailboxItemId: string, phase: "subscription", err: unknown) => void;
}

/**
 * Builds the Microsoft Graph subscription `MailAccountLifecycle` for one account (issue #198) —
 * the Graph-mode analogue of `createGmailWatchLifecycleFactory` (issue #197), simplified to a
 * single loop: Graph delivers change notifications by pushing them to `notificationUrl`
 * (handled independently by `graphWebhookNotifications.ts`'s HTTP receiver), so unlike Gmail's
 * Pub/Sub pull there is no polling loop for this factory to host — only the registration/renewal
 * loop that keeps the subscription itself alive.
 *
 * Each tick reads the account's currently persisted subscription id (not a value cached in this
 * closure) so a restart is handled the same way an ordinary renewal is: `start()` always
 * re-derives what to do from `mail_account_sync_state` rather than trusting an in-memory flag a
 * process restart would have lost. A persisted id renews in place (`graph_client_state` and the
 * id itself untouched, only the expiry moves); no persisted id, or a renewal that comes back
 * `GraphSubscriptionNotFoundError` (Graph no longer has it), registers a brand-new subscription
 * under a freshly generated `clientState` instead.
 */
export function createGraphWebhookLifecycleFactory(
  pool: Pool,
  transport: GraphSubscriptionTransport,
  options: CreateGraphWebhookLifecycleFactoryOptions,
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

    async function registerFresh(credential: string): Promise<void> {
      const clientState = randomBytes(32).toString("hex");
      const registration = await transport.createSubscription(account.mailboxItemId, credential, {
        notificationUrl: options.notificationUrl,
        clientState,
      });
      await recordGraphSubscriptionRegistration(pool, account.mailboxItemId, {
        subscriptionId: registration.subscriptionId,
        expiresAt: registration.expiresAt,
        clientState,
      });
    }

    async function registerOrRenew(credential: string): Promise<void> {
      const state = await getMailAccountSyncState(pool, account.mailboxItemId);
      if (!state?.graphSubscriptionId) {
        await registerFresh(credential);
        return;
      }
      try {
        const renewal = await transport.renewSubscription(account.mailboxItemId, credential, state.graphSubscriptionId);
        await recordGraphSubscriptionRenewal(pool, account.mailboxItemId, renewal.expiresAt);
      } catch (err) {
        if (!(err instanceof GraphSubscriptionNotFoundError)) throw err;
        await registerFresh(credential);
      }
    }

    async function runRenewalLoop(credential: string): Promise<void> {
      while (!stopped) {
        try {
          await registerOrRenew(credential);
        } catch (err) {
          options.onError?.(account.mailboxItemId, "subscription", err);
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
        // (mailLiveSyncRoot.ts) and the other two live-sync lifecycles.
        await enqueueMailAccountSync(pool, account.mailboxItemId);

        const credential = await options.getCredential(account.mailboxItemId);
        renewalLoop = runRenewalLoop(credential);
      },
      async stop() {
        stopped = true;
        stopResolve("stop");
        await renewalLoop;
      },
    };
  };
}
