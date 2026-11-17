import { Pool } from "pg";
import { getTenantZeroId, tenantZeroSessionOptions } from "./tenantFixtures.js";

// Test-only re-exports of production writers for cross-package fixtures, kept off the production entry point.
export { storeCredential } from "../credentials/externalCredentialsStore.js";
export { ensureMailAccountSyncState, recordProviderAccountAddress } from "../mail/mailAccountSyncStateStore.js";
export { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
export { ensureFolderItem } from "../mail/folderDiscovery.js";
export { ingestEmailMessage } from "../mail/ingest.js";
export { createThreadTask } from "../mail/threadTasks.js";
export { reconcileGmailAccount, type GmailMailClient } from "../mail/gmailReconcile.js";
export {
  bindToTenantZero,
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  inTenantZero,
  setTenantAiBudget,
  tenantForNextTestUser,
  tenantZeroSessionOptions,
  withTenantTransaction,
} from "./tenantFixtures.js";
export { createTestModuleItem, createTestProjectItem } from "./projectFixtures.js";
export { recordingTransport, sendAdapters, transportFor } from "./mailSendFakes.js";
export { stubDnsLookup, type DnsLookupStub } from "./dnsLookupStub.js";
export { writePageTextBlocks } from "./pageFixtures.js";
export { createSeriesOccurrence, startTaskSeries } from "./taskSeriesFixtures.js";
export { finishTickRunWithMessage, getOrCreateTickThread } from "../semp/sempTickThreadStore.js";
export {
  registerItemCreateHook,
  registerItemUpdateHook,
  registerItemDeleteHook,
  registerItemRestoreHook,
  registerRelationEdgeWriteHook,
  registerRelationEdgeDeleteHook,
  registerRelationEdgeChangedHook,
  clearHooksForTests,
  type ItemCreateHookContext,
  type ItemUpdateHookContext,
  type ItemDeleteHookContext,
  type ItemRestoreHookContext,
  type RelationEdgeWriteHookContext,
  type RelationEdgeDeleteHookContext,
  type RelationEdgeChangedHookContext,
} from "../chokePoint/hooks.js";

/**
 * Superuser pool for seeding and assertions. It bypasses RLS, but `tenant_id` defaults read `app.tenant_id`
 * strictly, so every connection starts in tenant zero; `withTenantTransaction` still overrides it. Pools built from
 * `TEST_DATABASE_URL` directly carry no such setting.
 */
export function getTestPool(config: { max?: number } = {}): Pool {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL is not set — is vitest.config.ts's globalSetup wired up?");
  }
  return new Pool({ connectionString, ...config, options: tenantZeroSessionOptions() });
}

/**
 * Truncates every `public` table except `schema_migrations` (found in the catalog, so new tables are covered), then
 * re-creates tenant zero under its original id.
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
  // TRUNCATE leaves the per-database `items_p_<id>` partitions in place; across a test run they bloat the catalog
  // and lock table until Postgres runs out of shared memory, so drop them all.
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

export { upsertMailMessageMeta } from "../mail/mailMessageMetaStore.js";

export { createInboxItemWithClient } from "../inbox/inboxStore.js";
export {
  GOULASH_ANSWER,
  createRecipeInboxItem,
  htmlPage,
  routedFetch,
  scriptedGateway,
  type PhotoFixture,
} from "./recipeInboxFixtures.js";
export {
  confirmProposalWithClient,
  reopenProposalWithClient,
  reviseProposalWithClient,
  updateProposalValuesWithClient,
} from "../inbox/proposalActions.js";
