import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import type { CustomRouteResult, RouteParams } from "../customRoute.js";

/** What removing one mailbox would affect; the confirmation dialog shows these counts. */
export interface MailboxRemovalImpact {
  /** Non-deleted Emails of the mailbox (`MAILBOX_REMOVAL_MEMBERS_CTE_SQL`), drafts excluded. */
  messages: number;
  drafts: number;
  /** Threads whose every non-deleted message is one of this mailbox's. */
  threads: number;
  /** The stored files are kept. */
  attachmentsKept: number;
}

interface MailboxRemovalImpactRow {
  messages: number;
  drafts: number;
  threads: number;
  attachmentsKept: number;
}

/**
 * Leading CTEs (`$1` mailbox id, `$2` Folders db, `$3` Emails db) defining the removal's members. The
 * impact report and the removal job both start from this text, so both apply one definition. An Email
 * is a draft when one of its folders is a Drafts folder.
 *
 * Members are the Emails in the mailbox's live Folders, and the Emails of the mailbox whose last folder copy an IMAP
 * pass removed (`folder_copy_removed_at`) before a pass decided them: those have no edge to any live Folder, so only
 * their meta row still names the mailbox.
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
folderless_members AS (
  SELECT meta.item_id AS email_id, false AS is_drafts
  FROM mail_message_meta meta
  WHERE meta.tenant_id = app_tenant_default()
    AND meta.mailbox_item_id = $1::uuid
    AND meta.folder_copy_removed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM item_relations r
      JOIN items f ON f.database_id = $2::uuid
       AND f.id = CASE WHEN r.item_a = meta.item_id THEN r.item_b ELSE r.item_a END
       AND f.deleted_at IS NULL
      WHERE r.relation_definition_id IN (SELECT id FROM email_folder_relations)
        AND (r.item_a = meta.item_id OR r.item_b = meta.item_id)
    )
),
mailbox_emails AS (
  SELECT m.email_id, bool_or(m.is_drafts) AS is_draft
  FROM (SELECT email_id, is_drafts FROM folder_members
        UNION ALL
        SELECT email_id, is_drafts FROM folderless_members) m
  JOIN items e ON e.database_id = $3::uuid
   AND e.id = m.email_id
   AND e.deleted_at IS NULL
  GROUP BY m.email_id
)`;

/** One statement, so the counts read one snapshot. */
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

/** `null` for an unknown, foreign (hidden by RLS) or soft-deleted mailbox, or no Mailboxes database. */
export async function getMailboxRemovalImpact(
  client: PoolClient,
  mailboxItemId: string,
): Promise<MailboxRemovalImpact | null> {
  // Such a tenant may not have the Folders and Emails databases either.
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

/** A malformed id gets the same 404 as an unknown one. */
const mailboxIdSchema = z.string().uuid();

/** A foreign mailbox answers exactly like an unknown one. */
export function createMailboxRemovalImpactRouteHandler(pool: Pool) {
  return async (ctx: RouteParams): Promise<CustomRouteResult> => {
    const parsedId = mailboxIdSchema.safeParse(ctx.params.id);
    const impact = parsedId.success
      ? await withTransaction(pool, (client) => getMailboxRemovalImpact(client, parsedId.data))
      : null;
    if (impact === null) throw new NotFoundError("Mailbox not found");
    return { status: 200, body: impact };
  };
}
