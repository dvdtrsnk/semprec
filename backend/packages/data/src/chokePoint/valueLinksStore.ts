// SQL for `value_links` and `value_link_sources`. A link records that the whole value of one property
// on one item was taken over from other items; no row means the value is the user's own. Statements
// never name `tenant_id`: the column default stamps it and RLS filters it.
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

/** Inserts a link and its sources; run inside the caller's transaction so a failed source leaves no link. */
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

export async function listValueLinksByItemIds(client: PoolClient, itemIds: string[]): Promise<ValueLinkRow[]> {
  if (itemIds.length === 0) return [];
  const { rows } = await client.query<ValueLinkDbRow>(
    `SELECT ${LINK_COLUMNS} FROM value_links WHERE item_id = ANY($1::uuid[]) ORDER BY item_id, property_key`,
    [itemIds],
  );
  return rows.map(mapValueLinkRow);
}

/** In a stable order. */
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
 * Ends the given links that are still `on`. Missing and already broken rows are untouched, so the
 * first writer to end a link stays recorded. Returns the property keys whose state changed.
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

/**
 * Share-locks the `on` links so a concurrent unlink, source change or break waits (or, with `nowait`,
 * fails with 55P03) until the caller's transaction ends. Ordered by link id so callers lock alike.
 */
export async function lockOnValueLinksOfProperties(
  client: PoolClient,
  targets: ReadonlyArray<{ itemId: string; propertyKey: string }>,
  lockMode: "wait" | "nowait",
): Promise<ValueLinkRow[]> {
  if (targets.length === 0) return [];
  // The SQL suffix is selected only from the two fixed lock clauses for this typed mode.
  const { rows } = await client.query<ValueLinkDbRow>(
    `SELECT ${LINK_COLUMNS} FROM value_links
     WHERE tenant_id = app_tenant_default() AND state = 'on'
       AND (item_id, property_key) IN (SELECT * FROM unnest($1::uuid[], $2::text[]))
     ORDER BY id FOR SHARE${lockMode === "nowait" ? " NOWAIT" : ""}`,
    [targets.map((target) => target.itemId), targets.map((target) => target.propertyKey)],
  );
  return rows.map(mapValueLinkRow);
}

export async function listOnValueLinksFollowing(
  client: PoolClient,
  sourceItemId: string,
  sourcePropertyKey: string,
): Promise<ValueLinkRow[]> {
  const { rows } = await client.query<ValueLinkDbRow>(
    `SELECT l.id, l.item_id, l.property_key, l.rule_key, l.state, l.broken_by, l.broken_at
     FROM value_links l
     WHERE l.tenant_id = app_tenant_default() AND l.state = 'on'
       AND EXISTS (SELECT 1 FROM value_link_sources s
                    WHERE s.tenant_id = app_tenant_default() AND s.link_id = l.id AND s.source_kind = 'item'
                      AND s.source_item_id = $1 AND s.source_property_key = $2)
     ORDER BY l.item_id, l.property_key`,
    [sourceItemId, sourcePropertyKey],
  );
  return rows.map(mapValueLinkRow);
}

/** Links in any state with an item source naming `sourceItemId`, once per link, in `(item_id, property_key)` order. */
export async function listValueLinksBySourceItem(client: PoolClient, sourceItemId: string): Promise<ValueLinkRow[]> {
  const { rows } = await client.query<ValueLinkDbRow>(
    `SELECT l.id, l.item_id, l.property_key, l.rule_key, l.state, l.broken_by, l.broken_at
     FROM value_links l
     WHERE l.tenant_id = app_tenant_default()
       AND EXISTS (SELECT 1 FROM value_link_sources s
                    WHERE s.tenant_id = app_tenant_default() AND s.link_id = l.id AND s.source_kind = 'item'
                      AND s.source_item_id = $1)
     ORDER BY l.item_id, l.property_key`,
    [sourceItemId],
  );
  return rows.map(mapValueLinkRow);
}

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

