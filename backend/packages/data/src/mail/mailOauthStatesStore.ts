import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openSecret, sealSecret } from "@semprec/credentials";
import { getOrCreateTenantDataKey, getTenantDataKey } from "../credentials/tenantKeysStore.js";
import type { Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";

/**
 * One-time OAuth states for connecting a Gmail or Outlook mailbox (issue #1483). The `state` sent to
 * the provider is a random opaque token of which only the SHA-256 hash is stored; the PKCE code
 * verifier is sealed under the tenant data key and is never returned by `createMailOauthState`.
 */
export const MAIL_OAUTH_PROVIDERS = ["gmail", "outlook"] as const;
export type MailOauthProvider = (typeof MAIL_OAUTH_PROVIDERS)[number];

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
}

export interface CreatedMailOauthState {
  /** The opaque value to send to the provider as `state`. */
  state: string;
  /** The S256 PKCE challenge derived from the stored verifier. */
  codeChallenge: string;
}

/**
 * Generates the state and PKCE verifier, seals the verifier under the current tenant's data key
 * (created on first use) and inserts the row, valid for 10 minutes. Inside a transaction a newly
 * created tenant key rolls back with the caller.
 */
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
       (id, tenant_id, user_id, provider, mailbox_item_id, state_hash, code_verifier_ciphertext, code_verifier_nonce)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [rowId, key.tenantId, input.userId, input.provider, input.mailboxItemId, hashState(state), ciphertext, nonce],
  );
  return { state, codeChallenge };
}

export interface ConsumedMailOauthState {
  provider: MailOauthProvider;
  mailboxItemId: string | null;
  codeVerifier: string;
}

/**
 * Consumes a state in one statement: the row is marked used only when its hash matches, it belongs
 * to `userId`, it has not expired and it is unused, so two racing calls succeed at most once. Returns
 * `null` in every other case without saying which condition failed. A verifier that cannot be opened
 * throws; the caller's transaction then rolls the consumption back.
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
    code_verifier_ciphertext: Buffer;
    code_verifier_nonce: Buffer;
  }>(
    `UPDATE mail_oauth_states
        SET used_at = now()
      WHERE state_hash = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING id, tenant_id, provider, mailbox_item_id, code_verifier_ciphertext, code_verifier_nonce`,
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
    codeVerifier: verifier.toString("utf8"),
  };
}
