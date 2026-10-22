import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { runMigrations } from "../db/migrate.js";
import { createPool, withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { createUser } from "../auth/usersStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { acceptInvitation } from "../tenancy/acceptInvitation.js";
import { createInvite, revokeInvite, type CreatedInvite } from "../tenancy/invites.js";
import { logger } from "../tenancy/logger.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

const PASSWORD = "invitee-password";
const SYSTEM_MODULES = [SYSTEM_SETTINGS_MODULE_ID, "projects", "tasks", "emails", "inbox"];
// The fresh-database test creates and fully migrates its own database, which late in the
// integration run can take well past the default timeout (see czechHunspellSearch.test.ts).
const FRESH_DATABASE_TEST_TIMEOUT_MS = 120_000;

let adminPool: Pool;
let dataPool: Pool;
let inviterId: string;

function tokenFromUrl(inviteUrl: string): string {
  const token = new URL(inviteUrl).hash.replace("#token=", "");
  if (token.length === 0) throw new Error(`no token in ${inviteUrl}`);
  return token;
}

async function invite(email = `${randomUUID()}@example.test`): Promise<CreatedInvite & { token: string }> {
  const created = await runAsSystem("test", () =>
    withTransaction(dataPool, (client) =>
      createInvite(client, { email, invitedBy: inviterId, appBaseUrl: "https://app.example.test", mailer: null }),
    ),
  );
  return { ...created, token: tokenFromUrl(created.inviteUrl) };
}

interface Snapshot {
  tenants: { id: string; status: string }[];
  users: { email: string; tenant_id: string; role: string }[];
  invites: { id: string; accepted_at: Date | null; revoked_at: Date | null }[];
  zeroDatabases: number;
  zeroItems: number;
}

/** Every row acceptance can write, read through the superuser pool so no row is hidden by RLS. */
async function snapshot(): Promise<Snapshot> {
  const tenants = await adminPool.query<{ id: string; status: string }>("SELECT id, status FROM tenants ORDER BY id");
  const users = await adminPool.query<{ email: string; tenant_id: string; role: string }>(
    "SELECT email, tenant_id, role FROM users ORDER BY email",
  );
  const invites = await adminPool.query<{ id: string; accepted_at: Date | null; revoked_at: Date | null }>(
    "SELECT id, accepted_at, revoked_at FROM invites ORDER BY id",
  );
  const zero = await adminPool.query<{ databases: number; items: number }>(
    `SELECT (SELECT count(*)::int FROM databases WHERE tenant_id = $1) AS databases,
            (SELECT count(*)::int FROM items WHERE tenant_id = $1) AS items`,
    [getTenantZeroId()],
  );
  return {
    tenants: tenants.rows,
    users: users.rows,
    invites: invites.rows,
    zeroDatabases: zero.rows[0]?.databases ?? -1,
    zeroItems: zero.rows[0]?.items ?? -1,
  };
}

async function tenantOfUser(userId: string): Promise<{ tenantId: string; status: string; role: string }> {
  const { rows } = await adminPool.query<{ tenant_id: string; status: string; role: string }>(
    "SELECT u.tenant_id, t.status, u.role FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1",
    [userId],
  );
  const row = rows[0];
  if (!row) throw new Error("user or tenant missing");
  return { tenantId: row.tenant_id, status: row.status, role: row.role };
}

describe("acceptInvitation (issue #1087)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    inviterId = (
      await createUser(adminPool, {
        email: "admin@example.test",
        passwordHash: "x",
        tenantId: getTenantZeroId(),
        role: "admin",
      })
    ).id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await adminPool.query("DROP TRIGGER IF EXISTS test_reject_invited_user ON users");
    await adminPool.query("DROP FUNCTION IF EXISTS test_reject_invited_user()");
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("creates an active tenant with its own system databases and a member bound to it", async () => {
    const pending = await invite("invitee@example.test");
    const before = await snapshot();

    const user = await acceptInvitation(dataPool, { token: pending.token, password: PASSWORD });

    expect(user.email).toBe("invitee@example.test");
    expect(user).not.toHaveProperty("passwordHash");
    const binding = await tenantOfUser(user.id);
    expect(binding.tenantId).not.toBe(getTenantZeroId());
    expect(binding.status).toBe("active");
    expect(binding.role).toBe("member");

    const { rows: invites } = await adminPool.query<{ accepted_at: Date | null }>(
      "SELECT accepted_at FROM invites WHERE id = $1",
      [pending.invite.id],
    );
    expect(invites[0]?.accepted_at).toBeInstanceOf(Date);

    const ownDatabases = await runInTenant(binding.tenantId, () =>
      withTransaction(dataPool, async (client) => {
        const ids: (string | null)[] = [];
        for (const moduleId of SYSTEM_MODULES) ids.push((await getDatabaseByModuleId(client, moduleId))?.id ?? null);
        return ids;
      }),
    );
    expect(ownDatabases.every((id) => id !== null)).toBe(true);
    const { rows: owners } = await adminPool.query<{ tenant_id: string }>(
      "SELECT DISTINCT tenant_id FROM databases WHERE id = ANY($1::uuid[])",
      [ownDatabases],
    );
    expect(owners).toEqual([{ tenant_id: binding.tenantId }]);

    const { rows: budgets } = await adminPool.query("SELECT 1 FROM tenant_ai_budgets WHERE tenant_id = $1", [
      binding.tenantId,
    ]);
    expect(budgets).toEqual([]);

    const after = await snapshot();
    expect(after.tenants).toEqual(
      [...before.tenants, { id: binding.tenantId, status: "active" }].sort((x, y) => x.id.localeCompare(y.id)),
    );
    expect(after.tenants.find((t) => t.id === getTenantZeroId())).toEqual({ id: getTenantZeroId(), status: "active" });
    expect(after.zeroDatabases).toBe(before.zeroDatabases);
    expect(after.zeroItems).toBe(before.zeroItems);
  });

  describe("rejects every unusable invitation with the same NotFoundError and writes nothing", () => {
    async function expectRejectedWithoutWrites(token: string): Promise<void> {
      const before = await snapshot();
      const error = await acceptInvitation(dataPool, { token, password: PASSWORD }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ status: 404, code: "not_found", message: "Not found" });
      expect(await snapshot()).toEqual(before);
    }

    it("an unknown token", async () => {
      await invite();
      await expectRejectedWithoutWrites(randomUUID());
    });

    it("an expired invitation", async () => {
      const pending = await invite();
      // No production path backdates an invitation; expiry otherwise takes seven days.
      await adminPool.query("UPDATE invites SET expires_at = now() - interval '1 second' WHERE id = $1", [
        pending.invite.id,
      ]);
      await expectRejectedWithoutWrites(pending.token);
    });

    it("a revoked invitation", async () => {
      const pending = await invite();
      await runAsSystem("test", () => withTransaction(dataPool, (client) => revokeInvite(client, pending.invite.id)));
      await expectRejectedWithoutWrites(pending.token);
    });

    it("an invitation that was already accepted", async () => {
      const pending = await invite();
      await acceptInvitation(dataPool, { token: pending.token, password: PASSWORD });
      await expectRejectedWithoutWrites(pending.token);
    });

    it("an invitation whose email got an account after it was issued", async () => {
      const pending = await invite("taken@example.test");
      await createUser(adminPool, {
        email: "taken@example.test",
        passwordHash: "x",
        tenantId: await createTestTenant(adminPool),
      });
      await expectRejectedWithoutWrites(pending.token);
    });
  });

  it.each([
    [
      "a unique violation on another constraint",
      "USING ERRCODE = 'unique_violation', CONSTRAINT = 'users_other_key'",
      "23505",
    ],
    ["any other database error", "USING ERRCODE = 'check_violation'", "23514"],
  ])("rethrows %s from createUser unchanged and rolls the tenant back", async (_label, raiseOptions, code) => {
    const pending = await invite("blocked@example.test");
    // Fails only the invitee's insert, after the tenant row of the same transaction was written.
    await adminPool.query(`
      CREATE FUNCTION test_reject_invited_user() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.email = 'blocked@example.test' THEN
          RAISE EXCEPTION 'simulated user insert failure' ${raiseOptions};
        END IF;
        RETURN NEW;
      END $$`);
    await adminPool.query(
      "CREATE TRIGGER test_reject_invited_user BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION test_reject_invited_user()",
    );
    const before = await snapshot();

    const error = await acceptInvitation(dataPool, { token: pending.token, password: PASSWORD }).catch(
      (err: unknown) => err,
    );

    expect(error).not.toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ code, message: "simulated user insert failure" });
    expect(await snapshot()).toEqual(before);
  });

  it("lets exactly one of two concurrent acceptances of one token create the account", async () => {
    const pending = await invite("racer@example.test");
    const before = await snapshot();

    const outcomes = await Promise.allSettled([
      acceptInvitation(dataPool, { token: pending.token, password: PASSWORD }),
      acceptInvitation(dataPool, { token: pending.token, password: PASSWORD }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(NotFoundError);

    const after = await snapshot();
    expect(after.tenants).toHaveLength(before.tenants.length + 1);
    expect(after.users.filter((u) => u.email === "racer@example.test")).toHaveLength(1);
  });

  it.each([
    ["a valid token", true],
    ["an unknown token", false],
  ])("rejects a short password with ValidationError for %s and writes nothing", async (_label, valid) => {
    const pending = await invite();
    const before = await snapshot();

    const error = await acceptInvitation(dataPool, {
      token: valid ? pending.token : randomUUID(),
      password: "short",
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ValidationError);
    expect(await snapshot()).toEqual(before);
  });

  it("propagates a provisioning failure, logs the tenant id only and leaves the tenant provisioning", async () => {
    const pending = await invite("unlucky@example.test");
    const logged = vi.spyOn(logger, "error");
    const failure = new Error("seed failed");

    const error = await acceptInvitation(dataPool, { token: pending.token, password: PASSWORD }, async () => {
      throw failure;
    }).catch((err: unknown) => err);

    expect(error).toBe(failure);
    const { rows } = await adminPool.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [
      "unlucky@example.test",
    ]);
    const userId = rows[0]?.id;
    if (!userId) throw new Error("the user was not created");
    const binding = await tenantOfUser(userId);
    expect(binding.status).toBe("provisioning");
    expect(logged.mock.calls).toEqual([[{ tenantId: binding.tenantId }, "invitation_provisioning_failed"]]);
  });
});

/** A database of its own, migrated by `runMigrations` alone (the `czechHunspellSearch.test.ts` pattern). */
async function withFreshDatabase(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) throw new Error("TEST_DATABASE_URL is not set — is vitest.config.ts's globalSetup wired up?");
  const name = `drop_guard_${randomUUID().replaceAll("-", "")}`;
  const admin = createPool(baseUrl);
  try {
    // `name` is built from a generated UUID, so it cannot break out of the identifier.
    await admin.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
  } catch (createError) {
    try {
      await admin.end();
    } catch {
      // The CREATE DATABASE rejection is the real failure; a failed pool teardown must not replace it.
    }
    throw createError;
  }
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  let failure: { error: unknown } | undefined;
  try {
    await fn(pool);
  } catch (error) {
    failure = { error };
  }
  // Every step runs even when an earlier one rejects; fn's own error wins over cleanup errors.
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

describe("migration 0087_drop_single_tenant_guard (issue #1087)", () => {
  it(
    "leaves no single-tenant guard on a freshly migrated database, so a second tenant can be inserted",
    async () => {
      await withFreshDatabase(async (pool) => {
        await runMigrations(pool);

        const guard = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'tenants_single_tenant_guard'");
        expect(guard.rowCount).toBe(0);
        await pool.query("INSERT INTO tenants (status) VALUES ('provisioning')");
        const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM tenants");
        expect(rows[0]?.n).toBe(2);
      });
    },
    FRESH_DATABASE_TEST_TIMEOUT_MS,
  );
});
