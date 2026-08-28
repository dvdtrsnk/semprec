import type { Pool } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { withTransaction } from "../db/pool.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { getMailAccountSyncState, listAccountsDueForSync, recordSyncError } from "./mailAccountSyncStateStore.js";
import { reconcileImapAccount, type ImapMailClient } from "./imapReconcile.js";
import { reconcileGmailAccount, type GmailMailClient } from "./gmailReconcile.js";
import { reconcileGraphAccount, type GraphMailClient } from "./graphReconcile.js";
import type { BlobStorageWriter } from "./blobStorage.js";

/**
 * Real transport connections (imapflow / Gmail REST / Graph REST) are out of `@semprec/data`
 * — this package has no network-vendor dependency beyond the libraries it uses for parsing
 * (mailparser, sanitize-html) — same "inject the real implementation, default to a stub that
 * throws" shape as `LibraryMetadataFetcher` (issue #25). A real composition root supplies its
 * own factory (`ImapFlowMailClient`, `GmailRestClient`, `GraphRestClient`).
 */
export interface MailSyncAdapterFactory {
  createImapClient?: (mailboxItemId: string, credential: string) => Promise<ImapMailClient>;
  createGmailClient?: (mailboxItemId: string, credential: string) => GmailMailClient;
  createGraphClient?: (mailboxItemId: string, credential: string) => GraphMailClient;
}

export const noopMailSyncAdapterFactory: MailSyncAdapterFactory = {};

export interface MailModuleIds {
  emailsDatabaseId: string;
  filesDatabaseId: string;
  foldersDatabaseId: string;
}

export function mailAccountSyncJobKey(mailboxItemId: string): string {
  return `mail-account-sync:${mailboxItemId}`;
}

export async function enqueueMailAccountSync(pool: Pool, mailboxItemId: string): Promise<void> {
  await enqueueJob(pool, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC, { mailboxItemId }, { jobKey: mailAccountSyncJobKey(mailboxItemId), maxAttempts: 3 });
}

/** Periodic sweep (crontab, `CORE_CRONTAB` in worker.ts): enqueues a sync job for every account whose `next_expected_activity_at` is due — the safety-net reconcile that runs regardless of push-notification reliability. */
export async function handleMailAccountSyncSweepTask(pool: Pool): Promise<void> {
  const due = await withTransaction(pool, (client) => listAccountsDueForSync(client));
  for (const account of due) {
    await enqueueMailAccountSync(pool, account.itemId);
  }
}

export interface SyncMailAccountPayload {
  mailboxItemId: string;
}

/**
 * Dispatches to the account's configured adapter (`mail_account_sync_state.sync_mode`) and
 * runs one full reconcile pass. Each account's reconcile runs inside one DB transaction —
 * acceptable for a single-user mailbox in the thousands-of-messages range this issue targets
 * (the same "revisit only at real growth" judgment call the full-text-search design makes),
 * not a general-purpose bulk-sync architecture.
 */
export async function handleSyncMailAccountTask(
  pool: Pool,
  payload: SyncMailAccountPayload,
  adapters: MailSyncAdapterFactory,
  moduleIds: MailModuleIds,
  storage: BlobStorageWriter,
): Promise<void> {
  const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, payload.mailboxItemId));
  if (!state) throw new Error(`Mailbox ${payload.mailboxItemId} has no mail_account_sync_state row — never connected`);

  // Passed `pool` directly, not wrapped in `withTransaction`: each statement
  // (the access-log insert, then the decrypt) commits independently, so a decrypt failure
  // (wrong key_version, corrupted ciphertext) still leaves the access-attempt logged instead
  // of rolling it back along with the failed decryption — see externalCredentialsStore.ts.
  const credential = await getDecryptedCredential(pool, { itemId: payload.mailboxItemId, actorType: "sync_worker", purpose: `${state.syncMode}_sync` });
  if (!credential) throw new Error(`Mailbox ${payload.mailboxItemId} has no stored credential`);

  try {
    await withTransaction(pool, async (client) => {
      const [folderProperty, attachmentsProperty, mailboxFolderProperty] = await Promise.all([
        getPropertyByKey(client, moduleIds.emailsDatabaseId, "folder"),
        getPropertyByKey(client, moduleIds.emailsDatabaseId, "attachments"),
        getPropertyByKey(client, moduleIds.foldersDatabaseId, "mailbox"),
      ]);
      if (!folderProperty || !attachmentsProperty || !mailboxFolderProperty) {
        throw new Error("Email module schema is missing an expected relation property — was seedEmailModuleInTransaction run?");
      }

      const shared = {
        mailboxItemId: payload.mailboxItemId,
        emailsDatabaseId: moduleIds.emailsDatabaseId,
        filesDatabaseId: moduleIds.filesDatabaseId,
        foldersDatabaseId: moduleIds.foldersDatabaseId,
        folderRelationPropertyId: folderProperty.id,
        mailboxFolderRelationPropertyId: mailboxFolderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        storage,
        storageKeyPrefix: payload.mailboxItemId,
      };

      if (state.syncMode === "imap") {
        if (!adapters.createImapClient) throw new Error("No IMAP adapter configured for this composition root");
        const imap = await adapters.createImapClient(payload.mailboxItemId, credential);
        await reconcileImapAccount(client, imap, shared);
      } else if (state.syncMode === "gmail_api") {
        if (!adapters.createGmailClient) throw new Error("No Gmail adapter configured for this composition root");
        const gmail = adapters.createGmailClient(payload.mailboxItemId, credential);
        await reconcileGmailAccount(client, gmail, shared);
      } else {
        if (!adapters.createGraphClient) throw new Error("No Graph adapter configured for this composition root");
        const graph = adapters.createGraphClient(payload.mailboxItemId, credential);
        await reconcileGraphAccount(client, graph, shared);
      }
    });
  } catch (err) {
    // The reconcile pass above ran inside one transaction that this error just aborted —
    // recording that failure needs its own, separate transaction, or the UPDATE recording
    // it would itself be rolled back along with everything else `withTransaction` undoes.
    const message = err instanceof Error ? err.message : String(err);
    await withTransaction(pool, (client) => recordSyncError(client, payload.mailboxItemId, message));
    throw err;
  }
}
