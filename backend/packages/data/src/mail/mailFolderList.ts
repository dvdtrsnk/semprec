import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { toManifestLocale, type ManifestLocale } from "../manifest/catalogResolution.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { mailThreadCopyCtes } from "./mailThreadListQuery.js";
import { mailThreadPredicates } from "./mailThreadPredicates.js";

/**
 * The special purposes whose folders the list puts first, in this order (issue gh-1689). Such a
 * folder is named by the catalog entry `mail.folder.<specialPurpose>` instead of the name the provider
 * gave it. Every other folder follows, by its own name. A folder whose `specialPurpose` is `all` is
 * not listed at all.
 */
const SYSTEM_FOLDER_ORDER = ["inbox", "sent", "drafts", "archive", "junk", "trash"] as const;

const folderRow = z.object({
  id: z.uuid(),
  name: z.string(),
  specialPurpose: z.string(),
  behavior: z.string().nullable(),
  unreadCount: z.number().int(),
  totalCount: z.number().int(),
});

type MailFolder = z.infer<typeof folderRow>;

/**
 * Every listed folder of the mailbox `$1` with both counts, in one statement. `mailbox_folders` are
 * the non-deleted Folders related to the mailbox through `Folders.mailbox`, without the `all` folder.
 * `unreadCount` counts threads over the thread list's own `copies` and `copy_stats`
 * (`mailThreadCopyCtes`, with `$2` null: the list mode) with the list's `unread` predicate and its
 * `inFolder` predicate for the folder row (`inFolderRow`), so it equals the number of threads
 * `GET /api/mail/threads?folderId=<id>&unread=true` returns. `totalCount` counts the non-deleted
 * Emails items linked to the folder, drafts included.
 */
const MAIL_FOLDER_LIST_SQL = `
WITH ${mailThreadCopyCtes(2)}, mailbox_folders AS (
  SELECT f.id, COALESCE(f.properties->>'name', '') AS name,
    COALESCE(f.properties->>'specialPurpose', 'none') AS special_purpose,
    f.properties->>'behavior' AS behavior
  FROM properties p
  JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  JOIN item_relations r ON r.tenant_id = p.tenant_id AND r.relation_definition_id = rd.id
    AND (CASE WHEN rd.property_id_a = p.id THEN r.item_b ELSE r.item_a END) = $1::uuid
  JOIN items f ON f.tenant_id = p.tenant_id AND f.database_id = (SELECT folders FROM schema_ids)
    AND f.id = CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END AND f.deleted_at IS NULL
  WHERE p.tenant_id = app_tenant_default() AND p.database_id = (SELECT folders FROM schema_ids)
    AND p.key = 'mailbox' AND COALESCE(f.properties->>'specialPurpose', 'none') <> 'all'
), unread_threads AS (
  SELECT mf.id AS folder_id, count(*)::int AS n
  FROM mailbox_folders mf CROSS JOIN copy_stats cs CROSS JOIN LATERAL (SELECT cs.thread_id) l
  WHERE ${mailThreadPredicates.unread} AND ${mailThreadPredicates.inFolderRow}
  GROUP BY mf.id
), folder_messages AS (
  SELECT mf.id AS folder_id, count(DISTINCT e.id)::int AS n
  FROM mailbox_folders mf
  CROSS JOIN folder_definition fd
  JOIN item_relations r ON r.tenant_id = app_tenant_default() AND r.relation_definition_id = fd.id
    AND (CASE WHEN fd.email_is_a THEN r.item_b ELSE r.item_a END) = mf.id
  JOIN items e ON e.tenant_id = r.tenant_id AND e.database_id = (SELECT emails FROM schema_ids)
    AND e.id = CASE WHEN fd.email_is_a THEN r.item_a ELSE r.item_b END AND e.deleted_at IS NULL
  GROUP BY mf.id
)
SELECT mf.id, mf.name, mf.special_purpose AS "specialPurpose", mf.behavior,
  COALESCE(u.n, 0) AS "unreadCount", COALESCE(m.n, 0) AS "totalCount"
FROM mailbox_folders mf
LEFT JOIN unread_threads u ON u.folder_id = mf.id
LEFT JOIN folder_messages m ON m.folder_id = mf.id
`;

