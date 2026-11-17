// Item writes by the property type migration job. Unlike `updateItemWithClient` they run no update
// hooks, enqueue no heartbeat, emit no invalidation, and also reach soft-deleted items.
import type { PoolClient } from "pg";
import { requireAffectedRows } from "../db/pool.js";

export interface MigrateItemPropertyInput {
  databaseId: string;
  itemId: string;
  key: string;
  change: { kind: "set"; value: unknown } | { kind: "remove" };
}

/**
 * Sets or removes one key of `properties` and advances `updated_at`, in the caller's transaction.
 * Throws when no row matches, and before writing when `change.value` has no JSON form: pg would bind
 * it as NULL and `jsonb_set` would replace the whole `properties` with NULL.
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
