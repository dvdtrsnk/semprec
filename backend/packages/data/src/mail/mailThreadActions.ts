import type { PoolClient } from "pg";
import { z } from "zod";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { findFolderBySpecialPurpose } from "./folderDiscovery.js";
import { getMailAccountSyncState } from "./mailAccountSyncStateStore.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { resolveMergedThreadId } from "./mailMessageMetaStore.js";
import {
  hasPreservedMailMoveSource,
  recordDesiredMailMessageMove,
  type MailMovePurpose,
  type MailMoveSource,
} from "./mailMessageMoveSyncStore.js";
import { mailThreadCopyCtes } from "./mailThreadListQuery.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";
import { enqueueMailAccountSync } from "./mailSyncEnqueue.js";

/**
 * One live Emails copy of a mail thread, as the thread actions see it. A message delivered to several
 * mailboxes is several copies with one `messageId`.
 */
export interface MailThreadActionMessage {
  /** The copy's Emails item. */
  itemId: string;
  messageId: string;
  /** The copy's `read` property (an absent one reads as `false`). */
  read: boolean;
  /**
   * Whether the copy is incoming mail: its sender is none of the tenant's mailbox addresses and it is in
   * neither a Sent nor a Drafts folder.
   */
  incoming: boolean;
}

export interface MailThreadActionMessages {
  /** Every live copy of the thread, in any folder or mailbox, ordered by item id. */
  messages: MailThreadActionMessage[];
  /**
   * The `messageId` of the last incoming message: that of the incoming copy with the latest activity, then
   * the highest item id (the order the thread list picks a thread's latest copy in). `null` when the thread
   * has no incoming copy.
   */
  lastIncomingMessageId: string | null;
}

const messageRow = z.object({
  itemId: z.uuid(),
  messageId: z.string(),
  read: z.boolean(),
  incoming: z.boolean(),
  lastIncoming: z.boolean(),
});

/**
 * Starts a thread action in the caller's READ COMMITTED tenant transaction: takes the tenant's mail-thread guard
 * (`lockMailThreadMutation`) and then resolves the thread id. A merged-away id is translated to the thread that
 * absorbed it (issue #1493), a live id is returned as it is. An unknown id and another tenant's id (row-level
 * security hides it) both throw the same `NotFoundError`.
 *
 * The guard comes first, before the thread is resolved and before any copy is locked, as it does in the reconcilers
 * and ingest ([[2026-11-01-mail-thread-mutations-use-a-tenant-transaction-guard]]): a reconcile pass holds the
 * guard for its whole transaction and locks Emails items one after another in provider order, so a thread action
 * that locked several copies in item id order without it could wait on a copy the pass holds while the pass waits
 * on one of its own, a deadlock no layer answers as a domain error. Every thread action calls this first; see
 * [[2026-11-13-mail-thread-actions-take-the-thread-guard-before-their-item-locks]].
 */
export async function resolveMailThreadForAction(client: PoolClient, threadId: string): Promise<string> {
  await lockMailThreadMutation(client);
  const resolved = await resolveMergedThreadId(client, threadId);
  if (resolved === null) throw new NotFoundError("Thread not found");
  return resolved;
}

/**
 * The copies of thread `threadId` (an id `resolveMailThreadForAction` returned) in the thread detail's view
 * of the thread: every live copy, drafts included, read from the CTEs the thread list and the detail share
 * (`mailThreadCopyCtes`). A copy in a Drafts folder is never incoming, whoever the sender is.
 */
export async function listMailThreadActionMessages(
  client: PoolClient,
  threadId: string,
): Promise<MailThreadActionMessages> {
  const { rows } = await client.query<{ message: unknown }>(
    `
WITH ${mailThreadCopyCtes(1)}, classified AS (
  SELECT c.item_id, c.message_id, c.is_read, c.activity,
    NOT c.own AND NOT c.has_sent AND NOT EXISTS (
      SELECT 1 FROM items f
      WHERE f.tenant_id = app_tenant_default() AND f.id = ANY(c.folder_ids) AND f.properties->>'specialPurpose' = 'drafts'
    ) AS incoming
  FROM copies c
), last_incoming AS (
  SELECT item_id FROM classified WHERE incoming ORDER BY activity DESC NULLS LAST, item_id DESC LIMIT 1
)
SELECT jsonb_build_object(
  'itemId', k.item_id, 'messageId', k.message_id, 'read', k.is_read, 'incoming', k.incoming,
  'lastIncoming', COALESCE(k.item_id = (SELECT item_id FROM last_incoming), false)
) AS message
FROM classified k
ORDER BY k.item_id
`,
    [threadId],
  );
  const parsed = rows.map((row) => messageRow.parse(row.message));
  return {
    messages: parsed.map(({ itemId, messageId, read, incoming }) => ({ itemId, messageId, read, incoming })),
    lastIncomingMessageId: parsed.find((message) => message.lastIncoming)?.messageId ?? null,
  };
}

