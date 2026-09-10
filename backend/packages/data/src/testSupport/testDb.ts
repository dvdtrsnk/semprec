import { Pool } from "pg";

const TABLES = [
  "module_migrations",
  "idempotency_keys",
  "login_attempts",
  "push_subscriptions",
  "sessions",
  "notifications",
  "manifest_drift_findings",
  "rollup_dependencies",
  "resource_grants",
  "project_agent_guidance",
  "project_mcp_grants",
  "mcp_tool_registrations",
  "approval_requests",
  "agent_run_events",
  "agent_runs",
  "project_heartbeats",
  "view_items",
  "views",
  "task_recurrence",
  "item_automation",
  "mail_attachments",
  "mail_message_meta",
  "mail_threads",
  "mail_folder_sync_state",
  "mail_account_sync_state",
  "credential_access_log",
  "external_credentials",
  "person_email_index",
  "item_search_index",
  "item_relations",
  "items",
  "relation_definitions",
  "properties",
  "doc_snapshot_history",
  "doc_history_updates",
  "doc_updates",
  "doc_snapshots",
  "docs",
  "blobs",
  "databases",
  "users",
];

export function getTestPool(): Pool {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL is not set — is vitest.config.ts's globalSetup wired up?");
  }
  return new Pool({ connectionString });
}

/** Test-only: wipes all rows between tests. `items` is partitioned but TRUNCATE cascades through all partitions. */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
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
