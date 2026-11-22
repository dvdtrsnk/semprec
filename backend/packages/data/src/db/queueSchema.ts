import type { Pool } from "pg";
import { ensureQueueSchema, grantQueueSchemaPrivileges } from "@semprec/queue";
import { runAsSystem } from "@semprec/shared";
import { withTransaction } from "./pool.js";

/**
 * Creates or updates graphile-worker's schema, then grants `semprec_side` access to it in one transaction that
 * holds the grant lock, so several processes may run it at once. Run as the role that owns the schema, at every
 * queue runtime's start and in the deploy migrations.
 */
export async function installQueueSchema(pool: Pool): Promise<void> {
  await runAsSystem("queue-schema", async () => {
    await ensureQueueSchema(pool);
    await withTransaction(pool, (client) => grantQueueSchemaPrivileges(client));
  });
}
