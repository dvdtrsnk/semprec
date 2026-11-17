import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  SEARCH_GROUP_TYPES,
  type SearchGroup,
  type SearchGroupType,
  type SearchItemGroupType,
  type SearchItemResult,
  type SearchJournalResult,
  type SearchOutput,
} from "@semprec/shared";
import { listUnreadableDatabaseIds } from "../agentGrants/agentDatabaseAccess.js";
import { visibleDatabaseIds } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { JOURNAL_PERIOD_TYPES } from "../journal/journalPeriods.js";
import { logger } from "./logger.js";
import { buildItemSearchQuery } from "./itemSearchQuery.js";
import { ITEM_SEARCH_MATCH_FROM, itemSearchMatchWhere } from "./itemSearchMatch.js";
import {
  getSearchGroup,
  type ItemSearchGroup,
  type ThreadSearchGroup,
  type ThreadSearchRun,
} from "./searchGroupRegistry.js";
import { buildSearchSnippetSql } from "./searchSnippet.js";
import { buildSubtitleParts } from "./searchSubtitleParts.js";

// Global search over `item_search_index`. Groups come from `searchGroupRegistry.ts`. An item group is an allow-list
// of databases by owner module, so any unlisted database is never searched; an Inbox entry is found through its
// Journal day's text. Thread groups (`chat`, `mail`) run their own search over threads.

/** A project owned by a system module is infrastructure and never a result. */
const EXCLUDE_SYSTEM_PROJECTS_SQL = "AND i.properties ->> 'systemActive' IS DISTINCT FROM 'true'";

/**
 * Applied to count and page alike, so `total` and the cursor never disagree with the listed results. Drops Journal
 * entries without a period `type` and a non-empty `period`.
 */
function groupFilter(group: SearchItemGroupType, firstParameter: number): { sql: string; params: unknown[] } {
  if (group === "project") return { sql: EXCLUDE_SYSTEM_PROJECTS_SQL, params: [] };
  if (group === "journal") {
    return {
      sql: `AND i.properties ->> 'type' = ANY($${firstParameter}::text[])
        AND jsonb_typeof(i.properties -> 'period') = 'string' AND i.properties ->> 'period' <> ''`,
      params: [[...JOURNAL_PERIOD_TYPES]],
    };
  }
  return { sql: "", params: [] };
}

export interface SearchItemGroupsInput {
  q: string;
  /** The answer follows the fixed `SEARCH_GROUP_TYPES` order, not this one. */
  scope: readonly SearchGroupType[];
  perGroupLimit: number;
  /** Allowed only when `scope` holds exactly that group. */
  cursor?: string;
  /** An agent run's Projects item: databases without a read grant are not searched. */
  agentProjectItemId?: string;
  /** `chat` is given to a person only: Semp conversations belong to the user, not to any granted database. */
  humanActor?: boolean;
}

/** Order: rank, then `updated_at`, then item id. */
const cursorSchema = z
  .object({
    /** `real` widened to double, which converts back without loss. */
    r: z.number().min(0).max(1e9),
    /** Whole microseconds since the epoch: a JavaScript date has only milliseconds. */
    u: z.string().regex(/^\d{1,18}$/),
    i: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  })
  .strict();
type SearchCursor = z.infer<typeof cursorSchema>;

function invalidCursor(): ValidationError {
  return new ValidationError("cursor is not a valid search cursor", { field: "cursor" });
}

function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Every shape is checked here, so a forged token is a 400 and never reaches the database. */
function decodeCursor(token: string): SearchCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw invalidCursor();
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidCursor();
    throw error;
  }
  const parsed = cursorSchema.safeParse(raw);
  if (!parsed.success) throw invalidCursor();
  return parsed.data;
}

interface SearchableDatabaseDbRow {
  id: string;
  owner_module_id: string;
  database_key: string;
  title_key: string | null;
}

interface CountDbRow {
  total: number;
}

interface SearchPageDbRow {
  id: string;
  database_id: string;
  module_id: string;
  database_key: string;
  title: string | null;
  properties: unknown;
  rank: number;
  updated_micros: string;
}

interface SnippetDbRow {
  id: string;
  snippet: string | null;
}

const propertiesSchema = z.record(z.string(), z.unknown());

/** `groupFilter` keeps every other Journal item out, so this never refuses a row it is given. */
const journalPeriodSchema = z.object({ type: z.enum(JOURNAL_PERIOD_TYPES), period: z.string().min(1) });

