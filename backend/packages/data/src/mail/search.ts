import type { Queryable } from "../db/pool.js";

/**
 * Full-text search over synced message content (issue #26's scope: Emails only — the
 * generic `items`/`properties` model has no single "message text" column, so this is a
 * separate index table maintained by the application's write path, not a generated column).
 * `'czech'` is the text-search configuration the migration builds on `unaccent` + `simple`
 * (see 0006_mail_sync.sql's header note on the hunspell dictionary deviation).
 */
export interface ReindexItemSearchInput {
  itemId: string;
  databaseId: string;
  text: string;
}

export async function reindexItemSearch(client: Queryable, input: ReindexItemSearchInput): Promise<void> {
  await client.query(
    `INSERT INTO item_search_index (item_id, database_id, search_vector, updated_at)
     VALUES ($1, $2, to_tsvector('czech', $3), now())
     ON CONFLICT (item_id) DO UPDATE SET search_vector = EXCLUDED.search_vector, database_id = EXCLUDED.database_id, updated_at = now()`,
    [input.itemId, input.databaseId, input.text],
  );
}

export interface SearchItemsInput {
  databaseId: string;
  query: string;
  limit?: number;
}

export interface SearchItemsResultRow {
  itemId: string;
  rank: number;
}

/**
 * `websearch_to_tsquery` accepts Google-style syntax (quotes, OR, `-exclude`) and never
 * throws on malformed input, unlike `to_tsquery` — appropriate for a raw user search box.
 * `ts_rank_cd` rewards terms appearing close together, which reads better for prose than
 * raw term frequency. Structured operators (`from:`, `has:attachment`, `before:`/`after:`,
 * `is:unread`) belong in the caller's `WHERE`, not here — this function only ever ranks the
 * free-text remainder.
 */
export async function searchItems(client: Queryable, input: SearchItemsInput): Promise<SearchItemsResultRow[]> {
  const { rows } = await client.query<{ item_id: string; rank: number }>(
    `SELECT item_id, ts_rank_cd(search_vector, websearch_to_tsquery('czech', $2)) AS rank
     FROM item_search_index
     WHERE database_id = $1 AND search_vector @@ websearch_to_tsquery('czech', $2)
     ORDER BY rank DESC
     LIMIT $3`,
    [input.databaseId, input.query, input.limit ?? 50],
  );
  return rows.map((row) => ({ itemId: row.item_id, rank: row.rank }));
}
