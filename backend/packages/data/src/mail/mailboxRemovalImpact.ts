import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";

/**
 * What removing one mailbox would affect (issue gh-1501). The removal (#1690) soft-deletes the
 * mailbox's folders and messages, as #2029 specifies; the confirmation dialog shows these counts
 * first. The counting rules below are the definition #2029 applies too.
 */
export interface MailboxRemovalImpact {
  /** Non-deleted Emails in one of the mailbox's Folders, except the ones counted as drafts. */
  messages: number;
  /** Non-deleted Emails in one of the mailbox's Drafts folders (`specialPurpose` `drafts`). */
  drafts: number;
  /** Threads whose every non-deleted message is one of this mailbox's messages or drafts. */
  threads: number;
  /** Attachment rows of the counted messages and drafts. The stored files are kept. */
  attachmentsKept: number;
}

interface MailboxRemovalImpactRow {
  messages: number;
  drafts: number;
  threads: number;
  attachmentsKept: number;
}

/**
 * The membership rules of a mailbox removal, as the leading CTEs of a statement whose parameters are `$1`
 * the mailbox item id, `$2` the Folders database id and `$3` the Emails database id. `mailbox_folders`
 * (`id`, `is_drafts`) are the non-deleted Folders related to the mailbox, and `mailbox_emails`
 * (`email_id`, `is_draft`) the non-deleted Emails in any of them, each once. An Email is a draft when
 * one of its folders is a Drafts folder. The relation definitions are found by the property key on the
 * module-owned database, the way migration 0053 finds them. The impact report below and the removal
 * job (`mailboxRemovalJob.ts`, issue gh-2029) both start from this text, so both apply one definition.
 */
export const MAILBOX_REMOVAL_MEMBERS_CTE_SQL = `
WITH mailbox_folders AS (
  SELECT f.id,
         COALESCE(f.properties ->> 'specialPurpose' = 'drafts', false) AS is_drafts
  FROM relation_definitions rd
  JOIN properties p ON p.id IN (rd.property_id_a, rd.property_id_b)
  JOIN item_relations r ON r.relation_definition_id = rd.id
  JOIN items f ON f.database_id = $2::uuid
   AND f.id = CASE WHEN r.item_a = $1::uuid THEN r.item_b ELSE r.item_a END
  WHERE p.database_id = $2::uuid
    AND p.key = 'mailbox'
    AND (r.item_a = $1::uuid OR r.item_b = $1::uuid)
    AND f.deleted_at IS NULL
),
email_folder_relations AS (
  SELECT rd.id
  FROM relation_definitions rd
  JOIN properties p ON p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.database_id = $3::uuid
    AND p.key = 'folder'
),
folder_members AS (
  SELECT CASE WHEN r.item_a = mf.id THEN r.item_b ELSE r.item_a END AS email_id,
         mf.is_drafts
  FROM mailbox_folders mf
  JOIN item_relations r ON (r.item_a = mf.id OR r.item_b = mf.id)
  WHERE r.relation_definition_id IN (SELECT id FROM email_folder_relations)
),
mailbox_emails AS (
  SELECT fm.email_id, bool_or(fm.is_drafts) AS is_draft
  FROM folder_members fm
  JOIN items e ON e.database_id = $3::uuid
   AND e.id = fm.email_id
   AND e.deleted_at IS NULL
  GROUP BY fm.email_id
)`;

/**
 * All four counts in one statement, so they read one snapshot, over the members of
 * `MAILBOX_REMOVAL_MEMBERS_CTE_SQL`. A thread counts when it has a member and no non-deleted message
 * outside `mailbox_emails`.
 */
const MAILBOX_REMOVAL_IMPACT_SQL = `${MAILBOX_REMOVAL_MEMBERS_CTE_SQL},
member_threads AS (
  SELECT DISTINCT meta.thread_id
  FROM mailbox_emails me
  JOIN mail_message_meta meta ON meta.item_id = me.email_id
  WHERE meta.thread_id IS NOT NULL
)
SELECT
  (SELECT count(*) FROM mailbox_emails WHERE NOT is_draft)::int AS messages,
  (SELECT count(*) FROM mailbox_emails WHERE is_draft)::int AS drafts,
  (SELECT count(*)
   FROM member_threads mt
   WHERE NOT EXISTS (
     SELECT 1
     FROM mail_message_meta other
     JOIN items e ON e.database_id = $3::uuid
      AND e.id = other.item_id
      AND e.deleted_at IS NULL
     WHERE other.thread_id = mt.thread_id
       AND other.item_id NOT IN (SELECT email_id FROM mailbox_emails)
   ))::int AS threads,
  (SELECT count(*)
   FROM mail_attachments a
   WHERE a.message_item_id IN (SELECT email_id FROM mailbox_emails))::int AS "attachmentsKept"
`;

/**
 * The counts a removal of `mailboxItemId` would affect, read in the caller's tenant scope. Returns
 * `null` when the mailbox is unknown, belongs to another tenant (row-level security hides it), is
 * already soft-deleted, or the tenant has no Mailboxes database at all. Each answers the same way,
 * as `send.ts` treats a removed mailbox.
 */
export async function getMailboxRemovalImpact(
  client: PoolClient,
  mailboxItemId: string,
): Promise<MailboxRemovalImpact | null> {
  // A tenant without a Mailboxes database has no mailbox, so the answer is the same 404 without
  // resolving the Folders and Emails databases, which such a tenant may not have either.
  const mailboxesDatabase = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
  if (mailboxesDatabase === null) return null;
  const mailbox = await getItemById(client, mailboxesDatabase.id, mailboxItemId);
  if (mailbox === null || mailbox.deletedAt !== null) return null;
  const ids = await resolveMailModuleIds(client);
  const { rows } = await client.query<MailboxRemovalImpactRow>(MAILBOX_REMOVAL_IMPACT_SQL, [
    mailboxItemId,
    ids.foldersDatabaseId,
    ids.emailsDatabaseId,
  ]);
  const counts = requireSingleRow(rows, "mailbox removal impact");
  return {
    messages: counts.messages,
    drafts: counts.drafts,
    threads: counts.threads,
    attachmentsKept: counts.attachmentsKept,
  };
}

interface CustomRouteRequestContext {
  params: Record<string, string>;
}

type CustomRouteResult = { status: number; body: unknown };

/** `items.id` is a uuid: a malformed id names no mailbox, so it gets the same 404 as an unknown one. */
const mailboxIdSchema = z.string().uuid();

/**
 * `GET /api/mail/mailboxes/:id/removal-impact` (issue gh-1501). The lookup runs in the caller's tenant
 * scope, so a foreign mailbox answers exactly like an unknown one: the same `not_found` body.
 */
export function createMailboxRemovalImpactRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const parsedId = mailboxIdSchema.safeParse(ctx.params.id);
    const impact = parsedId.success
      ? await withTransaction(pool, (client) => getMailboxRemovalImpact(client, parsedId.data))
      : null;
    if (impact === null) throw new NotFoundError("Mailbox not found");
    return { status: 200, body: impact };
  };
}
