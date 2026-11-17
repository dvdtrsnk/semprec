import { captureMailMoveBaseline, listPendingMoves } from "./mailMessageMoveSyncStore.js";
import { drainGmailMoves, drainGraphMoves, drainImapMoves } from "./mailMessageMoveSync.js";
import { enqueueMailAccountSync } from "./mailSyncEnqueue.js";
export { enqueueMailAccountSync, mailAccountSyncJobKey } from "./mailSyncEnqueue.js";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { getTenantUserId } from "../auth/usersStore.js";
import { writeNotification } from "../notifications/notify.js";
import { parseAddressListProperty } from "./addressListParsing.js";
import {
  getMailAccountSyncState,
  classifyUnclassifiedMailSyncErrors,
  listAccountsDueForSync,
  recordConnectionLimitBackoff,
  recordSyncError,
  type MailSyncFailureKind,
} from "./mailAccountSyncStateStore.js";
import { reconcileImapAccount, type ImapMailClient } from "./imapReconcile.js";
import { reconcileGmailAccount, type GmailLabelRef, type GmailMailClient } from "./gmailReconcile.js";
import { reconcileGraphAccount, type GraphMailClient } from "./graphReconcile.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import { MailConnectionLimitError, MailReauthorizationRequiredError } from "./providerTypes.js";
import {
  connectionLimitBackoffSecondsForProvider,
  imapConnectionLimitForProvider,
  sharedImapConnectionLimiter,
  type ImapConnectionLimiter,
} from "./imapConnectionLimiter.js";
import { findEmailsMissingSearchIndex, reindexItemSearch } from "./search.js";
import { logger } from "./logger.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { lockMailboxSync, MailboxSyncBusyError } from "./mailboxSyncGuard.js";
import { raiseProblem, resolveProblem } from "../semp/sempProblemsStore.js";
import { mailProblemKey } from "../semp/sourceProblemKeys.js";

/** Real transports are injected by the composition root; this package carries no network-vendor dependency. */
export interface MailSyncAdapterFactory {
  createImapClient?: (mailboxItemId: string, credential: string) => Promise<ImapMailClient>;
  createGmailClient?: (mailboxItemId: string, credential: string) => GmailMailClient;
  loadGmailLabels?: (mailboxItemId: string) => Promise<GmailLabelRef[]>;
  createGraphClient?: (mailboxItemId: string, credential: string) => GraphMailClient;
}

export const noopMailSyncAdapterFactory: MailSyncAdapterFactory = {};

export interface MailModuleIds {
  emailsDatabaseId: string;
  filesDatabaseId: string;
  foldersDatabaseId: string;
  mailboxesDatabaseId: string;
}

/** `syncStatus` is `owner: 'system'`, and the sync worker is its declared owning process. */
const MAILBOX_SYNC_STATUS_ALLOWED_KEYS = ["syncStatus"] as const;

/** How long a pass waits for a mailbox another pass or a removal holds before it is skipped. */
const MAILBOX_SYNC_PASS_WAIT_MS = 5_000;

function mailSyncFailureKind(error: unknown): "connectionLimit" | "reauthorizationRequired" | "unexpected" {
  if (error instanceof MailConnectionLimitError) return "connectionLimit";
  if (error instanceof MailReauthorizationRequiredError) return "reauthorizationRequired";
  return "unexpected";
}

const STORED_FAILURE_KINDS: Record<ReturnType<typeof mailSyncFailureKind>, MailSyncFailureKind> = {
  reauthorizationRequired: "reauthorization",
  connectionLimit: "connectionLimit",
  unexpected: "other",
};

/** Runs in the same transaction as the `ok` `syncStatus` write; resolving an absent problem changes nothing. */
async function resolveMailboxProblem(client: PoolClient, mailboxItemId: string): Promise<void> {
  await resolveProblem(client, { dedupeKey: mailProblemKey(mailboxItemId), resolutionKind: "recovered" });
}

