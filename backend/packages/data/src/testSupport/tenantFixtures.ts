import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createPool, withTransaction } from "../db/pool.js";

/**
 * Harness for tests that need more than one tenant.
 *
 * Rules:
 * - Isolation assertions use a runtime-role pool (`createRuntimeRolePool`), never the superuser
 *   pool: superusers and table owners bypass row-level security, so such a test proves nothing.
 * - While a second tenant exists, `app_sole_tenant()` is NULL, so a scope-less read under a runtime
 *   role sees nothing and a scope-less insert fails on `NOT NULL`. That is the intended fail-closed
 *   behaviour; every write to a tenant table therefore runs inside a tenant (`withTenantTransaction`)
 *   or names `tenant_id`.
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
