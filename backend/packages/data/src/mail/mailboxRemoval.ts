// Removes a mailbox in one transaction: the Mailboxes item goes to the trash, its credential and sync
// rows are deleted, the job trashing its Emails and Folders is queued, and its calendar sync is stopped
// (the cleanup of its calendars is queued). After the commit the mailbox is cleaned up at the provider
// from what the transaction read into memory.
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { lockCalendarAccountSync } from "../calendar/sync/calendarAccountSyncGuard.js";
import { stopCalendarAccountSync } from "../calendar/sync/calendarAccountSyncLifecycle.js";
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
import { lockMailboxSync, MAILBOX_REMOVAL_SYNC_WAIT_MS } from "./mailboxSyncGuard.js";
import { deleteMailServerSettings } from "./mailServerSettingsStore.js";
import type { CustomRouteResult, RouteParams, RouteUser } from "../customRoute.js";

/** `syncStatus` is `owner: 'system'`; the removal is its second sanctioned writer. */
const MAILBOX_REMOVAL_ALLOWED_KEYS = ["syncStatus"] as const;

export interface RemoveMailboxOptions {
  queueAffinity: ActionQueueAffinity;
  /** Receives the item's realtime invalidations and is named in the credential access log. */
  actingUserId?: string;
  /**
   * Without it the live-sync stop and the OAuth-client steps fail as `notConfigured`, and a Gmail token
   * is revoked through the global `fetch`.
   */
  cleanupDependencies?: MailboxRemovalCleanupDependencies;
  cleanupStepTimeoutMs?: number;
  syncWaitMs?: number;
}

/**
 * Returns `null`, having written nothing, for an unknown, foreign (hidden by RLS) or already trashed
 * mailbox.
 *
 * Its first lock is the mailbox's sync guard, which a sync pass's write transaction takes first and holds
 * to its end. The removal waits for it holding no row lock, up to `syncWaitMs` (15 s default), then
 * throws `MailboxSyncBusyError` (409) having written nothing. The holder may be a pass of another
 * mailbox waiting for the tenant's mail-thread guard. A pass or second removal arriving later waits
 * unbounded and then finds the mailbox removed.
 *
 * Under the guard it takes the account's calendar sync guard (same bound, then `CalendarAccountSyncBusyError`,
 * 409), then locks the sync state row, then the Mailboxes item: the order the Calendars and Mail switches
 * take them in, and the order the mail sync job's failure paths (which take no guard) write the last two.
 * Before any change it reads the cleanup input into memory (decrypting a refresh token writes a
 * `credential_access_log` row). The deletes may match no row for a mailbox that never connected; what
 * matters is that none is left. The calendar sync stops as for Calendars switched off.
 */
async function removeMailboxWithClient(
  client: PoolClient,
  mailboxItemId: string,
  options: RemoveMailboxOptions,
): Promise<MailboxRemovalCleanupInput | null> {
  const mailboxes = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
  if (mailboxes === null) return null;
  const syncWaitMs = options.syncWaitMs ?? MAILBOX_REMOVAL_SYNC_WAIT_MS;
  await lockMailboxSync(client, mailboxItemId, { maxWaitMs: syncWaitMs });
  await lockCalendarAccountSync(client, mailboxItemId, { maxWaitMs: syncWaitMs });
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
  // The system writer is what the Mailboxes delete hook lets through.
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
  // Queued in this transaction so the job exists only when the removal commits.
  await enqueueMailboxRemoval(client, mailboxItemId);
  await stopCalendarAccountSync(client, mailboxItemId);
  return cleanup;
}

/**
 * Any failure rolls back every write. After the commit the provider cleanup (live sync, Graph
 * subscription, Gmail watch and grant when no other mailbox records the account) is awaited but best
 * effort: a failed step is logged and the answer stays `true`.
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

/** A malformed id gets the same 404 as an unknown one. */
const mailboxIdSchema = z.uuid();

/**
 * Runs in the caller's tenant scope, so unknown, malformed, foreign and already removed ids answer the
 * same `not_found`. Success is answered also when a cleanup step failed.
 */
export function createMailboxRemovalRouteHandler(
  pool: Pool,
  dependencies: MailboxRemovalCleanupDependencies,
  options: { cleanupStepTimeoutMs?: number } = {},
) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: RouteParams & RouteUser): Promise<CustomRouteResult> => {
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
