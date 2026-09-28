import type { PoolClient } from "pg";

interface LockItemBatchInput {
  databaseId: string;
  /** Exclusive lower bound on `id`; `null` starts from the first item. */
  afterId: string | null;
  pageSize: number;
  /** Skip rows another transaction holds a lock on instead of waiting for them. */
  skipLocked: boolean;
}

/**
 * Reads the next id-ordered page of `databaseId`'s items and row-locks it (`FOR UPDATE`,
 * optionally `SKIP LOCKED`). Must run inside the caller's transaction: the rows stay locked
 * until that transaction commits or rolls back, so a full-replace write of a row read here
 * cannot overwrite a concurrent choke-point update committed in between.
 */
export async function lockItemBatch(
  client: PoolClient,
  input: LockItemBatchInput,
): Promise<Array<{ id: string; properties: Record<string, unknown> }>> {
  const { rows } = await client.query<{ id: string; properties: Record<string, unknown> }>(
    `SELECT id, properties FROM items WHERE database_id = $1 ${input.afterId !== null ? "AND id > $3" : ""}
     ORDER BY id ASC LIMIT $2 FOR UPDATE${input.skipLocked ? " SKIP LOCKED" : ""}`,
    input.afterId !== null ? [input.databaseId, input.pageSize, input.afterId] : [input.databaseId, input.pageSize],
  );
  return rows;
}