export async function reactivateValueLink(client: PoolClient, linkId: string): Promise<void> {
  const result = await client.query(
    `UPDATE value_links SET state = 'on', broken_by = NULL, broken_at = NULL, updated_at = now()
     WHERE tenant_id = app_tenant_default() AND id = $1`,
    [linkId],
  );
  requireAffectedRows(result, "value link reactivation");
}

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

export async function listOnValueLinkSourceItemIds(client: PoolClient, ruleKey: string): Promise<string[]> {
  const { rows } = await client.query<{ source_item_id: string }>(
    `SELECT DISTINCT s.source_item_id
     FROM value_link_sources s JOIN value_links l ON l.tenant_id = app_tenant_default() AND l.id = s.link_id
     WHERE s.tenant_id = app_tenant_default() AND s.source_kind = 'item' AND l.rule_key = $1 AND l.state = 'on'
     ORDER BY s.source_item_id`,
    [ruleKey],
  );
  return rows.map((row) => row.source_item_id);
}

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
 * Moves every item source naming `fromItemId` onto `toItemId` (a recurring task's next instance takes
 * over its predecessor's sources). Locks each affected link first, in id order. A source whose link
 * already names `toItemId` for the same key is removed instead of duplicated. States and values are
 * unchanged. With `ruleKey`, only that rule's links. Returns how many sources were moved or merged.
 */
export async function moveValueLinkItemSources(
  client: PoolClient,
  fromItemId: string,
  toItemId: string,
  options: { ruleKey?: string } = {},
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT l.id FROM value_links l
     WHERE l.tenant_id = app_tenant_default() AND ($2::text IS NULL OR l.rule_key = $2)
       AND EXISTS (SELECT 1 FROM value_link_sources s WHERE s.tenant_id = app_tenant_default() AND s.link_id = l.id AND s.source_kind = 'item' AND s.source_item_id = $1)
     ORDER BY l.id FOR UPDATE`,
    [fromItemId, options.ruleKey ?? null],
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

/** Makes a caller-locked link's sources exactly `sources`; reports whether anything was deleted or inserted. */
export async function replaceValueLinkSources(
  client: PoolClient,
  linkId: string,
  sources: ValueLinkSourceInput[],
): Promise<boolean> {
  const stored = await listValueLinkSourcesByLinkIds(client, [linkId]);
  const sameSource = (row: ValueLinkSourceRow, input: ValueLinkSourceInput): boolean =>
    row.sourcePropertyKey === input.sourcePropertyKey &&
    ((row.kind === "item" && input.kind === "item" && row.sourceItemId === input.sourceItemId) ||
      (row.kind === "senderDomain" && input.kind === "senderDomain" && row.domain === input.domain));
  const obsolete = stored.filter((row) => !sources.some((input) => sameSource(row, input)));
  const missing = sources.filter((input) => !stored.some((row) => sameSource(row, input)));
  if (obsolete.length > 0)
    requireAffectedRows(
      await client.query(
        `DELETE FROM value_link_sources WHERE tenant_id = app_tenant_default() AND link_id = $1 AND id = ANY($2::uuid[])`,
        [linkId, obsolete.map((row) => row.id)],
      ),
      "value link source replacement",
    );
  for (const source of missing) {
    await client.query(
      `INSERT INTO value_link_sources (link_id, source_kind, source_item_id, source_property_key, domain)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        linkId,
        source.kind,
        source.kind === "item" ? source.sourceItemId : null,
        source.sourcePropertyKey,
        source.kind === "senderDomain" ? source.domain : null,
      ],
    );
  }
  return obsolete.length > 0 || missing.length > 0;
}

export async function deleteValueLinkOfProperty(
  client: PoolClient,
  itemId: string,
  propertyKey: string,
): Promise<boolean> {
  const result = await client.query(
    `DELETE FROM value_links WHERE tenant_id = app_tenant_default() AND item_id = $1 AND property_key = $2`,
    [itemId, propertyKey],
  );
  return result.rowCount === 1;
}

/**
 * Moves a property's link to another item (a thread merge), keeping its id, state and sources. The
 * caller must already have deleted `toItemId`'s link for that key (unique `(item_id, property_key)`).
 */
