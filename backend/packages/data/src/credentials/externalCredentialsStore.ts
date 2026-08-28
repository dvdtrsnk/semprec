import { encryptSecret, decryptSecret, resolveMasterKeyFromEnv } from "@semprec/credentials";
import type { Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";

/**
 * Generic reversible-secret storage (issue #26): `item_id` references any `items` row that
 * needs a secret handed back later — a Mailbox here, an MCP server in issue #31 — never the
 * `users` login table (issue #34, hashed, not encrypted, no `items` row at all). One table,
 * one encryption module (`@semprec/credentials`), several narrow accessors over it — this
 * file is the only place in the codebase allowed to call `decryptSecret`.
 */
export const CREDENTIAL_TYPES = ["oauth2_refresh_token", "app_password", "plain_password", "api_key", "bearer_token"] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const CREDENTIAL_ACTOR_TYPES = ["user", "sync_worker", "smtp_send", "mcp_connection_manager", "ai_agent"] as const;
export type CredentialActorType = (typeof CREDENTIAL_ACTOR_TYPES)[number];

export interface StoreCredentialInput {
  itemId: string;
  credentialType: CredentialType;
  plaintext: string;
  /** Defaults to the current key (1) — only a key-rotation migration should ever pass a different version. */
  keyVersion?: number;
}

/** Encrypts and stores/replaces the one credential this item holds (`item_id` is the table's PK — one credential per item, see the migration's header note). */
export async function storeCredential(client: Queryable, input: StoreCredentialInput): Promise<void> {
  const keyVersion = input.keyVersion ?? 1;
  const key = resolveMasterKeyFromEnv(keyVersion);
  const { ciphertext, nonce } = await encryptSecret(input.plaintext, key);
  await client.query(
    `INSERT INTO external_credentials (item_id, credential_type, ciphertext, nonce, key_version)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (item_id) DO UPDATE SET credential_type = EXCLUDED.credential_type, ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, key_version = EXCLUDED.key_version`,
    [input.itemId, input.credentialType, ciphertext, nonce, keyVersion],
  );
}

export async function deleteCredential(client: Queryable, itemId: string): Promise<void> {
  await client.query(`DELETE FROM external_credentials WHERE item_id = $1`, [itemId]);
}

export async function hasCredential(client: Queryable, itemId: string): Promise<boolean> {
  const { rows } = await client.query(`SELECT 1 FROM external_credentials WHERE item_id = $1`, [itemId]);
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
 * The narrow decryption accessor — the only function in this codebase that ever calls
 * `decryptSecret`. Logs every decryption *attempt* to `credential_access_log` — the log
 * insert runs before `decryptSecret` itself (see mailSyncJob.ts's caller-side note: this is
 * intentional, so a decrypt failure downstream of a real key/ciphertext still leaves the
 * access attempt on record) — and returns `null` (no log entry) only when there is nothing to
 * decrypt at all, since "no credential stored" is not itself a credential access. Callers: the
 * mail sync worker (every sync cycle) and the MCP connection manager (once per opened
 * transport) — never an agent tool.
 */
export async function getDecryptedCredential(client: Queryable, input: DecryptCredentialInput): Promise<string | null> {
  const { rows } = await client.query<{ ciphertext: Buffer; nonce: Buffer; key_version: number }>(
    `SELECT ciphertext, nonce, key_version FROM external_credentials WHERE item_id = $1`,
    [input.itemId],
  );
  const row = rows[0];
  if (!row) return null;

  await client.query(`INSERT INTO credential_access_log (item_id, actor_type, actor_id, purpose) VALUES ($1, $2, $3, $4)`, [
    input.itemId,
    assertKnownValue(CREDENTIAL_ACTOR_TYPES, input.actorType, "credential access actor type"),
    input.actorId ?? null,
    input.purpose,
  ]);

  const key = resolveMasterKeyFromEnv(row.key_version);
  return decryptSecret({ ciphertext: row.ciphertext, nonce: row.nonce }, key);
}
