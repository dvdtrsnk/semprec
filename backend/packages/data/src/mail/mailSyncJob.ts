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
import { lockMailboxSync } from "./mailboxSyncGuard.js";
import { raiseProblem, resolveProblem } from "../semp/sempProblemsStore.js";
import { mailProblemKey } from "../semp/sourceProblemKeys.js";

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

/** The only key this job is allowed to write on a Mailbox item — `syncStatus` is `owner: 'system'`, and the sync worker is its declared owning process (seedEmailModule.ts). */
const MAILBOX_SYNC_STATUS_ALLOWED_KEYS = ["syncStatus"] as const;

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

/**
 * Clears the mailbox's Semp problem after a completed pass (issue #1506). Callers run it in the same
 * transaction as their `ok` `syncStatus` write; resolving an absent problem changes nothing.
 */
async function resolveMailboxProblem(client: PoolClient, mailboxItemId: string): Promise<void> {
  await resolveProblem(client, { dedupeKey: mailProblemKey(mailboxItemId), resolutionKind: "recovered" });
}

/** Periodic sweep (crontab, `CORE_CRONTAB` in worker.ts): enqueues a sync job for every account whose `next_expected_activity_at` is due — the safety-net reconcile that runs regardless of push-notification reliability. */
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
 * Periodic safety net (crontab, `CORE_CRONTAB` in worker.ts) for `item_search_index` (issue
 * #26: "a periodic reindex job as a safety net for writes outside the standard path —
 * migrations, backfills"). Every ordinary sync-worker write already reindexes itself inside
 * `ingestEmailMessage`'s own transaction; this only ever catches an Emails item that reached
 * `items` through some other path and was never indexed at all. Reindexes from the item's
 * current `name`/`body` properties — a backfilled item has no `mail_attachments` rows to pull
 * PDF/DOCX text from, so this is a plain-text reindex, not a full re-run of ingest.
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
 * Wraps `storage` for the duration of one account's reconcile pass so a failure partway
 * through can clean up after itself: `ingestAttachments` (mail/attachments.ts) writes each
 * attachment's bytes to disk *before* the surrounding DB transaction commits (it needs the
 * resulting byte size/content hash to write the `mail_attachments` row in the same
 * transaction) — if a later message in the same pass then throws, the whole transaction rolls
 * back, but those already-written files are not part of that rollback and would otherwise
 * leak on disk, re-leaking under fresh random keys on every retry. `delete()` is idempotent
 * (`LocalFsBlobStorageWriter` uses `rm(..., { force: true })`), so re-deleting a key
 * `ingestAttachments` itself already cleaned up as a dedup loser is harmless.
 */
function trackWrittenKeys(storage: BlobStorageWriter): { storage: BlobStorageWriter; writtenKeys: Set<string> } {
  const writtenKeys = new Set<string>();
  return {
    writtenKeys,
    storage: {
      async writeStream(storageKey: string, source: Readable) {
        // Recorded before the write, not after it succeeds: `LocalFsBlobStorageWriter` opens
        // the destination file and starts writing before `writeStream` can throw (e.g. disk
        // full partway through), so a mid-write failure still leaves a partial file at this
        // key on disk — tracking early ensures the catch-block cleanup below still finds it.
        writtenKeys.add(storageKey);
        return storage.writeStream(storageKey, source);
      },
      delete: (storageKey: string) => storage.delete(storageKey),
      readStream: (storageKey: string, range?: { start: number; end: number }) => storage.readStream(storageKey, range),
    },
  };
}

/**
 * Dispatches to the account's configured adapter (`mail_account_sync_state.sync_mode`) and
 * runs one full reconcile pass. Each account's reconcile runs inside one DB transaction —
 * acceptable for a single-user mailbox in the thousands-of-messages range this issue targets
 * (the same "revisit only at real growth" judgment call the full-text-search design makes),
 * not a general-purpose bulk-sync architecture.
 */
export interface SyncMailAccountHelpers {
  job: { id: string };
}

