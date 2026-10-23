import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;

/**
 * A session token is high-entropy and single-use-per-session already, so it's hashed with a
 * fast, unsalted digest (SHA-256) rather than Argon2id — Argon2id's slowness defends against
 * brute-forcing a low-entropy secret (a password), which doesn't apply here; what the hash
 * defends against is a stolen database dump handing out live sessions directly.
 */
export interface OpaqueToken {
  /** The raw, opaque token — returned to the client once, never persisted. */
  token: string;
  /** What gets stored in `sessions.token_hash`. */
  tokenHash: string;
}

export function generateOpaqueToken(): OpaqueToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time equality for two secret hashes — a plain `===` short-circuits on the first
 * differing byte, which leaks how many leading bytes matched through response timing.
 * Returns `false` (never throws) on mismatched lengths, since two hex digests of different
 * length are trivially unequal and don't need — or admit — constant-time comparison.
 */
export function secureCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
