import type { PoolClient } from "pg";
import { ValidationError } from "../errors.js";
import type { ViewItemRow } from "../types.js";

function mapViewItemRow(row: { view_id: string; item_id: string; position: number }): ViewItemRow {
  return { viewId: row.view_id, itemId: row.item_id, position: row.position };
}

export async function listViewItems(client: PoolClient, viewId: string): Promise<ViewItemRow[]> {
  const { rows } = await client.query(`SELECT view_id, item_id, position FROM view_items WHERE view_id = $1 ORDER BY position ASC`, [viewId]);
  return rows.map(mapViewItemRow);
}

export async function addViewItem(client: PoolClient, viewId: string, itemId: string, position?: number): Promise<ViewItemRow> {
  let pos = position;
  if (pos === undefined) {
    const { rows } = await client.query<{ next: number }>(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM view_items WHERE view_id = $1`, [
      viewId,
    ]);
    pos = rows[0].next;
  }
  const { rows } = await client.query(
    `INSERT INTO view_items (view_id, item_id, position) VALUES ($1, $2, $3)
     ON CONFLICT (view_id, item_id) DO UPDATE SET position = EXCLUDED.position
     RETURNING view_id, item_id, position`,
    [viewId, itemId, pos],
  );
  return mapViewItemRow(rows[0]);
}

export async function removeViewItem(client: PoolClient, viewId: string, itemId: string): Promise<void> {
  await client.query(`DELETE FROM view_items WHERE view_id = $1 AND item_id = $2`, [viewId, itemId]);
}

/**
 * Moves `itemId` to `position`, shifting every row strictly between its old and new
 * position by one — a bare `UPDATE ... SET position = $N` would leave two rows tied on
 * the same position, making `ORDER BY position` non-deterministic between them.
 */
export async function reorderViewItem(client: PoolClient, viewId: string, itemId: string, position: number): Promise<ViewItemRow> {
  const { rows: currentRows } = await client.query<{ position: number }>(
    `SELECT position FROM view_items WHERE view_id = $1 AND item_id = $2 FOR UPDATE`,
    [viewId, itemId],
  );
  const current = currentRows[0];
  if (!current) throw new ValidationError(`Item ${itemId} is not a member of view ${viewId}`, { field: "itemId" });

  if (position > current.position) {
    await client.query(`UPDATE view_items SET position = position - 1 WHERE view_id = $1 AND position > $2 AND position <= $3`, [
      viewId,
      current.position,
      position,
    ]);
  } else if (position < current.position) {
    await client.query(`UPDATE view_items SET position = position + 1 WHERE view_id = $1 AND position >= $2 AND position < $3`, [
      viewId,
      position,
      current.position,
    ]);
  }

  const { rows } = await client.query(
    `UPDATE view_items SET position = $3 WHERE view_id = $1 AND item_id = $2 RETURNING view_id, item_id, position`,
    [viewId, itemId, position],
  );
  return mapViewItemRow(rows[0]);
}
