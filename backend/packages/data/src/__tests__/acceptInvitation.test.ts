import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { hashToken } from "../auth/token.js";
import { createUser } from "../auth/usersStore.js";
import { login } from "../auth/authActions.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { runMigrations } from "../db/migrate.js";
import { createPool, requireSingleRow, withTransaction } from "../db/pool.js";
import { NotFoundError, UnauthorizedError, ValidationError } from "../errors.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { acceptInvitation } from "../tenancy/acceptInvitation.js";
import { createInvite, revokeInvite } from "../tenancy/invites.js";
import { logger } from "../tenancy/logger.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

const APP_BASE_URL = "https://app.example.test";
const INVITEE = "novak@example.cz";
const PASSWORD = "correct-horse-battery";
const UNISSUED_TOKEN = "a-token-that-was-never-issued";
// Each test that runs the real provisioning builds a tenant's couple of dozen system databases.
const PROVISIONING_TEST_TIMEOUT_MS = 60_000;
// A test that migrates a database of its own runs every migration; late in the integration run that
// competes with the instance's checkpoint I/O.
const FRESH_DATABASE_TEST_TIMEOUT_MS = 120_000;

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set — is vitest.config.ts's globalSetup wired up?");
  return url;
}

/** A database of its own, migrated by `runMigrations` alone. The shared test database has its guard dropped by the harness. */
async function withFreshDatabase(fn: (pool: Pool) => Promise<void>): Promise<void> {
  // The name is a fixed prefix and a UUID's hex digits, so the interpolation below cannot break out of the quotes.
  const name = `accept_invitation_${randomUUID().replaceAll("-", "")}`;
  const admin = createPool(testDatabaseUrl());
  try {
    await admin.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
  } catch (createError) {
    try {
      await admin.end();
    } catch {
      // The CREATE DATABASE rejection is the real failure; a failed pool teardown must not replace it.
    }
    throw createError;
  }
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  let failure: { error: unknown } | undefined;
  try {
    await fn(pool);
  } catch (error) {
    failure = { error };
  }
  const cleanup = [() => pool.end(), () => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`), () => admin.end()];
  for (const step of cleanup) {
    try {
      await step();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

function tokenFromUrl(inviteUrl: string): string {
  const token = new URL(inviteUrl).hash.replace("#token=", "");
  if (token.length === 0) throw new Error(`no token in ${inviteUrl}`);
  return token;
}

/** Counts of the rows an acceptance may write; a refused acceptance must leave all of them as they were. */
interface Snapshot {
  tenants: number;
  users: number;
  acceptedInvites: number;
}

describe("acceptInvitation (issue #1087)", () => {
  let adminPool: Pool;
  let dataPool: Pool;
  let inviterId: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    const inviter = await createUser(adminPool, {
      email: "admin@example.test",
      passwordHash: "x",
      tenantId: getTenantZeroId(),
      role: "admin",
    });
    inviterId = inviter.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await dataPool.end();
  });

  /** Creates a pending invitation through the production store and returns its id and raw token. */
  async function invite(email: string): Promise<{ id: string; token: string }> {
    const created = await runAsSystem("acceptInvitationTest", () =>
      withTransaction(dataPool, (client) =>
        createInvite(client, { email, invitedBy: inviterId, appBaseUrl: APP_BASE_URL, mailer: null }),
      ),
    );
    return { id: created.invite.id, token: tokenFromUrl(created.inviteUrl) };
  }

  async function snapshot(): Promise<Snapshot> {
    const { rows } = await adminPool.query<{ tenants: number; users: number; accepted: number }>(
      `SELECT (SELECT count(*)::int FROM tenants) AS tenants,
              (SELECT count(*)::int FROM users) AS users,
              (SELECT count(*)::int FROM invites WHERE accepted_at IS NOT NULL) AS accepted`,
    );
    const row = requireSingleRow(rows, "acceptance snapshot");
    return { tenants: row.tenants, users: row.users, acceptedInvites: row.accepted };
  }

  /** The number of `databases` rows of one tenant, read as the superuser. */
  async function countDatabases(tenantId: string): Promise<number> {
    const { rows } = await adminPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM databases WHERE tenant_id = $1",
      [tenantId],
    );
    return rows[0]?.n ?? -1;
  }

  /** The refusal every unusable token and an already-held address get: the same error, and nothing written. */
  async function expectRefusedWithoutWrites(token: string): Promise<void> {
    const before = await snapshot();
    const provision = vi.fn(async () => undefined);
    const attempt = acceptInvitation(dataPool, { token, password: PASSWORD }, provision);
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
    await expect(attempt).rejects.toMatchObject({ message: "Not found" });
    expect(provision).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  }

  it(
    "activates the new tenant, binds a member with the invitation's email and seeds the tenant's own system databases",
    async () => {
      const zeroDatabasesBefore = await countDatabases(getTenantZeroId());
      const zeroBefore = await adminPool.query<{ row: unknown }>(
        "SELECT to_jsonb(t) AS row FROM tenants t WHERE id = $1",
        [getTenantZeroId()],
      );
      const zeroDatabaseRowsBefore = await adminPool.query<{ row: unknown }>(
        "SELECT to_jsonb(d) AS row FROM databases d WHERE tenant_id = $1 ORDER BY id",
        [getTenantZeroId()],
      );
      const inviterBefore = await adminPool.query<{ row: unknown }>(
        "SELECT to_jsonb(u) AS row FROM users u WHERE id = $1",
        [inviterId],
      );
      const { token } = await invite(INVITEE);

      const user = await acceptInvitation(dataPool, { token, password: PASSWORD });

      expect(user).toMatchObject({ email: INVITEE });
      expect(user).not.toHaveProperty("passwordHash");
      const bound = requireSingleRow(
        (
          await adminPool.query<{ tenant_id: string; role: string; email: string }>(
            "SELECT tenant_id, role, email FROM users WHERE id = $1",
            [user.id],
          )
        ).rows,
        "the new user",
      );
      expect(bound).toEqual({ tenant_id: expect.any(String), role: "member", email: INVITEE });
      const tenantId = bound.tenant_id;

      const tenant = requireSingleRow(
        (await adminPool.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1", [tenantId])).rows,
        "the new tenant",
      );
      expect(tenant.status).toBe("active");

      const accepted = await adminPool.query("SELECT 1 FROM invites WHERE accepted_at IS NOT NULL");
      expect(accepted.rowCount).toBe(1);

      const systemDatabases = await adminPool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM databases WHERE tenant_id = $1 AND system",
        [tenantId],
      );
      expect(systemDatabases.rows[0]?.n).toBeGreaterThan(0);
      const projects = await runInTenant(tenantId, () =>
        withTransaction(dataPool, (client) => getDatabaseByModuleId(client, PROJECTS_MODULE_ID)),
      );
      expect(projects?.system).toBe(true);

      const budgets = await adminPool.query("SELECT 1 FROM tenant_ai_budgets WHERE tenant_id = $1", [tenantId]);
      expect(budgets.rowCount).toBe(0);

      expect(await countDatabases(getTenantZeroId())).toBe(zeroDatabasesBefore);
      expect(
        (
          await adminPool.query<{ row: unknown }>("SELECT to_jsonb(t) AS row FROM tenants t WHERE id = $1", [
            getTenantZeroId(),
          ])
        ).rows,
      ).toEqual(zeroBefore.rows);
      expect(
        (
          await adminPool.query<{ row: unknown }>(
            "SELECT to_jsonb(d) AS row FROM databases d WHERE tenant_id = $1 ORDER BY id",
            [getTenantZeroId()],
          )
        ).rows,
      ).toEqual(zeroDatabaseRowsBefore.rows);
      expect(
        (await adminPool.query<{ row: unknown }>("SELECT to_jsonb(u) AS row FROM users u WHERE id = $1", [inviterId]))
          .rows,
      ).toEqual(inviterBefore.rows);
      const inviter = requireSingleRow(
        (await adminPool.query<{ tenant_id: string }>("SELECT tenant_id FROM users WHERE id = $1", [inviterId])).rows,
        "the inviting admin",
      );
      expect(inviter.tenant_id).toBe(getTenantZeroId());
    },
    PROVISIONING_TEST_TIMEOUT_MS,
  );

  it("refuses a token that was never issued with NotFoundError and writes nothing", async () => {
    await expectRefusedWithoutWrites(UNISSUED_TOKEN);
  });

  it("refuses an expired invitation with NotFoundError and writes nothing", async () => {
    const { token } = await invite(INVITEE);
    // No production writer ages an invitation, so the expiry is set by raw SQL on the superuser pool.
    await adminPool.query("UPDATE invites SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [
      hashToken(token),
    ]);

    await expectRefusedWithoutWrites(token);
  });

  it("refuses a revoked invitation with NotFoundError and writes nothing", async () => {
    const { id, token } = await invite(INVITEE);
    await runAsSystem("acceptInvitationTest", () => withTransaction(dataPool, (client) => revokeInvite(client, id)));

    await expectRefusedWithoutWrites(token);
  });

  it("refuses an already used invitation with NotFoundError and writes nothing", async () => {
    const { token } = await invite(INVITEE);
    await acceptInvitation(dataPool, { token, password: PASSWORD }, async () => undefined);

    await expectRefusedWithoutWrites(token);
  });

  it("refuses an invitation whose address already has an account, with NotFoundError and nothing written", async () => {
    const { token } = await invite(INVITEE);
    // The address gains an account after the invitation was issued. Creation refused it at the time, so only
    // acceptance can see this case.
    await createUser(adminPool, {
      email: INVITEE,
      passwordHash: "x",
      tenantId: await createTestTenant(adminPool),
      role: "member",
    });

    await expectRefusedWithoutWrites(token);
  });

  it("refuses a short password with ValidationError for a valid token, writes nothing and leaves the invitation usable", async () => {
    const { token } = await invite(INVITEE);
    const before = await snapshot();
    const provision = vi.fn(async () => undefined);

    const attempt = acceptInvitation(dataPool, { token, password: "short" }, provision);
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    expect(provision).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    // The refusal consumed nothing: the same invitation still accepts with a valid password.
    await expect(acceptInvitation(dataPool, { token, password: PASSWORD }, provision)).resolves.toMatchObject({
      email: INVITEE,
    });
  });

  it("refuses a short password with ValidationError for an unknown token alike, and writes nothing", async () => {
    const before = await snapshot();

    await expect(acceptInvitation(dataPool, { token: UNISSUED_TOKEN, password: "short" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await snapshot()).toEqual(before);
  });

  it("stores the trimmed displayName on the invited account and returns it", async () => {
    const { token } = await invite(INVITEE);
    const provision = vi.fn(async () => undefined);

    const user = await acceptInvitation(dataPool, { token, password: PASSWORD, displayName: "  Novak  " }, provision);

    expect(user.displayName).toBe("Novak");
    const { rows } = await adminPool.query<{ display_name: string | null }>(
      "SELECT display_name FROM users WHERE id = $1",
      [user.id],
    );
    expect(rows).toEqual([{ display_name: "Novak" }]);
  });

  it("stores NULL when the displayName is omitted", async () => {
    const { token } = await invite(INVITEE);
    const provision = vi.fn(async () => undefined);

    const user = await acceptInvitation(dataPool, { token, password: PASSWORD }, provision);

    expect(user.displayName).toBeNull();
  });

  it("refuses an invalid displayName with ValidationError, writes nothing and leaves the invitation usable", async () => {
    const { token } = await invite(INVITEE);
    const before = await snapshot();
    const provision = vi.fn(async () => undefined);

    for (const displayName of ["a".repeat(81), "   ", 42]) {
      const attempt = acceptInvitation(dataPool, { token, password: PASSWORD, displayName }, provision);
      await expect(attempt).rejects.toBeInstanceOf(ValidationError);
      await expect(attempt).rejects.toMatchObject({ details: { field: "displayName" } });
    }
    expect(provision).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    // The refusals consumed nothing: the same invitation still accepts.
    await expect(acceptInvitation(dataPool, { token, password: PASSWORD }, provision)).resolves.toMatchObject({
      email: INVITEE,
    });
  });

  it("creates one tenant and one account when two acceptances of one token run concurrently", async () => {
    const { token } = await invite(INVITEE);
    const before = await snapshot();
    const provision = vi.fn(async () => undefined);

    // Both calls start before either commits. However they interleave, exactly one may be accepted.
    const settled = await Promise.allSettled([
      acceptInvitation(dataPool, { token, password: PASSWORD }, provision),
      acceptInvitation(dataPool, { token, password: PASSWORD }, provision),
    ]);

    const accepted = settled.filter((result) => result.status === "fulfilled");
    const refused = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toBeInstanceOf(NotFoundError);
    expect(provision).toHaveBeenCalledTimes(1);
    const after = await snapshot();
    expect(after.tenants).toBe(before.tenants + 1);
    expect(after.users).toBe(before.users + 1);
    expect(after.acceptedInvites).toBe(before.acceptedInvites + 1);
  });

  it("propagates a provisioning failure, logs the tenant id only, and leaves the tenant provisioning and the account unable to sign in", async () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const { token } = await invite(INVITEE);
    const provision = vi.fn(async (): Promise<unknown> => {
      throw new Error("seed step failed");
    });

    await expect(acceptInvitation(dataPool, { token, password: PASSWORD }, provision)).rejects.toThrow(
      "seed step failed",
    );

    const tenant = requireSingleRow(
      (
        await adminPool.query<{ id: string; status: string }>(
          "SELECT id, status FROM tenants WHERE status = 'provisioning'",
        )
      ).rows,
      "the provisioning tenant",
    );
    expect(tenant.status).toBe("provisioning");
    expect(errorLog).toHaveBeenCalledWith({ tenantId: tenant.id }, "invitation_provisioning_failed");
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).not.toContain(INVITEE);
    expect(logged).not.toContain(token);
    await expect(
      login(adminPool, { email: INVITEE, password: PASSWORD, platform: "ios", ip: "203.0.113.5" }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it(
    "a database migrated by runMigrations alone has no single-tenant guard and accepts a second tenant",
    async () => {
      await withFreshDatabase(async (pool) => {
        await runMigrations(pool);

        const guard = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'tenants_single_tenant_guard'");
        expect(guard.rowCount).toBe(0);
        await pool.query("INSERT INTO tenants DEFAULT VALUES");
        const count = requireSingleRow(
          (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM tenants")).rows,
          "tenant count",
        );
        // Tenant zero from the migration, and the one inserted above.
        expect(count.n).toBe(2);
      });
    },
    FRESH_DATABASE_TEST_TIMEOUT_MS,
  );
});