/**
 * Whether thread `threadId` (an id `resolveMailThreadForAction` returned) is unread, as the thread detail reports
 * it: some live copy, drafts included, is neither the user's own mail nor in Sent and has no `read` flag set
 * (`copy_stats` of `mailThreadCopyCtes` with a thread id). A thread without a live copy is not unread.
 *
 * The thread list leaves drafts out of that aggregate (`mailThreadCopyCtes`), the detail and this value do not.
 * A thread action never writes a copy in a Drafts folder, so a draft whose sender is none of the tenant's
 * mailbox addresses and that has no `read` flag keeps the value `true` after `read: true`, as the detail shows it.
 */
export async function readMailThreadUnread(client: PoolClient, threadId: string): Promise<boolean> {
  const { rows } = await client.query<{ unread: boolean }>(
    `WITH ${mailThreadCopyCtes(1)} SELECT COALESCE((SELECT unread FROM copy_stats), false) AS unread`,
    [threadId],
  );
  return rows[0]?.unread === true;
}

/**
 * Whether thread `threadId` (an id `resolveMailThreadForAction` returned) is flagged, as the thread detail reports it:
 * some live copy, drafts included, has its `flagged` flag set (`copy_stats` of `mailThreadCopyCtes` with a thread
 * id). A thread without a live copy is not flagged.
 */
export async function readMailThreadFlagged(client: PoolClient, threadId: string): Promise<boolean> {
  const { rows } = await client.query<{ flagged: boolean }>(
    `WITH ${mailThreadCopyCtes(1)} SELECT COALESCE((SELECT flagged FROM copy_stats), false) AS flagged`,
    [threadId],
  );
  return rows[0]?.flagged === true;
}

/**
 * Announces after the commit of the caller's transaction that mail thread `threadId` changed: one thin
 * `mailThread` invalidation to every socket of the tenant (issue #1816), so a client refetches the thread,
 * the mailbox counts and the overview. A rolled-back transaction announces nothing. `threadId` is the id a
 * client knows the thread by now, which is the id `resolveMailThreadForAction` returned.
 */
export function announceMailThreadChanged(client: PoolClient, threadId: string): void {
  runAfterCommit(client, () => notifyInvalidation({ scope: "mailThread", threadId }));
}

const moveCopyRow = z.object({
  itemId: z.uuid(),
  mailboxItemId: z.uuid(),
  providerMessageId: z.string().nullable(),
  incoming: z.boolean(),
  draft: z.boolean(),
  purposes: z.array(z.string()),
});

/**
 * One live Emails copy of a mail thread as the move routes (archive, trash, restore) see it. A message delivered to
 * several mailboxes is several copies, each in its own mailbox.
 */
export interface MailThreadMoveCopy {
  itemId: string;
  /** The mailbox the copy belongs to; its provider holds the copy's move. */
  mailboxItemId: string;
  /** The copy's provider message id (`mail_message_meta`); `null` for a copy that has none, as every IMAP copy. */
  providerMessageId: string | null;
  /** Incoming mail, with the meaning `MailThreadActionMessage.incoming` has. */
  incoming: boolean;
  /**
   * A draft: the copy is in any Drafts folder or has a Semprec draft row that was not sent. The move routes leave a
   * draft where it is. This is wider than what the thread list leaves out (a copy whose every folder is Drafts, or
   * that has an unsent draft row), so a copy in a Drafts folder and another folder is counted by the list but never
   * moved: no provider puts one message in Inbox and Drafts, and moving a copy out of Drafts would lose the draft.
   */
  draft: boolean;
  /** The `specialPurpose` of every live folder the copy is in (`none` for a folder without one). */
  purposes: ReadonlySet<string>;
}