async function listSearchableDatabases(
  client: PoolClient,
  moduleIds: readonly string[],
  unreadableDatabaseIds: ReadonlySet<string>,
): Promise<SearchableDatabaseDbRow[]> {
  const { rows } = await client.query<SearchableDatabaseDbRow>(
    `SELECT d.id, d.owner_module_id, COALESCE(d.key, d.owner_module_id) AS database_key,
       (SELECT p.key FROM properties p WHERE p.database_id = d.id AND p.type = 'title' ORDER BY p.id LIMIT 1) AS title_key
     FROM databases d
     WHERE d.owner_module_id = ANY($1::text[]) AND d.archived_at IS NULL AND d.id <> ALL($2::uuid[])
     ORDER BY d.id`,
    [moduleIds, [...unreadableDatabaseIds]],
  );
  return rows;
}

async function countMatches(
  client: PoolClient,
  databaseIds: readonly string[],
  group: SearchItemGroupType,
  tsquery: { sql: string; params: string[] },
): Promise<number> {
  const filter = groupFilter(group, 2 + tsquery.params.length);
  const { rows } = await client.query<CountDbRow>(
    `SELECT count(*)::int AS total
     FROM ${ITEM_SEARCH_MATCH_FROM}
     WHERE ${itemSearchMatchWhere("$1::uuid[]", tsquery.sql)} AND i.deleted_at IS NULL
       ${filter.sql}`,
    [databaseIds, ...tsquery.params, ...filter.params],
  );
  return rows[0]?.total ?? 0;
}

/** One row more than `limit` tells whether another page follows. */
async function readPage(
  client: PoolClient,
  databases: readonly SearchableDatabaseDbRow[],
  group: SearchItemGroupType,
  limit: number,
  cursor: SearchCursor | undefined,
  buildQuery: (firstParameter: number) => { sql: string; params: string[] },
): Promise<SearchPageDbRow[]> {
  const tsquery = buildQuery(9);
  const filter = groupFilter(group, 9 + tsquery.params.length);
  const { rows } = await client.query<SearchPageDbRow>(
    `WITH matches AS (
       SELECT i.id, i.database_id, db.module_id, db.database_key, i.properties, i.properties ->> db.title_key AS title,
         ts_rank_cd(s.search_vector, ${tsquery.sql})::float8 AS rank,
         (extract(epoch FROM i.updated_at) * 1000000)::bigint AS updated_micros
       FROM ${ITEM_SEARCH_MATCH_FROM}
       JOIN unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) AS db(id, title_key, database_key, module_id)
         ON db.id = i.database_id
       WHERE ${itemSearchMatchWhere("$1::uuid[]", tsquery.sql)} AND i.deleted_at IS NULL
         ${filter.sql}
     )
     SELECT id, database_id, module_id, database_key, title, properties, rank, updated_micros::text AS updated_micros
     FROM matches
     WHERE $5::float8 IS NULL
       OR rank < $5::float8
       OR (rank = $5::float8 AND (updated_micros < $6::bigint OR (updated_micros = $6::bigint AND id > $7::uuid)))
     ORDER BY rank DESC, updated_micros DESC, id ASC
     LIMIT $8`,
    [
      databases.map((database) => database.id),
      databases.map((database) => database.title_key),
      databases.map((database) => database.database_key),
      databases.map((database) => database.owner_module_id),
      cursor?.r ?? null,
      cursor?.u ?? null,
      cursor?.i ?? null,
      limit + 1,
      ...tsquery.params,
      ...filter.params,
    ],
  );
  return rows;
}

/** Read only for the returned page. An item whose `body` does not match has a null excerpt. */
async function readSnippets(
  client: PoolClient,
  databaseIds: readonly string[],
  itemIds: readonly string[],
  buildQuery: (firstParameter: number) => { sql: string; params: string[] },
): Promise<Map<string, string | null>> {
  if (itemIds.length === 0) return new Map();
  const tsquery = buildQuery(3);
  const { rows } = await client.query<SnippetDbRow>(
    `SELECT item_id AS id, ${buildSearchSnippetSql(tsquery, 3)} AS snippet
     FROM item_search_index
     WHERE database_id = ANY($1::uuid[]) AND item_id = ANY($2::uuid[])`,
    [databaseIds, itemIds, ...tsquery.params],
  );
  return new Map(rows.map((row) => [row.id, row.snippet]));
}

/**
 * Searches the tenant for `input.q`, one group per registered type in `SEARCH_GROUP_TYPES` order; empty groups are
 * omitted. One repeatable-read transaction, so `total` and the page share a snapshot. Item groups are ordered by
 * `ts_rank_cd`, `updated_at` desc, id. Trashed items, system projects, archived databases, ungranted databases (for
 * an agent) and invalid Journal entries are never found. `snippet` is an excerpt of at most 160 characters when the
 * page text itself matches, else `null`. `q` is bound and never logged. A malformed cursor, or one with a scope of
 * not exactly one group, is a `ValidationError` before anything is searched.
 */
