// The Mail switch of an internet account (a Mailboxes item): switching `mailEnabled` off pauses the account's mail
// sync and queues the removal of its mail, switching it on resumes the sync. `calendarsEnabled` has no effect here.
import { currentTenantScope } from "@semprec/shared";
import type { ItemUpdateHook, ItemUpdatePreLockHook } from "../chokePoint/hooks.js";
import { runAfterCommit } from "../db/pool.js";
import type { DatabaseRow } from "../types.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { resolveProblem } from "../semp/sempProblemsStore.js";
import { mailProblemKey } from "../semp/sourceProblemKeys.js";
import { logger } from "./logger.js";
import {
  defaultSyncModeForProvider,
  lockMailAccountSyncState,
  pauseMailAccountSync,
  resumeMailAccountSync,
} from "./mailAccountSyncStateStore.js";
import { deleteMailFolderSyncStatesOfMailbox } from "./mailFolderSyncStateStore.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { enqueueMailboxMailOff } from "./mailboxRemovalJob.js";
import { lockMailboxSync, MAILBOX_REMOVAL_SYNC_WAIT_MS } from "./mailboxSyncGuard.js";
import { enqueueMailAccountSync } from "./mailSyncEnqueue.js";

/** What a connect flow writes on a new account. */
export const NEW_MAILBOX_SERVICE_SWITCHES = { mailEnabled: true, calendarsEnabled: false } as const;

/** An absent or `null` value is the default: Mail on. */
export function isMailEnabled(properties: Readonly<Record<string, unknown>>): boolean {
  return properties.mailEnabled !== false;
}

/** An absent or `null` value is the default: Calendars off. */
export function areCalendarsEnabled(properties: Readonly<Record<string, unknown>>): boolean {
  return properties.calendarsEnabled === true;
}

type MailLiveSyncStop = (tenantId: string, mailboxItemId: string) => Promise<void>;

let liveSyncStop: MailLiveSyncStop | undefined;

/**
 * Binds the stop of the process's mail live-sync root (`mailLiveSyncControl` in `semprec-api`). In a process without
 * a binding the account is unhosted by the root's next discovery pass, which skips paused accounts.
 */
export function bindMailboxServiceLiveSyncStop(stop: MailLiveSyncStop | undefined): void {
  liveSyncStop = stop;
}

function isMailboxesDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === MAILBOXES_MODULE_ID;
}

/**
 * Takes the mailbox's sync guard (at most `MAILBOX_REMOVAL_SYNC_WAIT_MS`, then 409 `mailbox_sync_busy`) and then its
 * sync state row before the update locks the Mailboxes item: the order of a removal, so neither a pass nor a removal
 * of this mailbox runs while the switch changes.
 */
export const mailboxServiceItemUpdatePreLockHook: ItemUpdatePreLockHook = async ({
  client,
  database,
  itemId,
  patch,
}) => {
  if (!isMailboxesDatabase(database) || !Object.hasOwn(patch, "mailEnabled")) return;
  await lockMailboxSync(client, itemId, { maxWaitMs: MAILBOX_REMOVAL_SYNC_WAIT_MS });
  await lockMailAccountSyncState(client, itemId);
};

/**
 * Decides by the locked sync state row, not by the previous value, so a repeated write changes nothing.
 *
 * Off: pauses the sync state (seeding a row for a never-connected mailbox), deletes the folder sync states, resolves
 * the mailbox's sync problem, queues the mail-off removal of the account's Emails, Folders and emptied threads, and
 * after the commit stops its live sync. The item, credential, server settings and sync mode stay.
 *
 * On: clears the pause and queues `mailAccountSync`; discovery hosts the live sync again on its next pass.
 */
export const mailboxServiceItemUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  if (!isMailboxesDatabase(database) || !Object.hasOwn(propertiesPatch, "mailEnabled")) return;
  if (isMailEnabled(propertiesPatch)) {
    if (await resumeMailAccountSync(client, item.id)) await enqueueMailAccountSync(client, item.id);
    return;
  }
  const provider = typeof item.properties.provider === "string" ? item.properties.provider : "generic";
  if (!(await pauseMailAccountSync(client, item.id, defaultSyncModeForProvider(provider)))) return;
  const { foldersDatabaseId } = await resolveMailModuleIds(client);
  await deleteMailFolderSyncStatesOfMailbox(client, { foldersDatabaseId, mailboxItemId: item.id });
  await resolveProblem(client, { dedupeKey: mailProblemKey(item.id), resolutionKind: "sourceDeleted" });
  await enqueueMailboxMailOff(client, item.id);
  // The tenant of the scope the write runs in; the pre-lock hook's sync guard already required a tenant scope.
  const scope = currentTenantScope();
  const stop = liveSyncStop;
  if (scope?.kind !== "tenant" || stop === undefined) return;
  const mailboxItemId = item.id;
  runAfterCommit(client, () => {
    // The switch has committed; a failed stop leaves the account to the next discovery pass, so it is logged only.
    stop(scope.tenantId, mailboxItemId).catch((err: unknown) => {
      logger.warn(
        { mailboxItemId, errorName: err instanceof Error ? err.name : typeof err },
        "Mail live-sync stop after Mail was switched off failed",
      );
    });
  });
};
