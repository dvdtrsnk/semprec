import type { Pool } from "pg";
import { GmailRestClient } from "./gmailRestClient.js";
import { refreshAndPersistAccessToken } from "./mailOAuthAccess.js";
import { GOOGLE_TOKEN_URL } from "./oauthTokenExchange.js";
import type { MailTransport } from "./mailTransport.js";

/** Names the send's token refresh in `credential_access_log`, next to `gmail_api_sync` for the sync pass. */
export const GMAIL_SEND_PURPOSE = "gmail_api_send";

export interface GmailMailTransportOptions {
  pool: Pool;
  mailboxItemId: string;
  clientId: string;
  clientSecret: string;
  /** Replaces the global `fetch` for the token endpoint and the Gmail API. Tests inject a fake Google here. */
  fetchImpl?: typeof fetch;
}

/**
 * The transport of a `gmail_api` mailbox. Each send refreshes an access token from the stored refresh token
 * (`refreshAndPersistAccessToken`, under its row lock), then submits the raw MIME with `users.messages.send`.
 * A provider thread id on the message becomes the send's `threadId`, which files a reply into its Gmail conversation.
 * The Message-ID inside the MIME is sent unchanged. The sent draft's `mail_message_meta` row keeps that id (send.ts),
 * which is the key ingest matches a later synced copy against.
 *
 * The client is built per send, so no access token outlives the send that obtained it. A refresh or send that
 * throws leaves nothing behind that a later send could reuse.
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
