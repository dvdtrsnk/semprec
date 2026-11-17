import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { mailThreadCopyCtes } from "./mailThreadListQuery.js";
import { mailThreadPredicates } from "./mailThreadPredicates.js";

/** The counts the Overview, the Profile and the mailbox sidebar show. */
interface MailSummary {
  /** Threads the default list shows with `unread=true`: in an inbox folder and unread. */
  unreadInbox: number;
  flagged: number;
  sempDrafts: number;
  accounts: number;
  accountsNeedingReauth: Array<{ id: string; name: string }>;
}

const summaryRow = z.object({
  unreadInbox: z.number().int(),
  flagged: z.number().int(),
  sempDrafts: z.number().int(),
  accounts: z.number().int(),
  accountsNeedingReauth: z.array(z.object({ id: z.uuid(), name: z.string() })),
});

/**
 * One statement, so every count reads the same snapshot. Thread counts use the thread list's own CTEs (`$1` null:
 * list mode, drafts left out) and predicates, so each equals what the list returns for the same filter.
 */
const MAIL_SUMMARY_SQL = `
WITH ${mailThreadCopyCtes(1)}, thread_counts AS (
  SELECT count(*) FILTER (WHERE ${mailThreadPredicates.inbox} AND ${mailThreadPredicates.unread})::int AS unread_inbox,
         count(*) FILTER (WHERE ${mailThreadPredicates.flagged})::int AS flagged,
         count(*) FILTER (WHERE ${mailThreadPredicates.sempDrafts})::int AS semp_drafts
  FROM copy_stats cs CROSS JOIN LATERAL (SELECT cs.thread_id) l
), mailbox_items AS (
  SELECT i.id, COALESCE(i.properties->>'name', '') AS name, i.properties->>'syncStatus' AS sync_status
  FROM items i
  WHERE i.tenant_id = app_tenant_default() AND i.database_id = (SELECT mailboxes FROM schema_ids)
    AND i.deleted_at IS NULL
)
SELECT tc.unread_inbox AS "unreadInbox", tc.flagged, tc.semp_drafts AS "sempDrafts",
  (SELECT count(*) FROM mailbox_items)::int AS accounts,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', mb.id, 'name', mb.name) ORDER BY mb.id), '[]'::jsonb)
   FROM mailbox_items mb WHERE mb.sync_status = 'needsReauthorization') AS "accountsNeedingReauth"
FROM thread_counts tc
`;

/** Row-level security and the tenant filters confine every count to the caller's tenant. */
export async function getMailSummary(client: PoolClient): Promise<MailSummary> {
  const { rows } = await client.query<Record<string, unknown>>(MAIL_SUMMARY_SQL, [null]);
  const row = summaryRow.parse(requireSingleRow(rows, "mail summary"));
  return {
    unreadInbox: row.unreadInbox,
    flagged: row.flagged,
    sempDrafts: row.sempDrafts,
    accounts: row.accounts,
    accountsNeedingReauth: row.accountsNeedingReauth,
  };
}

/** `GET /api/mail/summary`. */
export function createMailSummaryRouteHandler(pool: Pool) {
  return async (): Promise<{ status: number; body: MailSummary }> => ({
    status: 200,
    body: await withTransaction(pool, (client) => getMailSummary(client)),
  });
}
