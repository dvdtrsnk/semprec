import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAffectedRows, requireSingleRow, TransactionLocal, type Queryable } from "../db/pool.js";
import { ConflictError, NotFoundError } from "../errors.js";
import type { ItemRow } from "../types.js";

type ItemDbRow = {
  id: string;
  database_id: string;
  properties: Record<string, unknown>;
  computed: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  /** `bigint`, which pg returns as a decimal string. */
  version: string;
};

/**
 * System timestamps at full precision (`YYYY-MM-DDTHH:MM:SS.ffffffZ`), read only for a keyset cursor:
 * an `ItemRow` keeps whole milliseconds.
 */
export interface ExactItemTimestamps {
  createdAt: string;
  updatedAt: string;
}

const EXACT_TIMESTAMP_COLUMNS = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_exact,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_exact`;
const exactTimestampsRow = z.object({ created_at_exact: z.string(), updated_at_exact: z.string() });

function mapItemRow(row: ItemDbRow): ItemRow {
  return {
    id: row.id,
    databaseId: row.database_id,
    properties: row.properties,
    computed: row.computed,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    version: row.version,
  };
}

/**
 * Every database visible under RLS (the current tenant's, archived included). Bound as an array
 * parameter it lets the planner prune `items` partitions, which `= ANY(ARRAY(SELECT ...))` does not.
 */
export async function visibleDatabaseIds(client: Queryable): Promise<string[]> {
  const { rows } = await client.query<{ ids: string[] }>(`SELECT coalesce(array_agg(id), '{}') AS ids FROM databases`);
  return requireSingleRow(rows, "visible databases").ids;
}

export async function getItemById(client: Queryable, databaseId: string, itemId: string): Promise<ItemRow | null> {
  const { rows } = await client.query<ItemDbRow>(
    `SELECT id, database_id, properties, computed, created_at, updated_at, deleted_at, version
     FROM items WHERE database_id = $1 AND id = $2`,
    [databaseId, itemId],
  );
  return rows[0] ? mapItemRow(rows[0]) : null;
}

export async function lockItemById(client: Queryable, databaseId: string, itemId: string): Promise<ItemRow | null> {
  const { rows } = await client.query<ItemDbRow>(
    `SELECT id, database_id, properties, computed, created_at, updated_at, deleted_at, version
     FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE`,
    [databaseId, itemId],
  );
  return rows[0] ? mapItemRow(rows[0]) : null;
}

/**
 * Locks a row only if it is trashed strictly before `cutoff` (the purge's read). The predicate is in
 * the locking statement, so a non-qualifying row is not locked and `null` is returned; a row changed
 * while waiting is rechecked against its latest committed version.
 */
export async function lockTrashedItemBefore(
  client: Queryable,
  databaseId: string,
  itemId: string,
  cutoff: Date,
): Promise<ItemRow | null> {
  const { rows } = await client.query<ItemDbRow>(
    `SELECT id, database_id, properties, computed, created_at, updated_at, deleted_at, version
     FROM items WHERE database_id = $1 AND id = $2 AND deleted_at IS NOT NULL AND deleted_at < $3 FOR UPDATE`,
    [databaseId, itemId, cutoff],
  );
  return rows[0] ? mapItemRow(rows[0]) : null;
}

/** Reports a contended row through PostgreSQL's lock-not-available error. */
export async function lockItemByIdNowait(
  client: Queryable,
  databaseId: string,
  itemId: string,
): Promise<ItemRow | null> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT id, database_id, properties, computed, created_at, updated_at, deleted_at, version
     FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE NOWAIT`,
    [databaseId, itemId],
  );
  if (!rows[0]) return null;
  return mapItemRow(
    z
      .object({
        id: z.string(),
        database_id: z.string(),
        properties: z.record(z.string(), z.unknown()),
        computed: z.record(z.string(), z.unknown()),
        created_at: z.date(),
        updated_at: z.date(),
        deleted_at: z.date().nullable(),
        version: z.string(),
      })
      .parse(rows[0]),
  );
}

