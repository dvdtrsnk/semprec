import { hash, verify } from "@node-rs/argon2";

/** The library defaults are already Argon2id at OWASP-recommended cost; do not override them. */
export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** A malformed hash simply does not verify; never throws. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
