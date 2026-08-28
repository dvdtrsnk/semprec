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

export interface FindEmailsMissingSearchIndexResult {
  itemId: string;
  name: string | null;
  body: string | null;
}

/**
 * The periodic reindex job's actual query (issue #26: "a periodic reindex job as a safety net
 * for writes outside the standard path — migrations, backfills"). Only catches "never indexed
 * at all," not "indexed but now stale" — a write that goes through `ingestEmailMessage` (the
 * standard path) always calls `reindexItemSearch` itself in the same transaction, so staleness
 * from the normal path can't happen; this only needs to cover a direct-DB write skipping that
 * call entirely.
 */
export async function findEmailsMissingSearchIndex(client: Queryable, emailsDatabaseId: string, limit = 200): Promise<FindEmailsMissingSearchIndexResult[]> {
  const { rows } = await client.query<{ id: string; properties: { name?: string; body?: string } }>(
    `SELECT i.id, i.properties FROM items i
     LEFT JOIN item_search_index s ON s.item_id = i.id AND s.database_id = i.database_id
     WHERE i.database_id = $1 AND i.deleted_at IS NULL AND s.item_id IS NULL
     LIMIT $2`,
    [emailsDatabaseId, limit],
  );
  return rows.map((row) => ({ itemId: row.id, name: row.properties.name ?? null, body: row.properties.body ?? null }));
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
 * A thin layer of Gmail-style search operators over the free-text query (issue #26):
 * `from:`, `has:attachment`, `before:`/`after:` become structured `WHERE` conditions;
 * everything else is the free-text remainder handed to `websearch_to_tsquery`. `is:unread`
 * is deliberately not parsed here — there is no read/flags property anywhere in this issue's
 * Emails schema to filter on (that property, and the sync direction that would write it,
 * belongs to whichever issue adds a "mark as read" UI action) — an `is:unread` token is left
 * in the free text rather than silently doing nothing, which is at least visible to the user
 * as a literal non-match instead of a filter that looks like it did something.
 */
export interface ParsedMailSearchQuery {
  freeText: string;
  from?: string;
  hasAttachment?: boolean;
  before?: string;
  after?: string;
}

const OPERATOR_PATTERN = /\b(from|has|before|after):(\S+)/gi;

export function parseMailSearchQuery(query: string): ParsedMailSearchQuery {
  const parsed: ParsedMailSearchQuery = { freeText: "" };
  const freeText = query
    .replace(OPERATOR_PATTERN, (_match, operator: string, value: string) => {
      switch (operator.toLowerCase()) {
        case "from":
          parsed.from = value;
          return "";
        case "has":
          if (value.toLowerCase() === "attachment") parsed.hasAttachment = true;
          return "";
        case "before":
          parsed.before = value;
          return "";
        case "after":
          parsed.after = value;
          return "";
        default:
          return _match;
      }
    })
    .replace(/\s+/g, " ")
    .trim();
  parsed.freeText = freeText;
  return parsed;
}

/**
 * `websearch_to_tsquery` accepts Google-style syntax (quotes, OR, `-exclude`) and never
 * throws on malformed input, unlike `to_tsquery` — appropriate for a raw user search box.
 * Ranked by `ts_rank_cd` (rewards terms appearing close together, better for prose than raw
 * term frequency) blended with recency — for a personal mailbox, "most relevant" usually also
 * means "most recent" (issue #26). Recency is read off `item_search_index.updated_at` (written
 * once at ingest, alongside the vector itself) rather than the Email item's own `date`
 * property — the index table is intentionally generic across future non-Emails consumers and
 * doesn't assume every indexed item has a `date` property.
 */
export async function searchItems(client: Queryable, input: SearchItemsInput): Promise<SearchItemsResultRow[]> {
  const parsed = parseMailSearchQuery(input.query);
  const params: unknown[] = [input.databaseId];
  const conditions: string[] = ["s.database_id = $1"];
  let rankExpr = "1.0";

  if (parsed.freeText) {
    params.push(parsed.freeText);
    conditions.push(`s.search_vector @@ websearch_to_tsquery('czech', $${params.length})`);
    rankExpr = `ts_rank_cd(s.search_vector, websearch_to_tsquery('czech', $${params.length}))`;
  }
  if (parsed.from) {
    params.push(`%${parsed.from}%`);
    conditions.push(`i.properties ->> 'sender' ILIKE $${params.length}`);
  }
  if (parsed.before) {
    params.push(parsed.before);
    conditions.push(`(i.properties ->> 'date')::timestamptz < $${params.length}::timestamptz`);
  }
  if (parsed.after) {
    params.push(parsed.after);
    conditions.push(`(i.properties ->> 'date')::timestamptz > $${params.length}::timestamptz`);
  }
  if (parsed.hasAttachment) {
    conditions.push(`EXISTS (SELECT 1 FROM mail_attachments a WHERE a.message_item_id = s.item_id)`);
  }

  const rankWithRecency = `${rankExpr} * (1.0 / (1.0 + extract(epoch FROM now() - s.updated_at) / 86400.0 / 30.0))`;
  params.push(input.limit ?? 50);

  const { rows } = await client.query<{ item_id: string; rank: number }>(
    `SELECT s.item_id, ${rankWithRecency} AS rank
     FROM item_search_index s
     LEFT JOIN items i ON i.id = s.item_id AND i.database_id = s.database_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY rank DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({ itemId: row.item_id, rank: row.rank }));
}
