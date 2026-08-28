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

/**
 * Merges `flags` into an already-known folder edge's metadata alongside its `uid` (issue #26:
 * `UID FETCH ... CHANGEDSINCE <modseq> (FLAGS)` — a flag-only change on a message this folder
 * already knows about, e.g. read elsewhere). A `NULL` result from `findEmailItemIdByFolderUid`
 * (the message isn't known here yet — a race with this same pass's own new-message fetch, or
 * simply not synced yet) is a silent no-op: the next full reconcile picks up its flags along
 * with everything else once the message itself is ingested, there's nothing to merge onto yet.
 */
export async function updateFolderEdgeFlags(
  client: Queryable,
  relationDefinitionId: string,
  folderItemId: string,
  uid: number,
  flags: string[],
): Promise<void> {
  const emailItemId = await findEmailItemIdByFolderUid(client, relationDefinitionId, folderItemId, uid);
  if (!emailItemId) return;
  await client.query(
    `UPDATE item_relations SET metadata = metadata || jsonb_build_object('flags', $3::text[])
     WHERE relation_definition_id = $1 AND ((item_a = $2 AND item_b = $4) OR (item_a = $4 AND item_b = $2))`,
    [relationDefinitionId, folderItemId, flags, emailItemId],
  );
}