export interface InsertItemInput {
  databaseId: string;
  properties: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface InsertItemResult {
  item: ItemRow;
  /** `false` when an idempotency-key replay returned an existing row and wrote nothing. */
  created: boolean;
}

/**
 * Inserts an item, honoring an optional Idempotency-Key: a repeat with the same key returns the first
 * call's row. Must run in a transaction so the `idempotency_keys` row and the item commit together.
 * `created` lets a replay skip create-only side effects.
 *
 * A reservation whose item was purged or trashed is released and reserved again for a fresh item.
 * Reservations are per tenant under RLS; the insert names no conflict target, so the only unique
 * index, `idempotency_keys_pkey (tenant_id, key)`, is the arbiter.
 */
export async function insertItemWithReplay(
  client: Queryable,
  input: InsertItemInput,
  resolveCreateProperties?: () => Promise<Record<string, unknown>>,
): Promise<InsertItemResult> {
  const generatedId = randomUUID();
  const itemId: string = generatedId;

  if (input.idempotencyKey) {
    const reserve = await client.query<{ item_id: string }>(
      `INSERT INTO idempotency_keys (key, database_id, item_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING item_id`,
      [input.idempotencyKey, input.databaseId, generatedId],
    );
    if (reserve.rowCount === 0) {
      const { rows } = await client.query<{ item_id: string; database_id: string }>(
        `SELECT item_id, database_id FROM idempotency_keys WHERE key = $1 FOR UPDATE`,
        [input.idempotencyKey],
      );
      // ON CONFLICT DO NOTHING hit, so the row exists, unless a concurrent transaction deleted it since.
      const reserved = rows[0];
      if (reserved === undefined) {
        throw new ConflictError(
          `Idempotency key '${input.idempotencyKey}' was reserved and then removed concurrently`,
          {
            key: input.idempotencyKey,
          },
        );
      }
      if (reserved.database_id !== input.databaseId) {
        throw new ConflictError(`Idempotency key '${input.idempotencyKey}' was already used for a different database`, {
          key: input.idempotencyKey,
        });
      }
      const existing = await getItemById(client, input.databaseId, reserved.item_id);
      if (existing && existing.deletedAt === null) return { item: existing, created: false };

      // The reserved item is gone or trashed: release and re-reserve the key for a fresh item. Holding
      // the row FOR UPDATE means a racing transaction either blocks and then finds it gone (the
      // `reserved === undefined` branch) or already did this, and this DELETE affects zero rows.
      requireAffectedRows(
        await client.query(`DELETE FROM idempotency_keys WHERE key = $1`, [input.idempotencyKey]),
        `idempotency_keys row for key '${input.idempotencyKey}'`,
      );
      const reReserve = await client.query<{ item_id: string }>(
        `INSERT INTO idempotency_keys (key, database_id, item_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING item_id`,
        [input.idempotencyKey, input.databaseId, generatedId],
      );
      // Cannot fail after the DELETE in this same transaction; kept as a defensive guard.
      requireAffectedRows(reReserve, `idempotency_keys row for key '${input.idempotencyKey}'`);
    }
  }

  // Defaults may read tenant settings; defer them until the reservation has ruled out a replay.
  const properties = resolveCreateProperties ? await resolveCreateProperties() : input.properties;
  const { rows } = await client.query<ItemDbRow>(
    `INSERT INTO items (id, database_id, properties) VALUES ($1, $2, $3::jsonb)
     RETURNING id, database_id, properties, computed, created_at, updated_at, deleted_at, version`,
    [itemId, input.databaseId, JSON.stringify(properties)],
  );
  return { item: mapItemRow(requireSingleRow(rows, "items row")), created: true };
}

/** For callers (seeds, tests) that need not distinguish a replay from a fresh insert. */
export async function insertItem(client: Queryable, input: InsertItemInput): Promise<ItemRow> {
  return (await insertItemWithReplay(client, input)).item;
}

/**
 * The item already committed for an idempotency key reserved against `databaseId`, without writing:
 * lets the archived-database guard decide whether a create is an allowed no-write replay before
 * inserting. `null` when there is no reservation for this key and database or its item was purged.
 *
 * `requireLive: true` also returns `null` for a trashed item, as `insertItemWithReplay` treats it as
 * stale. Other callers (a proposal card's key) keep the default: a trashed card is still the earlier
 * run's completed work and must not be recreated. Per tenant under RLS.
 */
export async function findIdempotentReplay(
  client: Queryable,
  databaseId: string,
  idempotencyKey: string,
  options: { requireLive?: boolean } = {},
): Promise<ItemRow | null> {
  const { rows } = await client.query<{ item_id: string; database_id: string }>(
    `SELECT item_id, database_id FROM idempotency_keys WHERE key = $1`,
    [idempotencyKey],
  );
  const reserved = rows[0];
  if (!reserved || reserved.database_id !== databaseId) return null;
  const item = await getItemById(client, databaseId, reserved.item_id);
  if (!item) return null;
  if (options.requireLive && item.deletedAt !== null) return null;
  return item;
}

export interface UpdateItemInput {
  databaseId: string;
  itemId: string;
  propertiesPatch: Record<string, unknown>;
  /** The `version` the client last held; a mismatch is a conflict, not a silent overwrite. */
  ifVersion?: string;
}

export interface UpdateItemResult extends ItemRow {
  previous: Record<string, unknown>;
}

/** Per transaction and item (`databaseId/id`), how many `updateItemProperties` calls wrote the row. */
const propertyWriteCounts = new TransactionLocal(() => new Map<string, number>());

/**
 * How many times this transaction wrote the item's properties so far; `0` outside a managed transaction. A caller
 * that holds a row compares two readings to learn whether a nested write (a hook writing the same item) made its
 * row, and so its `version`, stale. A rolled-back savepoint may leave the count higher than the stored writes.
 */
export function itemPropertyWriteCount(client: Queryable, databaseId: string, itemId: string): number {
  return propertyWriteCounts.get(client)?.get(`${databaseId}/${itemId}`) ?? 0;
}

export async function updateItemProperties(client: Queryable, input: UpdateItemInput): Promise<UpdateItemResult> {
  const current = await lockItemById(client, input.databaseId, input.itemId);
  if (!current || current.deletedAt) {
    throw new NotFoundError(`Item ${input.itemId} not found`);
  }
  if (input.ifVersion !== undefined && input.ifVersion !== current.version) {
    throw new ConflictError("Item was modified since ifVersion was read", { current });
  }

  const { rows } = await client.query<ItemDbRow>(
    `UPDATE items SET properties = properties || $3::jsonb, updated_at = now(), version = version + 1
     WHERE database_id = $1 AND id = $2
     RETURNING id, database_id, properties, computed, created_at, updated_at, deleted_at, version`,
    [input.databaseId, input.itemId, JSON.stringify(input.propertiesPatch)],
  );
  const counts = propertyWriteCounts.get(client);
  const countKey = `${input.databaseId}/${input.itemId}`;
  counts?.set(countKey, (counts.get(countKey) ?? 0) + 1);
  return {
    ...mapItemRow(requireSingleRow(rows, "items row")),
    previous: Object.fromEntries(
      Object.keys(input.propertiesPatch).map((key) => [
        key,
        Object.hasOwn(current.properties, key) ? current.properties[key] : null,
      ]),
    ),
  };
}

/**
 * `deleted_at` is the transaction's `now()`, or `deletedAtExact` (six-digit UTC text) so the row joins
 * that trash epoch at full precision.
 */
export async function softDeleteItem(
  client: Queryable,
  databaseId: string,
  itemId: string,
  deletedAtExact?: string,
): Promise<ItemRow | null> {
  const { rows } = await client.query<ItemDbRow>(
    `UPDATE items SET deleted_at = COALESCE($3::timestamptz, now())
      WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL
     RETURNING id, database_id, properties, computed, created_at, updated_at, deleted_at, version`,
    [databaseId, itemId, deletedAtExact ?? null],
  );
  return rows[0] ? mapItemRow(rows[0]) : null;
}

/**
 * Locks one item `FOR SHARE` and returns its `deleted_at` in the format of `deletedAtExact`; `null`
 * when live or missing. The share lock makes a trash or restore (`FOR UPDATE`) wait for the caller.
 */
export async function lockItemTrashEpoch(
  client: Queryable,
  databaseId: string,
  itemId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ deleted_at_exact: string | null }>(
    `SELECT to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at_exact
       FROM items WHERE database_id = $1 AND id = $2 FOR SHARE`,
    [databaseId, itemId],
  );
  return rows[0]?.deleted_at_exact ?? null;
}

