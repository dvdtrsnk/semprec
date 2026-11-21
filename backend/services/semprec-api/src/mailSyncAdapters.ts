import type { Pool } from "pg";
import {
  GOOGLE_TOKEN_URL,
  GmailRestClient,
  GraphRestClient,
  MICROSOFT_TOKEN_URL,
  classifyImapConnectFailure,
  getMailServerSettings,
  openImapConnection,
  refreshAndPersistAccessToken,
  sharedImapSessionPool,
  type ImapMailClient,
  type ImapSessionPool,
  type MailSyncAdapterFactory,
} from "@semprec/data";
import { logger } from "./logger.js";

/** Counts as expired this long before the provider's stated expiry. */
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Must match mailSyncJob.ts's `syncPurpose` map. */
const GMAIL_SYNC_PURPOSE = "gmail_api_sync";
const GRAPH_SYNC_PURPOSE = "graph_api_sync";

export interface CreateMailSyncAdaptersOptions {
  pool: Pool;
  /** Only the Gmail and Microsoft Graph OAuth client keys are read. */
  env: Readonly<Record<string, string | undefined>>;
  /** Tests inject fake providers here. */
  fetchImpl?: typeof fetch;
  /** Where IMAP sync connections are kept between passes; defaults to the process-wide pool. */
  imapSessions?: ImapSessionPool;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/**
 * Passed to `createApiCoreTaskList`. `createImapClient` is always present: an IMAP mailbox names
 * its own server settings and its password is the stored app-specific password.
 *
 * Each OAuth provider is configured on its own. Without its two keys its factory is absent and one
 * warning names the missing keys (never values); the process still starts and each account of that
 * mode fails its sync with "No ... adapter configured for this composition root".
 */
export function createMailSyncAdapters(options: CreateMailSyncAdaptersOptions): MailSyncAdapterFactory {
  const { pool, env, fetchImpl } = options;
  const imapSessions = options.imapSessions ?? sharedImapSessionPool;
  const adapters: MailSyncAdapterFactory = {};

  adapters.createImapClient = (mailboxItemId, credential, accountLimit) =>
    checkoutMailboxImapClient(pool, imapSessions, mailboxItemId, credential, accountLimit);

  // Both OAuth transports deliberately ignore the credential the sync job passes: the refresh reads
  // the stored token under its row lock, so a value read before another refresh rotated it would
  // present a retired refresh token.
  const gmail = readOAuthClient(env, "GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET");
  if ("missingEnv" in gmail) {
    logger.warn(
      { missingEnv: gmail.missingEnv },
      "Gmail OAuth client is not configured; Gmail-mode mail accounts cannot sync",
    );
  } else {
    const { clientId, clientSecret } = gmail;
    const gmailClient = (mailboxItemId: string) => {
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
    adapters.createGmailClient = gmailClient;
    adapters.loadGmailLabels = (mailboxItemId) => gmailClient(mailboxItemId).listLabels();
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
 * The account's kept sync session, or a new connection with the mailbox's stored server settings. The password goes to
 * the connection only, never into errors or logs. A mailbox with no IMAP settings is a configuration error raised with
 * the mailbox id. `openImapConnection` vets the host's address; its failure is classified
 * (`classifyImapConnectFailure`).
 */
async function checkoutMailboxImapClient(
  pool: Pool,
  imapSessions: ImapSessionPool,
  mailboxItemId: string,
  password: string,
  accountLimit: number,
): Promise<ImapMailClient> {
  const settings = await getMailServerSettings(pool, mailboxItemId);
  const endpoint = settings?.imap ?? null;
  if (settings === null || endpoint === null) {
    throw new Error(`Mailbox ${mailboxItemId} has no IMAP server settings; set the IMAP host before syncing it`);
  }
  return imapSessions.checkout({
    mailboxItemId,
    accountLimit,
    host: endpoint.host,
    signIn: JSON.stringify([endpoint.host, endpoint.port, endpoint.security, settings.username, password]),
    async connect() {
      try {
        return await openImapConnection({ endpoint, username: settings.username }, { password });
      } catch (error) {
        // The original remains owned through the completed connection cleanup.
        throw classifyImapConnectFailure(error);
      }
    },
  });
}

/** An unset or empty key counts as missing; a missing result names the keys, never their values. */
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
 * Keeps the last token for the client's lifetime (one sync pass of one mailbox) and refreshes
 * within `ACCESS_TOKEN_EXPIRY_MARGIN_MS` of expiry. Overlapping refreshes are serialised by the row
 * lock in `refreshAndPersistAccessToken`. A failed refresh keeps the old token so the next request
 * retries; a rejected refresh token surfaces as `MailReauthorizationRequiredError`. No `scope` is
 * sent, so the provider keeps the scopes already granted.
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
