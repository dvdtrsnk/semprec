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
  claimMailSyncPass,
  getMailAccountSyncState,
  classifyUnclassifiedMailSyncErrors,
  releaseMailSyncPass,
  renewMailSyncPass,
  requestMailSyncRerun,
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

/**
 * How long a pass's lease outlives its last transaction. The pass renews it in each of its transactions; a holder that
 * died blocks the mailbox's passes for at most this long.
 */
const MAIL_SYNC_PASS_LEASE_MS = 5 * 60 * 1000;

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
  // This run's pass lease (`claimMailSyncPass`); `leased` once it holds it, so every way out releases it.
  const passToken = randomUUID();
  let leased = false;
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
   * Takes the mailbox's sync guard, which a removal and the Mail switch take first, so neither runs until this
   * transaction ends, then re-reads the mailbox and renews the pass lease. `false` (trashed, gone, no sync state row,
   * Mail switched off, or another pass holds the lease now) means the pass does nothing more. An IMAP pass runs it
   * first in each of its transactions, so a removal or the Mail switch can run between them and ends the pass at its
   * next one. The generic trash takes no guard and can still happen during a pass. A guard still held after
   * `MAILBOX_SYNC_PASS_WAIT_MS` throws `MailboxSyncBusyError`: a removal or the Mail switch of this mailbox, or a pass
   * whose lease expired, is running, and the pass is skipped.
   */
  const enterSyncPass = async (client: PoolClient): Promise<boolean> => {
    await lockMailboxSync(client, payload.mailboxItemId, { maxWaitMs: MAILBOX_SYNC_PASS_WAIT_MS });
    const mailbox = await getItemById(client, moduleIds.mailboxesDatabaseId, payload.mailboxItemId);
    if (!mailbox || mailbox.deletedAt) return false;
    const current = await getMailAccountSyncState(client, payload.mailboxItemId);
    if (current === null || current.syncPausedAt !== null) return false;
    return renewMailSyncPass(client, payload.mailboxItemId, passToken, MAIL_SYNC_PASS_LEASE_MS);
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
    // Mail is switched off: nothing is read from the provider and nothing is recorded.
    if (state.syncPausedAt !== null) {
      logger.info({ mailboxItemId: payload.mailboxItemId }, "Mail sync skipped: Mail is switched off for the account");
      return;
    }

    // One pass per mailbox at a time. A trigger while a pass runs (IDLE, push, write-back, sweep) only asks that pass
    // for one more run, which its release enqueues; nothing of the provider is touched here. A Gmail or Graph pass
    // holds the sync state row for its whole transaction: a claim still waiting after `MAILBOX_SYNC_PASS_WAIT_MS`
    // throws `MailboxSyncBusyError` and the trigger is skipped like one that finds the mailbox guard held.
    const claim = await withTransaction(pool, (client) =>
      claimMailSyncPass(client, payload.mailboxItemId, passToken, MAIL_SYNC_PASS_LEASE_MS, {
        maxWaitMs: MAILBOX_SYNC_PASS_WAIT_MS,
      }),
    );
    // The row was there a moment ago: a removal deleted it meanwhile, and there is nothing to sync.
    if (claim === "missing") {
      logger.info({ mailboxItemId: payload.mailboxItemId }, "Mail sync skipped: the sync state is gone");
      return;
    }
    if (claim === "busy") {
      logger.info(
        { mailboxItemId: payload.mailboxItemId },
        "Mail sync coalesced: the running pass of the mailbox runs once more",
      );
      return;
    }
    leased = true;

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
    // Only the user can store a credential again (a sign-in or a password entered again), so a missing one fails the
    // pass as a reauthorization case, whatever the status was.
    if (!credential) {
      throw new MailReauthorizationRequiredError(`Mailbox ${payload.mailboxItemId} has no stored credential`);
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
      // The limiter waits outside any transaction; the pass checks a pooled connection out only for each of its short
      // transactions. Attachment bytes of a failed batch are removed by the pass itself, so it gets the untracked
      // storage: a later failure must not delete the bytes of a batch that committed.
      ran = await imapConnectionLimiter.run(payload.mailboxItemId, connectionLimit, async () => {
        const imap = await adapters.createImapClient!(payload.mailboxItemId, credential);
        try {
          const result = await reconcileImapAccount(pool, imap, {
            ...shared,
            storage,
            pass: {
              enter: enterSyncPass,
              finish: async (client, { complete }) => {
                // The release that follows this pass enqueues the backfill's next pass.
                if (!complete) await requestMailSyncRerun(client, payload.mailboxItemId, passToken);
                // A completed pass, even one that ingested nothing, clears a prior 'error'/'needsReauthorization' and
                // resolves the Semp problem in the same transaction.
                await writeSyncStatus(client, "ok");
                await resolveMailboxProblem(client, payload.mailboxItemId);
              },
            },
          });
          return result.ran;
        } finally {
          // close() never rejects, so the pass's own error still propagates.
          await imap.close();
        }
      });
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
        "Mail sync skipped: the mailbox is in the trash, has no sync state, has Mail switched off or lost its pass lease",
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

    // Provider errors can include complete IMAP/OAuth authentication exchanges: log stable identifiers and a fixed
    // classification, never the raw error or message.
    const failure = { mailboxItemId: payload.mailboxItemId, mailboxProvider, failureKind: mailSyncFailureKind(err) };

    // Only the lease holder records the mailbox's outcome. A job that failed before it held the lease may run beside a
    // pass that does, whose outcome it would overwrite; its failure goes to graphile-worker's retry instead.
    if (!leased) {
      logger.error(
        { ...failure, errorName: err instanceof Error ? err.name : typeof err },
        "Mail sync failed before holding the pass lease",
      );
      throw err;
    }

    // The failure must be recorded in a new transaction; the one that failed is aborted or never existed.
    const message = err instanceof Error ? err.message : String(err);
    logger.error(failure, "Mail sync failed");

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
  } finally {
    if (leased) await releasePassLease(pool, payload.mailboxItemId, passToken);
  }
}

/**
 * Releases the lease and, when a trigger arrived while it was held, enqueues the one follow-up pass in the same
 * transaction. A failure here is logged, not thrown, so it never replaces the pass's own outcome: the lease then
 * expires after `MAIL_SYNC_PASS_LEASE_MS`, and a requested rerun waits for the next trigger or the sweep.
 */
async function releasePassLease(pool: Pool, mailboxItemId: string, passToken: string): Promise<void> {
  try {
    await withTransaction(pool, async (client) => {
      if (await releaseMailSyncPass(client, mailboxItemId, passToken))
        await enqueueMailAccountSync(client, mailboxItemId);
    });
  } catch (error) {
    logger.error(
      { mailboxItemId, errorName: error instanceof Error ? error.name : typeof error },
      "Releasing the mail sync pass lease failed",
    );
  }
}
