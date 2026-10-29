import type { Pool } from "pg";
import {
  GOOGLE_TOKEN_URL,
  GmailRestClient,
  GraphRestClient,
  MICROSOFT_TOKEN_URL,
  refreshAndPersistAccessToken,
  type MailSyncAdapterFactory,
} from "@semprec/data";
import { logger } from "./logger.js";

/** A cached access token counts as expired this long before the provider's stated expiry. */
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** The purposes the sync job records for its own credential reads (mailSyncJob.ts's `syncPurpose` map). */
const GMAIL_SYNC_PURPOSE = "gmail_api_sync";
const GRAPH_SYNC_PURPOSE = "graph_api_sync";

export interface CreateMailSyncAdaptersOptions {
  pool: Pool;
  /** The process environment. Only the Gmail and Microsoft Graph OAuth client keys are read. */
  env: Readonly<Record<string, string | undefined>>;
  /** Replaces the global `fetch` for the token endpoints and the provider REST APIs. Tests inject fake providers here. */
  fetchImpl?: typeof fetch;
}

/** One provider's OAuth client keys, as `readOAuthClient` reads them from the environment. */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/**
 * The mail sync transports this api process runs, passed to `createApiCoreTaskList`. Issue #1505 fills
 * `createGmailClient` and issue #1508 fills `createGraphClient`; the IMAP transport comes with #1510.
 *
 * Each provider is configured on its own. Without a provider's two OAuth keys its client factory is
 * absent, and this logs one warning that names that provider's missing keys (never their values). The
 * process still starts: each account of that mode then fails its sync with the sync job's own
 * "No ... adapter configured for this composition root" message.
 */
export function createMailSyncAdapters(options: CreateMailSyncAdaptersOptions): MailSyncAdapterFactory {
  const { pool, env, fetchImpl } = options;
  const adapters: MailSyncAdapterFactory = {};

  // Both transports below ignore the credential the sync job passes to their factory on purpose: the
  // refresh reads the stored token under its row lock, so a value read before another refresh rotated
  // it would present a retired refresh token.
  const gmail = readOAuthClient(env, "GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET");
  if ("missingEnv" in gmail) {
    logger.warn(
      { missingEnv: gmail.missingEnv },
      "Gmail OAuth client is not configured; Gmail-mode mail accounts cannot sync",
    );
  } else {
    const { clientId, clientSecret } = gmail;
    adapters.createGmailClient = (mailboxItemId) => {
      const getAccessToken = createOAuthAccessTokenSource({
        pool,
        mailboxItemId,
        tokenUrl: GOOGLE_TOKEN_URL,
        clientId,
        clientSecret,
        purpose: GMAIL_SYNC_PURPOSE,
        fetchImpl,
      });
      return new GmailRestClient(getAccessToken, fetchImpl);
    };
  }

  const graph = readOAuthClient(env, "MS_GRAPH_OAUTH_CLIENT_ID", "MS_GRAPH_OAUTH_CLIENT_SECRET");
  if ("missingEnv" in graph) {
    logger.warn(
      { missingEnv: graph.missingEnv },
      "Microsoft Graph OAuth client is not configured; Graph-mode mail accounts cannot sync",
    );
  } else {
    const { clientId, clientSecret } = graph;
    adapters.createGraphClient = (mailboxItemId) => {
      const getAccessToken = createOAuthAccessTokenSource({
        pool,
        mailboxItemId,
        tokenUrl: MICROSOFT_TOKEN_URL,
        clientId,
        clientSecret,
        purpose: GRAPH_SYNC_PURPOSE,
        fetchImpl,
      });
      return new GraphRestClient(getAccessToken, fetchImpl);
    };
  }

  return adapters;
}

/**
 * Reads one provider's OAuth client keys. An unset or empty key counts as missing. A missing result
 * names the keys that are missing, never their values.
 */
export function readOAuthClient(
  env: CreateMailSyncAdaptersOptions["env"],
  idKey: string,
  secretKey: string,
): OAuthClient | { missingEnv: string[] } {
  const clientId = env[idKey];
  const clientSecret = env[secretKey];
  if (clientId && clientSecret) return { clientId, clientSecret };
  return { missingEnv: [idKey, secretKey].filter((name) => !env[name]) };
}

interface OAuthAccessTokenSourceInput {
  pool: Pool;
  mailboxItemId: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Names the sync mode in `credential_access_log`. */
  purpose: string;
  fetchImpl: typeof fetch | undefined;
}

/**
 * The `getAccessToken` of one provider REST client. It keeps the last token it obtained for as long as
 * that client lives (one sync pass of one mailbox), and refreshes once the token is within
 * `ACCESS_TOKEN_EXPIRY_MARGIN_MS` of its expiry. Calls that overlap on one client can each refresh;
 * the row lock in `refreshAndPersistAccessToken` serialises those refreshes. A refresh that throws
 * leaves the kept token unchanged, so the next request tries again. A rejected refresh token surfaces
 * as `MailReauthorizationRequiredError`, which the sync job maps to `needsReauthorization`. The refresh
 * sends no `scope`, so the provider keeps the scopes the account already granted.
 */
function createOAuthAccessTokenSource(input: OAuthAccessTokenSourceInput): () => Promise<string> {
  let kept: { accessToken: string; expiresAt: Date } | undefined;
  return async () => {
    if (kept && Date.now() < kept.expiresAt.getTime() - ACCESS_TOKEN_EXPIRY_MARGIN_MS) return kept.accessToken;
    const refreshed = await refreshAndPersistAccessToken(input.pool, {
      mailboxItemId: input.mailboxItemId,
      tokenUrl: input.tokenUrl,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      purpose: input.purpose,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    kept = refreshed;
    return refreshed.accessToken;
  };
}