export async function searchItemGroups(pool: Pool, input: SearchItemGroupsInput): Promise<SearchOutput> {
  const itemGroups: ItemSearchGroup[] = [];
  const threadGroups: ThreadSearchGroup[] = [];
  for (const type of SEARCH_GROUP_TYPES.filter((candidate) => input.scope.includes(candidate))) {
    const registered = getSearchGroup(type);
    if (registered === undefined) continue;
    if ("ownerModuleIds" in registered) itemGroups.push(registered);
    else threadGroups.push(registered);
  }
  // A thread group owns the cursor of a scope that is exactly that group; every other cursor is ours. Checked
  // before searching, so a malformed token is refused whoever asks.
  const [onlyType] = input.scope;
  const owner = input.scope.length === 1 ? threadGroups.find((group) => group.type === onlyType) : undefined;
  const cursor = input.cursor === undefined || owner !== undefined ? undefined : decodeCursor(input.cursor);
  if (input.cursor !== undefined && input.scope.length !== 1) {
    throw new ValidationError("cursor requires a scope of exactly one type", { field: "cursor" });
  }
  const threadRuns: Array<{ type: ThreadSearchGroup["type"]; run: ThreadSearchRun }> = threadGroups.map((group) => ({
    type: group.type,
    run: group.prepare(group === owner ? input.cursor : undefined),
  }));
  const buildQuery = (firstParameter: number) => buildItemSearchQuery(input.q, firstParameter);
  const result: SearchGroup[] =
    buildQuery(1).params.length === 0 || (itemGroups.length === 0 && threadRuns.length === 0)
      ? []
      : await withTransaction(
          pool,
          async (client) => {
            const found: SearchGroup[] = [];
            const unreadable =
              input.agentProjectItemId === undefined
                ? new Set<string>()
                : await listUnreadableDatabaseIds(client, input.agentProjectItemId);
            const searchable = await listSearchableDatabases(
              client,
              itemGroups.flatMap((group) => group.ownerModuleIds),
              unreadable,
            );
            const tenantDatabaseIds = await visibleDatabaseIds(client);
            for (const group of itemGroups) {
              const databases = searchable.filter((database) =>
                group.ownerModuleIds.includes(database.owner_module_id),
              );
              if (databases.length === 0) continue;
              const total = await countMatches(
                client,
                databases.map((database) => database.id),
                group.type,
                buildQuery(2),
              );
              if (total === 0) continue;
              const rows = await readPage(client, databases, group.type, input.perGroupLimit, cursor, buildQuery);
              const page = rows.slice(0, input.perGroupLimit);
              const snippets = await readSnippets(
                client,
                databases.map((database) => database.id),
                page.map((row) => row.id),
                buildQuery,
              );
              const subtitles = await buildSubtitleParts(
                client,
                page.map((row) => ({
                  id: row.id,
                  databaseId: row.database_id,
                  moduleId: row.module_id,
                  properties: propertiesSchema.parse(row.properties),
                })),
                tenantDatabaseIds,
                unreadable,
              );
              const lastListed = rows.length > input.perGroupLimit ? page[page.length - 1] : undefined;
              const toResult = (row: SearchPageDbRow): SearchItemResult => ({
                itemId: row.id,
                databaseId: row.database_id,
                databaseKey: row.database_key,
                title: row.title ?? "",
                subtitleParts: subtitles.get(row.id) ?? [],
                snippet: snippets.get(row.id) ?? null,
              });
              const nextCursor =
                lastListed === undefined
                  ? null
                  : encodeCursor({ r: lastListed.rank, u: lastListed.updated_micros, i: lastListed.id });
              const type = group.type;
              if (type === "journal") {
                const items: SearchJournalResult[] = page.map((row) => ({
                  ...toResult(row),
                  journal: journalPeriodSchema.parse(row.properties),
                }));
                found.push({ type, total, items, nextCursor });
              } else {
                found.push({ type, total, items: page.map(toResult), nextCursor });
              }
            }
            for (const { type, run } of threadRuns) {
              const threads = await run(client, {
                q: input.q,
                buildQuery,
                limit: input.perGroupLimit,
                agentProjectItemId: input.agentProjectItemId,
                humanActor: input.humanActor === true,
              });
              if (threads.total > 0) {
                found.push({ type, total: threads.total, items: threads.items, nextCursor: threads.nextCursor });
              }
            }
            return found;
          },
          { isolation: "repeatable_read" },
        );
  logger.info(
    {
      queryLength: input.q.length,
      groupCount: result.length,
      resultCount: result.reduce((sum, group) => sum + group.items.length, 0),
      totalMatches: result.reduce((sum, group) => sum + group.total, 0),
    },
    "Global search completed",
  );
  return { groups: result };
}
