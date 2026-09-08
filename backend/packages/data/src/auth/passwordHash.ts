import { hash, verify } from "@node-rs/argon2";

/**
 * `@node-rs/argon2`'s defaults are already Argon2id at OWASP-recommended cost (m=19456
 * KiB, t=2, p=1) — the issue asks for "Argon2id", not a specific cost, so there is no
 * tuning to do here beyond not overriding the library's choice.
 */
export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** Never throws on a wrong password or a malformed hash — both are simply "doesn't verify". */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
