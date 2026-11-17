import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { logger } from "./logger.js";
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

/** Graph no longer has the subscription (404): the loop registers a fresh one instead of retrying. */
export class GraphSubscriptionNotFoundError extends Error {}

/** Subscription management only; notifications just enqueue the idempotent sync job. */
export interface GraphSubscriptionTransport {
  createSubscription(
    mailboxItemId: string,
    credential: string,
    params: { notificationUrl: string; clientState: string },
  ): Promise<GraphSubscriptionRegistration>;
  /** Extends the expiry in place; throws `GraphSubscriptionNotFoundError` if Graph no longer has it. */
  renewSubscription(
    mailboxItemId: string,
    credential: string,
    subscriptionId: string,
  ): Promise<GraphSubscriptionRegistration>;
}

/** Daily, well inside Graph's ~2.94-day maximum, so one failed renewal leaves slack. */
const DEFAULT_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CreateGraphWebhookLifecycleFactoryOptions {
  /** Fetched fresh on every `start()`, never cached across restarts. */
  getCredential: (mailboxItemId: string) => Promise<string>;
  /** The single public HTTPS webhook URL shared by all accounts. */
  notificationUrl: string;
  renewalIntervalMs?: number;
  onError?: (mailboxItemId: string, phase: "subscription", err: unknown) => void;
}

/**
 * Graph pushes notifications to the webhook, so this only hosts the registration/renewal loop.
 * Each tick reads the persisted subscription id (so restarts behave like renewals): an existing
 * id is renewed in place; none, or a not-found renewal, registers a fresh subscription with a new
 * `clientState`.
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
          if (options.onError) {
            options.onError(account.mailboxItemId, "subscription", err);
          } else {
            logger.error({ err, mailboxItemId: account.mailboxItemId }, "Graph subscription lifecycle error");
          }
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
