import sodium from "libsodium-wrappers";

/**
 * Reversible encryption for third-party secrets the server must present again later
 * (an IMAP password, an OAuth refresh token, an MCP server's API key) — as opposed to a
 * user's own login password (issue #34), which is hashed one-way and never needs to be
 * recovered. Not email-specific: this module is a peer of `data`/`module-registry`/`queue`,
 * used by `packages/data/src/credentials/externalCredentialsStore.ts` for any `items` row
 * that needs a secret (Mailboxes here; MCP servers in issue #31).
 *
 * Two schemes live here:
 * - `encryptSecret`/`decryptSecret` use `crypto_secretbox_easy` (XSalsa20-Poly1305) directly
 *   under the deployment master key. They carry no associated data, so a ciphertext copied onto
 *   another row decrypts there. They remain only until the sealed scheme has replaced them.
 * - `sealSecret`/`openSecret` use XChaCha20-Poly1305 (IETF AEAD) with caller-supplied associated
 *   data that binds a ciphertext to its owner. New data uses this scheme, under a per-tenant data
 *   key that `wrapDataKey`/`unwrapDataKey` protect with the master key
 *   (docs/adr/2026-10-05-per-tenant-envelope-encryption.md).
 */

let readyPromise: Promise<typeof sodium> | null = null;

async function ready(): Promise<typeof sodium> {
  readyPromise ??= sodium.ready.then(() => sodium);
  return readyPromise;
}

export interface EncryptedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
}

/** Encrypts `plaintext` under `key` (must be exactly `crypto_secretbox_KEYBYTES` = 32 bytes). */
export async function encryptSecret(plaintext: string, key: Buffer): Promise<EncryptedSecret> {
  const s = await ready();
  if (key.length !== s.crypto_secretbox_KEYBYTES) {
    throw new Error(`Master key must be ${s.crypto_secretbox_KEYBYTES} bytes, got ${key.length}`);
  }
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ciphertext = s.crypto_secretbox_easy(s.from_string(plaintext), nonce, key);
  return { ciphertext: Buffer.from(ciphertext), nonce: Buffer.from(nonce) };
}

/** Inverse of `encryptSecret`. Throws if `key`/`nonce` don't match — never returns a partial/corrupted result. */
export async function decryptSecret(encrypted: EncryptedSecret, key: Buffer): Promise<string> {
  const s = await ready();
  let plaintext: Uint8Array;
  try {
    plaintext = s.crypto_secretbox_open_easy(encrypted.ciphertext, encrypted.nonce, key);
  } catch {
    throw new Error("Failed to decrypt secret: wrong key or corrupted ciphertext");
  }
  return s.to_string(plaintext);
}

export const MASTER_KEY_BYTES = 32;

/**
 * Resolves a versioned master key from the process environment — `CREDENTIALS_MASTER_KEY`
 * for version 1, `CREDENTIALS_MASTER_KEY_V<n>` for a later rotated version (`key_version`
 * on `external_credentials`). A single self-hosted, single-tenant deployment's key lives in
 * root-owned `shared/.env` (issue #40), outside git and outside the data backup — never in
 * application config or a database row, and never logged (see `resolveMasterKeyFromEnv`'s
 * callers, which only ever pass the decoded `Buffer` onward, never the raw env string).
 */
export function resolveMasterKeyFromEnv(keyVersion: number, env: NodeJS.ProcessEnv = process.env): Buffer {
  const varName = keyVersion === 1 ? "CREDENTIALS_MASTER_KEY" : `CREDENTIALS_MASTER_KEY_V${keyVersion}`;
  const raw = env[varName];
  if (!raw) throw new Error(`${varName} is not set`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(`${varName} must decode to ${MASTER_KEY_BYTES} bytes (got ${key.length})`);
  }
  return key;
}

export const DATA_KEY_BYTES = 32;

/** A fresh random tenant data key. */
export async function generateDataKey(): Promise<Buffer> {
  const s = await ready();
  return Buffer.from(s.crypto_aead_xchacha20poly1305_ietf_keygen());
}

/** Seals `plaintext` under `key` with a fresh random nonce, binding it to `associatedData`. */
export async function sealSecret(
  plaintext: string | Uint8Array,
  key: Buffer,
  associatedData: Uint8Array,
): Promise<EncryptedSecret> {
  const s = await ready();
  if (key.length !== DATA_KEY_BYTES) {
    throw new Error(`Data key must be ${DATA_KEY_BYTES} bytes, got ${key.length}`);
  }
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, associatedData, null, nonce, key);
  return { ciphertext: Buffer.from(ciphertext), nonce: Buffer.from(nonce) };
}

/**
 * Inverse of `sealSecret`. Throws one plain error — deliberately without a `code` property, which
 * database-failure detection would misread — when the key, associated data or ciphertext do not match.
 */
export async function openSecret(encrypted: EncryptedSecret, key: Buffer, associatedData: Uint8Array): Promise<Buffer> {
  const s = await ready();
  try {
    return Buffer.from(
      s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, encrypted.ciphertext, associatedData, encrypted.nonce, key),
    );
  } catch {
    throw new Error("Failed to open sealed secret: wrong key, associated data or corrupted ciphertext");
  }
}

function dataKeyWrapAssociatedData(tenantId: string): Uint8Array {
  return new TextEncoder().encode(`semprec:tenant-key:v1:${tenantId}`);
}

/** Wraps a tenant's data key under the master key, bound to `tenantId` (lowercase canonical UUID text). */
export async function wrapDataKey(dataKey: Buffer, masterKey: Buffer, tenantId: string): Promise<EncryptedSecret> {
  return sealSecret(dataKey, masterKey, dataKeyWrapAssociatedData(tenantId));
}

/** Inverse of `wrapDataKey`; also rejects a result that is not a 32-byte key. */
export async function unwrapDataKey(wrapped: EncryptedSecret, masterKey: Buffer, tenantId: string): Promise<Buffer> {
  const dataKey = await openSecret(wrapped, masterKey, dataKeyWrapAssociatedData(tenantId));
  if (dataKey.length !== DATA_KEY_BYTES) {
    throw new Error(`Unwrapped data key must be ${DATA_KEY_BYTES} bytes, got ${dataKey.length}`);
  }
  return dataKey;
}
