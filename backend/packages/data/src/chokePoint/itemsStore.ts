import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/pool.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import type { ItemRow } from "../types.js";
import type { ComputedKeyRegistry } from "./computedKeyRegistry.js";

function mapItemRow(row: {
  id: string;
  database_id: string;
  properties: Record<string, unknown>;
  computed: Record<string, unknown>;
  updated_at: Date;
  deleted_at: Date | null;
}): ItemRow {
  return {
    id: row.id,
    databaseId: row.database_id,
    properties: row.properties,
    computed: row.computed,
    updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
  };
}

export async function getItemById(client: Queryable, databaseId: string, itemId: string): Promise<ItemRow | null> {
  const { rows } = await client.query(
    `SELECT id, database_id, properties, computed, updated_at, deleted_at
     FROM items WHERE database_id = $1 AND id = $2`,
    [databaseId, itemId],
  );
  return rows[0] ? mapItemRow(rows[0]) : null;
}

/** Row-locking read used before a mutation, inside the caller's transaction. */
async function lockItemById(client: Queryable, databaseId: string, itemId: string): Promise<ItemRow | null> {
  const { rows } = await client.query(
    `SELECT id, database_id, properties, computed, updated_at, deleted_at
     FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE`,
    [databaseId, itemId],
  );
  return rows[0] ? mapItemRow(rows[0]) : null;
}

export interface InsertItemInput {
  databaseId: string;
  properties: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * Inserts a new item, honoring an optional Idempotency-Key: a repeat call with the
 * same key returns the row created by the first call instead of inserting a second
 * one. Must run inside a transaction (the reservation race is only safe because the
 * idempotency_keys row and the items row commit atomically together).
 */
export async function insertItem(client: Queryable, input: InsertItemInput): Promise<ItemRow> {
  const generatedId = randomUUID();
  let itemId: string = generatedId;

  if (input.idempotencyKey) {
    const reserve = await client.query<{ item_id: string }>(
      `INSERT INTO idempotency_keys (key, database_id, item_id) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING
       RETURNING item_id`,
      [input.idempotencyKey, input.databaseId, generatedId],
    );
    if (reserve.rowCount === 0) {
      const { rows } = await client.query<{ item_id: string; database_id: string }>(
        `SELECT item_id, database_id FROM idempotency_keys WHERE key = $1`,
        [input.idempotencyKey],
      );
      const reserved = rows[0];
      if (reserved.database_id !== input.databaseId) {
        throw new ConflictError(`Idempotency key '${input.idempotencyKey}' was already used for a different database`, {
          key: input.idempotencyKey,
          reservedDatabaseId: reserved.database_id,
        });
      }
      itemId = reserved.item_id;
      const existing = await getItemById(client, input.databaseId, itemId);
      if (existing) return existing;
      // The winning transaction committed the idempotency_keys row but, being the
      // same transaction as its items insert, must also have committed that row —
      // this branch is unreachable in practice and exists only as a defensive guard.
      throw new ConflictError("Idempotency key reservation exists but its item is missing");
    }
  }

  const { rows } = await client.query(
    `INSERT INTO items (id, database_id, properties) VALUES ($1, $2, $3::jsonb)
     RETURNING id, database_id, properties, computed, updated_at, deleted_at`,
    [itemId, input.databaseId, JSON.stringify(input.properties)],
  );
  return mapItemRow(rows[0]);
}

export interface UpdateItemInput {
  databaseId: string;
  itemId: string;
  propertiesPatch: Record<string, unknown>;
  /** the `updated_at` the client last held; a mismatch is a conflict, not a silent overwrite */
  ifVersion?: string;
}

export async function updateItemProperties(client: Queryable, input: UpdateItemInput): Promise<ItemRow> {
  const current = await lockItemById(client, input.databaseId, input.itemId);
  if (!current || current.deletedAt) {
    throw new NotFoundError(`Item ${input.itemId} not found`);
  }
  if (input.ifVersion !== undefined && input.ifVersion !== current.updatedAt) {
    throw new ConflictError("Item was modified since ifVersion was read", { current });
  }

  const { rows } = await client.query(
    `UPDATE items SET properties = properties || $3::jsonb, updated_at = now()
     WHERE database_id = $1 AND id = $2
     RETURNING id, database_id, properties, computed, updated_at, deleted_at`,
    [input.databaseId, input.itemId, JSON.stringify(input.propertiesPatch)],
  );
  return mapItemRow(rows[0]);
}

export async function softDeleteItem(client: Queryable, databaseId: string, itemId: string): Promise<ItemRow | null> {
  const { rows } = await client.query(
    `UPDATE items SET deleted_at = now() WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL
     RETURNING id, database_id, properties, computed, updated_at, deleted_at`,
    [databaseId, itemId],
  );
  return rows[0] ? mapItemRow(rows[0]) : null;
}

export async function restoreItem(client: Queryable, databaseId: string, itemId: string): Promise<ItemRow | null> {
  const { rows } = await client.query(
    `UPDATE items SET deleted_at = NULL WHERE database_id = $1 AND id = $2 AND deleted_at IS NOT NULL
     RETURNING id, database_id, properties, computed, updated_at, deleted_at`,
    [databaseId, itemId],
  );
  return rows[0] ? mapItemRow(rows[0]) : null;
}

export interface ListItemsOptions {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
}

export async function listItems(
  client: Queryable,
  databaseId: string,
  options: ListItemsOptions = {},
): Promise<{ items: ItemRow[]; nextCursor: string | null }> {
  const limit = Math.min(options.limit ?? 50, 200);
  const conditions = ["database_id = $1"];
  const params: unknown[] = [databaseId];
  if (!options.includeDeleted) conditions.push("deleted_at IS NULL");
  if (options.cursor) {
    params.push(options.cursor);
    conditions.push(`id > $${params.length}`);
  }
  params.push(limit + 1);

  const { rows } = await client.query(
    `SELECT id, database_id, properties, computed, updated_at, deleted_at
     FROM items WHERE ${conditions.join(" AND ")} ORDER BY id ASC LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(mapItemRow),
    nextCursor: hasMore ? (page[page.length - 1] as { id: string }).id : null,
  };
}

/**
 * Writes exclusively to `items.computed`, never to `properties`, and never advances
 * `updated_at`/the ifVersion token — a background rollup recompute must not cause a
 * spurious 409 on the client's next properties write. Not reachable from the generic
 * update path; only the rollup recompute worker and declared module cache writers may
 * call this.
 */
export async function writeComputed(
  client: Queryable,
  databaseId: string,
  itemId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await client.query(
    `UPDATE items SET computed = jsonb_set(computed, ARRAY[$3]::text[], $4::jsonb, true)
     WHERE database_id = $1 AND id = $2`,
    [databaseId, itemId, key, JSON.stringify(value)],
  );
}

/**
 * The entry point a module cache writer (transcription, Inbox summaries, ...) must go
 * through instead of calling `writeComputed` directly: refuses the write if `key` isn't
 * declared in the registry, so an undeclared or colliding key can never reach
 * `items.computed`. The rollup engine does not go through here — its keys are already
 * validated when the rollup property itself is created (see chokePoint.ts).
 */
export async function writeModuleComputed(
  client: Queryable,
  registry: ComputedKeyRegistry,
  databaseId: string,
  itemId: string,
  key: string,
  value: unknown,
): Promise<void> {
  if (!registry.has(key)) {
    throw new ForbiddenError(`Computed key '${key}' is not declared by any registered module`, { field: key }, "computed_key_undeclared");
  }
  await writeComputed(client, databaseId, itemId, key, value);
}
