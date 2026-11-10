import type { Queryable } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { FOLDERS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { DRAFTS_AND_SENT_SPECIAL_PURPOSES, FLAGGED_PROPERTY_KEY, READ_PROPERTY_KEY } from "./messageFlags.js";

/**
 * Full-text search over synced message content (issue #26's scope: Emails only — the
 * generic `items`/`properties` model has no single "message text" column, so this is a
 * separate index table maintained by the application's write path, not a generated column).
 * `'czech'` is the text-search configuration 0006_mail_sync.sql builds on `unaccent` + `simple`,
 * which 0046_czech_hunspell_search.sql puts a Hunspell dictionary in front of once the
 * provisioned assets exist.
 */
export interface ReindexItemSearchInput {
  itemId: string;
  databaseId: string;
  text: string;
}

export async function reindexItemSearch(client: Queryable, input: ReindexItemSearchInput): Promise<void> {
  // A repeat rebuild keeps the timestamp when both vector and database are unchanged.
  await client.query(
    `INSERT INTO item_search_index (item_id, database_id, search_vector, updated_at)
     VALUES ($1, $2, to_tsvector('czech', $3) || to_tsvector('czech_simple', $3), now())
     ON CONFLICT (item_id) DO UPDATE SET search_vector = EXCLUDED.search_vector, database_id = EXCLUDED.database_id, updated_at = now()
     WHERE item_search_index.search_vector IS DISTINCT FROM EXCLUDED.search_vector
        OR item_search_index.database_id IS DISTINCT FROM EXCLUDED.database_id`,
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
export async function findEmailsMissingSearchIndex(
  client: Queryable,
  emailsDatabaseId: string,
  limit = 200,
): Promise<FindEmailsMissingSearchIndexResult[]> {
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
 * `from:`, `has:attachment`, `before:`/`after:`, and `is:read`/`is:unread`/`is:flagged`/
 * `is:unflagged` become structured `WHERE` conditions; everything else is the free-text
 * remainder handed to `websearch_to_tsquery`. The `is:` operators compile over #97's
 * canonical `read`/`flagged` boolean properties (issue #90) — never into full text.
 */
export interface ParsedMailSearchQuery {
  freeText: string;
  from?: string;
  hasAttachment?: boolean;
  before?: string;
  after?: string;
  read?: boolean;
  flagged?: boolean;
  contradictory?: boolean;
}

const OPERATOR_PATTERN = /\b(from|has|before|after|is):(\S+)/gi;

/**
 * `is:read`/`is:unread` and `is:flagged`/`is:unflagged` are each a single independent
 * boolean dimension: identical repeats collapse (`is:unread is:unread` is just `unread`),
 * but the two values of the same dimension contradict each other and fail predictably
 * (issue #90) rather than silently picking one or returning arbitrary results. An
 * unrecognized `is:` value (e.g. `is:spam`) is left unhandled — the caller falls back to
 * leaving the token in free text, the same as any other unrecognized operator, rather than
 * silently discarding it as if it were a no-op filter.
 */
function applyIsOperator(parsed: ParsedMailSearchQuery, value: string, allowContradictions: boolean): boolean {
  switch (value.toLowerCase()) {
    case "read":
    case "unread": {
      const next = value.toLowerCase() === "read";
      if (parsed.read !== undefined && parsed.read !== next) {
        if (allowContradictions) {
          parsed.contradictory = true;
          return true;
        }
        throw new ValidationError("Contradictory is:read/is:unread search operators", {
          field: "is:read",
          conflict: ["read", "unread"],
        });
      }
      parsed.read = next;
      return true;
    }
    case "flagged":
    case "unflagged": {
      const next = value.toLowerCase() === "flagged";
      if (parsed.flagged !== undefined && parsed.flagged !== next) {
        if (allowContradictions) {
          parsed.contradictory = true;
          return true;
        }
        throw new ValidationError("Contradictory is:flagged/is:unflagged search operators", {
          field: "is:flagged",
          conflict: ["flagged", "unflagged"],
        });
      }
      parsed.flagged = next;
      return true;
    }
    default:
      return false;
  }
}

export function parseMailSearchQuery(query: string, allowContradictions = false): ParsedMailSearchQuery {
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
        case "is":
          return applyIsOperator(parsed, value, allowContradictions) ? "" : _match;
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
  if (parsed.read !== undefined) {
    params.push(parsed.read);
    conditions.push(`coalesce((i.properties ->> '${READ_PROPERTY_KEY}')::boolean, false) = $${params.length}`);
    if (parsed.read === false) {
      // is:unread leaves out a message linked to any Drafts or Sent folder (issue #1461): those are read by
      // definition, so a Sent message that was never marked read is not unread. The check is per edge, so a
      // message that is also in an Inbox is left out too.
      params.push(FOLDERS_MODULE_ID, DRAFTS_AND_SENT_SPECIAL_PURPOSES);
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM item_relations r
        JOIN items f ON f.id = CASE WHEN r.item_a = s.item_id THEN r.item_b ELSE r.item_a END
        WHERE (r.item_a = s.item_id OR r.item_b = s.item_id)
          AND f.database_id = (SELECT id FROM databases WHERE owner_module_id = $${params.length - 1})
          AND f.deleted_at IS NULL
          AND f.properties ->> 'specialPurpose' = ANY($${params.length}::text[])
      )`);
    }
  }
  if (parsed.flagged !== undefined) {
    params.push(parsed.flagged);
    conditions.push(`coalesce((i.properties ->> '${FLAGGED_PROPERTY_KEY}')::boolean, false) = $${params.length}`);
  }

  const rankWithRecency = `${rankExpr} * (1.0 / (1.0 + extract(epoch FROM now() - s.updated_at) / 86400.0 / 30.0))`;
  params.push(input.limit ?? 50);

  const { rows } = await client.query<{ item_id: string; rank: number }>(
    `SELECT s.item_id, ${rankWithRecency} AS rank
     FROM item_search_index s
     JOIN items i ON i.id = s.item_id AND i.database_id = s.database_id AND i.deleted_at IS NULL
     WHERE ${conditions.join(" AND ")}
     ORDER BY rank DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({ itemId: row.item_id, rank: row.rank }));
}
