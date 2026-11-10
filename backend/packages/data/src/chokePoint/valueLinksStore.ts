// Owns SQL for `value_links` and `value_link_sources` (issue #1403). A link records that the whole
// value of one property on one item was taken over from other items; no row means the value is the
// user's own. Both tables are tenant tables: every statement here runs under the caller's tenant
// scope and never names `tenant_id`, so the column default stamps it and RLS filters it.
import type { PoolClient } from "pg";
import { requireAffectedRows, requireSingleRow } from "../db/pool.js";
import { assertKnownValue, assertShape } from "../dbRowValidation.js";

const LINK_STATES = ["on", "broken"] as const;
const BROKEN_BY = ["user", "agent"] as const;
const SOURCE_KINDS = ["item", "senderDomain"] as const;

export type ValueLinkState = (typeof LINK_STATES)[number];
export type ValueLinkBrokenBy = (typeof BROKEN_BY)[number];

export interface ValueLinkRow {
  id: string;
  itemId: string;
  propertyKey: string;
  ruleKey: string;
  state: ValueLinkState;
  brokenBy: ValueLinkBrokenBy | null;
  brokenAt: string | null;
}

export type ValueLinkSourceRow =
  | { id: string; linkId: string; kind: "item"; sourceItemId: string; sourcePropertyKey: string }
  | { id: string; linkId: string; kind: "senderDomain"; domain: string; sourcePropertyKey: string };

/** One source of a link to insert; `id` and `linkId` are assigned by the insert. */
export type ValueLinkSourceInput =
  | { kind: "item"; sourceItemId: string; sourcePropertyKey: string }
  | { kind: "senderDomain"; domain: string; sourcePropertyKey: string };

export interface InsertValueLinkInput {
  itemId: string;
  propertyKey: string;
  ruleKey: string;
  /** Defaults to an `on` link. A `broken` link needs both `brokenBy` and `brokenAt` (the table CHECK). */
  state?: ValueLinkState;
  brokenBy?: ValueLinkBrokenBy;
  brokenAt?: Date;
  sources: ValueLinkSourceInput[];
}

type ValueLinkDbRow = {
  id: string;
  item_id: string;
  property_key: string;
  rule_key: string;
  state: string;
  broken_by: string | null;
  broken_at: Date | null;
};

type ValueLinkSourceDbRow = {
  id: string;
  link_id: string;
  source_kind: string;
  source_item_id: string | null;
  source_property_key: string;
  domain: string | null;
};

const LINK_COLUMNS = "id, item_id, property_key, rule_key, state, broken_by, broken_at";
const SOURCE_COLUMNS = "id, link_id, source_kind, source_item_id, source_property_key, domain";

function mapValueLinkRow(row: ValueLinkDbRow): ValueLinkRow {
  return {
    id: row.id,
    itemId: row.item_id,
    propertyKey: row.property_key,
    ruleKey: row.rule_key,
    state: assertKnownValue(LINK_STATES, row.state, "value link state"),
    brokenBy: row.broken_by === null ? null : assertKnownValue(BROKEN_BY, row.broken_by, "value link broken_by"),
    brokenAt: row.broken_at === null ? null : row.broken_at.toISOString(),
  };
}

function mapValueLinkSourceRow(row: ValueLinkSourceDbRow): ValueLinkSourceRow {
  const kind = assertKnownValue(SOURCE_KINDS, row.source_kind, "value link source kind");
  if (kind === "item") {
    assertShape(row.source_item_id !== null, "value link source");
    return {
      id: row.id,
      linkId: row.link_id,
      kind,
      sourceItemId: row.source_item_id!,
      sourcePropertyKey: row.source_property_key,
    };
  }
  assertShape(row.domain !== null, "value link source");
  return { id: row.id, linkId: row.link_id, kind, domain: row.domain!, sourcePropertyKey: row.source_property_key };
}

/**
 * Inserts a link and its sources. Run it inside the caller's transaction so a failed source leaves
 * no link behind. Used by fixtures today and by link creation (#1593) later.
 */
