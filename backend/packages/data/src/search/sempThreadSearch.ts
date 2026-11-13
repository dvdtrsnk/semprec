import type { PoolClient } from "pg";
import type { SearchThreadResult } from "@semprec/shared";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { getCalendarClock } from "../calendarTime.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import {
  loadSempThreadTitleResolver,
  parseSempThreadListCursor,
  SEMP_THREAD_KINDS,
  type SempThreadListCursor,
} from "../semp/sempThreadsListStore.js";
import type { ThreadSearchGroup } from "./searchGroupRegistry.js";

// The `chat` group of global search (issue #1854): the user's Semp conversations found by title or preview. A thread
// is not an item, so it has no row in `item_search_index`; the combined query of `buildItemSearchQuery` is applied to
// the two short texts of each thread on the fly, which is cheap because a user has few threads.

/**
 * The thread kinds the group searches: the ones the thread list shows by default. A tick thread is the log of an
 * automatic task, which the list hides unless it is asked for, so search hides it too.
 */
const SEARCHED_KINDS: readonly string[] = ["chat", "item"];

/** The preview window of the thread list (issue #1737): the first code points of the stored text of the previewed message. */
const PREVIEW_CODE_POINTS = 140;

/**
 * How much of a title is searched, in code points from its start. An item thread is titled by the text of its Inbox
 * item, which nothing short bounds, and Postgres refuses a tsvector above 1 MiB, which would fail the whole search.
 */
const TITLE_SEARCH_MAX_CODE_POINTS = 1000;

/** The current `text` of the joined Inbox item `subject`, null unless it is a JSON string; the same rule as the thread list. */
const SUBJECT_TEXT_SQL = `CASE WHEN jsonb_typeof(subject.properties -> 'text') = 'string'
                 THEN subject.properties ->> 'text' END`;

/** `users.locale` of a tenant without a bound user: the column default. */
const FALLBACK_LOCALE = "cs";

/**
 * The tsquery of the search text as the shared builder produces it, with its bind values; `buildQuery(n)` numbers
 * the parameters from `$n`.
 */
export type ThreadSearchQueryBuilder = (firstParameter: number) => { sql: string; params: string[] };

export interface SempThreadSearchInput {
  buildQuery: ThreadSearchQueryBuilder;
  /** The most threads returned. */
  limit: number;
  /** The `nextCursor` of an earlier page, as the thread list issues it, already parsed by `parseSempThreadListCursor`. */
  cursor?: SempThreadListCursor;
}

export interface SempThreadSearchPage {
  /** Every matching thread, whatever the page or the cursor. */
  total: number;
  items: SearchThreadResult[];
  nextCursor: string | null;
}

interface ThreadMatchDbRow {
  id: string;
  kind: string;
  title: string | null;
  subject_text: string | null;
  last_activity_at: Date;
  activity_cursor: string;
}

interface CountDbRow {
  total: number;
}

/** True when the combined `czech` and `czech_simple` vector of the text, a fixed SQL fragment, matches the tsquery. */
function vectorMatches(textSql: string, tsquerySql: string): string {
  return `(to_tsvector('czech', coalesce(${textSql}, '')) || to_tsvector('czech_simple', coalesce(${textSql}, ''))) @@ ${tsquerySql}`;
}

/**
 * The part of the statements after the select list. `$1` is the searched kinds and `$2` the Inbox database id, which
 * an item thread needs to read its subject. A thread matches when the words of the query are found, by
 * lemma or as a prefix, in what its title is resolved from or in the preview window, each taken alone as the thread
 * list does. Every table read is a tenant table, so only the caller's tenant is seen.
 */
function matchingThreadsSql(tsquerySql: string): string {
  return `FROM semp_threads t
     LEFT JOIN items subject ON subject.tenant_id = t.tenant_id AND subject.database_id = $2::uuid
            AND subject.id = t.subject_inbox_item_id AND subject.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT left(m.text, ${PREVIEW_CODE_POINTS}) AS text
         FROM semp_messages m
        WHERE m.tenant_id = t.tenant_id AND m.thread_id = t.id
          AND (m.text IS NOT NULL OR m.system_key IS NOT NULL)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
     ) last_message ON true
     CROSS JOIN LATERAL (
       SELECT left(CASE t.kind WHEN 'chat' THEN t.title ELSE ${SUBJECT_TEXT_SQL} END, ${TITLE_SEARCH_MAX_CODE_POINTS}) AS text
     ) searched_title
     WHERE t.kind = ANY($1::text[])
       AND (${vectorMatches("searched_title.text", tsquerySql)} OR ${vectorMatches("last_message.text", tsquerySql)})`;
}

