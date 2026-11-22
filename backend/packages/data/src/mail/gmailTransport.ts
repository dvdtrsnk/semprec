import type { Pool } from "pg";
import { GmailRestClient } from "./gmailRestClient.js";
import { refreshAndPersistAccessToken } from "./mailOAuthAccess.js";
import { GOOGLE_TOKEN_URL } from "./oauthTokenExchange.js";
import type { MailTransport } from "./mailTransport.js";
import { logger } from "./logger.js";

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
 * Each send refreshes the access token under its row lock and submits the raw MIME unchanged. Gmail files the message
 * under a Message-ID of its own, so the send reads it back and reports it with the provider ids, letting the caller
 * record the identity the later synced copy will carry. The client is built per send so no access token outlives it.
 */
export function createGmailMailTransport(options: GmailMailTransportOptions): MailTransport {
  const { pool, mailboxItemId, clientId, clientSecret, fetchImpl } = options;
  return {
    async send(message) {
      // One refresh per send: the send and its read-back share the token.
      let accessToken: Promise<string> | null = null;
      const client = new GmailRestClient(() => (accessToken ??= refreshSendToken()), fetchImpl);
      async function refreshSendToken(): Promise<string> {
        const { accessToken: token } = await refreshAndPersistAccessToken(pool, {
          mailboxItemId,
          tokenUrl: GOOGLE_TOKEN_URL,
          clientId,
          clientSecret,
          purpose: GMAIL_SEND_PURPOSE,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        return token;
      }
      const sent = await client.sendMessage(message.raw, message.providerThreadId);
      // The message is delivered from here on, so a failed read-back must not fail the send: the caller then keeps the
      // submitted Message-ID and the later synced copy is ingested beside it.
      let messageId: string | undefined;
      try {
        messageId = (await client.fetchMessage(sent.id, "metadata"))?.message.messageId;
      } catch (err) {
        logger.warn(
          { mailboxItemId, errorName: err instanceof Error ? err.name : typeof err },
          "Gmail sent message read-back failed; its Message-ID stays the submitted one",
        );
      }
      return { providerMessageId: sent.id, providerThreadId: sent.threadId, ...(messageId ? { messageId } : {}) };
    },
  };
}
