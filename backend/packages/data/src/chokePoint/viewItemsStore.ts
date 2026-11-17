import type { PoolClient } from "pg";
import { requireSingleRow } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import type { ViewItemRow } from "../types.js";
import { visibleDatabaseIds } from "./itemsStore.js";
import { inheritedSensitivityDeniedSql } from "../agentGrants/agentDatabaseAccess.js";

type ViewItemDbRow = { view_id: string; item_id: string; position: number };

function mapViewItemRow(row: ViewItemDbRow): ViewItemRow {
  return { viewId: row.view_id, itemId: row.item_id, position: row.position };
}

/** Every visible database but the excluded ones. */
async function readableDatabaseIds(client: PoolClient, excluded: ReadonlySet<string> | undefined): Promise<string[]> {
  const databaseIds = await visibleDatabaseIds(client);
  return excluded === undefined || excluded.size === 0 ? databaseIds : databaseIds.filter((id) => !excluded.has(id));
}

/** The members of a curated view an agent's project may not read. */
interface ViewMemberExclusions {
  /** Members whose item (live or trashed) lies in one of these databases. */
  excludeDatabaseIds?: ReadonlySet<string>;
  /**
   * An agent run's Projects item: drops members of a sensitivity-inheriting database
   * (`inheritedSensitivityDeniedSql`) that are linked to a sensitive database it may not read.
   */
  excludeInheritedSensitiveFor?: string;
}

function hasExclusions(exclusions: ViewMemberExclusions): boolean {
  return (
    (exclusions.excludeDatabaseIds !== undefined && exclusions.excludeDatabaseIds.size > 0) ||
    exclusions.excludeInheritedSensitiveFor !== undefined
  );
}

/** For the member item aliased `i`; extends `params`. */
function inheritedMemberCondition(exclusions: ViewMemberExclusions, params: unknown[]): string[] {
  if (exclusions.excludeInheritedSensitiveFor === undefined) return [];
  return [
    `NOT ${inheritedSensitivityDeniedSql(params, { itemId: "i.id", databaseId: "i.database_id" }, exclusions.excludeInheritedSensitiveFor)}`,
  ];
}

/** The members of a view in position order, without the members `exclusions` names. */
export async function listViewItems(
  client: PoolClient,
  viewId: string,
  options: ViewMemberExclusions = {},
): Promise<ViewItemRow[]> {
  if (!hasExclusions(options)) {
    const { rows } = await client.query<ViewItemDbRow>(
      `SELECT view_id, item_id, position FROM view_items WHERE view_id = $1 ORDER BY position ASC`,
      [viewId],
    );
    return rows.map(mapViewItemRow);
  }
  const params: unknown[] = [viewId, await readableDatabaseIds(client, options.excludeDatabaseIds)];
  const conditions = ["m.view_id = $1", ...inheritedMemberCondition(options, params)];
  const { rows } = await client.query<ViewItemDbRow>(
    `SELECT m.view_id, m.item_id, m.position FROM view_items m
     JOIN items i ON i.id = m.item_id AND i.database_id = ANY($2::uuid[])
     WHERE ${conditions.join(" AND ")}
     ORDER BY m.position ASC`,
    params,
  );
  return rows.map(mapViewItemRow);
}

