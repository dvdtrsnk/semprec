import type { Pool } from "pg";

/**
 * Test-only observation of queue state, so tests read Graphile Worker's private backing tables
 * through this module instead of querying them directly. Counts every job row (pending, locked or
 * awaiting retry) whose task has the given identifier.
 */
export async function countJobsByIdentifier(pool: Pool, identifier: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
     WHERE tasks.identifier = $1`,
    [identifier],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Test-only read-back of the raw payloads (the envelope as stored) of every job row whose task has
 * the given identifier. The public `graphile_worker.jobs` view does not expose `payload`, so this
 * is the one place that reads it from the private tables.
 */
export async function readJobPayloadsByIdentifier(pool: Pool, identifier: string): Promise<unknown[]> {
  const { rows } = await pool.query<{ payload: unknown }>(
    `SELECT jobs.payload FROM graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
     WHERE tasks.identifier = $1`,
    [identifier],
  );
  return rows.map((row) => row.payload);
}
