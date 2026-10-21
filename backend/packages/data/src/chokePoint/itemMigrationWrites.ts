// Owns the choke point's item writes made by the property type migration job: replacing or
// removing one key of an item's `properties`. Unlike `updateItemWithClient`, these writes run no
// item update hooks, enqueue no heartbeat and emit no invalidation, and they also reach a
// soft-deleted item.
// Constrained by: docs/adr/2026-09-10-choke-point-api-for-state-writes.md
import type { PoolClient } from "pg";
import { requireAffectedRows } from "../db/pool.js";

export interface MigrateItemPropertyInput {
  databaseId: string;
  itemId: string;
  key: string;
  change: { kind: "set"; value: unknown } | { kind: "remove" };
}

/**
 * Sets `key` in the item's `properties` to `change.value` (`set`) or deletes `key` (`remove`),
 * leaving every other key as-is, and advances `updated_at`. Runs on the caller's client, so it
 * joins the caller's transaction. Throws when `(databaseId, itemId)` matches no row.
 */
export async function migrateItemPropertyWithClient(
  client: PoolClient,
  input: MigrateItemPropertyInput,
): Promise<void> {
  const { databaseId, itemId, key, change } = input;
  if (change.kind === "set") {
    requireAffectedRows(
      await client.query(
        `UPDATE items SET properties = jsonb_set(properties, ARRAY[$3]::text[], $4::jsonb), updated_at = now() WHERE database_id = $1 AND id = $2`,
        [databaseId, itemId, key, JSON.stringify(change.value)],
      ),
      "property type migration value conversion update",
    );
    return;
  }
  requireAffectedRows(
    await client.query(
      `UPDATE items SET properties = properties - $3, updated_at = now() WHERE database_id = $1 AND id = $2`,
      [databaseId, itemId, key],
    ),
    "property type migration dropped value update",
  );
}