/**
 * One page of the tenant's chat and Inbox item threads that match the query, newest activity first (the order of the
 * thread list), with the real `total`. Runs in the caller's transaction and tenant scope, and writes nothing. The
 * query must have at least one searchable word; the caller checks that. A thread result carries its title, resolved
 * as the thread list resolves it in the user's locale (an empty string when the thread has none), and the date and
 * time of its last activity in the user's time zone as `date` and `time` parts. `snippet` is `null`.
 *
 * `cursor` is the parsed `nextCursor` of an earlier page, in the format of the thread list's cursor (the last
 * thread's `last_activity_at` with microseconds, and its id). The caller parses the token (`sempThreadSearchGroup.prepare`
 * does), so that a token of another shape is refused whether or not this group is searched.
 */
export async function searchSempThreads(
  client: PoolClient,
  input: SempThreadSearchInput,
): Promise<SempThreadSearchPage> {
  const cursor = input.cursor ?? null;
  const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
  const inboxId = inbox?.id ?? null;
  const countQuery = input.buildQuery(3);
  const { rows: counted } = await client.query<CountDbRow>(
    `SELECT count(*)::int AS total ${matchingThreadsSql(countQuery.sql)}`,
    [[...SEARCHED_KINDS], inboxId, ...countQuery.params],
  );
  const total = counted[0]?.total ?? 0;
  if (total === 0) return { total, items: [], nextCursor: null };

  const pageQuery = input.buildQuery(6);
  const { rows } = await client.query<ThreadMatchDbRow>(
    `SELECT t.id, t.kind, t.title, ${SUBJECT_TEXT_SQL} AS subject_text, t.last_activity_at,
            to_char(t.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activity_cursor
     ${matchingThreadsSql(pageQuery.sql)}
       AND ($3::timestamptz IS NULL OR (t.last_activity_at, t.id) < ($3::timestamptz, $4::uuid))
     ORDER BY t.last_activity_at DESC, t.id DESC
     LIMIT $5`,
    [
      [...SEARCHED_KINDS],
      inboxId,
      cursor?.lastActivityAt ?? null,
      cursor?.id ?? null,
      input.limit + 1,
      ...pageQuery.params,
    ],
  );
  const page = rows.slice(0, input.limit);
  if (page.length === 0) return { total, items: [], nextCursor: null };

  const resolveTitle = await loadSempThreadTitleResolver((await getTenantUserLocale(client)) ?? FALLBACK_LOCALE);
  const clock = await getCalendarClock(client);
  const items = page.map((row): SearchThreadResult => {
    const activity = clock.instantToWallClock(row.last_activity_at);
    return {
      threadId: row.id,
      title:
        resolveTitle({
          kind: assertKnownValue(SEMP_THREAD_KINDS, row.kind, "thread kind"),
          title: row.title,
          heartbeatName: null,
          subjectText: row.subject_text,
        }) ?? "",
      subtitleParts: [
        { kind: "date", value: activity.date },
        { kind: "time", value: activity.time },
      ],
      snippet: null,
    };
  });
  const lastListed = rows.length > input.limit ? page[page.length - 1] : undefined;
  return {
    total,
    items,
    nextCursor:
      lastListed === undefined
        ? null
        : Buffer.from(`${lastListed.activity_cursor}|${lastListed.id}`).toString("base64url"),
  };
}

/**
 * The `chat` group as the search registry holds it. `prepare` parses a token with `parseSempThreadListCursor`, which
 * refuses a malformed one with a `ValidationError` naming `cursor`. The run searches the Semp threads for a person
 * only: Semp conversations belong to the user and are part of no database an agent or an MCP client is granted, so
 * for any other actor it answers an empty page and reads nothing.
 */
export const sempThreadSearchGroup: ThreadSearchGroup = {
  type: "chat",
  prepare(cursor) {
    const parsed = cursor === undefined ? undefined : parseSempThreadListCursor(cursor);
    return async (client, request) =>
      request.humanActor
        ? searchSempThreads(client, { buildQuery: request.buildQuery, limit: request.limit, cursor: parsed })
        : { total: 0, items: [], nextCursor: null };
  },
};
