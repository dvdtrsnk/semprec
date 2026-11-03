import type { PoolClient } from "pg";
import { requireManagedTransaction } from "../db/pool.js";

/** Enforces the transaction assumptions of the rollup archive coordination ADR. */
export async function requireRollupCoordinationTransaction(client: PoolClient): Promise<void> {
  requireManagedTransaction(client);
  if (client.getTransactionStatus() !== "T") {
    throw new Error("Rollup coordination requires an active READ COMMITTED transaction");
  }
  const { rows } = await client.query<{ isolation: string }>(
    "SELECT current_setting('transaction_isolation') AS isolation",
  );
  if (rows[0]?.isolation !== "read committed") {
    throw new Error("Rollup coordination requires an active READ COMMITTED transaction");
  }
}

/** Holds the visible source row through dependency upsert and its caller's commit. */
export async function lockRollupSourceDatabase(client: PoolClient, databaseId: string): Promise<void> {
  await requireRollupCoordinationTransaction(client);
  await client.query<{ id: string }>("SELECT id FROM databases WHERE id = $1 FOR SHARE", [databaseId]);
}