/** Counted over the same join `listLiveViewItemsAfter` pages. */
export async function countLiveViewItems(
  client: PoolClient,
  viewId: string,
  options: ViewMemberExclusions = {},
): Promise<number> {
  const params: unknown[] = [viewId, await readableDatabaseIds(client, options.excludeDatabaseIds)];
  const conditions = ["m.view_id = $1", "i.deleted_at IS NULL", ...inheritedMemberCondition(options, params)];
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM view_items m
     JOIN items i ON i.id = m.item_id AND i.database_id = ANY($2::uuid[])
     WHERE ${conditions.join(" AND ")}`,
    params,
  );
  return Number(requireSingleRow(rows, "view items count").count);
}

/**
 * Live members paged by `position`, so a page fills with `limit` live items instead of coming back
 * short for memberships of trashed items. Binding `visibleDatabaseIds` lets the planner prune `items`
 * partitions. Exclusions apply in the join, so a page fills with readable members only.
 */
export async function listLiveViewItemsAfter(
  client: PoolClient,
  viewId: string,
  input: { afterPosition: number | null; limit: number } & ViewMemberExclusions,
): Promise<ViewItemRow[]> {
  const databaseIds = await readableDatabaseIds(client, input.excludeDatabaseIds);
  const conditions = ["m.view_id = $1", "i.deleted_at IS NULL"];
  const params: unknown[] = [viewId, input.limit, databaseIds];
  if (input.afterPosition !== null) {
    params.push(input.afterPosition);
    conditions.push(`m.position > $${params.length}`);
  }
  conditions.push(...inheritedMemberCondition(input, params));
  const { rows } = await client.query<ViewItemDbRow>(
    `SELECT m.view_id, m.item_id, m.position FROM view_items m
     JOIN items i ON i.id = m.item_id AND i.database_id = ANY($3::uuid[])
     WHERE ${conditions.join(" AND ")}
     ORDER BY m.position ASC
     LIMIT $2`,
    params,
  );
  return rows.map(mapViewItemRow);
}

/**
 * Adding an already-present item is a move (delegates to `reorderViewItem`). A new member at an
 * explicit position first shifts every row at or after it, so positions stay unique.
 */
export async function addViewItem(
  client: PoolClient,
  viewId: string,
  itemId: string,
  position?: number,
): Promise<ViewItemRow> {
  // Serializes concurrent adds on this view: there is no UNIQUE (view_id, position), so two adds could
  // otherwise read the same MAX(position) and tie.
  await client.query(`SELECT id FROM views WHERE id = $1 FOR UPDATE`, [viewId]);

  const { rows: existingRows } = await client.query<{ position: number }>(
    `SELECT position FROM view_items WHERE view_id = $1 AND item_id = $2 FOR UPDATE`,
    [viewId, itemId],
  );
  if (existingRows[0]) {
    if (position === undefined)
      return mapViewItemRow({ view_id: viewId, item_id: itemId, position: existingRows[0].position });
    return reorderViewItem(client, viewId, itemId, position);
  }

  let pos = position;
  if (pos === undefined) {
    const { rows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM view_items WHERE view_id = $1`,
      [viewId],
    );
    pos = requireSingleRow(rows, "view_items next position").next;
  } else {
    await client.query(`UPDATE view_items SET position = position + 1 WHERE view_id = $1 AND position >= $2`, [
      viewId,
      pos,
    ]);
  }

  const { rows } = await client.query<ViewItemDbRow>(
    `INSERT INTO view_items (view_id, item_id, position) VALUES ($1, $2, $3) RETURNING view_id, item_id, position`,
    [viewId, itemId, pos],
  );
  return mapViewItemRow(requireSingleRow(rows, "view_items row"));
}

/** Whether a row was removed, so a non-member `itemId` is distinguishable from a real removal. */
export async function removeViewItem(client: PoolClient, viewId: string, itemId: string): Promise<boolean> {
  const result = await client.query(`DELETE FROM view_items WHERE view_id = $1 AND item_id = $2`, [viewId, itemId]);
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Shifts every row between the old and new position by one; a bare `SET position` would tie two rows
 * and make `ORDER BY position` non-deterministic.
 */
export async function reorderViewItem(
  client: PoolClient,
  viewId: string,
  itemId: string,
  position: number,
): Promise<ViewItemRow> {
  // Serializes concurrent reorders on this view; no UNIQUE (view_id, position) catches a tie.
  await client.query(`SELECT id FROM views WHERE id = $1 FOR UPDATE`, [viewId]);

  const { rows: currentRows } = await client.query<{ position: number }>(
    `SELECT position FROM view_items WHERE view_id = $1 AND item_id = $2 FOR UPDATE`,
    [viewId, itemId],
  );
  const current = currentRows[0];
  if (!current) throw new ValidationError(`Item ${itemId} is not a member of view ${viewId}`, { field: "itemId" });

  if (position > current.position) {
    await client.query(
      `UPDATE view_items SET position = position - 1 WHERE view_id = $1 AND position > $2 AND position <= $3`,
      [viewId, current.position, position],
    );
  } else if (position < current.position) {
    await client.query(
      `UPDATE view_items SET position = position + 1 WHERE view_id = $1 AND position >= $2 AND position < $3`,
      [viewId, position, current.position],
    );
  }

  const { rows } = await client.query<ViewItemDbRow>(
    `UPDATE view_items SET position = $3 WHERE view_id = $1 AND item_id = $2 RETURNING view_id, item_id, position`,
    [viewId, itemId, position],
  );
  return mapViewItemRow(requireSingleRow(rows, "view_items row"));
}
