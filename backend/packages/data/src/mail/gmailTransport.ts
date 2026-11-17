import type { Pool } from "pg";
import { GmailRestClient } from "./gmailRestClient.js";
import { refreshAndPersistAccessToken } from "./mailOAuthAccess.js";
import { GOOGLE_TOKEN_URL } from "./oauthTokenExchange.js";
import type { MailTransport } from "./mailTransport.js";

/** The `credential_access_log` purpose of a send's token refresh. */
export const GMAIL_SEND_PURPOSE = "gmail_api_send";

export interface GmailMailTransportOptions {
  pool: Pool;
  mailboxItemId: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

/**
 * Each send refreshes the access token under its row lock and submits the raw MIME unchanged, so
 * ingest can match the later synced copy by Message-ID. The client is built per send so no access
 * token outlives it.
 */
export function createGmailMailTransport(options: GmailMailTransportOptions): MailTransport {
  const { pool, mailboxItemId, clientId, clientSecret, fetchImpl } = options;
  return {
    async send(message) {
      const client = new GmailRestClient(async () => {
        const { accessToken } = await refreshAndPersistAccessToken(pool, {
          mailboxItemId,
          tokenUrl: GOOGLE_TOKEN_URL,
          clientId,
          clientSecret,
          purpose: GMAIL_SEND_PURPOSE,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        return accessToken;
      }, fetchImpl);
      const sent = await client.sendMessage(message.raw, message.providerThreadId);
      return { providerMessageId: sent.id };
    },
  };
}