/**
 * The live copies of thread `threadId` (an id `resolveMailThreadForAction` returned) in any folder or mailbox,
 * drafts included and flagged as such, ordered by item id. The classification is that of
 * `listMailThreadActionMessages`.
 */
export async function listMailThreadMoveCopies(client: PoolClient, threadId: string): Promise<MailThreadMoveCopy[]> {
  const { rows } = await client.query<{ copy: unknown }>(
    `
WITH ${mailThreadCopyCtes(1)}
SELECT jsonb_build_object(
  'itemId', c.item_id, 'mailboxItemId', c.mailbox_item_id, 'providerMessageId', meta.provider_message_id,
  'purposes', p.purposes,
  'incoming', NOT c.own AND NOT c.has_sent AND NOT (p.purposes @> '"drafts"'::jsonb),
  'draft', p.purposes @> '"drafts"'::jsonb OR EXISTS (
    SELECT 1 FROM mail_drafts d WHERE d.tenant_id = app_tenant_default() AND d.email_item_id = c.item_id AND d.sent_at IS NULL)
) AS copy
FROM copies c
JOIN mail_message_meta meta ON meta.tenant_id = app_tenant_default() AND meta.item_id = c.item_id
CROSS JOIN LATERAL (
  SELECT COALESCE(jsonb_agg(COALESCE(f.properties->>'specialPurpose', 'none')), '[]'::jsonb) AS purposes
  FROM items f WHERE f.tenant_id = app_tenant_default() AND f.id = ANY(c.folder_ids)
) p
ORDER BY c.item_id
`,
    [threadId],
  );
  return rows.map((row) => {
    const parsed = moveCopyRow.parse(row.copy);
    return { ...parsed, purposes: new Set(parsed.purposes) };
  });
}

const MOVE_TARGET_MISSING: Record<MailMovePurpose, { code: string; folder: string }> = {
  archive: { code: "mail_archive_folder_missing", folder: "Archive" },
  trash: { code: "mail_trash_folder_missing", folder: "Trash" },
  inbox: { code: "mail_inbox_folder_missing", folder: "Inbox" },
  sent: { code: "mail_sent_folder_missing", folder: "Sent" },
};

/** One copy to move and the `specialPurpose` of the folder it moves to. */
export interface MailThreadMoveSelection {
  copy: MailThreadMoveCopy;
  purpose: MailMovePurpose;
}

/** One copy to move, the purpose of the folder it moves to and that folder in the copy's own mailbox. */
export interface MailThreadMovePlan {
  copy: MailThreadMoveCopy;
  purpose: MailMovePurpose;
  targetFolderId: string;
}

/**
 * Finds, for each selected copy, the folder with the wanted `specialPurpose` in the copy's own mailbox (a Gmail API
 * mailbox keeps its synthetic Archive there too). A mailbox without such a folder fails the whole call with the 409
 * code of that purpose (`mail_archive_folder_missing`, `mail_trash_folder_missing`, `mail_inbox_folder_missing`,
 * `mail_sent_folder_missing`); the first copy in item id order decides which. Nothing is written here, so the failure
 * leaves every copy as it was.
 */
export async function planMailThreadMoves(
  client: PoolClient,
  selections: readonly MailThreadMoveSelection[],
): Promise<MailThreadMovePlan[]> {
  if (selections.length === 0) return [];
  const { foldersDatabaseId } = await resolveMailModuleIds(client);
  const mailboxProperty = await getPropertyByKey(client, foldersDatabaseId, "mailbox");
  if (!mailboxProperty) throw new Error("The Folders database has no mailbox property");
  const plans: MailThreadMovePlan[] = [];
  for (const { copy, purpose } of selections) {
    const targetFolderId = await findFolderBySpecialPurpose(client, {
      foldersDatabaseId,
      mailboxRelationPropertyId: mailboxProperty.id,
      mailboxItemId: copy.mailboxItemId,
      specialPurpose: purpose,
    });
    if (targetFolderId === null) {
      const { code, folder } = MOVE_TARGET_MISSING[purpose];
      throw new ConflictError(`A mailbox of the thread has no ${folder} folder`, undefined, code);
    }
    plans.push({ copy, purpose, targetFolderId });
  }
  return plans;
}

const imapSourceRow = z.object({
  folderId: z.uuid(),
  path: z.string().min(1).max(1024),
  uid: z.string().regex(/^[1-9]\d{0,9}$/),
  uidValidity: z.string().regex(/^[1-9]\d{0,9}$/),
});

