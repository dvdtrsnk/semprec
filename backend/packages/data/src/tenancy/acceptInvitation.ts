import type { Pool, PoolClient } from "pg";
import { runAsSystem } from "@semprec/shared";
import { MIN_PASSWORD_LENGTH, type PublicUser } from "../auth/authActions.js";
import { normalizeDisplayName } from "../auth/displayName.js";
import { hashPassword } from "../auth/passwordHash.js";
import { hashToken } from "../auth/token.js";
import type { UserRow } from "../auth/types.js";
import { createUser } from "../auth/usersStore.js";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { seedAccountSystemProjectGuidance } from "../projectAgentGuidance/seedSystemProjectAgentGuidance.js";
import { logger } from "./logger.js";
import { provisionTenant } from "./provisionTenant.js";
import { createTenant } from "./tenantsStore.js";

export interface AcceptInvitationInput {
  /** The raw token from the invitation link's fragment. Only its hash is stored. */
  token: string;
  password: string;
  /** Optional; validated by `normalizeDisplayName` before any lookup, so a refused name never consumes the invitation (issue #1513). */
  displayName?: unknown;
}

/** Seeds a tenant's system databases and activates it. Production passes `provisionTenant`; a test may inject another. */
export type ProvisionTenant = (pool: Pool, tenantId: string) => Promise<unknown>;

interface InviteRef {
  id: string;
  email: string;
}

/** `UserRow` without the password hash, the shape `authActions.ts` hands back. */
function toPublicUser(user: UserRow): PublicUser {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

/** True only for a Postgres unique violation (`23505`) of the named constraint. */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "23505" &&
    "constraint" in err &&
    err.constraint === constraint
  );
}

/** The unlocked first lookup: an unusable token is refused before the password is hashed. */
async function findUsableInvite(pool: Pool, tokenHash: string): Promise<InviteRef | null> {
  const { rows } = await pool.query<InviteRef>(
    `SELECT id, email FROM invites
      WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

/** The decisive lookup, locked inside the acceptance transaction. */
async function lockUsableInvite(client: PoolClient, tokenHash: string): Promise<InviteRef | null> {
  const { rows } = await client.query<InviteRef>(
    `SELECT id, email FROM invites
      WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      FOR UPDATE`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

/**
 * Creates the invited person's `member` account in `tenantId`. An account that already holds the
 * address makes the invitation unusable; the caller's transaction rolls back the tenant created with it.
 */
async function createInvitedUser(
  client: PoolClient,
  input: { email: string; passwordHash: string; tenantId: string; displayName: string | null },
): Promise<UserRow> {
  try {
    return await createUser(client, {
      email: input.email,
      passwordHash: input.passwordHash,
      tenantId: input.tenantId,
      role: "member",
      displayName: input.displayName ?? undefined,
    });
  } catch (err) {
    if (isUniqueViolation(err, "users_email_key")) throw new NotFoundError("Not found");
    throw err;
  }
}

/**
 * Accepts an admin-issued invitation (issue #1087), the only way to create an account after
 * `bootstrapFirstAccount`. One transaction creates the invited person's tenant in `provisioning`, binds
 * their `member` account to it and marks the invitation accepted. After it commits, `provision` seeds the
 * tenant's system databases and activates it, and then the system projects get their agent guidance rows
 * (issue #1449). A tenant that is not `active` cannot authenticate, so a failed `provision` leaves the
 * account unable to sign in until the next deploy's seed step provisions it.
 *
 * Every unusable token (unknown, expired, revoked or already used) and an address that already has an
 * account answer the same `NotFoundError("Not found")` and write nothing. The tenant id is generated here,
 * never taken from the caller.
 *
 * The first lookup is unlocked, so an unusable token is refused before the password is hashed. The decision
 * is the second lookup, `FOR UPDATE` inside the transaction: two acceptances of one token that both pass the
 * first lookup queue on that row, and the one that waits re-checks the conditions after the other commits,
 * finds the invitation accepted and is refused.
 */
export async function acceptInvitation(
  pool: Pool,
  input: AcceptInvitationInput,
  provision: ProvisionTenant = provisionTenant,
): Promise<PublicUser> {
  return runAsSystem("invitation-acceptance", async () => {
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(`'password' must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    // Before the lookup: a refused name must leave the invitation usable, so nothing below runs for it.
    const displayName = normalizeDisplayName(input.displayName);
    const tokenHash = hashToken(input.token);
    const candidate = await findUsableInvite(pool, tokenHash);
    if (!candidate) throw new NotFoundError("Not found");
    const passwordHash = await hashPassword(input.password);

    const accepted = await withTransaction(pool, async (client) => {
      const invite = await lockUsableInvite(client, tokenHash);
      if (!invite) throw new NotFoundError("Not found");
      const tenantId = await createTenant(client, "provisioning");
      const user = await createInvitedUser(client, { email: invite.email, passwordHash, tenantId, displayName });
      const marked = await client.query(
        "UPDATE invites SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL",
        [invite.id],
      );
      requireAffectedRows(marked, "marking the invitation accepted");
      return { tenantId, user };
    });

    try {
      await provision(pool, accepted.tenantId);
    } catch (err) {
      // The tenant id only: no email, token or error text, which can carry user content.
      logger.error({ tenantId: accepted.tenantId }, "invitation_provisioning_failed");
      throw err;
    }
    // The system projects exist only once the tenant is provisioned, so their guidance is seeded after it (issue #1449).
    await seedAccountSystemProjectGuidance(pool, accepted.tenantId, accepted.user.id);
    return toPublicUser(accepted.user);
  });
}
