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

/** A message delivered to several mailboxes is several copies with one `messageId`. */
export interface MailThreadActionMessage {
  itemId: string;
  messageId: string;
  /** An absent property reads as `false`. */
  read: boolean;
  /**
   * Received and not in a Drafts folder: delivered to an Inbox or Junk folder (mail to oneself included), a copy of its
   * own beside a Sent copy, or from none of the tenant's mailbox addresses and in no Sent folder.
   */
  incoming: boolean;
}

export interface MailThreadActionMessages {
  /** Every live copy of the thread, in any folder or mailbox, ordered by item id. */
  messages: MailThreadActionMessage[];
  /** Of the incoming copy with the latest activity, then the highest item id (the thread list's latest-copy order). */
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
 * Takes the tenant's mail-thread guard, then resolves the thread id. The guard comes before any copy lock, as in the
 * reconcilers and ingest: a reconcile pass holds it while locking Emails items in provider order, so an action locking
 * copies in item id order without it could deadlock against the pass. Every thread action calls this first.
 */
export async function resolveMailThreadForAction(client: PoolClient, threadId: string): Promise<string> {
  await lockMailThreadMutation(client);
  const resolved = await resolveMergedThreadId(client, threadId);
  if (resolved === null) throw new NotFoundError("Thread not found");
  return resolved;
}

/** Every live copy, drafts included. A copy in a Drafts folder is never incoming, whoever the sender is. */
export async function listMailThreadActionMessages(
  client: PoolClient,
  threadId: string,
): Promise<MailThreadActionMessages> {
  const { rows } = await client.query<{ message: unknown }>(
    `
WITH ${mailThreadCopyCtes(1)}, classified AS (
  SELECT c.item_id, c.message_id, c.is_read, c.activity,
    c.received AND NOT EXISTS (
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
 * As the thread detail reports it, drafts included (the thread list leaves them out). Actions never write a Drafts
 * copy, so an unread draft stays unread after `read: true`.
 */
export async function readMailThreadUnread(client: PoolClient, threadId: string): Promise<boolean> {
  const { rows } = await client.query<{ unread: boolean }>(
    `WITH ${mailThreadCopyCtes(1)} SELECT COALESCE((SELECT unread FROM copy_stats), false) AS unread`,
    [threadId],
  );
  return rows[0]?.unread === true;
}

/** Flagged as the thread detail reports it: some live copy, drafts included, has `flagged` set. */
export async function readMailThreadFlagged(client: PoolClient, threadId: string): Promise<boolean> {
  const { rows } = await client.query<{ flagged: boolean }>(
    `WITH ${mailThreadCopyCtes(1)} SELECT COALESCE((SELECT flagged FROM copy_stats), false) AS flagged`,
    [threadId],
  );
  return rows[0]?.flagged === true;
}

/** After the commit, one thin `mailThread` invalidation to every socket of the tenant. */
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

/** A copy as the move routes see it; each copy is in its own mailbox. */
export interface MailThreadMoveCopy {
  itemId: string;
  /** Its provider holds the copy's move. */
  mailboxItemId: string;
  /** `null` for a copy without one, as every IMAP copy. */
  providerMessageId: string | null;
  incoming: boolean;
  /**
   * In any Drafts folder, or with an unsent Semprec draft row; the move routes leave a draft where it is. Wider than
   * the thread list's rule, so a copy in Drafts and another folder is counted but never moved: moving it out of
   * Drafts would lose the draft.
   */
  draft: boolean;
  /** `none` for a folder without one. */
  purposes: ReadonlySet<string>;
}

/** Classified like `listMailThreadActionMessages`, ordered by item id. */
export async function listMailThreadMoveCopies(client: PoolClient, threadId: string): Promise<MailThreadMoveCopy[]> {
  const { rows } = await client.query<{ copy: unknown }>(
    `
WITH ${mailThreadCopyCtes(1)}
SELECT jsonb_build_object(
  'itemId', c.item_id, 'mailboxItemId', c.mailbox_item_id, 'providerMessageId', meta.provider_message_id,
  'purposes', p.purposes,
  'incoming', c.received AND NOT (p.purposes @> '"drafts"'::jsonb),
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

export interface MailThreadMoveSelection {
  copy: MailThreadMoveCopy;
  purpose: MailMovePurpose;
}

export interface MailThreadMovePlan {
  copy: MailThreadMoveCopy;
  purpose: MailMovePurpose;
  targetFolderId: string;
}

/** A Gmail API mailbox keeps its synthetic Archive among its folders too. Writes nothing. */
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

const imapCopyEdgeRow = z.object({
  folderId: z.uuid(),
  purpose: z.string().nullable(),
  path: z.string().min(1).max(1024),
  uid: z.string().regex(/^[1-9]\d{0,9}$/),
  uidValidity: z.string().regex(/^[1-9]\d{0,9}$/),
});

const MAX_IMAP_UID = 4_294_967_295;

/** A folder edge of an IMAP copy that carries a UID: one provider message, with its path and stored `UIDVALIDITY`. */
interface ImapCopyEdge {
  source: Extract<MailMoveSource, { provider: "imap" }>;
  inSent: boolean;
}

/** `null` when an edge is malformed: no provider message can then be addressed with certainty. */
async function readImapCopyEdges(
  client: PoolClient,
  messageItemId: string,
  folderDefinitionId: string,
): Promise<ImapCopyEdge[] | null> {
  const { rows } = await client.query<{ edge: unknown }>(
    `SELECT jsonb_build_object('folderId', folder.id, 'purpose', folder.properties->>'specialPurpose',
             'path', folder.properties->>'providerId', 'uid', edge.metadata->>'uid',
             'uidValidity', state.uidvalidity::text) AS edge
     FROM item_relations edge
     JOIN items folder ON folder.tenant_id = app_tenant_default() AND folder.deleted_at IS NULL
       AND folder.id = CASE WHEN edge.item_a = $1 THEN edge.item_b ELSE edge.item_a END
     JOIN mail_folder_sync_state state ON state.tenant_id = app_tenant_default() AND state.item_id = folder.id
     WHERE edge.tenant_id = app_tenant_default() AND edge.relation_definition_id = $2
       AND (edge.item_a = $1 OR edge.item_b = $1) AND edge.metadata->>'uid' IS NOT NULL
     ORDER BY folder.id`,
    [messageItemId, folderDefinitionId],
  );
  const edges: ImapCopyEdge[] = [];
  for (const row of rows) {
    const parsed = imapCopyEdgeRow.safeParse(row.edge);
    if (!parsed.success || Number(parsed.data.uid) > MAX_IMAP_UID || Number(parsed.data.uidValidity) > MAX_IMAP_UID)
      return null;
    edges.push({
      source: {
        provider: "imap",
        folderItemId: parsed.data.folderId,
        path: parsed.data.path,
        uid: Number(parsed.data.uid),
        uidValidity: parsed.data.uidValidity,
      },
      inSent: parsed.data.purpose === "sent",
    });
  }
  return edges;
}

/**
 * How one copy moves. `source` is `undefined` when an earlier outstanding desire keeps its own evidence. `keepFolderIds`
 * are the folders whose edges the move leaves in place: an IMAP server keeps mail to oneself twice, in Sent and where
 * it was delivered, and one Emails item holds both; the move takes the delivered message and leaves the Sent copy.
 */
interface CopyMoveSource {
  source: MailMoveSource | undefined;
  keepFolderIds: ReadonlySet<string>;
}

const NO_FOLDERS: ReadonlySet<string> = new Set();

function unaddressable(): ConflictError {
  return new ConflictError(
    "A message of the thread cannot be addressed at its provider",
    undefined,
    "mail_move_source_unverified",
  );
}

/**
 * An IMAP copy moves the one provider message an edge with a UID names. When the item is also in another folder, its
 * Sent copies stay and the move takes the one message outside Sent. Throws 409 `mail_move_source_unverified` when the
 * copy cannot be addressed.
 */
async function resolveMoveSource(
  client: PoolClient,
  copy: MailThreadMoveCopy,
  syncModes: Map<string, string | null>,
  folderDefinitionId: string,
): Promise<CopyMoveSource> {
  if (!syncModes.has(copy.mailboxItemId))
    syncModes.set(copy.mailboxItemId, (await getMailAccountSyncState(client, copy.mailboxItemId))?.syncMode ?? null);
  const syncMode = syncModes.get(copy.mailboxItemId);
  const preserved = await hasPreservedMailMoveSource(client, copy.itemId);
  if (syncMode === "imap") {
    const edges = await readImapCopyEdges(client, copy.itemId, folderDefinitionId);
    if (edges === null) throw unaddressable();
    const sentCopyFolderIds = new Set(edges.filter((edge) => edge.inSent).map((edge) => edge.source.folderItemId));
    const inOtherFolder = (await listRelationsForItem(client, folderDefinitionId, copy.itemId)).some(
      (edge) => !sentCopyFolderIds.has(otherSide(edge, copy.itemId)),
    );
    const keepFolderIds = inOtherFolder ? sentCopyFolderIds : NO_FOLDERS;
    if (preserved) return { source: undefined, keepFolderIds };
    const [only, ...more] = inOtherFolder ? edges.filter((edge) => !edge.inSent) : edges;
    if (only === undefined || more.length > 0) throw unaddressable();
    return { source: only.source, keepFolderIds };
  }
  if (preserved) return { source: undefined, keepFolderIds: NO_FOLDERS };
  if ((syncMode === "gmail_api" || syncMode === "graph_api") && copy.providerMessageId !== null)
    return {
      source: { provider: syncMode === "gmail_api" ? "gmail" : "graph", providerMessageId: copy.providerMessageId },
      keepFolderIds: NO_FOLDERS,
    };
  throw unaddressable();
}

/**
 * Moves the planned copies under the caller's thread guard. All sources are resolved first, so nothing is written for
 * an unaddressable copy. Recording the desired move verifies an IMAP source against the current edge, so it must
 * precede the edge replacement; the new edge carries no metadata, so no old UID survives. The edges of a Sent copy the
 * move leaves in place are kept with their UIDs.
 */
export async function applyMailThreadMoves(client: PoolClient, plans: readonly MailThreadMovePlan[]): Promise<number> {
  if (plans.length === 0) return 0;
  const { emailsDatabaseId } = await resolveMailModuleIds(client);
  const folderProperty = await getPropertyByKey(client, emailsDatabaseId, "folder");
  if (!folderProperty) throw new Error("The Emails database has no folder property");
  const definition = await getRelationDefinitionByPropertyId(client, folderProperty.id);
  if (!definition) throw new Error("The Emails folder property has no relation definition");

  const syncModes = new Map<string, string | null>();
  const moves: Array<MailThreadMovePlan & CopyMoveSource> = [];
  for (const plan of plans)
    moves.push({ ...plan, ...(await resolveMoveSource(client, plan.copy, syncModes, definition.id)) });

  for (const { copy, purpose, targetFolderId, source, keepFolderIds } of moves) {
    await recordDesiredMailMessageMove(client, {
      messageItemId: copy.itemId,
      mailboxItemId: copy.mailboxItemId,
      desiredPurpose: purpose,
      source,
    });
    for (const edge of await listRelationsForItem(client, definition.id, copy.itemId)) {
      if (keepFolderIds.has(otherSide(edge, copy.itemId))) continue;
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

/** Archive: non-draft copies in an `inbox` folder, to `archive`. */
export function selectMailThreadArchiveMoves(copies: readonly MailThreadMoveCopy[]): MailThreadMoveSelection[] {
  return copies
    .filter((copy) => !copy.draft && copy.purposes.has("inbox"))
    .map((copy) => ({ copy, purpose: "archive" }));
}

/** Trash: every non-draft copy not already in Trash; a drafts-only thread selects nothing. */
export function selectMailThreadTrashMoves(copies: readonly MailThreadMoveCopy[]): MailThreadMoveSelection[] {
  const counted = copies.filter((copy) => !copy.draft);
  if (counted.length > 0 && counted.every((copy) => copy.purposes.has("trash") || copy.purposes.has("junk")))
    throw new ConflictError("The thread is already in Trash or Junk", undefined, "mail_thread_already_trashed");
  return counted.filter((copy) => !copy.purposes.has("trash")).map((copy) => ({ copy, purpose: "trash" }));
}

/** Restore: received copies to `inbox`, the user's own to `sent` so sent mail never lands in an Inbox. */
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