export async function restoreItem(client: Queryable, databaseId: string, itemId: string): Promise<ItemRow | null> {
  const { rows } = await client.query<ItemDbRow>(
    `UPDATE items SET deleted_at = NULL WHERE database_id = $1 AND id = $2 AND deleted_at IS NOT NULL
     RETURNING id, database_id, properties, computed, created_at, updated_at, deleted_at, version`,
    [databaseId, itemId],
  );
  return rows[0] ? mapItemRow(rows[0]) : null;
}

/** Every row regardless of `deleted_at`: the cascade traversal must see live and trashed rows alike. */
export async function getAllItemsInDatabase(client: Queryable, databaseId: string): Promise<ItemRow[]> {
  const { rows } = await client.query<ItemDbRow>(
    `SELECT id, database_id, properties, computed, created_at, updated_at, deleted_at, version FROM items WHERE database_id = $1`,
    [databaseId],
  );
  return rows.map(mapItemRow);
}

/**
 * `getAllItemsInDatabase` with `FOR SHARE` on every row in id order. For a database of a few rows,
 * such as a singleton.
 */
export async function lockAllItemsInDatabaseForShare(client: Queryable, databaseId: string): Promise<ItemRow[]> {
  const { rows } = await client.query<ItemDbRow>(
    `SELECT id, database_id, properties, computed, created_at, updated_at, deleted_at, version FROM items WHERE database_id = $1
     ORDER BY id FOR SHARE`,
    [databaseId],
  );
  return rows.map(mapItemRow);
}

