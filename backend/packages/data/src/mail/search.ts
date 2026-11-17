import type { Queryable } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { FOLDERS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { DRAFTS_AND_SENT_SPECIAL_PURPOSES, FLAGGED_PROPERTY_KEY, READ_PROPERTY_KEY } from "./messageFlags.js";

/**
 * A separate index table maintained by the write path, because the generic item model has no single
 * message text column. `'czech'` is the schema's `unaccent` + `simple` configuration, which a Hunspell
 * dictionary is put in front of once the assets are provisioned.
 */
export interface ReindexItemSearchInput {
  itemId: string;
  databaseId: string;
  text: string;
}

export async function reindexItemSearch(client: Queryable, input: ReindexItemSearchInput): Promise<void> {
  // Postgres text cannot hold U+0000, which text extracted from a PDF attachment can carry; it is no word.
  const text = input.text.replaceAll("\u0000", " ");
  // A repeat rebuild keeps the timestamp when both vector and database are unchanged.
  await client.query(
    `INSERT INTO item_search_index (item_id, database_id, search_vector, updated_at)
     VALUES ($1, $2, to_tsvector('czech', $3) || to_tsvector('czech_simple', $3), now())
     ON CONFLICT (item_id) DO UPDATE SET search_vector = EXCLUDED.search_vector, database_id = EXCLUDED.database_id, updated_at = now()
     WHERE item_search_index.search_vector IS DISTINCT FROM EXCLUDED.search_vector
        OR item_search_index.database_id IS DISTINCT FROM EXCLUDED.database_id`,
    [input.itemId, input.databaseId, text],
  );
}

export interface FindEmailsMissingSearchIndexResult {
  itemId: string;
  name: string | null;
  body: string | null;
}

/**
 * Safety net for direct-DB writes that skip `reindexItemSearch`. Finds only never-indexed items: the
 * standard path reindexes in the same transaction, so it cannot leave a stale entry.
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

/** Gmail-style operators compile to structured conditions (never full text); the rest goes to `websearch_to_tsquery`. */
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
 * Identical repeats collapse, but both values of one dimension contradict and fail predictably. An
 * unrecognized `is:` value is left in free text, like any unrecognized operator.
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
 * `websearch_to_tsquery` never throws on malformed input, unlike `to_tsquery`. Ranked by `ts_rank_cd`
 * blended with recency. Recency comes from `item_search_index.updated_at`, not the Email's `date`,
 * because the index is generic across item types.
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
      // Drafts and Sent are read by definition. The check is per edge, so a message also in an Inbox is
      // left out too.
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
