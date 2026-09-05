import type { Pool } from "pg";

/**
 * Gates a heartbeat action on the fired item's relation membership — e.g. "only run when the
 * Emails item is related (via `folder`) to a Folder whose `specialPurpose` is `inbox`, and none
 * of its related Folders are `junk`/`trash`." Generic (keyed only by relation property id and a
 * property name), so `core.agentRun`'s `actionConfig` can express this without any mail-specific
 * code in the scheduler (issue #99: "do not create a separate mail scheduler").
 */
export interface ItemRelationFilterConfig {
  /** The property id of the relation to follow from the fired item (either side of the reldef). */
  relationPropertyId: string;
  /** The property key read off each related item. */
  property: string;
  /** At least one related item's `property` value must be in this set. */
  include: string[];
  /** No related item's `property` value may be in this set — checked even if `include` also matches. */
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
 * Evaluated at heartbeat-fire time (after the enqueuing transaction has committed), not at
 * enqueue time: a message's folder-membership relation is written after the Emails item itself
 * within the same ingest transaction (mail/ingest.ts), so it would not yet exist if this were
 * checked at `triggerOnItemEventHeartbeats` time.
 */
export async function passesItemRelationFilter(pool: Pool, itemId: string, filter: ItemRelationFilterConfig): Promise<boolean> {
  const { rows } = await pool.query<{ value: string | null }>(
    `SELECT related.properties ->> $2 AS value
     FROM relation_definitions rd
     JOIN item_relations r ON r.relation_definition_id = rd.id
     JOIN items related ON related.id = CASE WHEN r.item_a = $3 THEN r.item_b ELSE r.item_a END
     WHERE (rd.property_id_a = $1 OR rd.property_id_b = $1)
       AND (r.item_a = $3 OR r.item_b = $3)`,
    [filter.relationPropertyId, filter.property, itemId],
  );
  const values = rows.map((row) => row.value).filter((value): value is string => value !== null);
  const included = filter.include.length === 0 || values.some((value) => filter.include.includes(value));
  const excluded = values.some((value) => filter.exclude.includes(value));
  return included && !excluded;
}