/**
 * Every row, trashed or live, whose text property equals `value`, in id order. With `lock`, `FOR
 * UPDATE` in that order; rows inserted while it waits are not in the result.
 */
export async function listItemsByTextProperty(
  client: Queryable,
  databaseId: string,
  propertyKey: string,
  value: string,
  lock: boolean,
): Promise<ItemRow[]> {
  const { rows } = await client.query<ItemDbRow>(
    `SELECT id, database_id, properties, computed, created_at, updated_at, deleted_at, version FROM items
     WHERE database_id = $1 AND properties->>$2 = $3 ORDER BY id${lock ? " FOR UPDATE" : ""}`,
    [databaseId, propertyKey, value],
  );
  return rows.map(mapItemRow);
}

/**
 * The lowest-id live Files item whose `file` points at `blobId`: concurrent identical uploads dedupe
 * onto one blob and reuse the first Files item. Also resolves a download filename from a blob id.
 */
export async function findFileItemByBlobId(
  client: Queryable,
  databaseId: string,
  blobId: string,
): Promise<ItemRow | null> {
  const { rows } = await client.query<ItemDbRow>(
    `SELECT id, database_id, properties, computed, created_at, updated_at, deleted_at, version FROM items
     WHERE database_id = $1 AND deleted_at IS NULL AND properties -> 'file' ->> 'blobId' = $2
     ORDER BY id ASC LIMIT 1`,
    [databaseId, blobId],
  );
  return rows[0] ? mapItemRow(rows[0]) : null;
}

/**
 * One keyset page (on the composite primary key) of items trashed before `olderThan`, in non-archived
 * databases of the current tenant: the purge sweep's subtree roots. Items of an archived database go
 * with that database's own purge. Queries the partitioned parent, confined to the tenant by a
 * database-id list resolved under RLS.
 */
