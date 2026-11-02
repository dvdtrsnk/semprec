import type { Pool } from "pg";
import {
  GOOGLE_TOKEN_URL,
  GmailRestClient,
  GraphRestClient,
  MICROSOFT_TOKEN_URL,
  MailConnectionLimitError,
  MailReauthorizationRequiredError,
  MailServerUnreachableError,
  getMailServerSettings,
  isImapConnectionLimitError,
  openImapConnection,
  refreshAndPersistAccessToken,
  type ImapMailClient,
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
 * `createGmailClient`, issue #1508 fills `createGraphClient`, and issue #1510 fills `createImapClient`.
 *
 * The IMAP transport needs no OAuth key: an IMAP mailbox names its own host, port, security and
 * username (`mail_account_server_settings`), and its password is the stored app-specific password the
 * sync job passes in. So `createImapClient` is always present.
 *
 * Each OAuth provider is configured on its own. Without a provider's two OAuth keys its client factory is
 * absent, and this logs one warning that names that provider's missing keys (never their values). The
 * process still starts: each account of that mode then fails its sync with the sync job's own
 * "No ... adapter configured for this composition root" message.
 */
export function createMailSyncAdapters(options: CreateMailSyncAdaptersOptions): MailSyncAdapterFactory {
  const { pool, env, fetchImpl } = options;
  const adapters: MailSyncAdapterFactory = {};

  adapters.createImapClient = (mailboxItemId, credential) => openMailboxImapClient(pool, mailboxItemId, credential);

  // Both OAuth transports below ignore the credential the sync job passes to their factory on purpose: the
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
 * Opens the IMAP connection of one mailbox from its stored server settings (issue #1510). The password is
 * the credential the sync job decrypted for this pass. It goes to the connection and nowhere else: neither
 * the errors below nor the logs carry it.
 *
 * A mailbox with no IMAP settings is a configuration error, not a provider failure, so it is raised here
 * with the mailbox id. The connection goes through `openImapConnection`, which vets the host's address and
 * maps a refused or unreachable server to `MailServerUnreachableError`; that error passes through unchanged.
 */
async function openMailboxImapClient(pool: Pool, mailboxItemId: string, password: string): Promise<ImapMailClient> {
  const settings = await getMailServerSettings(pool, mailboxItemId);
  const endpoint = settings?.imap ?? null;
  if (settings === null || endpoint === null) {
    throw new Error(`Mailbox ${mailboxItemId} has no IMAP server settings; set the IMAP host before syncing it`);
  }
  try {
    return await openImapConnection({ endpoint, username: settings.username }, { password });
  } catch (error) {
    let safe: Error;
    try {
      safe = classifyImapConnectError(error);
    } catch {
      safe = new Error("IMAP connection failed unexpectedly");
    }
    // The original remains owned through the completed connection cleanup.
    throw safe;
  }
}

/**
 * Maps the two connect failures the sync job must handle differently. A provider that refuses the
 * connection for too many open sessions becomes `MailConnectionLimitError`, so the job backs off instead of
 * retrying at once (imapFlowClient.ts's `isImapConnectionLimitError`). A login the server rejects becomes
 * `MailReauthorizationRequiredError`, so the account reads as needing reauthorization. Every other error
 * becomes a fixed generic error without claiming a known failure kind.
 */
function classifyImapConnectError(error: unknown): Error {
  if (error instanceof MailServerUnreachableError) return new MailServerUnreachableError();
  if (error instanceof MailConnectionLimitError) {
    return new MailConnectionLimitError("The IMAP server reports too many simultaneous connections for this account");
  }
  if (error instanceof MailReauthorizationRequiredError) {
    return new MailReauthorizationRequiredError("The IMAP server rejected the stored login; reauthorize the mailbox");
  }
  if (isImapConnectionLimitError(error)) {
    return new MailConnectionLimitError("The IMAP server reports too many simultaneous connections for this account");
  }
  if (isLoginRejection(error)) {
    return new MailReauthorizationRequiredError("The IMAP server rejected the stored login; reauthorize the mailbox");
  }
  return new Error("IMAP connection failed unexpectedly");
}

/** imapflow sets `authenticationFailed` on a login the server rejected (imapflow's commands/login.js). */
function isLoginRejection(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "authenticationFailed" in error &&
    error.authenticationFailed === true
  );
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
