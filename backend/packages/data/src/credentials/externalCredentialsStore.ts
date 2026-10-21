import { decryptSecret, openSecret, resolveMasterKeyFromEnv, sealSecret } from "@semprec/credentials";
import type { Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { getOrCreateTenantDataKey, getTenantDataKey } from "./tenantKeysStore.js";

/**
 * Generic reversible-secret storage (issue #26): `item_id` references any `items` row that
 * needs a secret handed back later — a Mailbox here, an MCP server in issue #31 — never the
 * `users` login table (issue #34, hashed, not encrypted, no `items` row at all). One table,
 * one encryption module (`@semprec/credentials`), several narrow accessors over it — this
 * file is still the only place in the codebase allowed to decrypt a credential, and it reads both
 * schemes: `master` (secretbox under `CREDENTIALS_MASTER_KEY`) and `tenant` (AEAD under the tenant's
 * data key, bound to the tenant and item).
 */
export const CREDENTIAL_TYPES = [
  "oauth2_refresh_token",
  "app_password",
  "plain_password",
  "api_key",
  "bearer_token",
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

const CREDENTIAL_SCHEMES = ["master", "tenant"] as const;

/**
 * The associated data a `tenant` credential is sealed with, binding the ciphertext to its tenant and
 * item so it cannot be copied onto another row. Both ids are lowercase canonical UUID text.
 */
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
 * Seals under the current tenant's data key (created on first use), bound to `tenant_id‖item_id`,
 * marks the row `tenant` and stores/replaces the one credential this item holds (`item_id` is the
 * table's PK — one credential per item, see the migration's header note). Replacing a `master` row
 * turns it into a `tenant` row. Inside a transaction a newly created tenant key rolls back with the
 * caller. `key_version` is written as 1 and is not meaningful on a `tenant` row: the version of the
 * master key wrapping the tenant's data key lives in `tenant_keys.master_key_version`.
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

export interface DecryptCredentialInput {
  itemId: string;
  actorType: CredentialActorType;
  actorId?: string;
  /** e.g. 'imap_sync' | 'smtp_send' | 'test_connection' | 'mcp_connect' — keeps `credential_access_log` attributable. */
  purpose: string;
}

/**
 * The narrow decryption accessor — the only function in this codebase that decrypts a credential,
 * under either scheme: `tenant` rows are what `storeCredential` writes, `master` rows are those
 * written before it sealed under the tenant key and not yet re-encrypted. Logs every decryption
 * *attempt* to `credential_access_log` — the log insert runs before the decryption itself (see
 * mailSyncJob.ts's caller-side note: this is intentional, so a decrypt failure downstream of a real key/ciphertext still leaves the
 * access attempt on record) — and returns `null` (no log entry) only when there is nothing to
 * decrypt at all, since "no credential stored" is not itself a credential access. Callers: the
 * mail sync worker (every sync cycle) and the MCP connection manager (once per opened
 * transport) — never an agent tool.
 */
export async function getDecryptedCredential(client: Queryable, input: DecryptCredentialInput): Promise<string | null> {
  const { rows } = await client.query<{
    ciphertext: Buffer;
    nonce: Buffer;
    key_version: number;
    tenant_id: string;
    scheme: string;
  }>(`SELECT ciphertext, nonce, key_version, tenant_id, scheme FROM external_credentials WHERE item_id = $1`, [
    input.itemId,
  ]);
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

  const scheme = assertKnownValue(CREDENTIAL_SCHEMES, row.scheme, "credential scheme");
  if (scheme === "master") {
    const key = resolveMasterKeyFromEnv(row.key_version);
    return decryptSecret({ ciphertext: row.ciphertext, nonce: row.nonce }, key);
  }

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
