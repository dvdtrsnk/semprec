import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { UnauthorizedError } from "../errors.js";
import { hashPassword, verifyPassword } from "./passwordHash.js";
import { generateOpaqueToken, hashToken } from "./token.js";
import { getUserByEmail, getUserById } from "./usersStore.js";
import {
  createSession,
  getActiveSessionByTokenHash,
  revokeSession,
  revokeSessionForUser,
  touchSessionLastSeen,
} from "./sessionsStore.js";
import { recordLoginAttempt } from "./loginAttemptsStore.js";
import type { SessionPlatform, SessionRow, UserRow } from "./types.js";

/** How long a freshly-issued session stays valid without further activity. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** `UserRow` minus `passwordHash` — the shape safe to hand back to a caller or attach to a request. */
export type PublicUser = Omit<UserRow, "passwordHash">;

function toPublicUser(user: UserRow): PublicUser {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

/**
 * A verify call against a hash generated once at module load, run whenever no user matches
 * `email` — without it, "unknown email" would skip Argon2id entirely and return far faster than
 * "known email, wrong password", letting a caller enumerate valid emails by response timing.
 */
const dummyPasswordHash = hashPassword(randomBytes(32).toString("hex"));

export interface LoginInput {
  email: string;
  password: string;
  platform: SessionPlatform;
  ip: string;
  userAgent?: string | null;
}

export interface LoginResult {
  token: string;
  session: SessionRow;
  user: PublicUser;
}

/**
 * Verifies email/password, creates one new session row, and returns its opaque token — the
 * token is generated fresh per call and never persisted anywhere but this return value; only its
 * hash is stored. Every attempt (success or failure) is recorded via `recordLoginAttempt` for
 * #141's throttling to consume later; this issue does not itself enforce any throttling.
 * Throws `UnauthorizedError` for every failure reason (unknown email, wrong password) with the
 * same message, per #140's "don't reveal which condition applied" requirement.
 */
export async function login(client: Pool | PoolClient, input: LoginInput): Promise<LoginResult> {
  const user = await getUserByEmail(client, input.email);
  const passwordOk = await verifyPassword(user ? user.passwordHash : await dummyPasswordHash, input.password);

  if (!user || !passwordOk) {
    await recordLoginAttempt(client, { email: input.email, ip: input.ip, succeeded: false });
    throw new UnauthorizedError();
  }

  const { token, tokenHash } = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const session = await createSession(client, {
    userId: user.id,
    tokenHash,
    platform: input.platform,
    expiresAt,
    userAgent: input.userAgent,
  });
  await recordLoginAttempt(client, { email: input.email, ip: input.ip, succeeded: true });

  return { token, session, user: toPublicUser(user) };
}

export interface AuthenticatedIdentity {
  session: SessionRow;
  user: PublicUser;
}

/**
 * The one path shared by every request-authentication surface (web cookie, native `Authorization:
 * Bearer`): hashes the presented opaque token, requires a session that is neither expired nor
 * revoked, and bumps `last_seen_at`. Throws `UnauthorizedError` — same message as `login`'s
 * failure — for a missing, invalid, expired, or revoked token alike.
 */
export async function verifySessionToken(client: Pool | PoolClient, token: string): Promise<AuthenticatedIdentity> {
  const session = await getActiveSessionByTokenHash(client, hashToken(token));
  if (!session) throw new UnauthorizedError();

  const user = await getUserById(client, session.userId);
  if (!user) throw new UnauthorizedError();

  await touchSessionLastSeen(client, session.id);
  return { session, user: toPublicUser(user) };
}

/** Ends exactly the session the caller is currently authenticated with; every other session for the user stays valid. */
export async function logout(client: Pool | PoolClient, sessionId: string): Promise<void> {
  await revokeSession(client, sessionId);
}

/**
 * Remote revocation of one of the current user's *other* sessions (device management). Scoped to
 * `userId` so a caller can't revoke a session id they don't own by guessing it. Returns `false`
 * for an unknown id, an id owned by someone else, or an already-revoked session — the caller
 * treats all three as the same "nothing to do" outcome.
 */
export async function revokeUserSession(
  client: Pool | PoolClient,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  return revokeSessionForUser(client, sessionId, userId);
}
