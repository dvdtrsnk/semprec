import type { Pool } from "pg";
import {
  GOOGLE_TOKEN_URL,
  MICROSOFT_TOKEN_URL,
  createBoundedImapIdleLifecycleFactory,
  createGmailPubSubDispatcher,
  createGmailPubSubTransport,
  createGmailWatchLifecycleFactory,
  createGraphSubscriptionRestClient,
  createGraphWebhookLifecycleFactory,
  createImapFlowIdleTransport,
  createNoopMailLiveSyncLifecycleFactory,
  getDecryptedCredential,
  getItemById,
  getMailServerSettings,
  getProviderAccountAddress,
  imapConnectionLimitForProvider,
  openImapFlow,
  refreshAndPersistAccessToken,
  resolveMailModuleIds,
  withTransaction,
  type CreateIdleTunedImapFlowClient,
  type GmailPubSubDispatcher,
  type GmailWatchTransport,
  type MailLiveSyncAccount,
  type MailLiveSyncLifecycleFactory,
} from "@semprec/data";
import { loadGmailPubSubConfig, type GmailPubSubConfig } from "./gmailPubSubConfig.js";
import { readOAuthClient, type OAuthClient } from "./mailSyncAdapters.js";
import { logger } from "./logger.js";

export interface MailLiveSyncLifecycleDispatchOptions {
  pool: Pool;
  /**
   * The lifecycle factory of each sync mode this process hosts. A mode without an entry gets the noop lifecycle.
   */
  hosted: Partial<Record<MailLiveSyncAccount["syncMode"], MailLiveSyncLifecycleFactory>>;
}

/**
 * Dispatches on `account.syncMode` to the factory that hosts that mode, or to the noop lifecycle when none does
 * (issue #1550). The noop lifecycle's `start()` enqueues one sync, so an account in a mode with no hosted lifecycle
 * is still synced by the periodic sweep.
 */
export function createMailLiveSyncLifecycleFactory(
  options: MailLiveSyncLifecycleDispatchOptions,
): MailLiveSyncLifecycleFactory {
  const noop = createNoopMailLiveSyncLifecycleFactory(options.pool);
  return (account) => (options.hosted[account.syncMode] ?? noop)(account);
}

/**
 * The IMAP IDLE lifecycle of every IMAP account, hosted by this process (issue #196, hosted by #1550). Each
 * connection opens through `openImapFlow`, the address-checked connect step, with the mailbox's stored server
 * settings and the IDLE options (docs/adr/2026-10-29-imap-idle-connections-through-the-shared-imap-connect-step.md).
 * The transport never connects the client it receives; the `createClient` below is what opens it.
 */
export function createImapIdleLifecycleFactory(pool: Pool): MailLiveSyncLifecycleFactory {
  const createClient: CreateIdleTunedImapFlowClient = async (mailboxItemId, password, idleOptions) => {
    const settings = await getMailServerSettings(pool, mailboxItemId);
    const endpoint = settings?.imap ?? null;
    if (settings === null || endpoint === null) {
      throw new Error(`Mailbox ${mailboxItemId} has no IMAP server settings; set the IMAP host before syncing it`);
    }
    return openImapFlow({ endpoint, username: settings.username }, { password }, idleOptions);
  };
  return createBoundedImapIdleLifecycleFactory(pool, createImapFlowIdleTransport(createClient), {
    // Passed `pool`, not a transaction, as mailSyncJob.ts does: the access-log insert commits on its own.
    getCredential: async (mailboxItemId) => {
      const credential = await getDecryptedCredential(pool, {
        itemId: mailboxItemId,
        actorType: "sync_worker",
        purpose: "imap_idle",
      });
      if (credential === null) throw new Error(`Mailbox ${mailboxItemId} has no stored credential`);
      return credential;
    },
    getConnectionLimit: (mailboxItemId) => connectionLimitOf(pool, mailboxItemId),
    onError: (mailboxItemId) => {
      logger.warn({ mailboxItemId, stage: "idle", category: "failure" }, "IMAP IDLE lifecycle failed");
    },
  });
}

