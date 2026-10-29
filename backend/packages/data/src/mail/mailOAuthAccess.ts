import type { Pool } from "pg";
import { getDecryptedCredential, storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { logger } from "./logger.js";
import { refreshAccessToken } from "./oauthTokenExchange.js";

export interface RefreshAndPersistAccessTokenInput {
  /** The mailbox item whose `oauth2_refresh_token` credential is refreshed. */
  mailboxItemId: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /** Names the sync mode in `credential_access_log`, e.g. `gmail_sync`. */
  purpose: string;
}

export interface RefreshedAccessToken {
  accessToken: string;
  expiresAt: Date;
}

/**
 * Refreshes a mailbox's OAuth access token and persists a rotated refresh token (Microsoft rotates it
 * on every refresh; Google rarely does). One transaction holds a row lock on the mailbox's credential
 * from the read to the commit, so concurrent refreshes of one mailbox queue up and each later caller
 * reads the token the earlier one stored instead of presenting a stale one. The provider call runs
 * while that lock is held (bounded by `refreshAccessToken`'s 15 s timeout): releasing it first would
 * let a second caller present the token this call is about to retire.
 *
 * A new refresh token is written before the access token is returned; if that write fails the
 * transaction rolls back, the previous token stays stored, and the call throws. The provider may
 * already have retired the previous token, so the failure is logged. No log line or thrown message
 * carries a token. A 400/401 from the provider throws `MailReauthorizationRequiredError`.
 */
export async function refreshAndPersistAccessToken(
  pool: Pool,
  input: RefreshAndPersistAccessTokenInput,
): Promise<RefreshedAccessToken> {
  return withTransaction(pool, async (client) => {
    // Lock first; the decrypting read below then sees the committed token of the previous holder.
    const locked = await client.query<{ item_id: string }>(
      `SELECT item_id FROM external_credentials WHERE item_id = $1 FOR UPDATE`,
      [input.mailboxItemId],
    );
    if (locked.rows.length === 0) {
      throw new Error(`No OAuth credential is stored for mailbox ${input.mailboxItemId}`);
    }
    const refreshToken = await getDecryptedCredential(client, {
      itemId: input.mailboxItemId,
      actorType: "sync_worker",
      purpose: input.purpose,
    });
    if (refreshToken === null) {
      throw new Error(`No OAuth credential is stored for mailbox ${input.mailboxItemId}`);
    }

    const refreshed = await refreshAccessToken({
      tokenUrl: input.tokenUrl,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      refreshToken,
      ...(input.scope ? { scope: input.scope } : {}),
    });

    if (refreshed.refreshToken !== undefined) {
      try {
        await storeCredential(client, {
          itemId: input.mailboxItemId,
          credentialType: "oauth2_refresh_token",
          plaintext: refreshed.refreshToken,
        });
      } catch (err) {
        // The provider may already have invalidated the previous token, so this must be visible.
        // Only the error name is logged: its message could carry credential material.
        logger.error(
          { mailboxItemId: input.mailboxItemId, errorName: err instanceof Error ? err.name : typeof err },
          "Persisting a rotated OAuth refresh token failed; the mailbox may need reauthorization",
        );
        throw new Error(`Persisting the rotated OAuth refresh token failed for mailbox ${input.mailboxItemId}`, {
          cause: err,
        });
      }
    }
    return { accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
  });
}
