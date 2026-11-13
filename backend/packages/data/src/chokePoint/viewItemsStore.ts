import type { PoolClient } from "pg";
import { requireSingleRow } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import type { ViewItemRow } from "../types.js";
import { visibleDatabaseIds } from "./itemsStore.js";
import { inheritedSensitivityDeniedSql } from "../agentGrants/agentDatabaseAccess.js";

/** The raw `view_items` row shape this module reads back from Postgres. */
type ViewItemDbRow = { view_id: string; item_id: string; position: number };

function mapViewItemRow(row: ViewItemDbRow): ViewItemRow {
  return { viewId: row.view_id, itemId: row.item_id, position: row.position };
}

/**
 * The databases a read of a curated view's members may come from: every visible database but the excluded ones
 * (the ones an agent's project may not read, issue #1810).
 */
async function readableDatabaseIds(client: PoolClient, excluded: ReadonlySet<string> | undefined): Promise<string[]> {
  const databaseIds = await visibleDatabaseIds(client);
  return excluded === undefined || excluded.size === 0 ? databaseIds : databaseIds.filter((id) => !excluded.has(id));
}

/** What a curated view's reads leave out: the members an agent's project may not read (issues #1810 and #1999). */
interface ViewMemberExclusions {
  /** The members whose item (live or trashed) lies in one of these databases. */
  excludeDatabaseIds?: ReadonlySet<string>;
  /**
   * The Projects item of an agent's run: the members that are linked to a sensitive database it may not read, when the
   * member belongs to a database that inherits sensitivity (`inheritedSensitivityDeniedSql`).
   */
  excludeInheritedSensitiveFor?: string;
}

function hasExclusions(exclusions: ViewMemberExclusions): boolean {
  return (
    (exclusions.excludeDatabaseIds !== undefined && exclusions.excludeDatabaseIds.size > 0) ||
    exclusions.excludeInheritedSensitiveFor !== undefined
  );
}

/** The condition that drops the members `excludeInheritedSensitiveFor` names, for the member item aliased `i`; `params` is extended. */
function inheritedMemberCondition(exclusions: ViewMemberExclusions, params: unknown[]): string[] {
  if (exclusions.excludeInheritedSensitiveFor === undefined) return [];
  return [
    `NOT ${inheritedSensitivityDeniedSql(params, { itemId: "i.id", databaseId: "i.database_id" }, exclusions.excludeInheritedSensitiveFor)}`,
  ];
}

/**
 * The members of a view in position order. `excludeDatabaseIds`, when given and not empty, keeps only the members
 * whose item (live or trashed) lies in another database, and `excludeInheritedSensitiveFor` drops the linked items
 * of a database that inherits sensitivity, so the members an agent may not read are not in the list.
 */
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

/**
 * The number of live (non-trashed) members of a curated view, counted over the same join `listLiveViewItemsAfter` pages,
 * without the members the exclusions name.
 */
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
 * `listViewItems` filtered to live (non-trashed) members and paged by `position` — used to
 * page a curated view's default listing, where a page must fill with `limit` live items
 * rather than come back short whenever memberships happen to point at trashed items. The
 * join also binds the caller's visible database ids (`visibleDatabaseIds`), so the planner
 * prunes `items` to those partitions instead of scanning every tenant's partition. The exclusions drop the
 * members of those databases, and the linked items of a database that inherits sensitivity, from the join, so a page
 * fills with readable members and its end is the end of the readable ones (issues #1810 and #1999).
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
 * Adding an already-present item is a move, not a duplicate insert: it delegates to
 * `reorderViewItem`, whose position-shifting logic is what keeps `position` values
 * unique. A brand-new member inserted at an explicit position likewise shifts every
 * row at or after it up by one first, so it can never land on (or collide with) an
 * existing position.
 */
export async function addViewItem(
  client: PoolClient,
  viewId: string,
  itemId: string,
  position?: number,
): Promise<ViewItemRow> {
  // Serializes concurrent addViewItem calls on the same view: without this, two calls
  // for different items can both read the same MAX(position) (or both match the same
  // `position >= $2` shift) and race to the same position, tying it — there is no
  // UNIQUE (view_id, position) constraint to catch that at the DB level.
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

/** Returns whether a row was actually removed, so the choke-point can distinguish a real removal from a no-op on a non-member `itemId`. */
export async function removeViewItem(client: PoolClient, viewId: string, itemId: string): Promise<boolean> {
  const result = await client.query(`DELETE FROM view_items WHERE view_id = $1 AND item_id = $2`, [viewId, itemId]);
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Moves `itemId` to `position`, shifting every row strictly between its old and new
 * position by one — a bare `UPDATE ... SET position = $N` would leave two rows tied on
 * the same position, making `ORDER BY position` non-deterministic between them.
 */
export async function reorderViewItem(
  client: PoolClient,
  viewId: string,
  itemId: string,
  position: number,
): Promise<ViewItemRow> {
  // Serializes concurrent reorderViewItem calls on the same view: without this, two calls
  // for different items can both read the same `position` shift window and race to the
  // same position, tying it — there is no UNIQUE (view_id, position) constraint to catch
  // that at the DB level.
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
