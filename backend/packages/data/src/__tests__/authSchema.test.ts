import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { hashPassword } from "../auth/passwordHash.js";
import { generateOpaqueToken } from "../auth/token.js";
import { createUser, getUserByEmail, getUserById } from "../auth/usersStore.js";
import {
  createSession,
  getActiveSessionByTokenHash,
  listSessionsForUser,
  revokeSession,
} from "../auth/sessionsStore.js";
import { countRecentFailedAttempts, recordLoginAttempt } from "../auth/loginAttemptsStore.js";

let pool: Pool;

async function makeUser(pool: Pool, email = "person@example.com") {
  return createUser(pool, { email, passwordHash: await hashPassword("s3cret-password") });
}

describe("auth schema (issue #139)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates a user with locale defaulting to 'cs', and never persists the raw password", async () => {
    const user = await createUser(pool, { email: "a@example.com", passwordHash: await hashPassword("hunter2") });

    expect(user.locale).toBe("cs");
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain("hunter2");

    const { rows } = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [
      user.id,
    ]);
    expect(rows[0]!.password_hash).not.toContain("hunter2");

    expect(await getUserByEmail(pool, "a@example.com")).toEqual(user);
    expect(await getUserById(pool, user.id)).toEqual(user);
  });

  it("rejects a duplicate email", async () => {
    await createUser(pool, { email: "dup@example.com", passwordHash: await hashPassword("first") });
    await expect(
      createUser(pool, { email: "dup@example.com", passwordHash: await hashPassword("second") }),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("lets one user hold two live sessions at once, one per device", async () => {
    const user = await makeUser(pool);
    const expiresAt = new Date(Date.now() + 60_000);

    const web = await createSession(pool, {
      userId: user.id,
      tokenHash: generateOpaqueToken().tokenHash,
      platform: "web",
      expiresAt,
    });
    const ios = await createSession(pool, {
      userId: user.id,
      tokenHash: generateOpaqueToken().tokenHash,
      platform: "ios",
      expiresAt,
    });

    const sessions = await listSessionsForUser(pool, user.id);
    expect(sessions.map((s) => s.id).sort()).toEqual([web.id, ios.id].sort());
  });

  it("rejects a duplicate token hash across sessions", async () => {
    const user = await makeUser(pool);
    const { tokenHash } = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + 60_000);

    await createSession(pool, { userId: user.id, tokenHash, platform: "web", expiresAt });
    await expect(createSession(pool, { userId: user.id, tokenHash, platform: "macos", expiresAt })).rejects.toThrow(
      /duplicate key|unique/i,
    );
  });

  it("only resolves an active session — not an expired or a revoked one", async () => {
    const user = await makeUser(pool);

    const live = await createSession(pool, {
      userId: user.id,
      tokenHash: generateOpaqueToken().tokenHash,
      platform: "web",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await getActiveSessionByTokenHash(pool, live.tokenHash)).toEqual(live);

    const expired = await createSession(pool, {
      userId: user.id,
      tokenHash: generateOpaqueToken().tokenHash,
      platform: "web",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await getActiveSessionByTokenHash(pool, expired.tokenHash)).toBeNull();

    const revoked = await createSession(pool, {
      userId: user.id,
      tokenHash: generateOpaqueToken().tokenHash,
      platform: "web",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await revokeSession(pool, revoked.id);
    expect(await getActiveSessionByTokenHash(pool, revoked.tokenHash)).toBeNull();
  });

  it("rejects platform values outside web/ios/macos", async () => {
    const user = await makeUser(pool);
    await expect(
      createSession(pool, {
        userId: user.id,
        tokenHash: generateOpaqueToken().tokenHash,
        platform: "android" as never,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow();
  });

  it("counts only recent failed login attempts for the same email and IP", async () => {
    await recordLoginAttempt(pool, { email: "target@example.com", ip: "1.2.3.4", succeeded: false });
    await recordLoginAttempt(pool, { email: "target@example.com", ip: "1.2.3.4", succeeded: false });
    await recordLoginAttempt(pool, { email: "target@example.com", ip: "1.2.3.4", succeeded: true });
    await recordLoginAttempt(pool, { email: "target@example.com", ip: "9.9.9.9", succeeded: false });
    await recordLoginAttempt(pool, { email: "someone-else@example.com", ip: "1.2.3.4", succeeded: false });

    expect(await countRecentFailedAttempts(pool, "target@example.com", "1.2.3.4", 3600)).toBe(2);
    expect(await countRecentFailedAttempts(pool, "target@example.com", "1.2.3.4", 0)).toBe(0);
  });

  it("records a login attempt for an email with no matching user", async () => {
    const attempt = await recordLoginAttempt(pool, { email: "nobody@example.com", ip: "127.0.0.1", succeeded: false });
    expect(attempt.succeeded).toBe(false);
  });
});