const MAX_IMAP_UID = 4_294_967_295;

/**
 * The source of an IMAP copy's move: the one folder edge of the copy that carries a UID, with the folder's path and
 * its stored `UIDVALIDITY`. `null` when the copy has no such edge or more than one (a tentative edge a move wrote
 * carries no UID), which means the provider copy cannot be addressed.
 */
async function readImapMoveSource(
  client: PoolClient,
  messageItemId: string,
  folderDefinitionId: string,
): Promise<MailMoveSource | null> {
  const { rows } = await client.query<{ source: unknown }>(
    `SELECT jsonb_build_object('folderId', folder.id, 'path', folder.properties->>'providerId',
             'uid', edge.metadata->>'uid', 'uidValidity', state.uidvalidity::text) AS source
     FROM item_relations edge
     JOIN items folder ON folder.tenant_id = app_tenant_default() AND folder.deleted_at IS NULL
       AND folder.id = CASE WHEN edge.item_a = $1 THEN edge.item_b ELSE edge.item_a END
     JOIN mail_folder_sync_state state ON state.tenant_id = app_tenant_default() AND state.item_id = folder.id
     WHERE edge.tenant_id = app_tenant_default() AND edge.relation_definition_id = $2
       AND (edge.item_a = $1 OR edge.item_b = $1) AND edge.metadata->>'uid' IS NOT NULL`,
    [messageItemId, folderDefinitionId],
  );
  if (rows.length !== 1) return null;
  const parsed = imapSourceRow.safeParse(rows[0]?.source);
  if (!parsed.success || Number(parsed.data.uid) > MAX_IMAP_UID || Number(parsed.data.uidValidity) > MAX_IMAP_UID)
    return null;
  return {
    provider: "imap",
    folderItemId: parsed.data.folderId,
    path: parsed.data.path,
    uid: Number(parsed.data.uid),
    uidValidity: parsed.data.uidValidity,
  };
}

/**
 * The source evidence a new desired move of `copy` records, or `undefined` when an earlier desire of the copy is still
 * outstanding and keeps its own (`hasPreservedMailMoveSource`). A Gmail API or Graph copy is addressed by its provider
 * message id, an IMAP copy by the folder, UID and `UIDVALIDITY` of its current edge. Throws a 409
 * `mail_move_source_unverified` for a copy that has none of them or whose mailbox has no sync state.
 */
async function resolveMoveSource(
  client: PoolClient,
  copy: MailThreadMoveCopy,
  syncModes: Map<string, string | null>,
  folderDefinitionId: string,
): Promise<MailMoveSource | undefined> {
  if (await hasPreservedMailMoveSource(client, copy.itemId)) return undefined;
  if (!syncModes.has(copy.mailboxItemId))
    syncModes.set(copy.mailboxItemId, (await getMailAccountSyncState(client, copy.mailboxItemId))?.syncMode ?? null);
  const syncMode = syncModes.get(copy.mailboxItemId);
  let source: MailMoveSource | null = null;
  if (syncMode === "imap") source = await readImapMoveSource(client, copy.itemId, folderDefinitionId);
  else if ((syncMode === "gmail_api" || syncMode === "graph_api") && copy.providerMessageId !== null)
    source = {
      provider: syncMode === "gmail_api" ? "gmail" : "graph",
      providerMessageId: copy.providerMessageId,
    };
  if (source === null)
    throw new ConflictError(
      "A message of the thread cannot be addressed at its provider",
      undefined,
      "mail_move_source_unverified",
    );
  return source;
}

/**
 * Moves the planned copies inside the caller's transaction, which has taken the thread guard
 * (`resolveMailThreadForAction`), and returns how many it moved. The source of every copy is resolved first
 * (`resolveMoveSource`), so a copy that cannot be addressed fails the call before anything is written. Then each copy,
 * in the order of the plan, records its desired move (`recordDesiredMailMessageMove`, which verifies an IMAP source
 * against the copy's current edge and so runs before the edge is replaced), loses all its folder edges and gets one
 * edge to the target folder, written as the Emails module with no metadata, so no UID of the old edge survives. The
 * account sync of each mailbox the plan touched is enqueued once, in the same transaction. Every move route calls
 * this function and does not repeat these steps:
 * [[2026-11-14-a-mail-thread-move-records-the-desired-move-before-it-replaces-the-folder-edge]].
 */
