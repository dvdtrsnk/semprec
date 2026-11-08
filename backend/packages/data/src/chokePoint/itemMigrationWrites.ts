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
 * joins the caller's transaction. Throws when `(databaseId, itemId)` matches no row, and throws
 * before writing when `change.value` has no JSON form (`undefined`, a function, a symbol):
 * `JSON.stringify` returns `undefined` for those, pg binds it as SQL NULL, and `jsonb_set` with a
 * NULL value would replace the item's whole `properties` with NULL.
 */
export async function migrateItemPropertyWithClient(
  client: PoolClient,
  input: MigrateItemPropertyInput,
): Promise<void> {
  const { databaseId, itemId, key, change } = input;
  if (change.kind === "set") {
    const serialized: string | undefined = JSON.stringify(change.value);
    if (serialized === undefined) {
      throw new TypeError(`property type migration value for "${key}" has no JSON representation`);
    }
    requireAffectedRows(
      await client.query(
        `UPDATE items SET properties = jsonb_set(properties, ARRAY[$3]::text[], $4::jsonb), updated_at = now() WHERE database_id = $1 AND id = $2`,
        [databaseId, itemId, key, serialized],
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
