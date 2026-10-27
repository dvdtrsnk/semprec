import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { currentTenantScope, TenantScopeMissingError } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { assertRowSecurityActive, forEachMaintainedTenant } from "../tenancy/provisionTenant.js";
import { tenantLane } from "../tenancy/tenantLane.js";
import { indexItem } from "./itemSearchIndexer.js";

const CHUNK_SIZE = 100;
const backfillOptionsSchema = z
  .object({
    databaseId: z.uuid().optional(),
    afterItemId: z.uuid().optional(),
    onlyMissing: z.boolean(),
  })
  .strict();
export type ItemSearchBackfillOptions = z.infer<typeof backfillOptionsSchema>;

/** Enqueues one chunk; its cursor is part of the key so a running chunk cannot absorb its continuation. */
export async function enqueueItemSearchBackfill(client: PoolClient, options: ItemSearchBackfillOptions): Promise<void> {
  const payload = backfillOptionsSchema.parse(options);
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new TenantScopeMissingError("Item search backfill requires a tenant scope");
  await enqueueJob(client, CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL, payload, {
    jobKey: `item-search-backfill:${scope.tenantId}:${payload.databaseId ?? "all"}:${payload.onlyMissing ? "missing" : "all"}:${payload.afterItemId ?? "start"}`,
    queueName: tenantLane("item-search-index"),
    maxAttempts: 3,
  });
}

/** Each invocation commits at most one chunk together with its continuation; errors roll back that chunk. */
export async function handleItemSearchBackfillTask(pool: Pool, payload: unknown): Promise<void> {
  const options = backfillOptionsSchema.parse(payload);
  await withTransaction(pool, async (client) => {
    const { rows: databases } = await client.query<{ id: string }>(
      `SELECT id FROM databases WHERE owner_module_id IS DISTINCT FROM $1
       AND ($2::uuid IS NULL OR id = $2) ORDER BY id`,
      [EMAILS_MODULE_ID, options.databaseId ?? null],
    );
    const { rows } = await client.query<{ id: string }>(
      `SELECT i.id FROM items i
       WHERE i.database_id = ANY($1::uuid[]) AND i.deleted_at IS NULL
         AND ($2::uuid IS NULL OR i.id > $2)
         AND (NOT $3::boolean OR NOT EXISTS (SELECT 1 FROM item_search_index s WHERE s.item_id = i.id))
       ORDER BY i.id LIMIT $4`,
      [databases.map((db) => db.id), options.afterItemId ?? null, options.onlyMissing, CHUNK_SIZE],
    );
    for (const row of rows) await indexItem(client, row.id, { onlyMissing: options.onlyMissing });
    const last = rows.at(-1);
    if (rows.length === CHUNK_SIZE && last) {
      await enqueueItemSearchBackfill(client, { ...options, afterItemId: last.id });
    }
  });
}

/** Deploy calls this after queue schema grants, using the semprec_data pool so RLS applies. */
export async function runItemSearchBackfillCutover(pool: Pool): Promise<void> {
  await assertRowSecurityActive(pool);
  await forEachMaintainedTenant(pool, async () => {
    await withTransaction(pool, (client) => enqueueItemSearchBackfill(client, { onlyMissing: true }));
  });
}
