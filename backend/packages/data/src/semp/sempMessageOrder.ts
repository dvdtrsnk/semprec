import type { PoolClient } from "pg";
import { requireManagedTransaction, requireSingleRow } from "../db/pool.js";
import { NotFoundError } from "../errors.js";

export async function allocateSempMessageTimestamp(client: PoolClient, threadId: string): Promise<string> {
  requireManagedTransaction(client);
  const isolation = await client.query<{ transaction_isolation: string }>("SHOW transaction_isolation");
  if (requireSingleRow(isolation.rows, "transaction isolation").transaction_isolation !== "read committed") {
    throw new Error("Semp message insertion requires read committed isolation");
  }
  const locked = await client.query<{ id: string }>("SELECT id FROM semp_threads WHERE id = $1 FOR UPDATE", [threadId]);
  if (locked.rowCount !== 1) throw new NotFoundError("Thread not found");
  const stamp = await client.query<{ created_at: string }>(
    `SELECT to_char(GREATEST(clock_timestamp(), COALESCE(MAX(created_at) + interval '1 microsecond', '-infinity'::timestamptz))
      AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM semp_messages WHERE thread_id = $1`,
    [threadId],
  );
  return requireSingleRow(stamp.rows, "Semp message timestamp").created_at;
}