export async function findItemsDeletedBefore(
  client: Queryable,
  olderThan: Date,
  after?: { databaseId: string; id: string },
  limit = 500,
): Promise<ItemRow[]> {
  const { rows: databaseRows } = await client.query<{ ids: string[] }>(
    "SELECT coalesce(array_agg(id), '{}') AS ids FROM databases WHERE archived_at IS NULL",
  );
  const databaseIds = requireSingleRow(databaseRows, "live databases").ids;
  const { rows } = await client.query<ItemDbRow>(
    `SELECT id, database_id, properties, computed, created_at, updated_at, deleted_at, version
     FROM items
     WHERE deleted_at IS NOT NULL AND deleted_at < $1
       AND database_id = ANY($5::uuid[])
       AND ($2::uuid IS NULL OR (database_id, id) > ($2::uuid, $3::uuid))
     ORDER BY database_id, id
     LIMIT $4`,
    [olderThan, after?.databaseId ?? null, after?.id ?? null, limit, databaseIds],
  );
  return rows.map(mapItemRow);
}

/**
 * Permanently removes one row; only the purge sweep calls it. `deleted_at IS NOT NULL` guards against
 * a concurrent restore between the eligibility scan and this call, since the sweep's snapshot holds no
 * lock. Returns whether a row was removed.
 */
