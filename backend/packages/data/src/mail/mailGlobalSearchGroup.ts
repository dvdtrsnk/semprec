import type { PoolClient } from "pg";
import type { SearchMailResult } from "@semprec/shared";
import { listUnreadableDatabaseIds } from "../agentGrants/agentDatabaseAccess.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { buildItemSearchQuery } from "../search/itemSearchQuery.js";
import type { ThreadSearchGroup, ThreadSearchPage } from "../search/searchGroupRegistry.js";
import { buildSearchSnippetSql } from "../search/searchSnippet.js";
import { htmlToPlainText } from "./mailPlainText.js";
import {
  hasInvalidMailSearchDate,
  MAIL_SEARCH_MESSAGES_CTE,
  mailThreadCopyCtes,
  parseMailThreadListCursor,
} from "./mailThreadListQuery.js";
import { matchesSearch } from "./mailThreadPredicates.js";
import { parseMailSearchQuery, type ParsedMailSearchQuery } from "./search.js";

// The `mail` group of global search (issue #1864): the tenant's mail threads that match the search text, one entry per
// thread however many of its messages match. The matching is the thread search of `GET /api/mail/threads?q=`
// (`matchesSearch`, issue #1639), so the text, `from:`, `has:attachment`, `before:`, `after:` and `is:` operators of the
// group's text mean what they mean there. It registers as a thread group (`search/searchGroupRegistry.ts`), which the
// composition root `domainWriteHooks.ts` does.

const emptyPage = (): ThreadSearchPage => ({ total: 0, items: [], nextCursor: null });

/** The longest `snippet` of a search result, in characters (the contract of `SearchOutputSchema`). */
const SNIPPET_MAX_CHARS = 160;

/**
 * How much of a message body is read to build an excerpt, in characters from its start. A body is not bounded by
 * anything short, and only the page's threads are read.
 */
const SNIPPET_SOURCE_MAX_CHARS = 200_000;

/**
 * How many messages of one thread are read as candidates for its excerpt, newest first. A candidate is a message whose
 * body holds the words as stored; only a body whose markup holds a word that its plain text does not (a search for
 * `style` or `href`) fails the second test, so the first candidate yields the excerpt in practice, and the bound keeps
 * a thread of hundreds of messages from reading all of their bodies.
 */
const SNIPPET_CANDIDATES_PER_THREAD = 5;

/** The timestamp format of the thread list's `lastMessageAt` and of its cursor: UTC with microseconds. */
const INSTANT_SQL = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

interface EmailsDatabaseDbRow {
  id: string;
  database_key: string;
}

interface CountDbRow {
  total: number;
}

interface ThreadDbRow {
  thread_id: string;
  item_id: string;
  subject: string;
  last_message_at: string;
  sender_name: string;
  sender_address: string;
  person_id: string | null;
  person_database_id: string | null;
  preview_text: string | null;
}

interface SnippetSourceDbRow {
  thread_id: string;
  body: string | null;
}

interface SnippetDbRow {
  ordinal: number;
  thread_id: string;
  snippet: string | null;
}

/**
 * True when the query carries nothing to match on: no text and no operator that is a condition. `has:` with a value
 * other than `attachment` is removed from the text and is no condition, and `matchesSearch` of such a query would match
 * every message.
 */
function hasNoCondition(search: ParsedMailSearchQuery): boolean {
  return (
    search.freeText === "" &&
    search.from === undefined &&
    search.hasAttachment === undefined &&
    search.before === undefined &&
    search.after === undefined &&
    search.read === undefined &&
    search.flagged === undefined
  );
}

/**
 * The first `SNIPPET_MAX_CHARS` code points of the text with its whitespace collapsed, or null when nothing is left. A
 * code point is never split, so a result never ends in half a surrogate pair.
 */
function toSnippet(text: string | null): string | null {
  const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;
  return Array.from(collapsed).slice(0, SNIPPET_MAX_CHARS).join("");
}

/**
 * The statement prefix both reads share: the thread list's copy CTEs and search messages, then `matched`, one row per
 * matching thread, which is the thread's last message (the newest live copy, drafts left out as the list does). A
 * thread is searched when it has a message outside Junk and Trash, the rule of the flagged box, and when any of its
 * live messages satisfies the search. `$1` is the thread filter of the copy CTEs and is always null here.
 */
function matchedThreadsSql(searchSql: string): string {
  return `WITH ${mailThreadCopyCtes(1)}, ${MAIL_SEARCH_MESSAGES_CTE}, latest AS (
  SELECT DISTINCT ON (c.thread_id) c.thread_id, c.item_id, c.subject, c.envelope, c.preview_text, c.activity
  FROM copies c ORDER BY c.thread_id, c.activity DESC NULLS LAST, c.item_id DESC
), matched AS (
  SELECT l.* FROM latest l
  WHERE EXISTS (SELECT 1 FROM copies c WHERE c.thread_id = l.thread_id AND c.has_non_junk)
    AND ${searchSql}
)`;
}

