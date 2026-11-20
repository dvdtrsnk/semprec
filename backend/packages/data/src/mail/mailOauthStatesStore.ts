import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openSecret, sealSecret } from "@semprec/credentials";
import { getOrCreateTenantDataKey, getTenantDataKey } from "../credentials/tenantKeysStore.js";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { MAIL_ACCOUNT_SERVICES, type MailAccountService } from "./oauthServiceScopes.js";

/**
 * One-time OAuth states for connecting a mailbox. Only the SHA-256 hash of the opaque `state` is stored; the PKCE
 * verifier is sealed under the tenant data key and never returned.
 */
export const MAIL_OAUTH_PROVIDERS = ["gmail", "outlook"] as const;
export type MailOauthProvider = (typeof MAIL_OAUTH_PROVIDERS)[number];

/** Where the public callback sends the browser instead of answering JSON. */
export const MAIL_OAUTH_REDIRECT_TARGETS = ["app"] as const;
export type MailOauthRedirectTarget = (typeof MAIL_OAUTH_REDIRECT_TARGETS)[number];

/** The app's registered URL scheme, opened by the system browser sheet the sign-in runs in. */
const REDIRECT_TARGET_URLS: Record<MailOauthRedirectTarget, string> = { app: "semprec://oauth" };

const RANDOM_BYTES = 32;

function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

/** Binds the sealed verifier to its tenant and row so the ciphertext cannot be copied elsewhere. */
function verifierAssociatedData(tenantId: string, rowId: string): Buffer {
  return Buffer.from(`semprec:mail-oauth-state:v1:${tenantId.toLowerCase()}:${rowId.toLowerCase()}`, "utf8");
}

export interface CreateMailOauthStateInput {
  userId: string;
  provider: MailOauthProvider;
  /** Null starts a new account; a mailbox item id reauthorizes that mailbox. */
  mailboxItemId: string | null;
  /** The services the authorization request asked consent for. */
  services: readonly MailAccountService[];
  /** Null: the callback answers JSON. */
  redirectTarget: MailOauthRedirectTarget | null;
}

export interface CreatedMailOauthState {
  state: string;
  codeChallenge: string;
}

/** The row is valid for 10 minutes. Inside a transaction a newly created tenant key rolls back with the caller. */
export async function createMailOauthState(
  client: Queryable,
  input: CreateMailOauthStateInput,
): Promise<CreatedMailOauthState> {
  const state = randomBytes(RANDOM_BYTES).toString("base64url");
  const codeVerifier = randomBytes(RANDOM_BYTES).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
  const rowId = randomUUID();
  const key = await getOrCreateTenantDataKey(client);
  const { ciphertext, nonce } = await sealSecret(
    codeVerifier,
    key.dataKey,
    verifierAssociatedData(key.tenantId, rowId),
  );
  await client.query(
    `INSERT INTO mail_oauth_states
       (id, tenant_id, user_id, provider, mailbox_item_id, state_hash, code_verifier_ciphertext, code_verifier_nonce,
        services, redirect_target)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      rowId,
      key.tenantId,
      input.userId,
      input.provider,
      input.mailboxItemId,
      hashState(state),
      ciphertext,
      nonce,
      [...input.services],
      input.redirectTarget,
    ],
  );
  return { state, codeChallenge };
}

export interface ConsumedMailOauthState {
  provider: MailOauthProvider;
  mailboxItemId: string | null;
  services: MailAccountService[];
  codeVerifier: string;
}

/**
 * Consumes a state in one guarded statement (hash, `userId`, unexpired, unused), so two racing calls succeed at most
 * once. Returns `null` without saying which condition failed. A verifier that cannot be opened throws, and the
 * caller's rollback undoes the consumption.
 */
export async function consumeMailOauthState(
  client: Queryable,
  input: { state: string; userId: string },
): Promise<ConsumedMailOauthState | null> {
  const { rows } = await client.query<{
    id: string;
    tenant_id: string;
    provider: string;
    mailbox_item_id: string | null;
    services: string[];
    code_verifier_ciphertext: Buffer;
    code_verifier_nonce: Buffer;
  }>(
    `UPDATE mail_oauth_states
        SET used_at = now()
      WHERE state_hash = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING id, tenant_id, provider, mailbox_item_id, services, code_verifier_ciphertext, code_verifier_nonce`,
    [hashState(input.state), input.userId],
  );
  const row = rows[0];
  if (!row) return null;

  const tenantKey = await getTenantDataKey(client);
  if (!tenantKey || tenantKey.tenantId !== row.tenant_id) {
    throw new Error("No data key for this OAuth state's tenant");
  }
  const verifier = await openSecret(
    { ciphertext: row.code_verifier_ciphertext, nonce: row.code_verifier_nonce },
    tenantKey.dataKey,
    verifierAssociatedData(row.tenant_id, row.id),
  );
  return {
    provider: assertKnownValue(MAIL_OAUTH_PROVIDERS, row.provider, "mail_oauth_states.provider"),
    mailboxItemId: row.mailbox_item_id,
    services: row.services.map((service) =>
      assertKnownValue(MAIL_ACCOUNT_SERVICES, service, "mail_oauth_states.services"),
    ),
    codeVerifier: verifier.toString("utf8"),
  };
}

/**
 * The redirect URL the public callback answers with for `state`, or `null` (answer JSON) for a state that is unknown,
 * used, expired or asked for no redirect. Called without a tenant: `route_mail_oauth_state` names the tenant of an
 * open state by its hash, and the target is then read inside that tenant. Reads only; the state stays open for the
 * authenticated completion.
 */
export async function resolveMailOauthRedirectUrl(pool: Pool, state: string): Promise<string | null> {
  const stateHash = hashState(state);
  const tenantIds = await runAsSystem("mail-oauth-callback", async () => {
    const { rows } = await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM route_mail_oauth_state($1)", [
      stateHash,
    ]);
    return rows.map((row) => row.tenant_id);
  });
  // Hashes are unique per tenant only; a hash open in two tenants names neither.
  const [tenantId] = tenantIds;
  if (tenantId === undefined || tenantIds.length > 1) return null;
  const { rows } = await runInTenant(tenantId, () =>
    pool.query<{ redirect_target: string | null }>(
      `SELECT redirect_target FROM mail_oauth_states
        WHERE state_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [stateHash],
    ),
  );
  const target = rows[0]?.redirect_target ?? null;
  if (target === null) return null;
  return REDIRECT_TARGET_URLS[
    assertKnownValue(MAIL_OAUTH_REDIRECT_TARGETS, target, "mail_oauth_states.redirect_target")
  ];
}
