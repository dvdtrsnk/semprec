import type { Pool } from "pg";
import {
  GOOGLE_TOKEN_URL,
  GmailRestClient,
  refreshAndPersistAccessToken,
  type MailSyncAdapterFactory,
} from "@semprec/data";
import { logger } from "./logger.js";

/** A cached access token counts as expired this long before the provider's stated expiry. */
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** The purpose the sync job records for its own credential reads (mailSyncJob.ts's `syncPurpose` map). */
const GMAIL_SYNC_PURPOSE = "gmail_api_sync";

export interface CreateMailSyncAdaptersOptions {
  pool: Pool;
  /** The process environment. Only the two Gmail OAuth client keys are read. */
  env: Readonly<Record<string, string | undefined>>;
  /** Replaces the global `fetch` for the token endpoint and the Gmail REST API. Tests inject a fake Gmail server here. */
  fetchImpl?: typeof fetch;
}

/**
 * The mail sync transports this api process runs, passed to `createApiCoreTaskList`. Issue #1505
 * fills `createGmailClient`; the IMAP and Graph transports come with #1510 and #1508.
 *
 * Without both Gmail OAuth keys the factory has no `createGmailClient`, and this logs one warning that
 * names the missing keys (never their values). The process still starts: each Gmail-mode account then
 * fails its sync with the sync job's own "No Gmail adapter configured" message.
 */
export function createMailSyncAdapters(options: CreateMailSyncAdaptersOptions): MailSyncAdapterFactory {
  const { pool, env, fetchImpl } = options;
  const clientId = env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const missingEnv = (["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET"] as const).filter((name) => !env[name]);
    logger.warn({ missingEnv }, "Gmail OAuth client is not configured; Gmail-mode mail accounts cannot sync");
    return {};
  }
  return {
    // The sync job passes the credential it decrypted for this pass, which is deliberately not used here.
    // The refresh reads the stored token under its row lock, so a value read before another refresh
    // rotated it would present a retired refresh token.
    createGmailClient: (mailboxItemId) => {
      const getAccessToken = createGmailAccessTokenSource({ pool, mailboxItemId, clientId, clientSecret, fetchImpl });
      return new GmailRestClient(getAccessToken, fetchImpl);
    },
  };
}

interface GmailAccessTokenSourceInput {
  pool: Pool;
  mailboxItemId: string;
  clientId: string;
  clientSecret: string;
  fetchImpl: typeof fetch | undefined;
}

/**
 * The `getAccessToken` of one `GmailRestClient`. It keeps the last token it obtained for as long as
 * that client lives (one sync pass of one mailbox), and refreshes once the token is within
 * `ACCESS_TOKEN_EXPIRY_MARGIN_MS` of its expiry. Calls that overlap on one client can each refresh;
 * the row lock in `refreshAndPersistAccessToken` serialises those refreshes. A refresh that throws
 * leaves the kept token unchanged, so the next request tries again. A rejected refresh token surfaces
 * as `MailReauthorizationRequiredError`, which the sync job maps to `needsReauthorization`.
 */
function createGmailAccessTokenSource(input: GmailAccessTokenSourceInput): () => Promise<string> {
  let kept: { accessToken: string; expiresAt: Date } | undefined;
  return async () => {
    if (kept && Date.now() < kept.expiresAt.getTime() - ACCESS_TOKEN_EXPIRY_MARGIN_MS) return kept.accessToken;
    const refreshed = await refreshAndPersistAccessToken(input.pool, {
      mailboxItemId: input.mailboxItemId,
      tokenUrl: GOOGLE_TOKEN_URL,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      purpose: GMAIL_SYNC_PURPOSE,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    kept = refreshed;
    return refreshed.accessToken;
  };
}
