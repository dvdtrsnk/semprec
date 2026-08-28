import * as Y from "yjs";
import type { Queryable } from "../db/pool.js";
import { ConflictError } from "../errors.js";
import { assertKnownValue } from "../dbRowValidation.js";
import type { DocKind, DocRow } from "../types.js";

const DOC_KIND_VALUES: readonly DocKind[] = ["page", "canvas"];

function mapDocRow(row: { id: string; item_id: string; kind: string; created_at: Date }): DocRow {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: assertKnownValue(DOC_KIND_VALUES, row.kind, "doc kind"),
    createdAt: row.created_at.toISOString(),
  };
}

export async function getDocByItemId(client: Queryable, itemId: string): Promise<DocRow | null> {
  const { rows } = await client.query(`SELECT id, item_id, kind, created_at FROM docs WHERE item_id = $1`, [itemId]);
  return rows[0] ? mapDocRow(rows[0]) : null;
}

export async function getDocById(client: Queryable, docId: string): Promise<DocRow | null> {
  const { rows } = await client.query(`SELECT id, item_id, kind, created_at FROM docs WHERE id = $1`, [docId]);
  return rows[0] ? mapDocRow(rows[0]) : null;
}

/**
 * Lazily creates the `docs` row (plus an empty `doc_snapshots` row) on the first
 * content-write to an item — never via migration/trigger (issue #23, point 3). Most
 * items never call this at all and stay with no doc, which is the expected normal
 * state, not an edge case.
 *
 * A concurrent first-write race (two callers creating a doc for the same item at the
 * same moment) is resolved by `ON CONFLICT DO NOTHING` plus a re-read of the winner's
 * row; given this is a single/two-user system this is accepted as a rare, low-stakes
 * race rather than solved with a lock on a row that doesn't exist yet.
 */
export async function getOrCreateDoc(client: Queryable, itemId: string, kind: DocKind): Promise<DocRow> {
  const existing = await getDocByItemId(client, itemId);
  if (existing) {
    if (existing.kind !== kind) {
      throw new ConflictError(`Item ${itemId} already has a '${existing.kind}' doc; cannot also create a '${kind}' doc`, { itemId, kind });
    }
    return existing;
  }

  const { rows } = await client.query(
    `INSERT INTO docs (item_id, kind) VALUES ($1, $2) ON CONFLICT (item_id) DO NOTHING RETURNING id, item_id, kind, created_at`,
    [itemId, kind],
  );
  if (rows[0]) {
    const emptyDoc = new Y.Doc();
    emptyDoc.gc = false;
    const state = Buffer.from(Y.encodeStateAsUpdate(emptyDoc));
    const stateVector = Buffer.from(Y.encodeStateVector(emptyDoc));
    await client.query(`INSERT INTO doc_snapshots (doc_id, state, state_vector) VALUES ($1, $2, $3)`, [rows[0].id, state, stateVector]);
    return mapDocRow(rows[0]);
  }

  const created = await getDocByItemId(client, itemId);
  if (!created) throw new Error(`docs row for item ${itemId} disappeared immediately after a concurrent insert`);
  return created;
}
