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

/**
 * Periodic safety net (issue #26: "a periodic reindex job as a safety net for writes outside
 * the standard path — migrations, backfills"), not the primary indexing path (`ingest.ts`
 * calls `reindexItemSearch` directly on every ingested message, already sanitized via
 * `sanitizeHtml`). Catches any Emails item whose index row is missing or older than the item's
 * own `updated_at` — a plain regexp tag-strip is an adequate approximation for a backfill this
 * coarse-grained, not a replacement for the properly-sanitized primary path.
 */
export async function reindexStaleEmailSearchEntries(client: Queryable, emailsDatabaseId: string): Promise<number> {
  const { rowCount } = await client.query(
    `INSERT INTO item_search_index (item_id, database_id, search_vector, updated_at)
     SELECT it.id, it.database_id,
            to_tsvector('czech', COALESCE(it.properties->>'name', '') || ' ' || regexp_replace(COALESCE(it.properties->>'body', ''), '<[^>]+>', ' ', 'g')),
            now()
     FROM items it
     LEFT JOIN item_search_index idx ON idx.item_id = it.id
     WHERE it.database_id = $1 AND it.deleted_at IS NULL AND (idx.item_id IS NULL OR idx.updated_at < it.updated_at)
     ON CONFLICT (item_id) DO UPDATE SET search_vector = EXCLUDED.search_vector, updated_at = now()`,
    [emailsDatabaseId],
  );
  return rowCount ?? 0;
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
 *
 * Blended with recency (issue #26: "for a personal mailbox 'most relevant' usually means
 * 'most recent'") — a smooth decay over the message's own `date` property (falling back to
 * `items.updated_at` for a row with no `date`, e.g. a draft never sent), not `updated_at`
 * alone, since a message resynced/re-indexed long after it arrived shouldn't read as recent.
 * A ~30-day half-life-ish divisor keeps this a tie-breaker among close text matches rather
 * than overriding a strongly-relevant old message with a weakly-relevant new one.
 */
export async function searchItems(client: Queryable, input: SearchItemsInput): Promise<SearchItemsResultRow[]> {
  // The tsquery is parsed once (`q`), not twice (once for the rank expression, once for the
  // WHERE predicate) — same query object reused in both places instead of two independent
  // `websearch_to_tsquery(...)` calls that could in principle disagree if Postgres ever
  // evaluated them at different times.
  const { rows } = await client.query<{ item_id: string; rank: number }>(
    `WITH q AS (SELECT websearch_to_tsquery('czech', $2) AS query)
     SELECT idx.item_id AS item_id,
            ts_rank_cd(idx.search_vector, q.query)
              / (1.0 + EXTRACT(EPOCH FROM (now() - COALESCE((it.properties->>'date')::timestamptz, it.updated_at))) / 86400.0 / 30.0)
              AS rank
     FROM item_search_index idx
     JOIN items it ON it.database_id = idx.database_id AND it.id = idx.item_id
     CROSS JOIN q
     WHERE idx.database_id = $1 AND idx.search_vector @@ q.query
     ORDER BY rank DESC
     LIMIT $3`,
    [input.databaseId, input.query, input.limit ?? 50],
  );
  return rows.map((row) => ({ itemId: row.item_id, rank: row.rank }));
}
