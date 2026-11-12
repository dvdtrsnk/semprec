import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { SENSITIVE_DATABASE_KEYS } from "./sensitiveDatabaseKeys.js";

/**
 * Populated-upgrade cutover for issue #1808: sets `sensitive` on the current tenant's system databases whose
 * key is in `SENSITIVE_DATABASE_KEYS`. A tenant seeded before the flag has these databases with the column
 * default `false`, and an already seeded tenant is not seeded again.
 *
 * One statement, one transaction. Only a row that is not yet sensitive is written, so a second run matches no
 * row and writes nothing. A tenant without one of the databases (the sleep databases of a tenant not yet
 * delivered, or any tenant that has not been seeded) simply has no row to update. Row-level security confines
 * the statement to the tenant of the scope it runs in.
 *
 * Returns how many databases it marked. `runTenantCutoverMigrations` calls it for each maintained tenant, inside
 * that tenant's scope.
 */
export async function runSensitiveDatabasesCutoverMigration(pool: Pool): Promise<number> {
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      "UPDATE databases SET sensitive = true WHERE system AND key = ANY($1::text[]) AND NOT sensitive",
      [SENSITIVE_DATABASE_KEYS],
    );
    // Zero rows is a valid outcome: nothing was left to mark.
    return result.rowCount ?? 0;
  });
}
