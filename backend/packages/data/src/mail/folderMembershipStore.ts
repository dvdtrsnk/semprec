import type { PoolClient } from "pg";
import type { Queryable } from "../db/pool.js";
import { createRelationWithClient } from "../chokePoint/chokePoint.js";

export interface KnownProviderMessage {
  itemId: string;
  providerMessageId: string;
}

/**
 * Every message currently linked (via any of `folderItemIds`) that has a `provider_message_id`
 * — used by the Gmail/Graph adapters' full-resync path (issue #26) to find messages that were
 * deleted from the provider between the last known position and now: `listAllMessageIds()` /
 * a fresh `fetchDelta(null)` only returns what *currently* exists, so anything already in our
 * DB but absent from that fresh list must be reconciled as removed, the same as IMAP's
 * `fetchAllUids`-vs-`listKnownFolderUids` diff on a server without CONDSTORE.
 */
export async function listKnownProviderMessagesForFolders(
  client: Queryable,
  relationDefinitionId: string,
  folderItemIds: string[],
): Promise<KnownProviderMessage[]> {
  if (folderItemIds.length === 0) return [];
  const { rows } = await client.query<{ item_id: string; provider_message_id: string }>(
    `SELECT DISTINCT mm.item_id, mm.provider_message_id
     FROM item_relations r
     JOIN mail_message_meta mm
       ON mm.item_id = CASE WHEN r.item_a = ANY($2::uuid[]) THEN r.item_b ELSE r.item_a END
     WHERE r.relation_definition_id = $1
       AND (r.item_a = ANY($2::uuid[]) OR r.item_b = ANY($2::uuid[]))
       AND mm.provider_message_id IS NOT NULL`,
    [relationDefinitionId, folderItemIds],
  );
  return rows.map((row) => ({ itemId: row.item_id, providerMessageId: row.provider_message_id }));
}

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
 * Writes through `createRelationWithClient` (the choke point), not a raw UPDATE — the edge's
 * `uid` is already known here (it's the lookup key), so the full desired metadata can be
 * reconstructed and passed through the same upsert every other edge write already uses,
 * rather than a second, ad hoc write path direct against `item_relations`.
 */
export async function updateFolderEdgeFlags(
  client: PoolClient,
  relationDefinitionId: string,
  relationPropertyId: string,
  folderItemId: string,
  uid: number,
  flags: string[],
): Promise<void> {
  const emailItemId = await findEmailItemIdByFolderUid(client, relationDefinitionId, folderItemId, uid);
  if (!emailItemId) return;
  await createRelationWithClient(client, {
    relationPropertyId,
    itemId: emailItemId,
    targetItemId: folderItemId,
    metadata: { uid, flags },
  });
}