/**
 * The Emails database of the tenant, unless it is archived or the actor may not read it, as the item groups decide, and
 * the databases the actor may not read, which the sender part must not link into. A person has none unreadable.
 */
async function readableEmailsDatabase(
  client: PoolClient,
  agentProjectItemId: string | undefined,
): Promise<{ emails: EmailsDatabaseDbRow; unreadable: ReadonlySet<string> } | null> {
  const { rows } = await client.query<EmailsDatabaseDbRow>(
    `SELECT d.id, COALESCE(d.key, d.owner_module_id) AS database_key
     FROM databases d WHERE d.owner_module_id = $1 AND d.system AND d.archived_at IS NULL`,
    [EMAILS_MODULE_ID],
  );
  const emails = rows[0];
  if (emails === undefined) return null;
  if (agentProjectItemId === undefined) return { emails, unreadable: new Set() };
  const unreadable = await listUnreadableDatabaseIds(client, agentProjectItemId);
  return unreadable.has(emails.id) ? null : { emails, unreadable };
}

/**
 * The excerpt of each listed thread: the fragment, around the words of the search text, of the newest live message
 * whose body itself contains those words (`buildSearchSnippetSql`, the rule of the item groups: no excerpt when the
 * body does not contain the words). A message that is in the search index only through its subject, its sender or an
 * attachment is no source, however new it is. The candidates are the thread's messages whose stored body holds the
 * words, newest first and at most `SNIPPET_CANDIDATES_PER_THREAD` of them; their bodies are converted to plain text,
 * and the first whose plain text holds the words gives the excerpt. A thread without such a message has no entry in the
 * answer.
 */
async function readMatchingFragments(
  client: PoolClient,
  emailsDatabaseId: string,
  threadIds: readonly string[],
  freeText: string,
): Promise<Map<string, string>> {
  const tsquery = buildItemSearchQuery(freeText, 5);
  if (tsquery.params.length === 0) return new Map();
  const { rows: sources } = await client.query<SnippetSourceDbRow>(
    `SELECT ranked.thread_id, ranked.body FROM (
       SELECT c.thread_id, c.body,
         row_number() OVER (PARTITION BY c.thread_id ORDER BY c.at DESC NULLS LAST, c.item_id DESC) AS candidate_rank
       FROM (
         SELECT m.thread_id, m.item_id, left(i.properties->>'body', $3) AS body,
           COALESCE(NULLIF(i.properties->>'date', '')::timestamptz, m.ingested_at, i.updated_at) AS at
         FROM mail_message_meta m
         JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id AND i.database_id = $2::uuid AND i.deleted_at IS NULL
         JOIN item_search_index s ON s.tenant_id = m.tenant_id AND s.item_id = m.item_id AND s.database_id = $2::uuid
         WHERE m.tenant_id = app_tenant_default() AND m.thread_id = ANY($1::uuid[]) AND s.search_vector @@ ${tsquery.sql}
       ) c
       WHERE c.body IS NOT NULL AND (to_tsvector('czech', c.body) || to_tsvector('czech_simple', c.body)) @@ ${tsquery.sql}
     ) ranked
     WHERE ranked.candidate_rank <= $4
     ORDER BY ranked.thread_id, ranked.candidate_rank`,
    [[...threadIds], emailsDatabaseId, SNIPPET_SOURCE_MAX_CHARS, SNIPPET_CANDIDATES_PER_THREAD, ...tsquery.params],
  );
  const texts = sources.flatMap((row) =>
    row.body === null ? [] : [{ id: row.thread_id, text: htmlToPlainText(row.body) }],
  );
  if (texts.length === 0) return new Map();
  const excerptQuery = buildItemSearchQuery(freeText, 3);
  const { rows } = await client.query<SnippetDbRow>(
    `SELECT t.ordinal::int AS ordinal, t.thread_id, ${buildSearchSnippetSql(excerptQuery, 3)} AS snippet
     FROM unnest($1::uuid[], $2::text[]) WITH ORDINALITY AS t(thread_id, body, ordinal)
     ORDER BY t.ordinal`,
    [texts.map((entry) => entry.id), texts.map((entry) => entry.text), ...excerptQuery.params],
  );
  const fragments = new Map<string, string>();
  for (const row of rows) {
    if (fragments.has(row.thread_id)) continue;
    const snippet = toSnippet(row.snippet);
    if (snippet !== null) fragments.set(row.thread_id, snippet);
  }
  return fragments;
}

/**
 * One page of the tenant's mail threads that match `search`, newest last message first (the order of the thread list),
 * with the real `total`, in the caller's transaction and tenant scope. Writes nothing. `cursor` is the parsed
 * `nextCursor` of an earlier page.
 */
