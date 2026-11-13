import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  SEARCH_ITEM_GROUP_TYPES,
  type SearchGroupType,
  type SearchItemGroup,
  type SearchItemGroupType,
  type SearchItemResult,
  type SearchOutput,
} from "@semprec/shared";
import { listUnreadableDatabaseIds } from "../agentGrants/agentDatabaseAccess.js";
import { visibleDatabaseIds } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import {
  AREAS_MODULE_ID,
  COMPANIES_MODULE_ID,
  EVENTS_MODULE_ID,
  FILES_MODULE_ID,
  JOURNAL_MODULE_ID,
  PEOPLE_MODULE_ID,
  PROJECTS_MODULE_ID,
  TASKS_MODULE_ID,
} from "../seed/tenDatabaseKeys.js";
import { logger } from "./logger.js";
import { buildItemSearchQuery } from "./itemSearchQuery.js";
import { buildSubtitleParts } from "./searchSubtitleParts.js";

// Global search over `item_search_index` (issue #1842). A group is an allow-list of databases by owner module, so a
// database that is not listed here (the inbox pipeline, mailboxes, folders, MCP servers, settings, proposals, the
// Inbox, subpage storage, Health records, Library, Recordings and every user-created collection) is never searched.
// An Inbox entry is found through the text its Journal day holds.

/** The owner modules whose databases each item group searches. The `mail` and `chat` groups are filled by later issues and have no entry yet. */
const GROUP_MODULES: Readonly<Record<SearchItemGroupType, readonly string[]>> = {
  task: [TASKS_MODULE_ID],
  event: [EVENTS_MODULE_ID],
  project: [PROJECTS_MODULE_ID],
  area: [AREAS_MODULE_ID],
  contact: [PEOPLE_MODULE_ID, COMPANIES_MODULE_ID],
  journal: [JOURNAL_MODULE_ID],
  file: [FILES_MODULE_ID],
};

/** A project that belongs to a system module (Email, Personal finance, ...) is infrastructure and is never a result. */
const EXCLUDE_SYSTEM_PROJECTS_SQL = "AND i.properties ->> 'systemActive' IS DISTINCT FROM 'true'";

export interface SearchItemGroupsInput {
  q: string;
  /** The groups to search; the answer follows the fixed order of `SEARCH_GROUP_TYPES`, not this order. */
  scope: readonly SearchGroupType[];
  perGroupLimit: number;
  /** The `nextCursor` of one group; allowed only when `scope` holds exactly that group. */
  cursor?: string;
  /** The Projects item of an agent's run: databases it has no read grant for are not searched. Absent for a person. */
  agentProjectItemId?: string;
}

