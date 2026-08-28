import { Pool } from "pg";

const TABLES = [
  "idempotency_keys",
  "notifications",
  "rollup_dependencies",
  "resource_grants",
  "agent_runs",
  "project_heartbeats",
  "view_items",
  "views",
  "item_relations",
  "items",
  "relation_definitions",
  "properties",
  "doc_snapshot_history",
  "doc_updates",
  "doc_snapshots",
  "docs",
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
}
