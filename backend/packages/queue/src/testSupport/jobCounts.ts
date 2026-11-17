import type { Pool } from "pg";

/** Test-only: counts every job row (pending, locked or awaiting retry) of `identifier`, so tests never query graphile-worker's private tables themselves. */
export async function countJobsByIdentifier(pool: Pool, identifier: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
     WHERE tasks.identifier = $1`,
    [identifier],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Test-only: the stored envelopes of every job row of `identifier`; the public `jobs` view does not expose `payload`. */
export async function readJobPayloadsByIdentifier(pool: Pool, identifier: string): Promise<unknown[]> {
  const { rows } = await pool.query<{ payload: unknown }>(
    `SELECT jobs.payload FROM graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
     WHERE tasks.identifier = $1`,
    [identifier],
  );
  return rows.map((row) => row.payload);
}