export async function insertValueLink(
  client: PoolClient,
  input: InsertValueLinkInput,
): Promise<{ link: ValueLinkRow; sources: ValueLinkSourceRow[] }> {
  const { rows } = await client.query<ValueLinkDbRow>(
    `INSERT INTO value_links (item_id, property_key, rule_key, state, broken_by, broken_at)
     VALUES ($1, $2, $3, COALESCE($4, 'on'), $5, $6)
     RETURNING ${LINK_COLUMNS}`,
    [
      input.itemId,
      input.propertyKey,
      input.ruleKey,
      input.state ?? null,
      input.brokenBy ?? null,
      input.brokenAt ?? null,
    ],
  );
  const link = mapValueLinkRow(requireSingleRow(rows, "value link"));
  const sources: ValueLinkSourceRow[] = [];
  for (const source of input.sources) {
    const { rows: sourceRows } = await client.query<ValueLinkSourceDbRow>(
      `INSERT INTO value_link_sources (link_id, source_kind, source_item_id, source_property_key, domain)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SOURCE_COLUMNS}`,
      [
        link.id,
        source.kind,
        source.kind === "item" ? source.sourceItemId : null,
        source.sourcePropertyKey,
        source.kind === "senderDomain" ? source.domain : null,
      ],
    );
    sources.push(mapValueLinkSourceRow(requireSingleRow(sourceRows, "value link source")));
  }
  return { link, sources };
}

/** Every link of the given items, in one query. */
export async function listValueLinksByItemIds(client: PoolClient, itemIds: string[]): Promise<ValueLinkRow[]> {
  if (itemIds.length === 0) return [];
  const { rows } = await client.query<ValueLinkDbRow>(
    `SELECT ${LINK_COLUMNS} FROM value_links WHERE item_id = ANY($1::uuid[]) ORDER BY item_id, property_key`,
    [itemIds],
  );
  return rows.map(mapValueLinkRow);
}

/** Every source of the given links, in one query, in a stable order. */
export async function listValueLinkSourcesByLinkIds(
  client: PoolClient,
  linkIds: string[],
): Promise<ValueLinkSourceRow[]> {
  if (linkIds.length === 0) return [];
  const { rows } = await client.query<ValueLinkSourceDbRow>(
    `SELECT ${SOURCE_COLUMNS} FROM value_link_sources WHERE link_id = ANY($1::uuid[])
     ORDER BY link_id, source_kind, source_item_id, domain, source_property_key`,
    [linkIds],
  );
  return rows.map(mapValueLinkSourceRow);
}

/**
 * Ends the links of the given item and keys that are still `on`, in one statement. A missing row
 * and an already broken row are untouched, so the first writer to end a link stays recorded.
 * Returns the property keys whose state changed.
 */
export async function breakOnValueLinks(
  client: PoolClient,
  input: { itemId: string; propertyKeys: string[]; brokenBy: ValueLinkBrokenBy },
): Promise<string[]> {
  if (input.propertyKeys.length === 0) return [];
  const { rows } = await client.query<{ property_key: string }>(
    `UPDATE value_links SET state = 'broken', broken_by = $3, broken_at = now(), updated_at = now()
     WHERE item_id = $1 AND property_key = ANY($2::text[]) AND state = 'on'
     RETURNING property_key`,
    [input.itemId, input.propertyKeys, input.brokenBy],
  );
  return rows.map((row) => row.property_key);
}

/** Locks the `on` link of one item property against a concurrent break and reports whether it exists. */
export async function lockOnValueLink(
  client: PoolClient,
  itemId: string,
  propertyKey: string,
  lockMode?: "nowait" | "none",
): Promise<boolean> {
  // The SQL suffix is selected only from the three fixed lock clauses for this typed mode.
  const { rows } = await client.query<{ "?column?": number }>(
    `SELECT 1 FROM value_links WHERE item_id = $1 AND property_key = $2 AND state = 'on'${lockMode === "none" ? "" : lockMode === "nowait" ? " FOR SHARE NOWAIT" : " FOR SHARE"}`,
    [itemId, propertyKey],
  );
  return rows.length > 0;
}