/** The account's IMAP connection budget, read the way mailSyncJob.ts reads it for its reconcile passes. */
export async function connectionLimitOf(pool: Pool, mailboxItemId: string): Promise<number> {
  const mailbox = await withTransaction(pool, async (client) => {
    const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
    return getItemById(client, mailboxesDatabaseId, mailboxItemId);
  });
  // A mailbox that is gone takes the default budget; the live-sync root stops its lifecycle on the next pass.
  const provider = typeof mailbox?.properties.provider === "string" ? mailbox.properties.provider : undefined;
  return imapConnectionLimitForProvider(provider, mailbox?.properties.connectionLimit);
}

/** The name of a thrown value, the only thing a lifecycle failure log carries about it. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A mailbox's stored OAuth credential for `purpose`, read the way the IDLE lifecycle reads its own. */
async function requireCredential(pool: Pool, mailboxItemId: string, purpose: string): Promise<string> {
  // Passed `pool`, not a transaction, as mailSyncJob.ts does: the access-log insert commits on its own.
  const credential = await getDecryptedCredential(pool, { itemId: mailboxItemId, actorType: "sync_worker", purpose });
  if (credential === null) throw new Error(`Mailbox ${mailboxItemId} has no stored credential`);
  return credential;
}

/** A fresh access token of the mailbox's own OAuth grant, refreshed and persisted by the #1481 owner. */
async function mailboxAccessToken(
  pool: Pool,
  mailboxItemId: string,
  tokenUrl: string,
  client: OAuthClient,
  purpose: string,
): Promise<string> {
  const refreshed = await refreshAndPersistAccessToken(pool, {
    mailboxItemId,
    tokenUrl,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    purpose,
  });
  return refreshed.accessToken;
}

/**
 * The Gmail account address a watch routes on: the provider-verified address the connect flow stores on
 * the mailbox (issue #1454), never the user-editable `Mailboxes.addresses`, so no tenant can claim another
 * account's notifications. A mailbox without one is a configuration error, reported by the root.
 */
export async function providerVerifiedAddressOf(pool: Pool, mailboxItemId: string): Promise<string> {
  const address = await withTransaction(pool, (client) => getProviderAccountAddress(client, mailboxItemId));
  if (address === null) throw new Error(`Mailbox ${mailboxItemId} has no provider-verified account address`);
  return address;
}

/** What hosting Gmail watches needs: the Pub/Sub configuration and the Gmail OAuth client. */
export interface GmailWatchHosting {
  /** The lifecycle of every `gmail_api` account. */
  lifecycle: MailLiveSyncLifecycleFactory;
  /** The one transport the watches and the process's Pub/Sub dispatcher share. */
  transport: GmailWatchTransport;
}

/**
 * Issue #1739: the Gmail watch lifecycle of every Gmail account (`createGmailWatchLifecycleFactory`) over
 * the one Pub/Sub transport. `users.watch` runs under the account's own grant (`refreshAndPersistAccessToken`
 * with the Gmail OAuth client); `pull` and `acknowledge` run as the deployment's service account.
 */
export function createGmailWatchHosting(pool: Pool, pubSub: GmailPubSubConfig, client: OAuthClient): GmailWatchHosting {
  const transport = createGmailPubSubTransport({
    getGmailAccessToken: (mailboxItemId) =>
      mailboxAccessToken(pool, mailboxItemId, GOOGLE_TOKEN_URL, client, "gmail_watch"),
    getPubSubAccessToken: () => pubSub.getPubSubAccessToken(),
    topicName: pubSub.topicName,
    subscriptionName: pubSub.subscriptionName,
  });
  const lifecycle = createGmailWatchLifecycleFactory(pool, transport, {
    getCredential: (mailboxItemId) => requireCredential(pool, mailboxItemId, "gmail_watch"),
    getAccountEmailAddress: (mailboxItemId) => providerVerifiedAddressOf(pool, mailboxItemId),
    onError: (mailboxItemId, phase, err) => {
      logger.warn({ mailboxItemId, phase, errorName: errorName(err) }, "Gmail watch renewal failed");
    },
  });
  return { lifecycle, transport };
}

/**
 * Whether this process hosts Gmail watches. With the Pub/Sub configuration incomplete or the Gmail OAuth
 * client missing it returns `null` and logs one warning that names what is missing, never a value: the
 * process still starts, and Gmail accounts keep the noop lifecycle and the periodic sweep.
 */
