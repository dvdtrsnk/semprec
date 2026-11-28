import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES } from "@alldots/queue";
import { currentTenantScope, TenantScopeMissingError } from "@alldots/shared";
import { withTransaction } from "../db/pool.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { indexItem } from "./itemSearchIndexer.js";
import { enqueueSearchLaneJob } from "./searchLaneEnqueue.js";

const CHUNK_SIZE = 100;
const backfillOptionsSchema = z
  .object({
    databaseId: z.uuid().optional(),
    afterItemId: z.uuid().optional(),
  })
  .strict();
export type ItemSearchBackfillOptions = z.infer<typeof backfillOptionsSchema>;

/** Added at the pre-commit flush; the cursor is part of the key so a running chunk cannot absorb its continuation. */
export async function enqueueItemSearchBackfill(client: PoolClient, options: ItemSearchBackfillOptions): Promise<void> {
  const payload = backfillOptionsSchema.parse(options);
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new TenantScopeMissingError("Item search backfill requires a tenant scope");
  enqueueSearchLaneJob(client, CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL, payload, {
    jobKey: `item-search-backfill:${scope.tenantId}:${payload.databaseId ?? "all"}:${payload.afterItemId ?? "start"}`,
    jobKeyMode: "replace",
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
       ORDER BY i.id LIMIT $3`,
      [databases.map((db) => db.id), options.afterItemId ?? null, CHUNK_SIZE],
    );
    for (const row of rows) await indexItem(client, row.id, { preserveBody: true });
    const last = rows.at(-1);
    if (rows.length === CHUNK_SIZE && last) {
      await enqueueItemSearchBackfill(client, { ...options, afterItemId: last.id });
    }
  });
}
