import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@alldots/shared";
import { createUser } from "../auth/usersStore.js";
import type { UserRow } from "../auth/types.js";
import { createPool, withTransaction, type CreatePoolOptions } from "../db/pool.js";

/**
 * Harness for multi-tenant tests.
 *
 * - Isolation assertions use a runtime-role pool (`createRuntimeRolePool`): superusers and table owners bypass RLS.
 * - `app_tenant_default()` is strict: a scope-less read under a runtime role sees nothing and a scope-less insert
 *   fails the RLS `WITH CHECK` (42501, before `NOT NULL`'s 23502). Tenant-table writes run in
 *   `withTenantTransaction` or name `tenant_id`. Only `getTestPool` starts connections in tenant zero.
 * - `resetDatabase` removes every tenant except tenant zero, whose id is stable for the run.
 */

type TenantStatus = "provisioning" | "active" | "suspended" | "deleting";
type RuntimeRole = "alldots_data" | "alldots_side";

/**
 * Roles are cluster-wide, so every worker of a run must apply the same password: globalSetup exports one per run.
 * Re-applied on every `createRuntimeRolePool` call because a cluster-exclusive file may have set its own.
 */
function runtimeRolePassword(): string {
  const password = process.env.TEST_RUNTIME_ROLE_PASSWORD;
  if (!password) {
    throw new Error("TEST_RUNTIME_ROLE_PASSWORD is not set — is vitest's globalSetup wired up?");
  }
  return password;
}

/** Exported by globalSetup. */
export function getTenantZeroId(): string {
  const id = process.env.TEST_TENANT_ZERO_ID;
  if (!id) {
    throw new Error("TEST_TENANT_ZERO_ID is not set — is vitest's globalSetup wired up?");
  }
  return id;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `-c app.tenant_id=<id>` for a pool's connections. The id is checked against the UUID shape first, so it cannot
 * smuggle another `-c` option in.
 */
export function tenantZeroSessionOptions(): string {
  const id = getTenantZeroId();
  if (!UUID_PATTERN.test(id)) {
    throw new Error(`TEST_TENANT_ZERO_ID is not a lowercase UUID: ${JSON.stringify(id)}`);
  }
  return `-c app.tenant_id=${id}`;
}

/** For a test that calls a job producer without its own scope: `registerTask` refuses jobs without a tenant. */
export function inTenantZero<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(getTenantZeroId(), fn);
}

/**
 * Proxies `target` so every method runs inside tenant zero, for the same reason as `inTenantZero`. Called from
 * inside another tenant's scope it throws `TenantScopeConflictError`.
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
 * Upserts the tenant's AI budget; an omitted cap is `NULL` (no cap). Raw SQL on the admin pool: no production writer
 * exists and the table is global. A tenant without a row is refused every gateway call.
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

/** What Postgres reports when two sessions update the same catalog row (here `pg_authid`) at once. */
function isConcurrentCatalogUpdate(error: unknown): boolean {
  return error instanceof Error && error.message === "tuple concurrently updated";
}

/**
 * Parallel workers set the same password on the same role, and Postgres refuses the loser of two simultaneous
 * `ALTER ROLE`s instead of waiting. Every worker writes the same value, so retrying is safe.
 */
async function alterRolePassword(adminPool: Pool, role: RuntimeRole, password: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // `role` is a closed union and the password a UUID; ALTER ROLE accepts no bind parameters.
      await adminPool.query(`ALTER ROLE ${role} WITH PASSWORD '${password}'`);
      return;
    } catch (error) {
      if (!isConcurrentCatalogUpdate(error) || attempt === 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }
}

/** Uses the production pool constructor. The caller ends it. */
export async function createRuntimeRolePool(
  adminPool: Pool,
  role: RuntimeRole,
  options: Pick<CreatePoolOptions, "statementTimeoutMs" | "max"> = {},
): Promise<Pool> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) {
    throw new Error("TEST_DATABASE_URL is not set — is vitest.config.ts's globalSetup wired up?");
  }
  const password = runtimeRolePassword();
  await alterRolePassword(adminPool, role, password);
  const url = new URL(baseUrl);
  url.username = role;
  url.password = password;
  return createPool(url.toString(), options);
}

/** Test-only stand-in for the tenant scope primitive. */
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
 * Tenant zero while it has no user, otherwise a fresh tenant: `users.tenant_id` is unique, so every test account
 * needs its own tenant.
 */
export async function tenantForNextTestUser(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ bound: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM users WHERE tenant_id = $1) AS bound",
    [getTenantZeroId()],
  );
  return (rows[0]?.bound ?? false) ? createTestTenant(pool) : getTenantZeroId();
}

/** Only the first call creates tenant zero's user (recipient of its events, actor of its root runs). */
export async function createTenantZeroUser(pool: Pool, email = `${randomUUID()}@example.com`): Promise<UserRow> {
  return createUser(pool, { email, passwordHash: "unused", tenantId: await tenantForNextTestUser(pool) });
}