/** Locks a specific link, including a broken one, for a change to its sources. */
export async function lockValueLink(
  client: PoolClient,
  itemId: string,
  propertyKey: string,
): Promise<ValueLinkRow | null> {
  const { rows } = await client.query<ValueLinkDbRow>(
    `SELECT ${LINK_COLUMNS} FROM value_links WHERE tenant_id = app_tenant_default() AND item_id = $1 AND property_key = $2 FOR UPDATE`,
    [itemId, propertyKey],
  );
  return rows[0] ? mapValueLinkRow(rows[0]) : null;
}

/** Reactivates the caller-locked link in the caller's transaction. */
export async function reactivateValueLink(client: PoolClient, linkId: string): Promise<void> {
  const result = await client.query(
    `UPDATE value_links SET state = 'on', broken_by = NULL, broken_at = NULL, updated_at = now()
     WHERE tenant_id = app_tenant_default() AND id = $1`,
    [linkId],
  );
  requireAffectedRows(result, "value link reactivation");
}

/** Pages active links whose source and rule match, ordered by stable link id. */
export async function pageValueLinksForSource(
  client: PoolClient,
  input: { ruleKey: string; sourceItemId: string; afterId: string | null; limit: number },
): Promise<ValueLinkRow[]> {
  const { rows } = await client.query<ValueLinkDbRow>(
    `SELECT l.id, l.item_id, l.property_key, l.rule_key, l.state, l.broken_by, l.broken_at
     FROM value_links l
     WHERE l.tenant_id = app_tenant_default() AND l.rule_key = $1 AND l.state = 'on' AND ($3::uuid IS NULL OR l.id > $3)
       AND EXISTS (SELECT 1 FROM value_link_sources s WHERE s.tenant_id = app_tenant_default() AND s.link_id = l.id AND s.source_kind = 'item' AND s.source_item_id = $2)
     ORDER BY l.id LIMIT $4`,
    [input.ruleKey, input.sourceItemId, input.afterId, input.limit],
  );
  return rows.map(mapValueLinkRow);
}

/** Adds one item source, idempotently, to a caller-locked link. */
export async function addValueLinkItemSource(
  client: PoolClient,
  linkId: string,
  sourceItemId: string,
  sourcePropertyKey: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO value_link_sources (link_id, source_kind, source_item_id, source_property_key)
     VALUES ($1, 'item', $2, $3) ON CONFLICT (tenant_id, link_id, source_item_id, source_property_key)
     WHERE source_kind = 'item' DO NOTHING`,
    [linkId, sourceItemId, sourcePropertyKey],
  );
  return result.rowCount === 1;
}

/** Removes an item source from a caller-locked link and reports whether it existed. */
export async function removeValueLinkItemSource(
  client: PoolClient,
  linkId: string,
  sourceItemId: string,
  sourcePropertyKey: string,
): Promise<boolean> {
  const result = await client.query(
    `DELETE FROM value_link_sources WHERE tenant_id = app_tenant_default() AND link_id = $1 AND source_kind = 'item' AND source_item_id = $2 AND source_property_key = $3`,
    [linkId, sourceItemId, sourcePropertyKey],
  );
  return result.rowCount === 1;
}

/**
 * Moves every item source naming `fromItemId` onto `toItemId`, in the caller's transaction (issue #1673: the next
 * instance of a recurring task takes over the sources its predecessor held). Each affected link is locked first,
 * in id order. A source whose link already names `toItemId` for the same property key is removed instead of
 * duplicated. Link states and values are not changed. Returns how many sources were moved or merged.
 */
export async function moveValueLinkItemSources(
  client: PoolClient,
  fromItemId: string,
  toItemId: string,
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT l.id FROM value_links l
     WHERE l.tenant_id = app_tenant_default()
       AND EXISTS (SELECT 1 FROM value_link_sources s WHERE s.tenant_id = app_tenant_default() AND s.link_id = l.id AND s.source_kind = 'item' AND s.source_item_id = $1)
     ORDER BY l.id FOR UPDATE`,
    [fromItemId],
  );
  if (rows.length === 0) return 0;
  const linkIds = rows.map((row) => row.id);
  const merged = await client.query(
    `DELETE FROM value_link_sources s
     WHERE s.tenant_id = app_tenant_default() AND s.link_id = ANY($3::uuid[]) AND s.source_kind = 'item' AND s.source_item_id = $1
       AND EXISTS (SELECT 1 FROM value_link_sources t WHERE t.tenant_id = s.tenant_id AND t.link_id = s.link_id
         AND t.source_kind = 'item' AND t.source_item_id = $2 AND t.source_property_key = s.source_property_key)`,
    [fromItemId, toItemId, linkIds],
  );
  const moved = await client.query(
    `UPDATE value_link_sources SET source_item_id = $2
     WHERE tenant_id = app_tenant_default() AND link_id = ANY($3::uuid[]) AND source_kind = 'item' AND source_item_id = $1`,
    [fromItemId, toItemId, linkIds],
  );
  return (merged.rowCount ?? 0) + (moved.rowCount ?? 0);
}

