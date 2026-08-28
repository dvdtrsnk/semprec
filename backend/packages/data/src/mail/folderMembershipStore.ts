import type { Queryable } from "../db/pool.js";

/**
 * The IMAP UID lives on the Emails<->Folders relation edge's `metadata` (issue #26: "the
 * per-folder UID lives on the relationship edge, not on the message" — reusing
 * `item_relations.metadata jsonb` from issue #21, the same field issue #25 uses for
 * ratings), so finding "which Email item has UID 88213 in this folder" needs a metadata
 * lookup the generic relation stores don't provide.
 */
export async function findEmailItemIdByFolderUid(client: Queryable, relationDefinitionId: string, folderItemId: string, uid: number): Promise<string | null> {
  const { rows } = await client.query<{ item_a: string; item_b: string }>(
    `SELECT item_a, item_b FROM item_relations WHERE relation_definition_id = $1 AND (item_a = $2 OR item_b = $2) AND metadata ->> 'uid' = $3`,
    [relationDefinitionId, folderItemId, String(uid)],
  );
  const row = rows[0];
  if (!row) return null;
  return row.item_a === folderItemId ? row.item_b : row.item_a;
}

/** Every UID this folder currently has an edge for — the DB side of a full UID diff on a server without CONDSTORE/QRESYNC. */
export async function listKnownFolderUids(client: Queryable, relationDefinitionId: string, folderItemId: string): Promise<number[]> {
  const { rows } = await client.query<{ uid: string }>(
    `SELECT metadata ->> 'uid' AS uid FROM item_relations
     WHERE relation_definition_id = $1 AND (item_a = $2 OR item_b = $2) AND metadata ? 'uid'`,
    [relationDefinitionId, folderItemId],
  );
  return rows.map((row) => Number(row.uid));
}
