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
  MailReauthorizationRequiredError,
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
  /** A mode without an entry gets the noop lifecycle. */
  hosted: Partial<Record<MailLiveSyncAccount["syncMode"], MailLiveSyncLifecycleFactory>>;
}

/**
 * The noop lifecycle's `start()` enqueues one sync, so an account in an unhosted mode is still
 * synced by the periodic sweep.
 */
export function createMailLiveSyncLifecycleFactory(
  options: MailLiveSyncLifecycleDispatchOptions,
): MailLiveSyncLifecycleFactory {
  const noop = createNoopMailLiveSyncLifecycleFactory(options.pool);
  return (account) => (options.hosted[account.syncMode] ?? noop)(account);
}

/**
 * Each connection opens through `openImapFlow`, the address-checked connect step, with the
 * mailbox's stored server settings and the IDLE options. The transport never connects the client it
 * receives; `createClient` opens it.
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
    // Passed `pool`, not a transaction: the access-log insert commits on its own.
    getCredential: async (mailboxItemId) => {
      const credential = await getDecryptedCredential(pool, {
        itemId: mailboxItemId,
        actorType: "sync_worker",
        purpose: "imap_idle",
      });
      if (credential === null) {
        throw new MailReauthorizationRequiredError(`Mailbox ${mailboxItemId} has no stored credential`);
      }
      return credential;
    },
    getConnectionLimit: (mailboxItemId) => connectionLimitOf(pool, mailboxItemId),
    onError: (mailboxItemId) => {
      logger.warn({ mailboxItemId, stage: "idle", category: "failure" }, "IMAP IDLE lifecycle failed");
    },
  });
}

/** Read the way mailSyncJob.ts reads it. */
export async function connectionLimitOf(pool: Pool, mailboxItemId: string): Promise<number> {
  const mailbox = await withTransaction(pool, async (client) => {
    const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
    return getItemById(client, mailboxesDatabaseId, mailboxItemId);
  });
  // A mailbox that is gone takes the default budget; the live-sync root stops its lifecycle on the
  // next pass.
  const provider = typeof mailbox?.properties.provider === "string" ? mailbox.properties.provider : undefined;
  return imapConnectionLimitForProvider(provider, mailbox?.properties.connectionLimit);
}

/** The only thing a lifecycle failure log carries about the error. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function requireCredential(pool: Pool, mailboxItemId: string, purpose: string): Promise<string> {
  // Passed `pool`, not a transaction: the access-log insert commits on its own.
  const credential = await getDecryptedCredential(pool, { itemId: mailboxItemId, actorType: "sync_worker", purpose });
  if (credential === null) throw new Error(`Mailbox ${mailboxItemId} has no stored credential`);
  return credential;
}

/** Refreshed and persisted by the token owner. */
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
 * The provider-verified address the connect flow stores, never the user-editable
 * `Mailboxes.addresses`, so no tenant can claim another account's notifications. A mailbox without
 * one is a configuration error.
 */
export async function providerVerifiedAddressOf(pool: Pool, mailboxItemId: string): Promise<string> {
  const address = await withTransaction(pool, (client) => getProviderAccountAddress(client, mailboxItemId));
  if (address === null) throw new Error(`Mailbox ${mailboxItemId} has no provider-verified account address`);
  return address;
}

export interface GmailWatchHosting {
  lifecycle: MailLiveSyncLifecycleFactory;
  /** Shared by the watches and the process's Pub/Sub dispatcher. */
  transport: GmailWatchTransport;
}

/**
 * `users.watch` runs under the account's own grant; `pull` and `acknowledge` run as the
 * deployment's service account.
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
 * Without the Gmail OAuth client returns `null` silently (`createMailSyncAdapters` already warns,
 * and Gmail accounts cannot sync). With the client but a missing or invalid Pub/Sub configuration
 * returns `null` with one warning naming the reason, never a value; Gmail accounts then keep the
 * noop lifecycle and the periodic sweep. An unexpected read failure propagates.
 */
export async function resolveGmailWatchHosting(pool: Pool, env: NodeJS.ProcessEnv): Promise<GmailWatchHosting | null> {
  const client = readOAuthClient(env, "GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET");
  if ("missingEnv" in client) return null;
  const pubSub = await loadGmailPubSubConfig(env);
  if (pubSub.config === null) {
    logger.warn(
      { reason: pubSub.reason },
      "Gmail watch lifecycles are not hosted; Gmail accounts are synced by the periodic sweep",
    );
    return null;
  }
  return createGmailWatchHosting(pool, pubSub.config, client);
}

/** Its failures log ids and error names only. */
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

const GRAPH_WEBHOOK_PATH = "/api/mail/graph/webhook";

export type GraphSubscriptionHostingDecision =
  { hosted: true; notificationUrl: string; client: OAuthClient } | { hosted: false; reason: string };

/**
 * The origin of `appBaseUrl` when it is an `https://` origin without a path (a trailing `/` is the
 * root), else `null`: the only base a provider's webhook `notificationUrl` is built on.
 */
export function publicHttpsOrigin(appBaseUrl: string): string | null {
  // Scheme, host, at most the root `/`: no path, query, fragment, user info, whitespace or
  // backslash (which URL parsing of an https URL turns into a path separator).
  if (!/^https:\/\/[^/?#@\\\s]+\/?$/.test(appBaseUrl)) return null;
  let url: URL;
  try {
    url = new URL(appBaseUrl);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  // The parsed URL must be that origin and nothing else, so no component is dropped by taking
  // `origin`.
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  return url.origin;
}

/**
 * Graph accepts only a public HTTPS `notificationUrl`, so subscriptions are hosted when
 * `appBaseUrl` is an `https://` origin without a path (`publicHttpsOrigin`) and the Graph OAuth
 * client is configured.
 */
export function decideGraphSubscriptionHosting(
  appBaseUrl: string,
  client: OAuthClient | { missingEnv: string[] },
): GraphSubscriptionHostingDecision {
  if ("missingEnv" in client) return { hosted: false, reason: `missing ${client.missingEnv.join(", ")}` };
  const origin = publicHttpsOrigin(appBaseUrl);
  if (origin === null) return { hosted: false, reason: "APP_BASE_URL is not an https:// origin without a path" };
  return { hosted: true, notificationUrl: `${origin}${GRAPH_WEBHOOK_PATH}`, client };
}

/**
 * Without the Graph OAuth client returns `null` silently (`createMailSyncAdapters` already warns).
 * With the client but an `APP_BASE_URL` the decision does not host, returns `null` with one
 * warning; Graph accounts keep the noop lifecycle and the periodic sweep. Failures log ids and
 * error names only.
 */
export function resolveGraphSubscriptionHosting(
  pool: Pool,
  env: NodeJS.ProcessEnv,
  appBaseUrl: string,
): MailLiveSyncLifecycleFactory | null {
  const oauthClient = readOAuthClient(env, "MS_GRAPH_OAUTH_CLIENT_ID", "MS_GRAPH_OAUTH_CLIENT_SECRET");
  if ("missingEnv" in oauthClient) return null;
  const decision = decideGraphSubscriptionHosting(appBaseUrl, oauthClient);
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