/** Safety-net sweep: enqueues a sync for every account whose `next_expected_activity_at` is due, whatever push does. */
export async function handleMailAccountSyncSweepTask(pool: Pool): Promise<void> {
  await forEachActiveTenant(pool, async () => {
    const due = await withTransaction(pool, (client) => listAccountsDueForSync(client));
    for (const account of due) {
      await enqueueMailAccountSync(pool, account.itemId);
    }
    await withTransaction(pool, (client) => classifyUnclassifiedMailSyncErrors(client));
  });
}

/**
 * Safety net for Emails items that reached `items` outside ingest, which indexes in its own transaction. Plain-text
 * reindex from `name`/`body`.
 */
export async function handleMailSearchReindexSweepTask(pool: Pool): Promise<void> {
  await forEachActiveTenant(pool, () =>
    withTransaction(pool, async (client) => {
      // Resolved per tenant pass: a tenant without mail databases fails only its own pass.
      const { emailsDatabaseId } = await resolveMailModuleIds(client);
      const missing = await findEmailsMissingSearchIndex(client, emailsDatabaseId);
      for (const item of missing) {
        await reindexItemSearch(client, {
          itemId: item.itemId,
          databaseId: emailsDatabaseId,
          text: [item.name ?? "", item.body ?? ""].join("\n\n"),
        });
      }
    }),
  );
}

export interface SyncMailAccountPayload {
  mailboxItemId: string;
}

/**
 * Attachment bytes are written before the DB transaction commits, so a rollback would leak them on disk, under fresh
 * keys on every retry. `delete()` is idempotent.
 */
function trackWrittenKeys(storage: BlobStorageWriter): { storage: BlobStorageWriter; writtenKeys: Set<string> } {
  const writtenKeys = new Set<string>();
  return {
    writtenKeys,
    storage: {
      async writeStream(storageKey: string, source: Readable) {
        // Recorded before the write: a mid-write failure (disk full) still leaves a partial file at this key.
        writtenKeys.add(storageKey);
        return storage.writeStream(storageKey, source);
      },
      delete: (storageKey: string) => storage.delete(storageKey),
      readStream: (storageKey: string, range?: { start: number; end: number }) => storage.readStream(storageKey, range),
    },
  };
}

/** One reconcile pass in one DB transaction per account: fine for a single-user mailbox, not a bulk-sync design. */
export interface SyncMailAccountHelpers {
  job: { id: string };
}

/**
 * Pass graphile-worker's per-attempt job id in `helpers` so the `mail_sync_error` notification's `transitionInstance`
 * dedupes across retries; it defaults to a fresh id.
 */