export async function hardDeleteItem(client: Queryable, databaseId: string, itemId: string): Promise<boolean> {
  const result = await client.query(`DELETE FROM items WHERE database_id = $1 AND id = $2 AND deleted_at IS NOT NULL`, [
    databaseId,
    itemId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/** Deleted rows included. */
export async function listItemIdsForPurge(client: Queryable, databaseId: string, limit: number): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM items WHERE database_id = $1 ORDER BY id LIMIT $2",
    [databaseId, limit],
  );
  return rows.map((row) => row.id);
}

/**
 * Permanently deletes the named rows, live or trashed, returning each as removed; only the purge of an
 * archived database calls it. A row another transaction removed first is not returned.
 */
export async function hardDeleteItemsOfDatabase(
  client: Queryable,
  databaseId: string,
  itemIds: readonly string[],
): Promise<ItemRow[]> {
  const { rows } = await client.query<ItemDbRow>(
    `DELETE FROM items WHERE database_id = $1 AND id = ANY($2::uuid[])
     RETURNING id, database_id, properties, computed, created_at, updated_at, deleted_at, version`,
    [databaseId, itemIds],
  );
  return rows.map(mapItemRow);
}

export interface ListItemsOptions {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  /**
   * Views-layer pushdown: called with the `params` array being built so bind offsets line up.
   * `cursor` pages via `id > cursor`, correct only under the default `id ASC` order; a custom order
   * uses `keyset`.
   */
  buildFilterSql?: (params: unknown[]) => string | undefined;
  buildOrderBySql?: (params: unknown[]) => string | undefined;
  /**
   * Keyset paging for a custom order: `buildAfterSql` replaces `id > cursor` (or returns `undefined` on
   * the first page) and `encodeCursor` turns a page's last row into `nextCursor`. When set, `cursor` is
   * ignored.
   */
  keyset?: {
    buildAfterSql: (params: unknown[]) => string | undefined;
    encodeCursor: (last: ItemRow, exact: ExactItemTimestamps) => string;
  };
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
  const filterSql = options.buildFilterSql?.(params);
  if (filterSql) conditions.push(filterSql);

  let orderBySql = "id ASC";
  const customOrderBySql = options.buildOrderBySql?.(params);
  if (customOrderBySql) orderBySql = `${customOrderBySql}, id ASC`;

  if (options.keyset) {
    const afterSql = options.keyset.buildAfterSql(params);
    if (afterSql) conditions.push(afterSql);
  } else if (options.cursor) {
    params.push(options.cursor);
    conditions.push(`id > $${params.length}`);
  }
  params.push(limit + 1);

  const exactColumns = options.keyset ? `, ${EXACT_TIMESTAMP_COLUMNS}` : "";
  const { rows } = await client.query<ItemDbRow & Record<string, unknown>>(
    `SELECT id, database_id, properties, computed, created_at, updated_at, deleted_at, version${exactColumns}
     FROM items WHERE ${conditions.join(" AND ")} ORDER BY ${orderBySql} LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(mapItemRow);
  const last = items[items.length - 1];
  let nextCursor: string | null = null;
  if (hasMore && last) {
    if (options.keyset) {
      const exact = exactTimestampsRow.parse(page[page.length - 1]);
      nextCursor = options.keyset.encodeCursor(last, {
        createdAt: exact.created_at_exact,
        updatedAt: exact.updated_at_exact,
      });
    } else {
      nextCursor = last.id;
    }
  }
  return { items, nextCursor };
}

/** Shares `buildFilterSql` with `listItems` so a count and its list agree on what matches. */
export async function countItems(
  client: Queryable,
  databaseId: string,
  options: Pick<ListItemsOptions, "includeDeleted" | "buildFilterSql"> = {},
): Promise<number> {
  const conditions = ["database_id = $1"];
  const params: unknown[] = [databaseId];
  if (!options.includeDeleted) conditions.push("deleted_at IS NULL");
  const filterSql = options.buildFilterSql?.(params);
  if (filterSql) conditions.push(filterSql);

  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM items WHERE ${conditions.join(" AND ")}`,
    params,
  );
  return Number(requireSingleRow(rows, "items count").count);
}

export type ItemCountGrouping =
  | {
      kind: "select";
      propertyKey: string;
      /** Display order; decides the order of the groups. */
      optionKeys: string[];
    }
  | {
      kind: "relation";
      relationDefinitionId: string;
      /** The side the counted items sit on; the other side holds the targets. */
      ownSide: "a" | "b";
      targetDatabaseId: string;
    };

export interface ItemCountGroup {
  key: string | null;
  count: number;
}

export interface GroupedItemCount {
  count: number;
  /** Present exactly when a grouping was asked for. */
  groups?: ItemCountGroup[];
}

/**
 * Counts live items `buildFilterSql` matches and optionally groups them, in one statement. An archived
 * database counts nothing.
 *
 * `select`: one group per occurring stored value, declared options first in `optionKeys` order, then
 * other values in byte order, then `null` for missing, JSON null or empty string.
 *
 * `relation`: one group per occurring target item by id, then `null`. A target counts while live and
 * its database is not archived, so an item whose every edge ends at a trashed or archived target is
 * in `null`. An item with several targets is in each group and once in `count`.
 *
 * Reads `items` under its own name because a compiled filter refers to `items.id`, `properties` and
 * `computed`.
 */
export async function countItemsGrouped(
  client: Queryable,
  databaseId: string,
  options: { buildFilterSql?: (params: unknown[]) => string | undefined; grouping?: ItemCountGrouping } = {},
): Promise<GroupedItemCount> {
  const conditions = [
    "items.database_id = $1",
    "items.deleted_at IS NULL",
    "EXISTS (SELECT 1 FROM databases counted WHERE counted.id = $1 AND counted.archived_at IS NULL)",
  ];
  const params: unknown[] = [databaseId];
  const filterSql = options.buildFilterSql?.(params);
  if (filterSql) conditions.push(filterSql);
  const where = conditions.join(" AND ");

  const { grouping } = options;
  if (!grouping) {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM items WHERE ${where}`,
      params,
    );
    return { count: Number(requireSingleRow(rows, "items count").count) };
  }

  let groupedSql: string;
  let orderBySql: string;
  if (grouping.kind === "select") {
    params.push(grouping.propertyKey);
    groupedSql = `SELECT items.id, NULLIF(items.properties ->> $${params.length}, '') AS group_key FROM items WHERE ${where}`;
    params.push(grouping.optionKeys);
    orderBySql = `(group_key IS NULL), array_position($${params.length}::text[], group_key) NULLS LAST, group_key COLLATE "C"`;
  } else {
    // Chosen from fixed identifiers by the definition's side, never from input.
    const ownColumn = grouping.ownSide === "a" ? "item_a" : "item_b";
    const targetColumn = grouping.ownSide === "a" ? "item_b" : "item_a";
    params.push(grouping.relationDefinitionId);
    const definitionParam = params.length;
    params.push(grouping.targetDatabaseId);
    const targetDatabaseParam = params.length;
    groupedSql = `SELECT matched.id, target.id::text AS group_key
       FROM (SELECT items.id FROM items WHERE ${where}) matched
       LEFT JOIN LATERAL (
         SELECT live_target.id
         FROM item_relations edge
         JOIN items live_target
           ON live_target.database_id = $${targetDatabaseParam}::uuid
          AND live_target.id = edge.${targetColumn}
          AND live_target.deleted_at IS NULL
         WHERE edge.relation_definition_id = $${definitionParam}::uuid
           AND edge.${ownColumn} = matched.id
           AND EXISTS (
             SELECT 1 FROM databases target_database
             WHERE target_database.id = $${targetDatabaseParam}::uuid AND target_database.archived_at IS NULL
           )
       ) target ON true`;
    orderBySql = `group_key COLLATE "C" NULLS LAST`;
  }

  const { rows } = await client.query<{ is_total: boolean; key: string | null; count: string }>(
    `SELECT GROUPING(group_key) = 1 AS is_total, group_key AS key, count(DISTINCT id)::text AS count
     FROM (${groupedSql}) grouped
     GROUP BY GROUPING SETS ((group_key), ())
     ORDER BY GROUPING(group_key) DESC, ${orderBySql}`,
    params,
  );
  // The empty grouping set yields the total as one row whatever the input, an empty one included.
  const total = requireSingleRow(
    rows.filter((row) => row.is_total),
    "grouped items count total",
  );
  return {
    count: Number(total.count),
    groups: rows.filter((row) => !row.is_total).map((row) => ({ key: row.key, count: Number(row.count) })),
  };
}

/**
 * By id alone, without `database_id`: curated views mix databases and cannot supply the partition key.
 * Confined to the tenant's partitions by a database-id list resolved under RLS.
 */
export async function getItemsByIds(client: Queryable, itemIds: string[]): Promise<ItemRow[]> {
  if (itemIds.length === 0) return [];
  const { rows } = await client.query<ItemDbRow>(
    `SELECT id, database_id, properties, computed, created_at, updated_at, deleted_at, version
     FROM items WHERE id = ANY($1::uuid[]) AND database_id = ANY($2::uuid[]) AND deleted_at IS NULL`,
    [itemIds, await visibleDatabaseIds(client)],
  );
  return rows.map(mapItemRow);
}

/**
 * `getItemsByIds` including trashed rows, for callers that must resolve a possibly trashed item's
 * `databaseId` first (idempotent delete, restore).
 */
export async function getItemsByIdsIncludingDeleted(client: Queryable, itemIds: string[]): Promise<ItemRow[]> {
  if (itemIds.length === 0) return [];
  const { rows } = await client.query<ItemDbRow>(
    `SELECT id, database_id, properties, computed, created_at, updated_at, deleted_at, version
     FROM items WHERE id = ANY($1::uuid[]) AND database_id = ANY($2::uuid[])`,
    [itemIds, await visibleDatabaseIds(client)],
  );
  return rows.map(mapItemRow);
}

/**
 * Batched `getItemById` within one database. No `deleted_at` filter on purpose: a trashed proposal
 * card still recorded a real outcome its callers must see.
 */
export async function getItemsByIdsInDatabaseIncludingDeleted(
  client: Queryable,
  databaseId: string,
  itemIds: string[],
): Promise<ItemRow[]> {
  if (itemIds.length === 0) return [];
  const { rows } = await client.query<ItemDbRow>(
    `SELECT id, database_id, properties, computed, created_at, updated_at, deleted_at, version
     FROM items WHERE database_id = $1 AND id = ANY($2::uuid[])`,
    [databaseId, itemIds],
  );
  return rows.map(mapItemRow);
}

/**
 * Writes only `items.computed`, never `properties`, and never advances `updated_at`, so a background
 * recompute cannot cause a spurious 409. Only the rollup worker and declared module cache writers call
 * it. Returns the row's `updated_at`.
 */
export async function writeComputed(
  client: Queryable,
  databaseId: string,
  itemId: string,
  key: string,
  value: unknown,
): Promise<string> {
  const result = await client.query<{ updated_at: Date }>(
    `UPDATE items SET computed = jsonb_set(computed, ARRAY[$3]::text[], $4::jsonb, true)
     WHERE database_id = $1 AND id = $2
     RETURNING updated_at`,
    [databaseId, itemId, key, JSON.stringify(value)],
  );
  requireAffectedRows(result, `computed key '${key}' for item '${itemId}'`);
  return requireSingleRow(result.rows, "items row").updated_at.toISOString();
}
