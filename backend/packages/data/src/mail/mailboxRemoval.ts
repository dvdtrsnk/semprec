// Removes a mailbox (issue gh-1690): the Mailboxes item goes to the trash and its credential, sync state,
// folder sync state and server settings are deleted with it, in one transaction that also queues the job
// trashing the mailbox's Emails and Folders (issue gh-2029, mailboxRemovalJob.ts). After the commit the
// mailbox is cleaned up outside the database (issue gh-2030, mailboxRemovalProviderCleanup.ts). Its trash
// of the Mailboxes item, made as the system writer, passes the item delete hook that refuses a user's or
// an agent's (issue gh-2031, mailboxDeleteHook.ts).
// Constrained by: docs/adr/2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status.md,
// docs/adr/2026-11-11-a-removed-mailbox-is-cleaned-up-at-the-provider-from-memory-after-the-commit.md,
// docs/adr/2026-11-11-a-mailboxes-item-is-trashed-only-by-the-system-writer.md
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { deleteCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { createActionQueueAffinity, type ActionQueueAffinity } from "../scheduler/actions.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { deleteMailAccountSyncState, lockMailAccountSyncState } from "./mailAccountSyncStateStore.js";
import { deleteMailFolderSyncStatesOfMailbox } from "./mailFolderSyncStateStore.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { enqueueMailboxRemoval } from "./mailboxRemovalJob.js";
import {
  cleanUpRemovedMailbox,
  readMailboxRemovalCleanupInput,
  type MailboxRemovalCleanupDependencies,
  type MailboxRemovalCleanupInput,
} from "./mailboxRemovalProviderCleanup.js";
import { lockMailboxSync } from "./mailboxSyncGuard.js";
import { deleteMailServerSettings } from "./mailServerSettingsStore.js";

/** The key the removal writes on the Mailboxes item: `syncStatus` is `owner: 'system'`, and the ADR named above records the removal as its second writer. */
const MAILBOX_REMOVAL_ALLOWED_KEYS = ["syncStatus"] as const;

export interface RemoveMailboxOptions {
  /** Routes the `onItemEvent` heartbeats of the item update and of the trash. */
  queueAffinity: ActionQueueAffinity;
  /**
   * The user whose request removes the mailbox; the realtime invalidations of the item are addressed
   * to them, and the credential access log names them when the removal reads the refresh token.
   */
  actingUserId?: string;
  /**
   * What the cleanup after the commit calls (issue gh-2030). Without it the live-sync stop and the
   * steps that need an OAuth client fail as `notConfigured`, and a Gmail token is revoked through the
   * global `fetch`.
   */
  cleanupDependencies?: MailboxRemovalCleanupDependencies;
  /** The time limit of one cleanup step; the cleanup's default unless a test passes a shorter one. */
  cleanupStepTimeoutMs?: number;
}

/**
 * The removal inside the caller's transaction and tenant scope. Returns `null`, having written
 * nothing, when the tenant has no Mailboxes database or no live mailbox with this id: an unknown id,
 * another tenant's mailbox (row-level security hides it) and a mailbox already in the trash.
 * Otherwise it returns what the cleanup after the commit needs.
 *
 * Its first lock is the mailbox's sync guard (`lockMailboxSync`), which the write transaction of a
 * sync pass of this mailbox takes as its first statement and holds to its end (`mailSyncJob.ts`). A
 * removal that arrives during a pass waits there, holding no row lock, until the pass has ended or the
 * statement timeout cancels the removal. A pass that arrives during a removal waits for it and then
 * finds the mailbox removed. A concurrent second removal of the same mailbox waits on the guard too
 * and then finds the mailbox trashed.
 *
 * Under the guard it locks the `mail_account_sync_state` row and then the Mailboxes item. That is the
 * order the sync job's failure paths write them in (the state row, then `syncStatus`); they run
 * outside a pass's write transaction and take no guard. Before it changes any of them it reads what
 * the cleanup needs from the rows it is about to delete and keeps it in memory only
 * (`readMailboxRemovalCleanupInput`, issue gh-2030; decrypting a refresh token writes its
 * `credential_access_log` row, and for a Gmail mailbox the read also asks whether another mailbox, of
 * any tenant, records the same Google account). Then it writes, in this order:
 * `syncStatus` `needsReauthorization`, the soft delete through the choke point's trash cascade as the
 * system writer, the credential, the sync state row, the folder sync state rows and the server
 * settings row. Each of the four deletes may match no row, because a mailbox that never connected has
 * none of them; what the removal establishes is that none is left. Last, it queues the `mailboxRemoval`
 * job (issue gh-2029), which trashes the mailbox's Emails and Folders after the commit.
 */
async function removeMailboxWithClient(
  client: PoolClient,
  mailboxItemId: string,
  options: RemoveMailboxOptions,
): Promise<MailboxRemovalCleanupInput | null> {
  const mailboxes = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
  if (mailboxes === null) return null;
  await lockMailboxSync(client, mailboxItemId);
  const syncState = await lockMailAccountSyncState(client, mailboxItemId);
  const mailbox = await lockItemById(client, mailboxes.id, mailboxItemId);
  if (mailbox === null || mailbox.deletedAt !== null) return null;
  const { foldersDatabaseId } = await resolveMailModuleIds(client);
  const cleanup = await readMailboxRemovalCleanupInput(client, {
    mailboxItemId,
    syncState,
    actingUserId: options.actingUserId,
  });

  await updateItemWithClient(
    client,
    { databaseId: mailboxes.id, itemId: mailboxItemId, propertiesPatch: { syncStatus: "needsReauthorization" } },
    {
      allowedSystemKeys: MAILBOX_REMOVAL_ALLOWED_KEYS,
      queueAffinity: options.queueAffinity,
      actingUserId: options.actingUserId,
    },
  );
  // The system writer is the marker the Mailboxes delete hook lets through (issue gh-2031): a user's or
  // an agent's trash of the item is refused there.
  const trashed = await itemDeleteWithClient(client, mailboxes.id, mailboxItemId, {
    queueAffinity: options.queueAffinity,
    actingUserId: options.actingUserId,
    writer: SYSTEM_WRITER,
  });
  // The row is locked and was live two statements ago, so the trash finds it.
  if (trashed === null) throw new Error(`Mailbox ${mailboxItemId} disappeared during its removal`);

  await deleteCredential(client, mailboxItemId);
  await deleteMailAccountSyncState(client, mailboxItemId);
  await deleteMailFolderSyncStatesOfMailbox(client, { foldersDatabaseId, mailboxItemId });
  await deleteMailServerSettings(client, mailboxItemId);
  // Issue gh-2029: the job that trashes the mailbox's Emails and Folders, queued in this transaction so
  // that it exists only when the removal commits.
  await enqueueMailboxRemoval(client, mailboxItemId);
  return cleanup;
}

/**
 * Removes mailbox `mailboxItemId` of the caller's tenant in one transaction (issue gh-1690): any
 * failure rolls back every write of `removeMailboxWithClient`, so the mailbox, its credential and its
 * sync rows stay as they were. Returns whether a live mailbox was removed.
 *
 * After the commit of a removal it awaits the cleanup outside the database (issue gh-2030,
 * `cleanUpRemovedMailbox`): the hosted live-sync lifecycle, the Graph subscription and, for a Gmail
 * mailbox that is the only one recording its Google account, the watch and the grant. The cleanup is
 * best effort: a step that fails is logged and leaves the answer `true`. What it works from was read
 * by the transaction and is kept in memory only.
 */
export async function removeMailbox(
  pool: Pool,
  mailboxItemId: string,
  options: RemoveMailboxOptions,
): Promise<boolean> {
  const cleanup = await withTransaction(pool, (client) => removeMailboxWithClient(client, mailboxItemId, options));
  if (cleanup === null) return false;
  await cleanUpRemovedMailbox(cleanup, options.cleanupDependencies ?? {}, options.cleanupStepTimeoutMs);
  return true;
}

/** `DELETE /api/mail/mailboxes/:id`'s request context: the session user is the acting user of the removal. */
interface MailboxRemovalRouteRequestContext {
  params: Record<string, string>;
  identity: { user: { id: string } };
}

type CustomRouteResult = { status: number; body: unknown };

/** `items.id` is a uuid: a malformed id names no mailbox, so it gets the same 404 as an unknown one. */
const mailboxIdSchema = z.uuid();

/**
 * `DELETE /api/mail/mailboxes/:id` (issue gh-1690). The removal runs in the caller's tenant scope, so
 * an unknown id, a malformed id, another tenant's mailbox and a mailbox already removed all answer the
 * same `not_found` body. Success answers the removed mailbox's id, also when a step of the cleanup
 * after the commit failed (issue gh-2030). The cleanup calls the members of `dependencies`, the
 * composition root's custom-route container; `options.cleanupStepTimeoutMs` is for tests.
 */
export function createMailboxRemovalRouteHandler(
  pool: Pool,
  dependencies: MailboxRemovalCleanupDependencies,
  options: { cleanupStepTimeoutMs?: number } = {},
) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: MailboxRemovalRouteRequestContext): Promise<CustomRouteResult> => {
    const parsedId = mailboxIdSchema.safeParse(ctx.params.id);
    if (!parsedId.success) throw new NotFoundError("Mailbox not found");
    const removed = await removeMailbox(pool, parsedId.data, {
      queueAffinity,
      actingUserId: ctx.identity.user.id,
      cleanupDependencies: dependencies,
      cleanupStepTimeoutMs: options.cleanupStepTimeoutMs,
    });
    if (!removed) throw new NotFoundError("Mailbox not found");
    return { status: 200, body: { id: parsedId.data } };
  };
}
