import { Pool } from "pg";
import { getTenantZeroId } from "./tenantFixtures.js";

// Test-only: lets a composition-root test outside this package make a Mailbox syncable (a stored
// credential plus its sync-state row) without adding either writer to the production entry point.
export { storeCredential } from "../credentials/externalCredentialsStore.js";
export { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
export {
  bindToTenantZero,
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  inTenantZero,
  setTenantAiBudget,
  tenantForNextTestUser,
  withTenantTransaction,
} from "./tenantFixtures.js";
export { createTestModuleItem, createTestProjectItem } from "./projectFixtures.js";

/**
 * The superuser pool existing suites seed and assert through. Superusers bypass row-level security,
 * so only the `tenant_id` defaults read `app.tenant_id` here; since the strict switch (#1067) they
 * no longer fall back to the sole tenant, so every connection of this pool starts with the
 * session-level setting `app.tenant_id` = tenant zero. A test's transaction-local `set_config`
 * (`withTenantTransaction`) still overrides it, and pools built from `TEST_DATABASE_URL` itself
 * (`createPool`, `createRuntimeRolePool`) carry no such setting.
 */
export function getTestPool(): Pool {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL is not set — is vitest.config.ts's globalSetup wired up?");
  }
  return new Pool({ connectionString, options: `-c app.tenant_id=${getTenantZeroId()}` });
}

/**
 * Test-only: wipes all rows between tests. Truncates every table in `public` except
 * `schema_migrations` (found in the catalog, so a new table is covered without editing a list), then
 * re-creates tenant zero under its original id — any other tenant is gone. `items` is partitioned
 * but TRUNCATE cascades through all partitions.
 */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    DO $$
    DECLARE tables text;
    BEGIN
      SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') INTO tables
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND NOT c.relispartition
         AND c.relname <> 'schema_migrations';
      IF tables IS NULL THEN
        RAISE EXCEPTION 'resetDatabase: no tables found in the public schema';
      END IF;
      EXECUTE 'TRUNCATE ' || tables || ' RESTART IDENTITY CASCADE';
    END $$;
  `);
  await pool.query("INSERT INTO tenants (id, status) VALUES ($1, 'active')", [getTenantZeroId()]);
  await pool.query(`TRUNCATE graphile_worker._private_jobs RESTART IDENTITY CASCADE`);
  // `databasesStore.createDatabase` creates one `items_p_<id>` partition per database and
  // there is no DEFAULT partition (see migration 0001's header note), so the TRUNCATE above
  // never removes the partition tables themselves — only their rows. Left unchecked across a
  // whole test run (every `seedSystem` call creates a couple dozen fresh ones), the resulting
  // catalog/lock-table bloat eventually exhausts Postgres's shared memory. Dropping every
  // dynamic partition here keeps the count bounded to whatever the current test creates.
  await pool.query(`
    DO $$
    DECLARE partition RECORD;
    BEGIN
      FOR partition IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'items\\_p\\_%' LOOP
        EXECUTE format('DROP TABLE IF EXISTS %I', partition.tablename);
      END LOOP;
    END $$;
  `);
}
