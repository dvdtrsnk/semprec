import * as Y from "yjs";
import type { Queryable } from "../db/pool.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { assertKnownValue } from "../dbRowValidation.js";
import type { CreatedBy, DocKind, DocRow } from "../types.js";

const DOC_KIND_VALUES: readonly DocKind[] = ["page", "canvas"];

type DocDbRow = {
  id: string;
  item_id: string;
  kind: string;
  created_at: Date;
  last_edited_at: Date | null;
  last_edited_by: string | null;
};

const DOC_COLUMNS = "id, item_id, kind, created_at, last_edited_at, last_edited_by";
const CREATED_BY_VALUES: readonly CreatedBy[] = ["user", "ai_agent", "system"];

function mapDocRow(row: DocDbRow): DocRow {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: assertKnownValue(DOC_KIND_VALUES, row.kind, "doc kind"),
    createdAt: row.created_at.toISOString(),
    lastEditedAt: (row.last_edited_at ?? row.created_at).toISOString(),
    lastEditedBy:
      row.last_edited_by === null
        ? null
        : assertKnownValue(CREATED_BY_VALUES, row.last_edited_by, "doc last edited by"),
  };
}

export async function getDocByItemId(client: Queryable, itemId: string): Promise<DocRow | null> {
  const { rows } = await client.query<DocDbRow>(`SELECT ${DOC_COLUMNS} FROM docs WHERE item_id = $1`, [itemId]);
  return rows[0] ? mapDocRow(rows[0]) : null;
}

export async function getDocById(client: Queryable, docId: string): Promise<DocRow | null> {
  const { rows } = await client.query<DocDbRow>(`SELECT ${DOC_COLUMNS} FROM docs WHERE id = $1`, [docId]);
  return rows[0] ? mapDocRow(rows[0]) : null;
}

/**
 * Created lazily on the first content write; most items never have a doc.
 *
 * Creation requires a live item here (a trashed one fails like a missing one; the foreign key alone would accept
 * it). An existing doc is returned whatever the item's state, so a trashed page stays restorable. `ON CONFLICT DO NOTHING`
 * without a target makes every unique index an arbiter, so concurrent first writes converge on the winner's row.
 */
export async function getOrCreateDoc(client: Queryable, itemId: string, kind: DocKind): Promise<DocRow> {
  const existing = await getDocByItemId(client, itemId);
  if (existing) {
    if (existing.kind !== kind) {
      throw new ConflictError(
        `Item ${itemId} already has a '${existing.kind}' doc; cannot also create a '${kind}' doc`,
        { itemId, kind },
      );
    }
    return existing;
  }

  const [item] = await getItemsByIds(client, [itemId]);
  if (!item) throw new NotFoundError(`Item ${itemId} not found`, { itemId });

  const { rows } = await client.query<DocDbRow & { history_available_from: Date }>(
    `INSERT INTO docs (item_id, kind, history_available_from) VALUES ($1, $2, now())
     ON CONFLICT DO NOTHING RETURNING ${DOC_COLUMNS}, history_available_from`,
    [itemId, kind],
  );
  if (rows[0]) {
    const emptyDoc = new Y.Doc();
    emptyDoc.gc = false;
    const state = Buffer.from(Y.encodeStateAsUpdate(emptyDoc));
    const stateVector = Buffer.from(Y.encodeStateVector(emptyDoc));
    await client.query(`INSERT INTO doc_snapshots (doc_id, state, state_vector) VALUES ($1, $2, $3)`, [
      rows[0].id,
      state,
      stateVector,
    ]);
    // The NULL-expiry baseline at exactly `history_available_from`, so any time since creation is reconstructible.
    await client.query(
      `INSERT INTO doc_snapshot_history (doc_id, state, through_update_id, represented_at, expires_at, created_by)
       VALUES ($1, $2, 0, $3, NULL, 'system')`,
      [rows[0].id, state, rows[0].history_available_from],
    );
    return mapDocRow(rows[0]);
  }

  const created = await getDocByItemId(client, itemId);
  if (!created) throw new Error(`docs row for item ${itemId} disappeared immediately after a concurrent insert`);
  // The race winner may have created a different kind.
  if (created.kind !== kind) {
    throw new ConflictError(`Item ${itemId} already has a '${created.kind}' doc; cannot also create a '${kind}' doc`, {
      itemId,
      kind,
    });
  }
  return created;
}

export interface PageStateRead {
  itemId: string;
  snapshot: Buffer | null;
  updates: Buffer[];
}

/** Reads item-backed documents and their state in a single non-compacting statement. */
export async function readRefDocumentStates(client: Queryable, itemIds: string[]): Promise<PageStateRead[]> {
  if (itemIds.length === 0) return [];
  const { rows } = await client.query<{ item_id: string; kind: number; bytes: unknown }>(
    `WITH selected AS (
       SELECT d.id, d.item_id FROM docs d
       JOIN items i ON i.tenant_id = d.tenant_id AND i.id = d.item_id
       WHERE d.item_id = ANY($1::uuid[])
     )
     SELECT selected.item_id, 0 AS kind, 0::bigint AS seq, s.state AS bytes
     FROM selected LEFT JOIN doc_snapshots s ON s.doc_id = selected.id
     UNION ALL
     SELECT selected.item_id, 1 AS kind, u.id AS seq, u.update AS bytes
     FROM selected JOIN doc_updates u ON u.doc_id = selected.id
     ORDER BY item_id, kind, seq`,
    [itemIds],
  );
  const documents = new Map<string, PageStateRead>();
  for (const row of rows) {
    if (row.bytes !== null && !Buffer.isBuffer(row.bytes)) throw new Error("Invalid document state bytes");
    let document = documents.get(row.item_id);
    if (!document) {
      document = { itemId: row.item_id, snapshot: null, updates: [] };
      documents.set(row.item_id, document);
    }
    if (row.kind === 0) document.snapshot = row.bytes;
    else if (row.kind === 1 && row.bytes !== null) document.updates.push(row.bytes);
    else throw new Error("Invalid document state row");
  }
  return [...documents.values()];
}

/** Reads selected page snapshots and updates in one statement without compaction. */
export async function readPageStatesForItems(client: Queryable, itemIds: string[]): Promise<PageStateRead[]> {
  if (itemIds.length === 0) return [];
  const { rows } = await client.query<{ item_id: string; kind: number; bytes: unknown }>(
    `WITH selected AS (SELECT d.id, d.item_id FROM docs d WHERE d.item_id = ANY($1::uuid[]) AND d.kind = 'page')
     SELECT selected.item_id, 0 AS kind, 0::bigint AS seq, s.state AS bytes
     FROM selected LEFT JOIN doc_snapshots s ON s.doc_id = selected.id
     UNION ALL
     SELECT selected.item_id, 1 AS kind, u.id AS seq, u.update AS bytes
     FROM selected JOIN doc_updates u ON u.doc_id = selected.id
     ORDER BY item_id, kind, seq`,
    [itemIds],
  );
  const pages = new Map<string, PageStateRead>();
  for (const row of rows) {
    if (row.bytes !== null && !Buffer.isBuffer(row.bytes)) throw new Error("Invalid page state bytes");
    let page = pages.get(row.item_id);
    if (!page) {
      page = { itemId: row.item_id, snapshot: null, updates: [] };
      pages.set(row.item_id, page);
    }
    if (row.kind === 0) page.snapshot = row.bytes;
    else if (row.kind === 1 && row.bytes !== null) page.updates.push(row.bytes);
    else throw new Error("Invalid page state row");
  }
  return [...pages.values()];
}
