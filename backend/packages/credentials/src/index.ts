import sodium from "libsodium-wrappers";

/**
 * Reversible encryption for third-party secrets the server must present again later
 * (an IMAP password, an OAuth refresh token, an MCP server's API key) — as opposed to a
 * user's own login password (issue #34), which is hashed one-way and never needs to be
 * recovered. Not email-specific: this module is a peer of `data`/`module-registry`/`queue`,
 * used by `packages/data/src/credentials/externalCredentialsStore.ts` for any `items` row
 * that needs a secret (Mailboxes here; MCP servers in issue #31).
 *
 * `crypto_secretbox_easy` (XSalsa20-Poly1305) is libsodium's own recommended
 * authenticated-encryption primitive for this shape (secret key + random nonce) — the
 * issue text names it "XChaCha20-Poly1305," but libsodium's `crypto_secretbox_*` family is
 * XSalsa20-Poly1305; XChaCha20-Poly1305 lives under `crypto_aead_xchacha20poly1305_ietf`
 * instead. `crypto_secretbox_easy` is the function this module's design explicitly names,
 * so that's what is implemented — both are modern, unbroken AEAD constructions with no
 * practical difference to this use case (one key, one random nonce, small plaintext).
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