export async function resolveGmailWatchHosting(pool: Pool, env: NodeJS.ProcessEnv): Promise<GmailWatchHosting | null> {
  const pubSub = await loadGmailPubSubConfig(env);
  const client = readOAuthClient(env, "GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET");
  const reasons = [
    ...(pubSub.config === null ? [pubSub.reason] : []),
    ...("missingEnv" in client ? [`missing ${client.missingEnv.join(", ")}`] : []),
  ];
  if (pubSub.config === null || "missingEnv" in client) {
    logger.warn({ reasons }, "Gmail watch lifecycles are not hosted; Gmail accounts are synced by the periodic sweep");
    return null;
  }
  return createGmailWatchHosting(pool, pubSub.config, client);
}

/** The process's one Pub/Sub dispatcher over the hosting's transport; its failures log ids and error names only. */
export function createGmailPubSubDispatcherFor(pool: Pool, hosting: GmailWatchHosting): GmailPubSubDispatcher {
  return createGmailPubSubDispatcher(pool, hosting.transport, {
    onError: (target, phase, err) => {
      logger.warn(
        { tenantId: target?.tenantId, mailboxItemId: target?.mailboxItemId, phase, errorName: errorName(err) },
        "Gmail Pub/Sub dispatch failed",
      );
    },
  });
}

/** Where every Graph subscription posts its change notifications (`app.ts` routes it). */
const GRAPH_WEBHOOK_PATH = "/api/mail/graph/webhook";

export type GraphSubscriptionHostingDecision =
  { hosted: true; notificationUrl: string; client: OAuthClient } | { hosted: false; reason: string };

/**
 * Issue #1745's rule, pure: Graph accepts only a public HTTPS `notificationUrl`, so subscriptions are hosted
 * when `appBaseUrl` is an `https://` origin without a path (a trailing `/` is the root, not a path) and the
 * Graph OAuth client is configured; the URL is that origin plus `/api/mail/graph/webhook`.
 */
export function decideGraphSubscriptionHosting(
  appBaseUrl: string,
  client: OAuthClient | { missingEnv: string[] },
): GraphSubscriptionHostingDecision {
  if ("missingEnv" in client) return { hosted: false, reason: `missing ${client.missingEnv.join(", ")}` };
  const notAnOrigin = { hosted: false, reason: "APP_BASE_URL is not an https:// origin without a path" } as const;
  // Scheme, then host (no path, query, fragment or user info), then at most the root `/`.
  if (!/^https:\/\/[^/?#@\s]+\/?$/.test(appBaseUrl)) return notAnOrigin;
  let origin: string;
  try {
    origin = new URL(appBaseUrl).origin;
  } catch (error) {
    if (error instanceof TypeError) return notAnOrigin;
    throw error;
  }
  return { hosted: true, notificationUrl: `${origin}${GRAPH_WEBHOOK_PATH}`, client };
}

/**
 * The Graph subscription lifecycle of every Graph account (`createGraphWebhookLifecycleFactory`), or `null`
 * with one warning when the decision above does not host it: the process still starts, and Graph accounts
 * keep the noop lifecycle and the periodic sweep. Tokens come from the account's own grant
 * (`refreshAndPersistAccessToken` with `MICROSOFT_TOKEN_URL`); failures log ids and error names only.
 */
export function resolveGraphSubscriptionHosting(
  pool: Pool,
  env: NodeJS.ProcessEnv,
  appBaseUrl: string,
): MailLiveSyncLifecycleFactory | null {
  const decision = decideGraphSubscriptionHosting(
    appBaseUrl,
    readOAuthClient(env, "MS_GRAPH_OAUTH_CLIENT_ID", "MS_GRAPH_OAUTH_CLIENT_SECRET"),
  );
  if (!decision.hosted) {
    logger.warn(
      { reason: decision.reason },
      "Graph subscription lifecycles are not hosted; Graph accounts are synced by the periodic sweep",
    );
    return null;
  }
  const { client, notificationUrl } = decision;
  return createGraphWebhookLifecycleFactory(
    pool,
    createGraphSubscriptionRestClient((mailboxItemId) =>
      mailboxAccessToken(pool, mailboxItemId, MICROSOFT_TOKEN_URL, client, "graph_subscription"),
    ),
    {
      getCredential: (mailboxItemId) => requireCredential(pool, mailboxItemId, "graph_subscription"),
      notificationUrl,
      onError: (mailboxItemId, phase, err) => {
        logger.warn({ mailboxItemId, phase, errorName: errorName(err) }, "Graph subscription lifecycle failed");
      },
    },
  );
}
