import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;

/**
 * High-entropy tokens need no slow hash; SHA-256 suffices to keep a stolen DB dump from yielding
 * live sessions.
 */
export interface OpaqueToken {
  /** Returned to the client once, never persisted. */
  token: string;
  tokenHash: string;
}

export function generateOpaqueToken(): OpaqueToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time against timing leaks; `false` (never throws) on mismatched lengths. */
export function secureCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