export async function moveValueLinkToItem(
  client: PoolClient,
  input: { fromItemId: string; toItemId: string; propertyKey: string },
): Promise<boolean> {
  const moved = await client.query(
    `UPDATE value_links SET item_id = $2, updated_at = now()
     WHERE tenant_id = app_tenant_default() AND item_id = $1 AND property_key = $3`,
    [input.fromItemId, input.toItemId, input.propertyKey],
  );
  return moved.rowCount === 1;
}

export async function deleteEmptyValueLink(client: PoolClient, linkId: string): Promise<boolean> {
  const result = await client.query(
    `DELETE FROM value_links l WHERE l.tenant_id = app_tenant_default() AND l.id = $1 AND NOT EXISTS (SELECT 1 FROM value_link_sources s WHERE s.tenant_id = app_tenant_default() AND s.link_id = l.id)`,
    [linkId],
  );
  return result.rowCount === 1;
}

/**
 * Locks, in item id order, the rows of the `ownerModuleId` database's items that have a link sourced
 * from `sourceItemId`. Call before taking the first link, so rows are held before links as the
 * propagation job does.
 */
export async function lockItemRowsOfLinksSourcedFromItem(
  client: PoolClient,
  sourceItemId: string,
  ownerModuleId: string,
): Promise<void> {
  await client.query(
    `SELECT i.id FROM items i
     JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id AND d.owner_module_id = $2
     WHERE i.tenant_id = app_tenant_default()
       AND i.id IN (
         SELECT l.item_id FROM value_links l
         WHERE l.tenant_id = app_tenant_default()
           AND EXISTS (SELECT 1 FROM value_link_sources s WHERE s.tenant_id = app_tenant_default() AND s.link_id = l.id AND s.source_kind = 'item' AND s.source_item_id = $1))
     ORDER BY i.id FOR NO KEY UPDATE OF i`,
    [sourceItemId, ownerModuleId],
  );
}

/**
 * Removes every item source naming `sourceItemId`. Locks each affected link first, ordered by item id,
 * its rule's position in `ruleKeyOrder` (unlisted rules last) and link id; the result keeps that
 * order. States and inheriting values are unchanged.
 */
export async function deleteValueLinkSourcesBySourceItem(
  client: PoolClient,
  sourceItemId: string,
  ruleKeyOrder: readonly string[] = [],
): Promise<Array<{ linkId: string; itemId: string }>> {
  const { rows } = await client.query<{ id: string; item_id: string }>(
    `SELECT l.id, l.item_id FROM value_links l
     WHERE l.tenant_id = app_tenant_default()
       AND EXISTS (SELECT 1 FROM value_link_sources s WHERE s.tenant_id = app_tenant_default() AND s.link_id = l.id AND s.source_kind = 'item' AND s.source_item_id = $1)
     ORDER BY l.item_id, array_position($2::text[], l.rule_key), l.id FOR UPDATE`,
    [sourceItemId, [...ruleKeyOrder]],
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

/** Returns the item ids of the deleted links. */
export async function deleteValueLinksWithoutSources(client: PoolClient, linkIds: string[]): Promise<string[]> {
  if (linkIds.length === 0) return [];
  const deleted = await client.query<{ item_id: string }>(
    `DELETE FROM value_links l
     WHERE l.tenant_id = app_tenant_default() AND l.id = ANY($1::uuid[])
       AND NOT EXISTS (SELECT 1 FROM value_link_sources s WHERE s.tenant_id = app_tenant_default() AND s.link_id = l.id)
     RETURNING l.item_id`,
    [linkIds],
  );
  if ((deleted.rowCount ?? 0) === 0) return [];
  return deleted.rows.map((row) => row.item_id);
}

/** A purged item's own links; sources go by cascade. Returns how many. */
export async function deleteValueLinksByItemId(client: PoolClient, itemId: string): Promise<number> {
  const result = await client.query("DELETE FROM value_links WHERE tenant_id = app_tenant_default() AND item_id = $1", [
    itemId,
  ]);
  return result.rowCount ?? 0;
}