/**
 * `helpers` defaults to a freshly generated id: only graphile-worker's real per-attempt job id
 * (threaded through by worker.ts) makes the `mail_sync_error` notification's `transitionInstance`
 * (issue #149) dedupe correctly across retries of the *same* attempt — callers that don't care
 * about that (most of this file's own tests) can omit it entirely, same as `imapConnectionLimiter`
 * below.
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
  // Set from the prologue read below (if it gets that far) so the catch block's connection-limit
  // backoff can still compute a provider-aware delay even though the transaction that read it
  // has since been rolled back.
  let mailboxProvider: string | undefined;
  // The `syncStatus` the prologue read: a pass writes the Mailboxes item only when its outcome
  // differs, so repeated identical passes cause no item update.
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
   * The first statements of a pass's write transaction (issue gh-1690,
   * docs/adr/2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status.md). It takes
   * the mailbox's sync guard, which the removal of the mailbox takes as its first lock too, so no
   * removal runs from here to the end of this transaction. Then it reads the mailbox again, because
   * the prologue's reads are older than this transaction and a removal may have committed since.
   * `false` means there is nothing to sync any more: the Mailboxes item is in the trash or gone, or
   * its `mail_account_sync_state` row is gone. The pass then does no work, so it writes no sync state
   * row for a mailbox the removal emptied. A removed mailbox that was restored is live and has a row
   * again (issue gh-2032, `mailboxRestoreHook.ts`), so this returns `true` for it
   * (docs/adr/2026-11-12-a-restored-mailbox-gets-its-sync-state-and-its-mail-back-in-the-restore-transaction.md).
   * The two reads take no row lock: the guard is what keeps the removal out. The generic trash of the
   * item takes no guard, so it can still happen during a pass, as before.
   */
  const enterSyncPass = async (client: PoolClient): Promise<boolean> => {
    await lockMailboxSync(client, payload.mailboxItemId);
    const mailbox = await getItemById(client, moduleIds.mailboxesDatabaseId, payload.mailboxItemId);
    if (!mailbox || mailbox.deletedAt) return false;
    return (await getMailAccountSyncState(client, payload.mailboxItemId)) !== null;
  };
  try {
    // Its own short, read-only transaction — not part of the write transaction below — because
    // these are plain lookups of stable ids that don't need to be atomic with anything the sync
    // itself writes. Read first (before the `mail_account_sync_state` read and the credential
    // decrypt) so #268's schema-missing check can run before either of those need to succeed.
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

    // A missing or soft-deleted mailbox item is "nothing to sync," not a failure: it's the very
    // row a sync-status write would target, so the catch block's own `updateItemWithClient`
    // would throw `NotFoundError` and roll back `recordSyncError` in the same transaction,
    // leaving a task that can never succeed and that the worker would retry forever. Returning
    // here, before any credential decrypt or provider call, avoids that dead end entirely.
    if (!mailboxItem || mailboxItem.deletedAt) return;

    previousSyncStatus = mailboxItem.properties.syncStatus;
    mailboxProvider = typeof mailboxItem.properties.provider === "string" ? mailboxItem.properties.provider : undefined;

    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, payload.mailboxItemId));
    if (!state)
      throw new Error(`Mailbox ${payload.mailboxItemId} has no mail_account_sync_state row — never connected`);

    // Passed `pool` directly, not wrapped in `withTransaction`: each statement
    // (the access-log insert, then the decrypt) commits independently, so a decrypt failure
    // (wrong key_version, corrupted ciphertext) still leaves the access-attempt logged instead
    // of rolling it back along with the failed decryption — see externalCredentialsStore.ts.
    // Deliberately inside this `try`, not before it: a credential fetch/decrypt failure is
    // just as much a sync failure as anything the reconcile pass itself could throw, and must
    // reach the same `syncStatus`/`last_error` recording below — a mailbox whose credential
    // silently stopped decrypting must not keep showing `syncStatus: 'ok'` forever.
    // An explicit map (not `${state.syncMode}_sync`): `state.syncMode` is already validated
    // against `SYNC_MODES` when the row is read (mailAccountSyncStateStore.ts's `mapRow`), but
    // spelling out every value here means `credential_access_log.purpose` can never carry
    // anything this file didn't itself write, independent of that upstream guarantee.
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
      // Issue gh-2032: the removal writes `needsReauthorization` in the transaction that deletes the
      // credential (`mailboxRemoval.ts`), and a mailbox restored from the trash returns with that
      // status and without a credential. A pass of it is still waiting on the user to sign in, so it
      // fails as a reauthorization case and the catch block below keeps the status. With any other
      // status a missing credential stays the ordinary failure it was
      // (docs/adr/2026-11-12-a-restored-mailbox-gets-its-sync-state-and-its-mail-back-in-the-restore-transaction.md).
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

    // Whether the pass ran: `false` when `enterSyncPass` found nothing to sync any more.
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
      // The limiter's wait for a free slot happens here, outside any transaction — a pooled
      // database connection is only ever checked out once a slot is actually granted, so a
      // long queue wait (up to `ACCOUNT_QUEUE_WAIT_TIMEOUT_MS`) never pins one for nothing.
      ran = await imapConnectionLimiter.run(payload.mailboxItemId, connectionLimit, () =>
        withTransaction(pool, async (client) => {
          // Opened before the transaction's first statement, as before the guard existed: a mailbox removed
          // while this pass waited still costs one connection, which the `finally` below closes.
          const imap = await adapters.createImapClient!(payload.mailboxItemId, credential);
          try {
            if (!(await enterSyncPass(client))) return false;
            await reconcileImapAccount(client, imap, shared);
          } finally {
            // Releases the socket whether the pass completed or threw (issue #1510). close() never rejects,
            // so the pass's own error still propagates to the transaction.
            await imap.close();
          }
          // A completed pass (even one that ingested nothing new) is the user-visible signal
          // that this Mailbox is healthy again — clears a prior 'error'/'needsReauthorization'
          // the same way the internal `mail_account_sync_state.last_error` columns above already do.
          // The Semp problem of this mailbox is resolved in the same transaction (issue #1506).
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
    // Any attachment bytes already written to disk this pass (mail/attachments.ts writes
    // before the DB transaction that references them commits, see trackWrittenKeys above) are
    // not covered by the transaction rollback the error below just triggered — clean them up
    // rather than leaking them, best-effort: a cleanup failure must not mask the original
    // error, which is why it's swallowed here and not awaited into the outer catch.
    await Promise.all([...writtenKeys].map((key) => trackedStorage.delete(key).catch(() => {})));

    // Whatever failed above (state fetch, credential decrypt, or the reconcile pass itself)
    // either ran outside a transaction or inside one this error just aborted — recording the
    // failure needs its own, separate transaction, or an UPDATE inside the aborted one would
    // itself be rolled back along with everything else `withTransaction` undoes.
    const message = err instanceof Error ? err.message : String(err);
    // Provider errors can include complete IMAP/OAuth authentication exchanges. Keep this
    // record diagnosable using stable identifiers and a fixed classification, but never pass
    // the provider's raw error object or message to the logger.
    logger.error(
      { mailboxItemId: payload.mailboxItemId, mailboxProvider, failureKind: mailSyncFailureKind(err) },
      "Mail sync failed",
    );

    if (err instanceof MailConnectionLimitError) {
      // The provider rejected this connection purely for having too many of this account's
      // IMAP sessions open at once — contention, not an account failure — but mail genuinely
      // isn't syncing right now, so `syncStatus` still reflects that exactly like any other
      // failure (and clears back to 'ok' the same way, via the next successful pass); what's
      // different is *how* the retry is scheduled. Recording the backoff through the same
      // `next_expected_activity_at` column the sweep already reads, then returning instead of
      // rethrowing, means the next attempt comes from that one delayed sweep pass rather than
      // also stacking graphile-worker's own immediate retry on top of it — which would just
      // reopen a connection and likely hit the same limit again before it has cleared.
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

    // A revoked credential (issue #26: "a normal state, not a system error") gets its own
    // visible status so the worker's continued (bounded, backed-off) retries read as "waiting
    // on the user," not as a persistent failure indistinguishable from a flaky connection. So
    // does the missing credential of a mailbox that already shows that status (issue gh-2032).
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
      // Issue #1506: the mailbox's one Semp problem, in this same transaction. A revoked credential
      // is critical; any other failure is a warning. `since` is the start of the failure streak. The
      // occurrence key is the job id, so an immediate redelivery of this job adds no occurrence.
      // Reauthorization gets the problem too, though it gets no notification. A null `failingSince`
      // means the state row is gone, so there is nothing to report on.
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
      // Issue #149: same transaction as the error record, so a replayed job (same job id,
      // same `transitionInstance`) never duplicates it. Deliberately not raised for the
      // `MailConnectionLimitError` branch above — that's contention, not a sync failure —
      // nor for `MailReauthorizationRequiredError`: per the comment above, that's "a normal
      // state, not a system error," and its own `needsReauthorization` status already makes
      // it distinguishable from a genuine failure, so notifying with the same "Mail sync
      // failed" title would conflate the two states. Its Semp problem (above) is still raised.
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
