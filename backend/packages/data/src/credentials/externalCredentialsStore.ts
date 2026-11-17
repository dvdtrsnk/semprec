import { openSecret, sealSecret } from "@semprec/credentials";
import type { Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { getOrCreateTenantDataKey, getTenantDataKey } from "./tenantKeysStore.js";

/**
 * Reversible-secret storage for any `items` row that needs a secret back later (a Mailbox, an MCP server); login
 * passwords are hashed elsewhere. This file is the only place allowed to decrypt a credential. Every row uses the
 * `tenant` scheme: AEAD under the tenant's data key, bound to tenant and item.
 */
export const CREDENTIAL_TYPES = [
  "oauth2_refresh_token",
  "app_password",
  "plain_password",
  "api_key",
  "bearer_token",
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/** Binds the ciphertext to its tenant and item so it cannot be copied onto another row. */
function credentialAssociatedData(tenantId: string, itemId: string): Buffer {
  return Buffer.from(`semprec:external-credential:v1:${tenantId.toLowerCase()}:${itemId.toLowerCase()}`, "utf8");
}

export const CREDENTIAL_ACTOR_TYPES = [
  "user",
  "sync_worker",
  "smtp_send",
  "mcp_connection_manager",
  "ai_agent",
] as const;
export type CredentialActorType = (typeof CREDENTIAL_ACTOR_TYPES)[number];

export interface StoreCredentialInput {
  itemId: string;
  credentialType: CredentialType;
  plaintext: string;
}

/**
 * Seals under the tenant's data key (created on first use; rolls back with the caller's transaction) and
 * stores or replaces the item's one credential (`item_id` is the PK). `key_version` is always 1 and meaningless
 * on a `tenant` row; the wrapping master key version lives in `tenant_keys.master_key_version`.
 */
export async function storeCredential(client: Queryable, input: StoreCredentialInput): Promise<void> {
  const key = await getOrCreateTenantDataKey(client);
  const { ciphertext, nonce } = await sealSecret(
    input.plaintext,
    key.dataKey,
    credentialAssociatedData(key.tenantId, input.itemId),
  );
  await client.query(
    `INSERT INTO external_credentials (tenant_id, item_id, credential_type, ciphertext, nonce, key_version, scheme)
     VALUES ($1, $2, $3, $4, $5, 1, 'tenant')
     ON CONFLICT (item_id) DO UPDATE SET credential_type = EXCLUDED.credential_type, ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, key_version = EXCLUDED.key_version, scheme = EXCLUDED.scheme`,
    [key.tenantId, input.itemId, input.credentialType, ciphertext, nonce],
  );
}

export async function deleteCredential(client: Queryable, itemId: string): Promise<void> {
  await client.query(`DELETE FROM external_credentials WHERE item_id = $1`, [itemId]);
}

export async function hasCredential(client: Queryable, itemId: string): Promise<boolean> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT 1 FROM external_credentials WHERE item_id = $1`,
    [itemId],
  );
  return rows.length > 0;
}

/** Reads the type only: nothing is decrypted, so no `credential_access_log` entry. */
export async function getCredentialType(client: Queryable, itemId: string): Promise<CredentialType | null> {
  const { rows } = await client.query<{ credential_type: string }>(
    `SELECT credential_type FROM external_credentials WHERE item_id = $1`,
    [itemId],
  );
  const row = rows[0];
  return row ? assertKnownValue(CREDENTIAL_TYPES, row.credential_type, "credential type") : null;
}

export interface DecryptCredentialInput {
  itemId: string;
  actorType: CredentialActorType;
  actorId?: string;
  /** e.g. 'imap_sync' | 'smtp_send' | 'test_connection' | 'mcp_connect', so the access log is attributable. */
  purpose: string;
}

/**
 * The only function that decrypts a credential. Every attempt is logged to `credential_access_log` before
 * decrypting, so a failed decrypt is still on record; returns `null` without a log entry only when nothing is
 * stored. Callers: mail sync, the MCP connection manager, and mailbox removal (OAuth cleanup at the provider),
 * never an agent tool.
 */
export async function getDecryptedCredential(client: Queryable, input: DecryptCredentialInput): Promise<string | null> {
  const { rows } = await client.query<{
    ciphertext: Buffer;
    nonce: Buffer;
    tenant_id: string;
    scheme: string;
  }>(`SELECT ciphertext, nonce, tenant_id, scheme FROM external_credentials WHERE item_id = $1`, [input.itemId]);
  const row = rows[0];
  if (!row) return null;

  await client.query(
    `INSERT INTO credential_access_log (item_id, actor_type, actor_id, purpose) VALUES ($1, $2, $3, $4)`,
    [
      input.itemId,
      assertKnownValue(CREDENTIAL_ACTOR_TYPES, input.actorType, "credential access actor type"),
      input.actorId ?? null,
      input.purpose,
    ],
  );

  // Throws like a decrypt failure, after the log insert.
  assertKnownValue(["tenant"], row.scheme, "credential scheme");

  const tenantKey = await getTenantDataKey(client);
  if (!tenantKey || tenantKey.tenantId !== row.tenant_id) {
    throw new Error("No data key for this credential's tenant");
  }
  const plaintext = await openSecret(
    { ciphertext: row.ciphertext, nonce: row.nonce },
    tenantKey.dataKey,
    credentialAssociatedData(row.tenant_id, input.itemId),
  );
  return plaintext.toString("utf8");
}
