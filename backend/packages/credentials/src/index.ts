import sodium from "libsodium-wrappers";

/**
 * Reversible encryption for third-party secrets the server must present again (an IMAP password,
 * an OAuth refresh token, an MCP server's API key), as opposed to one-way hashed login passwords.
 *
 * `sealSecret`/`openSecret` use XChaCha20-Poly1305 (IETF AEAD) with associated data binding a
 * ciphertext to its owner. A credential is sealed under its tenant's data key; the deployment
 * master key (`CREDENTIALS_MASTER_KEY`) only wraps and unwraps those data keys
 * (docs/architecture/tenancy-and-security.md#third-party-secrets).
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

export const MASTER_KEY_BYTES = 32;

/**
 * Resolves a versioned master key from the environment: `CREDENTIALS_MASTER_KEY` for version 1,
 * `CREDENTIALS_MASTER_KEY_V<n>` for a rotated version (`tenant_keys.master_key_version`). The key
 * lives in root-owned `shared/.env`, outside git and the data backup, never in config or a
 * database row, and is never logged.
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
  return new TextEncoder().encode(`alldots:tenant-key:v1:${tenantId}`);
}

/**
 * Wraps a tenant's data key under the master key, bound to `tenantId` (lowercase canonical UUID text).
 * Rejects a `dataKey` that is not 32 bytes, so it never wraps a value `unwrapDataKey` would refuse.
 */
export async function wrapDataKey(dataKey: Buffer, masterKey: Buffer, tenantId: string): Promise<EncryptedSecret> {
  if (dataKey.length !== DATA_KEY_BYTES) {
    throw new Error(`Data key to wrap must be ${DATA_KEY_BYTES} bytes, got ${dataKey.length}`);
  }
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