export async function applyMailThreadMoves(client: PoolClient, plans: readonly MailThreadMovePlan[]): Promise<number> {
  if (plans.length === 0) return 0;
  const { emailsDatabaseId } = await resolveMailModuleIds(client);
  const folderProperty = await getPropertyByKey(client, emailsDatabaseId, "folder");
  if (!folderProperty) throw new Error("The Emails database has no folder property");
  const definition = await getRelationDefinitionByPropertyId(client, folderProperty.id);
  if (!definition) throw new Error("The Emails folder property has no relation definition");

  const syncModes = new Map<string, string | null>();
  const sources: (MailMoveSource | undefined)[] = [];
  for (const { copy } of plans) sources.push(await resolveMoveSource(client, copy, syncModes, definition.id));

  for (const [index, { copy, purpose, targetFolderId }] of plans.entries()) {
    await recordDesiredMailMessageMove(client, {
      messageItemId: copy.itemId,
      mailboxItemId: copy.mailboxItemId,
      desiredPurpose: purpose,
      source: sources[index],
    });
    for (const edge of await listRelationsForItem(client, definition.id, copy.itemId)) {
      await deleteRelationWithClient(
        client,
        {
          relationPropertyId: folderProperty.id,
          callerItemId: copy.itemId,
          targetItemId: otherSide(edge, copy.itemId),
        },
        EMAILS_RELATION_CONTEXT,
      );
    }
    await createRelationWithClient(
      client,
      { relationPropertyId: folderProperty.id, callerItemId: copy.itemId, targetItemId: targetFolderId },
      EMAILS_RELATION_CONTEXT,
    );
  }
  for (const mailboxItemId of new Set(plans.map(({ copy }) => copy.mailboxItemId)))
    await enqueueMailAccountSync(client, mailboxItemId);
  return plans.length;
}

/**
 * Selects what `POST /api/mail/threads/:threadId/archive` moves: the copies that are not drafts
 * (`MailThreadMoveCopy.draft`) and are in a folder with the `specialPurpose` `inbox`, each to `archive`.
 */
export function selectMailThreadArchiveMoves(copies: readonly MailThreadMoveCopy[]): MailThreadMoveSelection[] {
  return copies
    .filter((copy) => !copy.draft && copy.purposes.has("inbox"))
    .map((copy) => ({ copy, purpose: "archive" }));
}

/**
 * Selects what `POST /api/mail/threads/:threadId/trash` moves: every copy that is not a draft and not already in Trash,
 * each to `trash`. A thread whose copies that are not drafts are all in Trash or Junk fails with 409
 * `mail_thread_already_trashed`; a thread of drafts only selects nothing and is no error.
 */
export function selectMailThreadTrashMoves(copies: readonly MailThreadMoveCopy[]): MailThreadMoveSelection[] {
  const counted = copies.filter((copy) => !copy.draft);
  if (counted.length > 0 && counted.every((copy) => copy.purposes.has("trash") || copy.purposes.has("junk")))
    throw new ConflictError("The thread is already in Trash or Junk", undefined, "mail_thread_already_trashed");
  return counted.filter((copy) => !copy.purposes.has("trash")).map((copy) => ({ copy, purpose: "trash" }));
}

/**
 * Selects what `POST /api/mail/threads/:threadId/restore` moves: the copies that are not drafts and are in a
 * folder with the `specialPurpose` `archive` or `trash`. An incoming copy goes back to `inbox`, the user's own copy
 * (not incoming, in the classification of `listMailThreadActionMessages`) to `sent`, so that the user's sent mail
 * never lands in an Inbox. Copies in any other folder, Junk included, are not selected. A thread with no copy in
 * Archive or Trash fails with 409 `mail_thread_not_archived_or_trashed`.
 */
export function selectMailThreadRestoreMoves(copies: readonly MailThreadMoveCopy[]): MailThreadMoveSelection[] {
  const selected = copies
    .filter((copy) => !copy.draft && (copy.purposes.has("archive") || copy.purposes.has("trash")))
    .map((copy) => ({ copy, purpose: copy.incoming ? ("inbox" as const) : ("sent" as const) }));
  if (selected.length === 0)
    throw new ConflictError(
      "The thread has no message in Archive or Trash",
      undefined,
      "mail_thread_not_archived_or_trashed",
    );
  return selected;
}
