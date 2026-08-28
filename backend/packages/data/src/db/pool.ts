import { Pool, type PoolClient } from "pg";

/** Anything a query can run against: a pool, or a client already inside a transaction. */
export type Queryable = Pool | PoolClient;

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

/** Runs `fn` inside a single transaction on a dedicated client, committing on success and rolling back on error. */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}