/** The position of the last result of a page in the order rank, then `updated_at`, then item id. */
const cursorSchema = z
  .object({
    /** `ts_rank_cd` of the item, widened from `real` to a double, which converts back without loss. */
    r: z.number().min(0).max(1e9),
    /** `updated_at` as whole microseconds since the epoch: a JavaScript date has only milliseconds. */
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

/** Every shape the token can take is checked here, so a forged token is a 400 and never reaches the database. */
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

const propertiesSchema = z.record(z.string(), z.unknown());

/** The unarchived databases of the requested modules that the actor may read, each with the key of its title property. */
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

/** How many live items of the group's databases match, whatever the page or the cursor. */
async function countMatches(
  client: PoolClient,
  databaseIds: readonly string[],
  group: SearchItemGroupType,
  tsquery: { sql: string; params: string[] },
): Promise<number> {
  const { rows } = await client.query<CountDbRow>(
    `SELECT count(*)::int AS total
     FROM item_search_index s
     JOIN items i ON i.database_id = s.database_id AND i.id = s.item_id
     WHERE s.database_id = ANY($1::uuid[]) AND i.database_id = ANY($1::uuid[]) AND i.deleted_at IS NULL
       AND s.search_vector @@ ${tsquery.sql}
       ${group === "project" ? EXCLUDE_SYSTEM_PROJECTS_SQL : ""}`,
    [databaseIds, ...tsquery.params],
  );
  return rows[0]?.total ?? 0;
}

/** One page of the group, one row more than `limit` so the caller can tell whether another page follows. */
async function readPage(
  client: PoolClient,
  databases: readonly SearchableDatabaseDbRow[],
  group: SearchItemGroupType,
  limit: number,
  cursor: SearchCursor | undefined,
  buildQuery: (firstParameter: number) => { sql: string; params: string[] },
): Promise<SearchPageDbRow[]> {
  const tsquery = buildQuery(9);
  const { rows } = await client.query<SearchPageDbRow>(
    `WITH matches AS (
       SELECT i.id, i.database_id, db.module_id, db.database_key, i.properties, i.properties ->> db.title_key AS title,
         ts_rank_cd(s.search_vector, ${tsquery.sql})::float8 AS rank,
         (extract(epoch FROM i.updated_at) * 1000000)::bigint AS updated_micros
       FROM item_search_index s
       JOIN items i ON i.database_id = s.database_id AND i.id = s.item_id
       JOIN unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) AS db(id, title_key, database_key, module_id)
         ON db.id = i.database_id
       WHERE s.database_id = ANY($1::uuid[]) AND i.database_id = ANY($1::uuid[]) AND i.deleted_at IS NULL
         AND s.search_vector @@ ${tsquery.sql}
         ${group === "project" ? EXCLUDE_SYSTEM_PROJECTS_SQL : ""}
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
    ],
  );
  return rows;
}

/**
 * Searches the caller tenant's tasks, events, projects, areas, contacts, journal days and files for `input.q`, one
 * group per type of `input.scope`, in the fixed order of `SEARCH_GROUP_TYPES`; a group without a match is omitted.
 * The tenant is the ambient one (`runInTenant`), as for every data function. The whole answer is read in one
 * repeatable-read transaction, so a group's `total` and its page come from the same snapshot.
 *
 * A group's `total` counts every match, even when `items` holds only `perGroupLimit` of them. Matches are ordered by
 * `ts_rank_cd` (best first), then `updated_at` (newest first), then item id, and `nextCursor` is the opaque token of
 * the last listed match, or `null` when nothing follows. Items in the trash, projects with `systemActive`, items of
 * an archived database and, for an agent (`agentProjectItemId`), items of a database it has no read grant for are
 * never found. A query with no searchable word, and the `mail` and `chat` groups (which later issues fill), match
 * nothing. `q` is bound as a parameter and is never logged; only its length and the counts of the answer are.
 *
 * Throws a `ValidationError` for a `cursor` that is not in the shape this function issues, and for a `cursor` with a
 * scope of more or fewer than one group.
 */
export async function searchItemGroups(pool: Pool, input: SearchItemGroupsInput): Promise<SearchOutput> {
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (cursor !== undefined && input.scope.length !== 1) {
    throw new ValidationError("cursor requires a scope of exactly one type", { field: "cursor" });
  }
  const groups = SEARCH_ITEM_GROUP_TYPES.filter((type) => input.scope.includes(type));
  const buildQuery = (firstParameter: number) => buildItemSearchQuery(input.q, firstParameter);
  const result: SearchItemGroup[] =
    buildQuery(1).params.length === 0 || groups.length === 0
      ? []
      : await withTransaction(
          pool,
          async (client) => {
            const unreadable =
              input.agentProjectItemId === undefined
                ? new Set<string>()
                : await listUnreadableDatabaseIds(client, input.agentProjectItemId);
            const searchable = await listSearchableDatabases(
              client,
              groups.flatMap((group) => GROUP_MODULES[group]),
              unreadable,
            );
            const tenantDatabaseIds = await visibleDatabaseIds(client);
            const found: SearchItemGroup[] = [];
            for (const group of groups) {
              const databases = searchable.filter((database) =>
                GROUP_MODULES[group].includes(database.owner_module_id),
              );
              if (databases.length === 0) continue;
              const total = await countMatches(
                client,
                databases.map((database) => database.id),
                group,
                buildQuery(2),
              );
              if (total === 0) continue;
              const rows = await readPage(client, databases, group, input.perGroupLimit, cursor, buildQuery);
              const page = rows.slice(0, input.perGroupLimit);
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
              // The extra row `readPage` asks for says another page follows; the cursor is the last listed match.
              const lastListed = rows.length > input.perGroupLimit ? page[page.length - 1] : undefined;
              const items: SearchItemResult[] = page.map((row) => ({
                itemId: row.id,
                databaseId: row.database_id,
                databaseKey: row.database_key,
                title: row.title ?? "",
                subtitleParts: subtitles.get(row.id) ?? [],
                snippet: null,
              }));
              found.push({
                type: group,
                total,
                items,
                nextCursor:
                  lastListed === undefined
                    ? null
                    : encodeCursor({ r: lastListed.rank, u: lastListed.updated_micros, i: lastListed.id }),
              });
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
