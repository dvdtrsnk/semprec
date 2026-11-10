import type { Pool } from "pg";
import { currentTenantScope, TenantScopeMissingError } from "@semprec/shared";
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
  /** Names the sync mode in `credential_access_log`, e.g. `gmail_api_sync`. */
  purpose: string;
  /** Replaces the global `fetch` for the token request (see `RefreshAccessTokenInput.fetchImpl`). */
  fetchImpl?: typeof fetch;
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
 * already have retired the previous token, so the code attempts to log the failure. No log line or thrown message
 * carries a token. A 400/401 from the provider throws `MailReauthorizationRequiredError`.
 */
export async function refreshAndPersistAccessToken(
  pool: Pool,
  input: RefreshAndPersistAccessTokenInput,
): Promise<RefreshedAccessToken> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new TenantScopeMissingError("Mail OAuth refresh requires a tenant scope");
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ isolation: string; tenant: string | null }>(
      "SELECT current_setting('transaction_isolation') AS isolation, app_current_tenant()::text AS tenant",
    );
    if (rows[0]?.isolation !== "read committed" || rows[0].tenant !== scope.tenantId) {
      throw new Error("Mail OAuth refresh requires a READ COMMITTED tenant transaction");
    }
    await client.query(`SELECT
      set_config('lock_timeout', CASE WHEN current_setting('lock_timeout')::interval = interval '0'
        OR current_setting('lock_timeout')::interval > interval '30 seconds' THEN '30s'
        ELSE current_setting('lock_timeout') END, true),
      set_config('statement_timeout', CASE WHEN current_setting('statement_timeout')::interval = interval '0'
        OR current_setting('statement_timeout')::interval > interval '60 seconds' THEN '60s'
        ELSE current_setting('statement_timeout') END, true)`);
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
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
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
        // Error names and causes can themselves contain credential material.
        const observed: unknown[] = [err];
        try {
          logger.error(
            { mailboxItemId: input.mailboxItemId, stage: "persist_refresh_token" },
            "Persisting a rotated OAuth refresh token failed; the mailbox may need reauthorization",
          );
        } catch (diagnosticError) {
          observed.push(diagnosticError);
        }
        void observed;
        // The raw cause can contain the newly rotated token and must not escape this boundary.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`Persisting the rotated OAuth refresh token failed for mailbox ${input.mailboxItemId}`);
      }
    }
    return { accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
  });
}
