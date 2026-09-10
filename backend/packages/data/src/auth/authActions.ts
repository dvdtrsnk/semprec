import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { NotFoundError, UnauthorizedError, ValidationError } from "../errors.js";
import { withTransaction } from "../db/pool.js";
import { hashPassword, verifyPassword } from "./passwordHash.js";
import { generateOpaqueToken, hashToken } from "./token.js";
import { anyUserExists, createUser, getUserByEmail, getUserById } from "./usersStore.js";
import {
  createSession,
  getActiveSessionByTokenHash,
  revokeSession,
  revokeSessionForUser,
  touchSessionLastSeen,
} from "./sessionsStore.js";
import { recordLoginAttempt, getFailureStreak } from "./loginAttemptsStore.js";
import { normalizeEmail } from "./emailNormalization.js";
import { lockoutDurationSeconds } from "./loginLockout.js";
import type { SessionPlatform, SessionRow, UserRow } from "./types.js";
import { revokePushSubscriptionsForSession } from "../push/pushSubscriptionsStore.js";

/** How long a freshly-issued session stays valid without further activity. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** `UserRow` minus `passwordHash` — the shape safe to hand back to a caller or attach to a request. */
export type PublicUser = Omit<UserRow, "passwordHash">;

function toPublicUser(user: UserRow): PublicUser {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** NIST SP 800-63B floors length-based password strength at 8 characters and leaves further complexity rules to the caller; we impose none. */
const MIN_PASSWORD_LENGTH = 8;

interface CreateAccountInput {
  email: string;
  password: string;
}

/**
 * Turns an email/password pair into a `users` row for `bootstrapFirstAccount` (#233).
 * Normalizes the email (see `normalizeEmail`), validates both fields, and hashes the password
 * with Argon2id (`hashPassword`) before handing off to `createUser`.
 */
async function createAccount(client: Pool | PoolClient, input: CreateAccountInput): Promise<PublicUser> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_PATTERN.test(email)) {
    throw new ValidationError("'email' must be a valid email address");
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`'password' must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const passwordHash = await hashPassword(input.password);
  const user = await createUser(client, { email, passwordHash });
  return toPublicUser(user);
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
 * hash is stored. Every attempt (success or failure) is recorded via `recordLoginAttempt` with
 * the normalized email (see `normalizeEmail`), which is also the identity `getFailureStreak`'s
 * lockout scoping keys on.
 *
 * Before password verification (#232's Task), an email+IP pair with an active exponential
 * lockout is rejected outright — including a correct password — without ever calling
 * `verifyPassword`; the rejection is itself recorded as a failed attempt, which is what makes
 * the lockout continue to grow if the caller keeps retrying through it. A success resets the
 * streak implicitly: `getFailureStreak` only counts failures since the pair's last success.
 *
 * Throws `UnauthorizedError` for every failure reason (unknown email, wrong password, active
 * lockout) with the same message, per #140's "don't reveal which condition applied" requirement.
 */
export async function login(client: Pool | PoolClient, input: LoginInput): Promise<LoginResult> {
  const email = normalizeEmail(input.email);

  const streak = await getFailureStreak(client, email, input.ip);
  if (streak.lastFailedAt) {
    const lockedUntil = new Date(streak.lastFailedAt).getTime() + lockoutDurationSeconds(streak.count) * 1000;
    if (Date.now() < lockedUntil) {
      await recordLoginAttempt(client, { email, ip: input.ip, succeeded: false });
      throw new UnauthorizedError();
    }
  }

  const user = await getUserByEmail(client, email);
  const passwordOk = await verifyPassword(user ? user.passwordHash : await dummyPasswordHash, input.password);

  if (!user || !passwordOk) {
    await recordLoginAttempt(client, { email, ip: input.ip, succeeded: false });
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
  await recordLoginAttempt(client, { email, ip: input.ip, succeeded: true });

  return { token, session, user: toPublicUser(user) };
}

/**
 * Postgres advisory-lock key for the `/setup` critical section (#233). Arbitrary but stable —
 * only its uniqueness within this process's advisory-lock keyspace matters, and nothing else in
 * the codebase takes advisory locks, so any constant would do.
 */
const SETUP_ADVISORY_LOCK_KEY = 2330n;

/** Constant-time so a network caller can't recover `SETUP_TOKEN` byte-by-byte from response timing. */
function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

export interface BootstrapFirstAccountInput {
  email: string;
  password: string;
}

/**
 * Creates the one and only account this deployment will ever create through `/setup` (#233).
 * Available exactly once: as soon as any user exists, this throws `NotFoundError` before even
 * looking at `providedToken` — the acceptance criteria's "return 404 before token validation" —
 * so a caller poking the route after bootstrap, with or without a valid token, learns nothing
 * beyond "not found". The same `NotFoundError`/404 is used for a wrong token, so the route
 * doesn't leak "setup is still open, you just guessed wrong" either.
 *
 * Race safety: a cheap unlocked check short-circuits the common post-bootstrap case, then the
 * actual decision runs inside a transaction holding `SETUP_ADVISORY_LOCK_KEY` for its duration —
 * concurrent callers queue on that lock, and every one after the first to commit re-checks
 * `anyUserExists` and finds it `true`, so exactly one call ever reaches `createAccount`.
 */
export async function bootstrapFirstAccount(
  pool: Pool,
  expectedToken: string,
  providedToken: string,
  input: BootstrapFirstAccountInput,
): Promise<PublicUser> {
  if (await anyUserExists(pool)) throw new NotFoundError("Not found");

  return withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [SETUP_ADVISORY_LOCK_KEY]);

    if (await anyUserExists(client)) throw new NotFoundError("Not found");
    if (!tokensMatch(providedToken, expectedToken)) throw new NotFoundError("Not found");

    return createAccount(client, { email: input.email, password: input.password });
  });
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

/**
 * Ends exactly the session the caller is currently authenticated with; every other session for
 * the user stays valid. Runs in the caller's transaction, so the session revocation and the
 * push-registration cascade (issue #150 — a registration must not outlive the session that
 * created it) commit or roll back together.
 */
export async function logout(client: Pool | PoolClient, sessionId: string): Promise<void> {
  await revokeSession(client, sessionId);
  await revokePushSubscriptionsForSession(client, sessionId);
}

/**
 * Remote revocation of one of the current user's *other* sessions (device management). Scoped to
 * `userId` so a caller can't revoke a session id they don't own by guessing it. Returns `false`
 * for an unknown id, an id owned by someone else, or an already-revoked session — the caller
 * treats all three as the same "nothing to do" outcome. On an actual revocation, also cascades
 * to that session's push registrations (issue #150), same as `logout`.
 */
export async function revokeUserSession(
  client: Pool | PoolClient,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const revoked = await revokeSessionForUser(client, sessionId, userId);
  if (revoked) await revokePushSubscriptionsForSession(client, sessionId);
  return revoked;
}
