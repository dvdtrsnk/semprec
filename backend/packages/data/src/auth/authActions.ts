import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { NotFoundError, UnauthorizedError, ValidationError } from "../errors.js";
import { withTransaction } from "../db/pool.js";
import { hashPassword, verifyPassword } from "./passwordHash.js";
import { generateOpaqueToken, hashToken } from "./token.js";
import { anyUserExists, createUser, getUserById } from "./usersStore.js";
import {
  createSession,
  type CreateSessionInput,
  getActiveSessionByTokenHash,
  revokeOtherSessionsForUser,
  revokeSession,
  revokeSessionForUser,
  revokeSessionsForDevice,
  touchSessionLastSeen,
} from "./sessionsStore.js";
import { lockSessionDevice } from "./sessionDeviceLock.js";
import { recordLoginAttempt, getFailureStreak } from "./loginAttemptsStore.js";
import { normalizeEmail } from "./emailNormalization.js";
import { lockoutDurationSeconds } from "./loginLockout.js";
import type { SessionPlatform, SessionRow, UserRole, UserRow } from "./types.js";
import {
  getSoleTenantId,
  getUserByEmailWithTenantStatus,
  getUserTenantBinding,
  lockUserTenantBinding,
} from "../tenancy/tenantsStore.js";
import { revokePushSubscriptionsForSession } from "../push/pushSubscriptionsStore.js";
import { seedAccountSystemProjectGuidance } from "../projectAgentGuidance/seedSystemProjectAgentGuidance.js";

const SECONDS_PER_DAY = 60 * 60 * 24;

/** How long a session stays valid without further activity; each authenticated request slides expiry forward by this much. */
export const SESSION_IDLE_TTL_SECONDS_BY_PLATFORM: Record<SessionPlatform, number> = {
  ios: 90 * SECONDS_PER_DAY,
  macos: 90 * SECONDS_PER_DAY,
  web: 30 * SECONDS_PER_DAY,
};

/** Absolute ceiling: a session never outlives `created_at` plus this, however actively it is used. */
export const SESSION_MAX_LIFETIME_SECONDS = 365 * SECONDS_PER_DAY;

/** `UserRow` minus `passwordHash` — the shape safe to hand back to a caller or attach to a request. */
export type PublicUser = Omit<UserRow, "passwordHash">;

function toPublicUser(user: UserRow): PublicUser {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** NIST SP 800-63B floors length-based password strength at 8 characters and leaves further complexity rules to the caller; we impose none. */
export const MIN_PASSWORD_LENGTH = 8;

interface CreateAccountInput {
  email: string;
  password: string;
  /** Already validated by `normalizeDisplayName`; `null` or omitted stores NULL. */
  displayName?: string | null;
  tenantId: string;
  role: UserRole;
}

/**
 * Turns an email/password pair into a `users` row for `bootstrapFirstAccount` (#233).
 * Normalizes the email (see `normalizeEmail`), validates both fields, and hashes the password
 * with Argon2id (`hashPassword`) before handing off to `createUser`. The display name arrives
 * already validated (issue #1513) and is stored as given.
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
  const user = await createUser(client, {
    email,
    passwordHash,
    tenantId: input.tenantId,
    role: input.role,
    displayName: input.displayName ?? undefined,
  });
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
  /** Already-validated device identity of the logging-in client; omitted leaves the session's device columns NULL. */
  device?: LoginDevice;
}

export type LoginDevice = Pick<
  CreateSessionInput,
  "deviceId" | "deviceName" | "deviceKind" | "osVersion" | "appVersion"
>;