/**
 * The listed folders of a mailbox of the caller's tenant, unordered and under their stored names, or
 * `null` when the mailbox is unknown, deleted or another tenant's (row-level security hides it), or
 * the tenant has no Mailboxes database. Each of those answers the same way.
 */
async function readMailboxFolders(client: PoolClient, mailboxItemId: string): Promise<MailFolder[] | null> {
  const mailboxesDatabase = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
  if (mailboxesDatabase === null) return null;
  const mailbox = await getItemById(client, mailboxesDatabase.id, mailboxItemId);
  if (mailbox === null || mailbox.deletedAt !== null) return null;
  const { rows } = await client.query<Record<string, unknown>>(MAIL_FOLDER_LIST_SQL, [mailboxItemId, null]);
  return rows.map((row) => folderRow.parse(row));
}

function systemFolderRank(specialPurpose: string): number {
  const rank = (SYSTEM_FOLDER_ORDER as readonly string[]).indexOf(specialPurpose);
  return rank === -1 ? SYSTEM_FOLDER_ORDER.length : rank;
}

/**
 * Names the system folders in `locale` and puts the list in the sidebar's order: the system folders
 * in `SYSTEM_FOLDER_ORDER`, then every other folder by its name as `locale` collates it. Ties, such
 * as two folders of one name, are ordered by id, so the order never depends on the provider's.
 */
function presentFolders(folders: MailFolder[], catalogs: ModuleCatalogs, locale: ManifestLocale): MailFolder[] {
  const collator = new Intl.Collator(locale);
  return folders
    .map((folder) => ({
      ...folder,
      name:
        systemFolderRank(folder.specialPurpose) < SYSTEM_FOLDER_ORDER.length
          ? resolveCatalogLabel(null, catalogs[locale], catalogs.en, `mail.folder.${folder.specialPurpose}`)
          : folder.name,
    }))
    .sort(
      (left, right) =>
        systemFolderRank(left.specialPurpose) - systemFolderRank(right.specialPurpose) ||
        collator.compare(left.name, right.name) ||
        (left.id < right.id ? -1 : 1),
    );
}

interface MailFolderListRouteContext {
  params: Record<string, string>;
  identity: { user: { locale: string } };
}

/** `items.id` is a uuid: a malformed id names no mailbox, so it gets the same 404 as an unknown one. */
const mailboxIdSchema = z.uuid();

/**
 * `GET /api/mail/mailboxes/:id/folders` (issue gh-1689): the mailbox's folders with their unread
 * thread count and message count, the system folders named in Czech or English by the caller's
 * `users.locale` (`toManifestLocale`). The mailbox lookup and the counts read one snapshot. Both run
 * in the caller's tenant scope, so a foreign mailbox answers exactly like an unknown one: the same
 * `not_found` body.
 *
 * The mail module's catalogs are loaded by the first request of this handler that finds its mailbox
 * and are kept. A failed load is forgotten, so the next such request tries again.
 */
export function createMailFolderListRouteHandler(pool: Pool) {
  let catalogsPromise: Promise<ModuleCatalogs> | undefined;
  const mailCatalogs = (): Promise<ModuleCatalogs> => {
    catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((error: unknown) => {
      catalogsPromise = undefined;
      throw error;
    });
    return catalogsPromise;
  };
  return async (ctx: MailFolderListRouteContext): Promise<{ status: number; body: MailFolder[] }> => {
    const parsedId = mailboxIdSchema.safeParse(ctx.params.id);
    const folders = parsedId.success
      ? await withTransaction(pool, (client) => readMailboxFolders(client, parsedId.data), {
          isolation: "repeatable_read",
        })
      : null;
    if (folders === null) throw new NotFoundError("Mailbox not found");
    const locale = toManifestLocale(ctx.identity.user.locale);
    return { status: 200, body: presentFolders(folders, await mailCatalogs(), locale) };
  };
}