async function searchMailThreads(
  client: PoolClient,
  emails: EmailsDatabaseDbRow,
  unreadableDatabaseIds: ReadonlySet<string>,
  search: ParsedMailSearchQuery,
  limit: number,
  cursor: { at: string; id: string } | undefined,
): Promise<ThreadSearchPage> {
  const counting = matchesSearch(search, 2);
  const { rows: counted } = await client.query<CountDbRow>(
    `${matchedThreadsSql(counting.sql)} SELECT count(*)::int AS total FROM matched`,
    [null, ...counting.params],
  );
  const total = counted[0]?.total ?? 0;
  if (total === 0) return emptyPage();

  const paging = matchesSearch(search, 5);
  const { rows } = await client.query<ThreadDbRow>(
    `${matchedThreadsSql(paging.sql)}
     SELECT m.thread_id, m.item_id, m.subject, to_char(m.activity AT TIME ZONE 'UTC', ${INSTANT_SQL}) AS last_message_at,
       COALESCE(m.envelope->'from'->>'name', '') AS sender_name, COALESCE(m.envelope->'from'->>'address', '') AS sender_address,
       person.id AS person_id, person.database_id AS person_database_id, m.preview_text
     FROM matched m
     LEFT JOIN person_email_index pei ON pei.tenant_id = app_tenant_default()
       AND pei.email = lower(btrim(m.envelope->'from'->>'address', E' \\t\\n\\r'))
     LEFT JOIN items person ON person.tenant_id = app_tenant_default() AND person.id = pei.item_id AND person.deleted_at IS NULL
       AND person.database_id = (SELECT people FROM schema_ids)
     WHERE $2::timestamptz IS NULL OR (m.activity, m.thread_id) < ($2::timestamptz, $3::uuid)
     ORDER BY m.activity DESC NULLS LAST, m.thread_id DESC
     LIMIT $4`,
    [null, cursor?.at ?? null, cursor?.id ?? null, limit + 1, ...paging.params],
  );
  const page = rows.slice(0, limit);
  const fragments = await readMatchingFragments(
    client,
    emails.id,
    page.map((row) => row.thread_id),
    search.freeText,
  );
  const items = page.map((row): SearchMailResult => {
    const senderName = row.sender_name === "" ? row.sender_address : row.sender_name;
    return {
      threadId: row.thread_id,
      itemId: row.item_id,
      databaseId: emails.id,
      databaseKey: emails.database_key,
      title: row.subject,
      subtitleParts: [
        ...(senderName === ""
          ? []
          : [
              {
                kind: "sender" as const,
                value: senderName,
                ...(row.person_id === null ||
                (row.person_database_id !== null && unreadableDatabaseIds.has(row.person_database_id))
                  ? {}
                  : { itemId: row.person_id }),
              },
            ]),
        { kind: "date" as const, value: row.last_message_at },
      ],
      snippet: fragments.get(row.thread_id) ?? toSnippet(row.preview_text),
    };
  });
  const lastListed = rows.length > limit ? page[page.length - 1] : undefined;
  return {
    total,
    items,
    nextCursor:
      lastListed === undefined
        ? null
        : Buffer.from(JSON.stringify({ at: lastListed.last_message_at, id: lastListed.thread_id })).toString(
            "base64url",
          ),
  };
}

/**
 * The `mail` group as the search registry holds it. `prepare` parses a token with `parseMailThreadListCursor`, the
 * token of the thread list's `nextCursor`, which refuses a malformed one with a `ValidationError` naming `cursor`.
 *
 * The group's text is parsed as the thread list parses `q`, with the contradictory operators (`is:read is:unread`)
 * matching nothing. A text that is no condition (`has:` with another value than `attachment` and nothing else) and a
 * `before:` or `after:` that is not an ISO date or date-time match nothing too, where the thread list answers the
 * second with a 400: a search over every group must not fail as a whole for the operator of one of them. An agent run
 * is given the group only when its project may read the Emails database, and the group is empty for an archived Emails
 * database, as the item groups are.
 *
 * An entry is one thread, represented by the Emails item of its last message. The thread's `snippet` is the fragment of
 * the newest message whose own text contains the words of the search text (not one that is found only through its
 * subject or sender), or the preview of the last message when no message does (or the search has no words, only
 * operators). The date part is the thread's `lastMessageAt`, the instant of the thread list. The sender part carries the
 * People item of the sender as `itemId` only when the actor may read the People database: an agent run whose project
 * may not has the sender's name from the Emails envelope and no link, as the item groups show no link into an
 * unreadable database.
 */
export const mailGlobalSearchGroup: ThreadSearchGroup = {
  type: "mail",
  prepare(cursor) {
    const parsedCursor = cursor === undefined ? undefined : parseMailThreadListCursor(cursor);
    return async (client, request) => {
      const search = parseMailSearchQuery(request.q, true);
      if (search.contradictory === true || hasNoCondition(search) || hasInvalidMailSearchDate(search)) {
        return emptyPage();
      }
      const readable = await readableEmailsDatabase(client, request.agentProjectItemId);
      if (readable === null) return emptyPage();
      return searchMailThreads(client, readable.emails, readable.unreadable, search, request.limit, parsedCursor);
    };
  },
};