export interface LoginResult {
  token: string;
  session: SessionRow;
  user: PublicUser;
  /** The user's role in their tenant, read by the same locked query that re-checks the tenant (#1387). */
  role: UserRole;
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
 * lockout, a user whose tenant is missing or not `active`) with the same message, per #140's "don't reveal which condition applied" requirement.
 *
 * Takes a `Pool`, not a caller's transaction, on purpose (#628): a failed attempt is recorded
 * with an auto-committed statement directly on `pool`, so the row survives the
 * `UnauthorizedError` thrown right after it. Inside a caller-managed transaction that throw
 * would roll the row back, `getFailureStreak` would always read zero, and the lockout would
 * never engage. Only the success path — the new session row and the streak-resetting success
 * row — runs in one `withTransaction`, so those two still commit or roll back together. That
 * transaction re-reads the tenant status through `lockUserTenantBinding`, so a session is never
 * created for a tenant a concurrent suspension has already left non-active. The `role` in the result
 * is read by that same locked query.
 *
 * A login whose `device` carries a `deviceId` replaces the earlier sessions of that installation
 * (issue #1687): in the success transaction, after the new session is created, it revokes the same
 * user's other unrevoked sessions with that `deviceId` and their push registrations, and each
 * revoked session's realtime event fires after the commit. Before creating the session it takes a
 * transaction-scoped advisory lock on the user and the `deviceId` (`lockSessionDevice`), so of two
 * overlapping logins of one installation the second waits for the first one's transaction to end and
 * then revokes the session that one committed. The client chooses the `deviceId`, so that lock has an
 * advisory lock class of its own and cannot equal a lock another path takes. A login without a
 * `deviceId` (web, or a native client that sends none) revokes nothing, and neither does a rejected
 * one, which never creates a session. See
 * docs/adr/2026-11-10-login-replaces-the-sessions-of-its-installation.md.
 */
export async function login(pool: Pool, input: LoginInput): Promise<LoginResult> {
  const email = normalizeEmail(input.email);

  const streak = await getFailureStreak(pool, email, input.ip);
  if (streak.lastFailedAt) {
    const lockedUntil = new Date(streak.lastFailedAt).getTime() + lockoutDurationSeconds(streak.count) * 1000;
    if (Date.now() < lockedUntil) {
      await recordLoginAttempt(pool, { email, ip: input.ip, succeeded: false });
      throw new UnauthorizedError();
    }
  }

  // The user and their tenant status come from one statement, before the password check, so an
  // unknown email, a wrong password and a refusal for a non-active tenant all run the same queries
  // and timing confirms neither the email nor the password.
  const found = await getUserByEmailWithTenantStatus(pool, email);
  const user = found?.user ?? null;
  const passwordOk = await verifyPassword(user ? user.passwordHash : await dummyPasswordHash, input.password);

  // A user whose tenant is not active gets exactly the wrong-password outcome: no session, a failed attempt.
  if (!user || !passwordOk || found?.tenantStatus !== "active") {
    await recordLoginAttempt(pool, { email, ip: input.ip, succeeded: false });
    throw new UnauthorizedError();
  }

  const { token, tokenHash } = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + SESSION_IDLE_TTL_SECONDS_BY_PLATFORM[input.platform] * 1000);
  const granted = await withTransaction(pool, async (client) => {
    // Re-checked under lock: a suspension that committed after the read above is seen here, and
    // one that has not yet locked the user waits for this commit and then revokes this session.
    const locked = await lockUserTenantBinding(client, user.id);
    if (!locked || locked.status !== "active") return null;
    const deviceId = input.device?.deviceId ?? null;
    if (deviceId !== null) {
      // Held until this transaction ends, so a concurrent login of the same installation creates its
      // session only afterwards, and its own replacement then revokes the session committed here.
      await lockSessionDevice(client, user.id, deviceId);
    }
    const created = await createSession(client, {
      userId: user.id,
      tokenHash,
      platform: input.platform,
      expiresAt,
      userAgent: input.userAgent,
      ...input.device,
    });
    if (deviceId !== null) {
      const replaced = await revokeSessionsForDevice(client, user.id, deviceId, created.id);
      for (const sessionId of replaced) await revokePushSubscriptionsForSession(client, sessionId);
    }
    await recordLoginAttempt(client, { email, ip: input.ip, succeeded: true });
    return { session: created, role: locked.role };
  });
  if (!granted) {
    await recordLoginAttempt(pool, { email, ip: input.ip, succeeded: false });
    throw new UnauthorizedError();
  }

  return { token, session: granted.session, user: toPublicUser(user), role: granted.role };
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
  /** Already validated by `normalizeDisplayName` at the setup route (issue #1513); `null` or omitted stores NULL. */
  displayName?: string | null;
}

