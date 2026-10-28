// Owns SQL for `value_links` and `value_link_sources` (issue #1403). A link records that the whole
// value of one property on one item was taken over from other items; no row means the value is the
// user's own. Both tables are tenant tables: every statement here runs under the caller's tenant
// scope and never names `tenant_id`, so the column default stamps it and RLS filters it.
import type { PoolClient } from "pg";
import { requireSingleRow } from "../db/pool.js";
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
