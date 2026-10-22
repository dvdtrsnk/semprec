import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import type { UserRow } from "../auth/types.js";
import { createPool, withTransaction } from "../db/pool.js";

/**
 * Harness for tests that need more than one tenant.
 *
 * Rules:
 * - Isolation assertions use a runtime-role pool (`createRuntimeRolePool`), never the superuser
 *   pool: superusers and table owners bypass row-level security, so such a test proves nothing.
 * - `app_tenant_default()` is strict (#1067), so a scope-less read under a runtime role sees
 *   nothing and a scope-less insert is refused by the RLS `WITH CHECK` (SQLSTATE 42501, which Postgres
 *   evaluates before the `NOT NULL` constraint, 23502), however many tenants exist. That is the
 *   intended fail-closed behaviour; every write to a tenant table therefore runs inside a tenant
 *   (`withTenantTransaction`) or names `tenant_id`. Only the superuser pool from `getTestPool`
 *   starts its connections in tenant zero.
 * - `resetDatabase` removes every tenant except tenant zero, which keeps its id for the whole run.
 */

type TenantStatus = "provisioning" | "active" | "suspended" | "deleting";
type RuntimeRole = "semprec_data" | "semprec_side";

// Generated once per module load; every `createRuntimeRolePool` call re-applies it because other
// test files set their own password on the same roles.
const RUNTIME_ROLE_PASSWORD = randomUUID();

/** The id of the tenant the migrations created, exported by globalSetup. */
export function getTenantZeroId(): string {
  const id = process.env.TEST_TENANT_ZERO_ID;
  if (!id) {
    throw new Error("TEST_TENANT_ZERO_ID is not set — is vitest's globalSetup wired up?");
  }
  return id;
}

/**
 * Runs `fn` inside tenant zero, for a test that calls a job producer without a scope of its own:
 * `registerTask` refuses a tenant task whose job envelope carries no tenant, so the jobs `fn`
 * enqueues must carry one.
 */
export function inTenantZero<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(getTenantZeroId(), fn);
}

/**
 * Returns `target` with every method run inside tenant zero (`runInTenant`), for a test that drives
 * a job producer (the choke point, a store's write functions) without a scope of its own:
 * `registerTask` refuses a tenant task whose job envelope carries no tenant, so the jobs those
 * writes enqueue must carry one. A bound method called from inside another tenant's scope throws
 * `TenantScopeConflictError`, as `runInTenant` does.
 */
export function bindToTenantZero<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown =>
        runInTenant(getTenantZeroId(), (): unknown => Reflect.apply(value, object, args));
    },
  });
}

/** Inserts a `tenants` row (status `active` unless given) and returns its id. */
export async function createTestTenant(pool: Pool, options: { status?: TenantStatus } = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("INSERT INTO tenants (status) VALUES ($1) RETURNING id", [
    options.status ?? "active",
  ]);
  const row = rows[0];
  if (!row) {
    throw new Error("createTestTenant: INSERT INTO tenants returned no row");
  }
  return row.id;
}

/**
 * Upserts `tenantId`'s `tenant_ai_budgets` row; an omitted cap is `NULL` (no per-tenant cap for
 * that window). Raw SQL on the admin pool because no production writer exists yet and the table
 * is global, so no tenant scope applies. `resetDatabase` empties the table, and a tenant without a
 * row is refused every gateway call.
 */
export async function setTenantAiBudget(
  pool: Pool,
  tenantId: string,
  caps: { dailyCapUsd?: number | null; monthlyCapUsd?: number | null } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_ai_budgets (tenant_id, daily_cap_usd, monthly_cap_usd) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE SET daily_cap_usd = EXCLUDED.daily_cap_usd, monthly_cap_usd = EXCLUDED.monthly_cap_usd`,
    [tenantId, caps.dailyCapUsd ?? null, caps.monthlyCapUsd ?? null],
  );
}

/** A pool logged in as a runtime role through the production pool constructor. The caller ends it. */
export async function createRuntimeRolePool(adminPool: Pool, role: RuntimeRole): Promise<Pool> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) {
    throw new Error("TEST_DATABASE_URL is not set — is vitest.config.ts's globalSetup wired up?");
  }
  // `role` is a closed union and the password a UUID, so neither can break out of the statement;
  // ALTER ROLE accepts no bind parameters.
  await adminPool.query(`ALTER ROLE ${role} WITH PASSWORD '${RUNTIME_ROLE_PASSWORD}'`);
  const url = new URL(baseUrl);
  url.username = role;
  url.password = RUNTIME_ROLE_PASSWORD;
  return createPool(url.toString());
}

/** Test-only stand-in for the tenant scope primitive: runs `fn` in a transaction scoped to `tenantId`. */
export async function withTenantTransaction<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return fn(client);
  });
}

/**
 * The tenant the next test account binds to: tenant zero while it has no user, otherwise a fresh
 * tenant (`createTestTenant`). `users.tenant_id` is unique and NOT NULL (#1067), so every test
 * account needs a tenant of its own; the first one becomes tenant zero's user.
 */
export async function tenantForNextTestUser(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ bound: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM users WHERE tenant_id = $1) AS bound",
    [getTenantZeroId()],
  );
  return (rows[0]?.bound ?? false) ? createTestTenant(pool) : getTenantZeroId();
}

/**
 * Creates a test account through `createUser` bound to `tenantForNextTestUser`: the first account
 * is tenant zero's user — the recipient of tenant zero's events and the actor of its root runs —
 * and every later one is bound to a fresh tenant of its own.
 */
export async function createTenantZeroUser(pool: Pool, email = `${randomUUID()}@example.com`): Promise<UserRow> {
  return createUser(pool, { email, passwordHash: "unused", tenantId: await tenantForNextTestUser(pool) });
}
