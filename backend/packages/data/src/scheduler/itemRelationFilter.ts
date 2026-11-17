import type { Pool } from "pg";

/**
 * Gates a heartbeat action on the fired item's relation membership, e.g. "the Emails item is related
 * via `folder` to an `inbox` Folder and to no `junk`/`trash` one". Generic, so `core.agentRun` config
 * expresses it without mail-specific scheduler code.
 */
export interface ItemRelationFilterConfig {
  /** Either side of the reldef. */
  relationPropertyId: string;
  property: string;
  include: string[];
  /** Checked even if `include` also matches. */
  exclude: string[];
}

export function parseItemRelationFilterConfig(raw: unknown): ItemRelationFilterConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.relationPropertyId !== "string" || typeof record.property !== "string") return null;
  const toStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    relationPropertyId: record.relationPropertyId,
    property: record.property,
    include: toStringArray(record.include),
    exclude: toStringArray(record.exclude),
  };
}

/**
 * `items` is partitioned by `database_id`, so the related-item lookup must pin it (resolved from the
 * other side's property) to prune partitions. A plain join condition is not enough: with fresh stats
 * the planner hashes every partition and filters afterwards. The LATERAL subquery with `OFFSET 0`
 * cannot be pulled up, so it runs as the inner side of a parameterized nested loop and the Append
 * prunes at run time. `deleted_at IS NULL` keeps a soft-deleted folder from counting. Exported so
 * tests can EXPLAIN it.
 */
export const ITEM_RELATION_FILTER_QUERY = `
  SELECT related.properties ->> $2 AS value
  FROM relation_definitions rd
  JOIN properties op ON op.id = CASE WHEN rd.property_id_a = $1 THEN rd.property_id_b ELSE rd.property_id_a END
  JOIN item_relations r ON r.relation_definition_id = rd.id
  CROSS JOIN LATERAL (
    SELECT item.properties
    FROM items item
    WHERE item.database_id = op.database_id
      AND item.id = CASE WHEN r.item_a = $3 THEN r.item_b ELSE r.item_a END
      AND item.deleted_at IS NULL
    OFFSET 0
  ) related
  WHERE (rd.property_id_a = $1 OR rd.property_id_b = $1)
    AND (r.item_a = $3 OR r.item_b = $3)
`;

/**
 * Evaluated at fire time, not enqueue time: the folder relation is written after the Emails item in
 * the same ingest transaction, so it would not exist yet at `triggerOnItemEventHeartbeats` time.
 */
export async function passesItemRelationFilter(
  pool: Pool,
  itemId: string,
  filter: ItemRelationFilterConfig,
): Promise<boolean> {
  const { rows } = await pool.query<{ value: string | null }>(ITEM_RELATION_FILTER_QUERY, [
    filter.relationPropertyId,
    filter.property,
    itemId,
  ]);
  const values = rows.map((row) => row.value).filter((value): value is string => value !== null);
  const included = filter.include.length === 0 || values.some((value) => filter.include.includes(value));
  const excluded = values.some((value) => filter.exclude.includes(value));
  return included && !excluded;
}
