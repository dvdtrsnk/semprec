import path from "node:path";
import pg from "pg";
import { afterAll, expect } from "vitest";
import {
  CLONE_LOCK_KEY,
  CLUSTER_LOCK_KEY,
  isClusterExclusive,
  readClusterExclusiveFiles,
  workerDatabaseName,
} from "./workerDatabaseConfig.js";

/**
 * Integration-tier `setupFiles` entry, run before every test file in its worker:
 *
 * - Points `TEST_DATABASE_URL` at this worker's own database, cloned once from the template globalSetup migrated, so
 *   test files in different workers never share tables.
 * - Holds a cluster lock for the whole file: shared for ordinary files, exclusive for the files in
 *   `clusterExclusiveFiles.json`, which change cluster-wide state (roles and their passwords) that every worker sees.
 *   Postgres queues lock requests in order, so a waiting exclusive file is not starved by later shared ones.
 *
 * docs/architecture/testing.md#parallel-integration-workers
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — is vitest's globalSetup wired up?`);
  return value;
}

async function ensureWorkerDatabase(admin: pg.Client, name: string, template: string): Promise<void> {
  // Clones are serialized: CREATE DATABASE refuses a template another clone is reading.
  await admin.query("SELECT pg_advisory_lock($1)", [CLONE_LOCK_KEY]);
  try {
    const { rows } = await admin.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present",
      [name],
    );
    // Both names are generated here or by globalSetup from fixed literals; CREATE DATABASE takes no bind parameters.
    if (rows[0]?.present !== true) await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  } finally {
    await admin.query("SELECT pg_advisory_unlock($1)", [CLONE_LOCK_KEY]);
  }
}

async function setUpWorkerDatabase(): Promise<void> {
  const testPath = expect.getState().testPath;
  if (testPath === undefined || !path.isAbsolute(testPath)) {
    throw new Error(`workerDatabase: cannot determine the running test file (got ${JSON.stringify(testPath)})`);
  }
  const name = workerDatabaseName(process.env.VITEST_POOL_ID);
  const template = requiredEnv("TEST_TEMPLATE_DATABASE");
  const adminUrl = requiredEnv("TEST_ADMIN_DATABASE_URL");

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await ensureWorkerDatabase(admin, name, template);
    const exclusive = isClusterExclusive(testPath, readClusterExclusiveFiles());
    // Top-level, not in a hook: waiting for other workers' files can outlast any hook timeout.
    await admin.query(exclusive ? "SELECT pg_advisory_lock($1)" : "SELECT pg_advisory_lock_shared($1)", [
      CLUSTER_LOCK_KEY,
    ]);
  } catch (error) {
    // The setup failure is what gets reported; a failed disconnect must not replace it.
    await admin.end().catch(() => undefined);
    throw error;
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  process.env.TEST_DATABASE_URL = url.toString();

  // Ending the session releases the lock; a crashed worker's session ends with it.
  afterAll(async () => {
    await admin.end();
  });
}

await setUpWorkerDatabase();