/**
 * Creates the one and only account this deployment will ever create through `/setup` (#233).
 * Available exactly once: as soon as any user exists, this throws `NotFoundError` before even
 * looking at `providedToken` — the acceptance criteria's "return 404 before token validation" —
 * so a caller poking the route after bootstrap, with or without a valid token, learns nothing
 * beyond "not found". The same `NotFoundError`/404 is used for a wrong token, so the route
 * doesn't leak "setup is still open, you just guessed wrong" either.
 *
 * The first account becomes tenant zero's admin: it is bound to the sole tenant with role `admin`.
 *
 * Race safety: a cheap unlocked check short-circuits the common post-bootstrap case, then the
 * actual decision runs inside a transaction holding `SETUP_ADVISORY_LOCK_KEY` for its duration —
 * concurrent callers queue on that lock, and every one after the first to commit re-checks
 * `anyUserExists` and finds it `true`, so exactly one call ever reaches `createAccount`.
 *
 * After that commit the tenant's system projects get their agent guidance rows (issue #1449), in the
 * tenant's own scope: the setup route calls this under the system scope, whose transactions cannot read
 * the tenant's system databases. A failure there rethrows after the account has been created.
 */
export async function bootstrapFirstAccount(
  pool: Pool,
  expectedToken: string,
  providedToken: string,
  input: BootstrapFirstAccountInput,
): Promise<PublicUser> {
  if (await anyUserExists(pool)) throw new NotFoundError("Not found");

  const created = await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [SETUP_ADVISORY_LOCK_KEY]);

    if (await anyUserExists(client)) throw new NotFoundError("Not found");
    if (!tokensMatch(providedToken, expectedToken)) throw new NotFoundError("Not found");

    const tenantId = await getSoleTenantId(client);
    const user = await createAccount(client, {
      email: input.email,
      password: input.password,
      displayName: input.displayName,
      tenantId,
      role: "admin",
    });
    return { tenantId, user };
  });
  await seedAccountSystemProjectGuidance(pool, created.tenantId, created.user.id);
  return created.user;
}

export interface AuthenticatedIdentity {
  session: SessionRow;
  user: PublicUser;
  tenantId: string;
  role: UserRole;
}

/**
 * The one path shared by every request-authentication surface (web cookie, native `Authorization:
 * Bearer`): hashes the presented opaque token, requires a session that is neither expired nor
 * revoked and whose user belongs to an `active` tenant, and bumps `last_seen_at`. Throws `UnauthorizedError` — same message as `login`'s
 * failure — for a missing, invalid, expired, or revoked token alike.
 */
export async function verifySessionToken(client: Pool | PoolClient, token: string): Promise<AuthenticatedIdentity> {
  const session = await getActiveSessionByTokenHash(client, hashToken(token));
  if (!session) throw new UnauthorizedError();

  const user = await getUserById(client, session.userId);
  if (!user) throw new UnauthorizedError();

  // A user without an active tenant fails exactly like a bad token, before `last_seen_at` is bumped.
  const binding = await getUserTenantBinding(client, user.id);
  if (!binding || binding.status !== "active") throw new UnauthorizedError();

  await touchSessionLastSeen(client, {
    id: session.id,
    idleSeconds: SESSION_IDLE_TTL_SECONDS_BY_PLATFORM[session.platform],
    maxLifetimeSeconds: SESSION_MAX_LIFETIME_SECONDS,
  });
  return { session, user: toPublicUser(user), tenantId: binding.tenantId, role: binding.role };
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

/**
 * "Sign out all other devices" (issue #1650): revokes every other active session of `userId`, keeping
 * `keepSessionId`, then each revoked session's push registrations, on the same client, and returns how
 * many sessions it revoked. Registrations without a session (`session_id` NULL) belong to no device being
 * signed out and are left alone. Run it in one transaction so the sessions, their registrations and the
 * post-commit socket closes hold together.
 */
export async function revokeOtherUserSessions(
  client: Pool | PoolClient,
  userId: string,
  keepSessionId: string,
): Promise<number> {
  const revoked = await revokeOtherSessionsForUser(client, userId, keepSessionId);
  for (const sessionId of revoked) await revokePushSubscriptionsForSession(client, sessionId);
  return revoked.length;
}