export async function handleSyncMailAccountTask(
  pool: Pool,
  payload: SyncMailAccountPayload,
  adapters: MailSyncAdapterFactory,
  moduleIds: MailModuleIds,
  storage: BlobStorageWriter,
  helpers: SyncMailAccountHelpers = { job: { id: randomUUID() } },
  imapConnectionLimiter: ImapConnectionLimiter = sharedImapConnectionLimiter,
): Promise<void> {
  const { storage: trackedStorage, writtenKeys } = trackWrittenKeys(storage);
  // Read in the prologue so the catch block can compute a provider-aware backoff after that transaction rolled back.
  let mailboxProvider: string | undefined;
  // A pass writes the Mailboxes item only when its outcome differs, so identical passes cause no item update.
  let previousSyncStatus: unknown;
  const writeSyncStatus = async (client: PoolClient, syncStatus: "ok" | "error" | "needsReauthorization") => {
    if (previousSyncStatus === syncStatus) return;
    await updateItemWithClient(
      client,
      { databaseId: moduleIds.mailboxesDatabaseId, itemId: payload.mailboxItemId, propertiesPatch: { syncStatus } },
      { allowedSystemKeys: MAILBOX_SYNC_STATUS_ALLOWED_KEYS },
    );
  };
  /**
   * Takes the mailbox's sync guard, which a removal takes first, so no removal runs until this transaction ends, then
   * re-reads the mailbox. `false` (trashed, gone, or no sync state row) means the pass does nothing. The generic trash
   * takes no guard and can still happen during a pass. A guard still held after `MAILBOX_SYNC_PASS_WAIT_MS` throws
   * `MailboxSyncBusyError`: another pass or a removal of this mailbox is running, and the pass is skipped.
   */
  const enterSyncPass = async (client: PoolClient): Promise<boolean> => {
    await lockMailboxSync(client, payload.mailboxItemId, { maxWaitMs: MAILBOX_SYNC_PASS_WAIT_MS });
    const mailbox = await getItemById(client, moduleIds.mailboxesDatabaseId, payload.mailboxItemId);
    if (!mailbox || mailbox.deletedAt) return false;
    return (await getMailAccountSyncState(client, payload.mailboxItemId)) !== null;
  };
  try {
    // A short read-only transaction of its own: stable id lookups need no atomicity with the sync's writes. Read first
    // so the schema-missing check runs before the sync state read and the credential decrypt.
    const prologue = await withTransaction(pool, async (client) => {
      const [folderProperty, attachmentsProperty, mailboxFolderProperty, mailboxItem] = await Promise.all([
        getPropertyByKey(client, moduleIds.emailsDatabaseId, "folder"),
        getPropertyByKey(client, moduleIds.emailsDatabaseId, "attachments"),
        getPropertyByKey(client, moduleIds.foldersDatabaseId, "mailbox"),
        getItemById(client, moduleIds.mailboxesDatabaseId, payload.mailboxItemId),
      ]);
      if (!folderProperty || !attachmentsProperty || !mailboxFolderProperty) {
        throw new Error(
          "Email module schema is missing an expected relation property — was seedEmailModuleInTransaction run?",
        );
      }
      return { folderProperty, attachmentsProperty, mailboxFolderProperty, mailboxItem };
    });
    const { folderProperty, attachmentsProperty, mailboxFolderProperty, mailboxItem } = prologue;

    // A missing or deleted mailbox is "nothing to sync", not a failure: the catch block's status write would throw
    // `NotFoundError`, roll back `recordSyncError` and leave a task that retries forever.
    if (!mailboxItem || mailboxItem.deletedAt) return;

    previousSyncStatus = mailboxItem.properties.syncStatus;
    mailboxProvider = typeof mailboxItem.properties.provider === "string" ? mailboxItem.properties.provider : undefined;

    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, payload.mailboxItemId));
    if (!state)
      throw new Error(`Mailbox ${payload.mailboxItemId} has no mail_account_sync_state row — never connected`);

    // Uses `pool`, not a transaction: the access-log insert commits on its own, so a decrypt failure stays logged.
    // Inside the `try` so a credential failure is recorded like any sync failure and the mailbox does not stay `ok`.
    // An explicit map, so `credential_access_log.purpose` only ever carries values written here.
    const syncPurpose: Record<typeof state.syncMode, string> = {
      imap: "imap_sync",
      gmail_api: "gmail_api_sync",
      graph_api: "graph_api_sync",
    };
    const credential = await getDecryptedCredential(pool, {
      itemId: payload.mailboxItemId,
      actorType: "sync_worker",
      purpose: syncPurpose[state.syncMode],
    });
    if (!credential) {
      const missingCredential = `Mailbox ${payload.mailboxItemId} has no stored credential`;
      // A removal writes `needsReauthorization` when it deletes the credential, and a restored mailbox returns with
      // that status and no credential: the pass fails as a reauthorization case so the status is kept. With any other
      // status a missing credential is an ordinary failure.
      if (previousSyncStatus === "needsReauthorization") throw new MailReauthorizationRequiredError(missingCredential);
      throw new Error(missingCredential);
    }

    logger.info({ mailboxItemId: payload.mailboxItemId, syncMode: state.syncMode }, "Mail sync starting");

    const { moveBaseline, movesAtStart } = await withTransaction(pool, async (client) => ({
      moveBaseline: await captureMailMoveBaseline(client, payload.mailboxItemId),
      movesAtStart: await listPendingMoves(client, payload.mailboxItemId),
    }));
    const shared = {
      mailboxItemId: payload.mailboxItemId,
      moveBaseline,
      emailsDatabaseId: moduleIds.emailsDatabaseId,
      filesDatabaseId: moduleIds.filesDatabaseId,
      foldersDatabaseId: moduleIds.foldersDatabaseId,
      folderRelationPropertyId: folderProperty.id,
      mailboxFolderRelationPropertyId: mailboxFolderProperty.id,
      attachmentsRelationPropertyId: attachmentsProperty.id,
      storage: trackedStorage,
      storageKeyPrefix: payload.mailboxItemId,
      mailboxAliases: parseAddressListProperty(mailboxItem.properties.addresses),
    };

    // `false` when `enterSyncPass` found nothing to sync any more.
    let ran: boolean;
    if (state.syncMode === "imap") {
      if (!adapters.createImapClient) throw new Error("No IMAP adapter configured for this composition root");
      const connectionLimit = imapConnectionLimitForProvider(mailboxProvider, mailboxItem.properties.connectionLimit);
      if (
        movesAtStart.some(
          (move) =>
            move.source_evidence.provider === "imap" &&
            move.operation_phase !== "in_flight" &&
            move.operation_phase !== "uncertain",
        )
      ) {
        await imapConnectionLimiter.run(payload.mailboxItemId, connectionLimit, () =>
          drainImapMoves(
            pool,
            payload.mailboxItemId,
            () => adapters.createImapClient!(payload.mailboxItemId, credential),
            moduleIds.foldersDatabaseId,
            mailboxFolderProperty.id,
            folderProperty.id,
          ),
        );
      }
      // The limiter waits outside any transaction; a pooled connection is checked out only once a slot is granted.
      ran = await imapConnectionLimiter.run(payload.mailboxItemId, connectionLimit, () =>
        withTransaction(pool, async (client) => {
          // Opened before the guard: a mailbox removed while this pass waited still costs one connection, which the
          // `finally` closes.
          const imap = await adapters.createImapClient!(payload.mailboxItemId, credential);
          try {
            if (!(await enterSyncPass(client))) return false;
            const { complete } = await reconcileImapAccount(client, imap, shared);
            // Committed with this batch, so the backfill continues as soon as the guard is free.
            if (!complete) await enqueueMailAccountSync(client, payload.mailboxItemId);
          } finally {
            // close() never rejects, so the pass's own error still propagates to the transaction.
            await imap.close();
          }
          // A completed pass, even one that ingested nothing, clears a prior 'error'/'needsReauthorization' and resolves
          // the Semp problem in the same transaction.
          await writeSyncStatus(client, "ok");
          await resolveMailboxProblem(client, payload.mailboxItemId);
          return true;
        }),
      );
    } else if (state.syncMode === "gmail_api") {
      if (!adapters.createGmailClient) throw new Error("No Gmail adapter configured for this composition root");
      const gmail = adapters.createGmailClient(payload.mailboxItemId, credential);
      await drainGmailMoves(pool, payload.mailboxItemId, gmail);
      ran = await withTransaction(pool, async (client) => {
        if (!(await enterSyncPass(client))) return false;
        await reconcileGmailAccount(client, gmail, shared);
        await writeSyncStatus(client, "ok");
        await resolveMailboxProblem(client, payload.mailboxItemId);
        return true;
      });
    } else {
      if (!adapters.createGraphClient) throw new Error("No Graph adapter configured for this composition root");
      const graph = adapters.createGraphClient(payload.mailboxItemId, credential);
      await drainGraphMoves(pool, payload.mailboxItemId, graph, moduleIds.foldersDatabaseId, mailboxFolderProperty.id);
      ran = await withTransaction(pool, async (client) => {
        if (!(await enterSyncPass(client))) return false;
        await reconcileGraphAccount(client, graph, shared);
        await writeSyncStatus(client, "ok");
        await resolveMailboxProblem(client, payload.mailboxItemId);
        return true;
      });
    }
    if (!ran) {
      logger.info(
        { mailboxItemId: payload.mailboxItemId, syncMode: state.syncMode },
        "Mail sync skipped: the mailbox is in the trash or has no sync state",
      );
      return;
    }
    logger.info({ mailboxItemId: payload.mailboxItemId, syncMode: state.syncMode }, "Mail sync completed");
  } catch (err) {
    // Attachment bytes written this pass are not covered by the rollback. Best-effort cleanup: a cleanup failure must
    // not mask the original error.
    await Promise.all([...writtenKeys].map((key) => trackedStorage.delete(key).catch(() => {})));

    // The running pass or removal decides the mailbox's state; this one has nothing to record. The sweep re-enqueues
    // an account that is still due.
    if (err instanceof MailboxSyncBusyError) {
      logger.info({ mailboxItemId: payload.mailboxItemId }, "Mail sync skipped: another pass holds the mailbox");
      return;
    }

    // The failure must be recorded in a new transaction; the one that failed is aborted or never existed.
    const message = err instanceof Error ? err.message : String(err);
    // Provider errors can include complete IMAP/OAuth authentication exchanges: log stable identifiers and a fixed
    // classification, never the raw error or message.
    logger.error(
      { mailboxItemId: payload.mailboxItemId, mailboxProvider, failureKind: mailSyncFailureKind(err) },
      "Mail sync failed",
    );

    if (err instanceof MailConnectionLimitError) {
      // Too many IMAP sessions for this account is contention, not an account failure, but mail is not syncing, so
      // `syncStatus` still records it. The backoff goes into `next_expected_activity_at` for the sweep and the task
      // returns instead of rethrowing, so graphile-worker's immediate retry does not hit the same limit again.
      await withTransaction(pool, async (client) => {
        await recordConnectionLimitBackoff(
          client,
          payload.mailboxItemId,
          message,
          connectionLimitBackoffSecondsForProvider(mailboxProvider),
          STORED_FAILURE_KINDS.connectionLimit,
        );
        await writeSyncStatus(client, "error");
      });
      return;
    }

    // A revoked (or, for a mailbox already in that status, missing) credential is "waiting on the user", shown as its
    // own status rather than a persistent failure.
    const reauthorizationRequired = err instanceof MailReauthorizationRequiredError;
    const syncStatus = reauthorizationRequired ? "needsReauthorization" : "error";
    await withTransaction(pool, async (client) => {
      const failingSince = await recordSyncError(
        client,
        payload.mailboxItemId,
        message,
        STORED_FAILURE_KINDS[mailSyncFailureKind(err)],
      );
      await writeSyncStatus(client, syncStatus);
      const userId = await getTenantUserId(client);
      // The mailbox's one Semp problem, in this same transaction: critical for a revoked credential, else a warning.
      // `since` is the start of the failure streak; the job id as occurrence key keeps a redelivery from adding one.
      // A null `failingSince` means the state row is gone.
      if (userId && failingSince) {
        await raiseProblem(client, {
          userId,
          category: "mail",
          kind: "mailSyncError",
          severity: reauthorizationRequired ? "critical" : "warning",
          sourceTable: "mail_account_sync_state",
          sourceId: payload.mailboxItemId,
          dedupeKey: mailProblemKey(payload.mailboxItemId),
          since: failingSince,
          occurrenceKey: helpers.job.id,
        });
      }
      // Same transaction as the error record, so a replayed job never duplicates it. Not raised for connection-limit
      // contention nor for reauthorization, whose own status already distinguishes it.
      if (userId && !reauthorizationRequired) {
        await writeNotification(client, {
          userId,
          kind: "mail_sync_error",
          linkHref: `?page=mailbox&id=${payload.mailboxItemId}`,
          sourceTable: "mail_account_sync_state",
          sourceId: payload.mailboxItemId,
          transitionInstance: helpers.job.id,
        });
      }
    });
    throw err;
  }
}