/** Deletes a caller-locked link after its last source is removed. */
export async function deleteEmptyValueLink(client: PoolClient, linkId: string): Promise<boolean> {
  const result = await client.query(
    `DELETE FROM value_links l WHERE l.tenant_id = app_tenant_default() AND l.id = $1 AND NOT EXISTS (SELECT 1 FROM value_link_sources s WHERE s.tenant_id = app_tenant_default() AND s.link_id = l.id)`,
    [linkId],
  );
  return result.rowCount === 1;
}

/**
 * Removes every item source naming `sourceItemId` (issue #1656), in the caller's transaction. Each
 * affected link is locked first, in id order, as `moveValueLinkItemSources` locks them. Link states
 * and the inheriting items' values are not changed. Returns each affected link with its item.
 */
export async function deleteValueLinkSourcesBySourceItem(
  client: PoolClient,
  sourceItemId: string,
): Promise<Array<{ linkId: string; itemId: string }>> {
  const { rows } = await client.query<{ id: string; item_id: string }>(
    `SELECT l.id, l.item_id FROM value_links l
     WHERE l.tenant_id = app_tenant_default()
       AND EXISTS (SELECT 1 FROM value_link_sources s WHERE s.tenant_id = app_tenant_default() AND s.link_id = l.id AND s.source_kind = 'item' AND s.source_item_id = $1)
     ORDER BY l.id FOR UPDATE`,
    [sourceItemId],
  );
  if (rows.length === 0) return [];
  const linkIds = rows.map((row) => row.id);
  const deleted = await client.query(
    `DELETE FROM value_link_sources
     WHERE tenant_id = app_tenant_default() AND link_id = ANY($2::uuid[]) AND source_kind = 'item' AND source_item_id = $1`,
    [sourceItemId, linkIds],
  );
  // Every locked link was selected for a source naming the item, so each loses at least one.
  if ((deleted.rowCount ?? 0) < linkIds.length) throw new Error("Value link sources changed during the detach");
  return rows.map((row) => ({ linkId: row.id, itemId: row.item_id }));
}

/** Deletes those caller-locked links among `linkIds` that have no source left; returns their items' ids. */
export async function deleteValueLinksWithoutSources(client: PoolClient, linkIds: string[]): Promise<string[]> {
  if (linkIds.length === 0) return [];
  const deleted = await client.query<{ item_id: string }>(
    `DELETE FROM value_links l
     WHERE l.tenant_id = app_tenant_default() AND l.id = ANY($1::uuid[])
       AND NOT EXISTS (SELECT 1 FROM value_link_sources s WHERE s.tenant_id = app_tenant_default() AND s.link_id = l.id)
     RETURNING l.item_id`,
    [linkIds],
  );
  // Zero rows is a valid outcome: every link still has another source.
  if ((deleted.rowCount ?? 0) === 0) return [];
  return deleted.rows.map((row) => row.item_id);
}

/** Deletes every link of `itemId` (a purged item's own links); their sources go with them by cascade. Returns how many. */
export async function deleteValueLinksByItemId(client: PoolClient, itemId: string): Promise<number> {
  const result = await client.query("DELETE FROM value_links WHERE tenant_id = app_tenant_default() AND item_id = $1", [
    itemId,
  ]);
  return result.rowCount ?? 0;
}
