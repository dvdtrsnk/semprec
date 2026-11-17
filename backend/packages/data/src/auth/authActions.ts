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

/** Idle TTL; each authenticated request slides expiry forward by this much. */
export const SESSION_IDLE_TTL_SECONDS_BY_PLATFORM: Record<SessionPlatform, number> = {
  ios: 90 * SECONDS_PER_DAY,
  macos: 90 * SECONDS_PER_DAY,
  web: 30 * SECONDS_PER_DAY,
};

/** Absolute ceiling: a session never outlives `created_at` plus this, however actively it is used. */
export const SESSION_MAX_LIFETIME_SECONDS = 365 * SECONDS_PER_DAY;

export type PublicUser = Omit<UserRow, "passwordHash">;

function toPublicUser(user: UserRow): PublicUser {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** NIST SP 800-63B length floor; no further complexity rules are imposed. */
export const MIN_PASSWORD_LENGTH = 8;

interface CreateAccountInput {
  email: string;
  password: string;
  /** Already validated by `normalizeDisplayName`. */
  displayName?: string | null;
  tenantId: string;
  role: UserRole;
}

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

/** Verified against when no user matches, so response timing does not reveal which emails exist. */
const dummyPasswordHash = hashPassword(randomBytes(32).toString("hex"));

export interface LoginInput {
  email: string;
  password: string;
  platform: SessionPlatform;
  ip: string;
  userAgent?: string | null;
  /** Already validated; omitted leaves the session's device columns NULL. */
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
  /** Read by the same locked query that re-checks the tenant. */
  role: UserRole;
}

/**
 * Only the token's hash is stored. Every failure (unknown email, wrong password, active lockout,
 * inactive tenant) throws the same `UnauthorizedError`. An active lockout rejects even a correct
 * password and is itself recorded as a failure, so retrying through it extends it.
 *
 * Takes a `Pool` on purpose: failed attempts are auto-committed so they survive the throw;
 * inside a caller transaction they would roll back and the lockout would never engage. Only the
 * success path runs in a transaction, which re-checks the tenant under lock.
 *
 * A login with a `deviceId` replaces that installation's earlier sessions, under a per-device
 * advisory lock so overlapping logins serialize. See
 * docs/architecture/tenancy-and-security.md#sessions-and-login.
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

  // Same queries for every outcome, so timing confirms neither the email nor the password.
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
    // Under lock: a concurrent suspension either is seen here or waits and then revokes this session.
    const locked = await lockUserTenantBinding(client, user.id);
    if (!locked || locked.status !== "active") return null;
    const deviceId = input.device?.deviceId ?? null;
    if (deviceId !== null) {
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

/** Advisory-lock key for the `/setup` critical section; arbitrary but stable. */
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
  /** Already validated by `normalizeDisplayName` at the setup route. */
  displayName?: string | null;
}

/**
 * Creates the first account (tenant zero's admin), exactly once. Once any user exists it 404s
 * before looking at the token, and a wrong token gets the same 404, so the route leaks nothing.
 * The advisory lock serializes concurrent callers; each re-checks `anyUserExists` under it.
 *
 * Guidance is seeded after the commit in the tenant's own scope, because the setup route's system
 * scope cannot read tenant system databases. A seeding failure rethrows after the account exists.
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
 * Shared by every request-authentication surface (cookie and bearer). Every failure, including an
 * inactive tenant, throws the same `UnauthorizedError`.
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

/** Runs in the caller's transaction so the push-registration cascade commits with the revocation. */
export async function logout(client: Pool | PoolClient, sessionId: string): Promise<void> {
  await revokeSession(client, sessionId);
  await revokePushSubscriptionsForSession(client, sessionId);
}

/**
 * Scoped to `userId` so a guessed foreign session id cannot be revoked. `false` for unknown,
 * foreign or already-revoked sessions alike.
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
 * "Sign out all other devices". Registrations without a session are left alone. Run in one
 * transaction so sessions, registrations and post-commit socket closes hold together.
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
