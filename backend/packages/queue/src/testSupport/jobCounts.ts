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
