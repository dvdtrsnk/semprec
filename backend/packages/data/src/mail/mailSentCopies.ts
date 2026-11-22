// The Sent copy of a message an SMTP server accepted. IMAP servers do not file sent mail themselves, so the copy is
// recorded in the transaction that records the send and appended by a queue job, at least once and without a
// duplicate.
import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, cancelJob, enqueueJob } from "@semprec/queue";
import { getItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getTenantUserId } from "../auth/usersStore.js";
import { getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction, type Queryable } from "../db/pool.js";
import { raiseProblem, resolveProblem } from "../semp/sempProblemsStore.js";
import { mailSentCopyProblemKey } from "../semp/sourceProblemKeys.js";
import { findFolderBySpecialPurpose } from "./folderDiscovery.js";
import {
  imapConnectionLimitForProvider,
  sharedImapConnectionLimiter,
  type ImapConnectionLimiter,
} from "./imapConnectionLimiter.js";
import { logger } from "./logger.js";
import { getMailAccountSyncState } from "./mailAccountSyncStateStore.js";
import { resolveMailModuleIds, type MailModuleIds } from "./mailModuleIds.js";
import {
  openImapConnection,
  type MailServerConnectionSettings,
  type MailServerCredential,
} from "./mailServerConnections.js";
import { getMailServerSettings } from "./mailServerSettingsStore.js";
import { IMAP_SEEN_FLAG, type WritableImapFlag } from "./messageFlags.js";

/** What the Sent-copy job asks of an IMAP connection. */
export interface SentCopyImapClient {
  /** Whether `path` holds a message whose Message-ID header is `messageId` (`SEARCH HEADER Message-ID`). */
  hasMessageWithId(path: string, messageId: string): Promise<boolean>;
  appendMessage(path: string, raw: Buffer, flags: readonly WritableImapFlag[]): Promise<void>;
  /** Never rejects. */
  close(): Promise<void>;
}

export type SentCopyImapOpener = (
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
) => Promise<SentCopyImapClient>;

/**
 * graphile-worker retries a failed attempt after `exp(attempts)` seconds, so eight attempts span about an hour and a
 * half (a provider outage, a connection slot held by long sync passes); the last one raises the mailbox's problem.
 */
export const MAIL_SENT_COPY_MAX_ATTEMPTS = 8;

export function mailSentCopyJobKey(copyId: string): string {
  return `mail-sent-copy:${copyId}`;
}

export interface PendingSentCopy {
  mailboxItemId: string;
  /** The message's Message-ID header, angle brackets included, as `buildOutgoingMime` wrote it. */
  messageId: string;
  /** The bytes the server accepted. */
  raw: Buffer;
}

/**
 * Records the copy and enqueues its job, keyed per copy, on `client`, so both commit or roll back with the
 * transaction that records the send. A copy of the same message recorded again keeps the first row and its job.
 */
export async function recordPendingSentCopy(client: PoolClient, copy: PendingSentCopy): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO mail_sent_copies (mailbox_item_id, message_id, raw) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, mailbox_item_id, message_id) DO NOTHING RETURNING id`,
    [copy.mailboxItemId, copy.messageId, copy.raw],
  );
  const id =
    inserted.rows[0]?.id ??
    (
      await client.query<{ id: string }>(
        `SELECT id FROM mail_sent_copies
          WHERE tenant_id = app_tenant_default() AND mailbox_item_id = $1 AND message_id = $2`,
        [copy.mailboxItemId, copy.messageId],
      )
    ).rows[0]?.id;
  if (id === undefined) throw new Error("The Sent copy was neither recorded nor found");
  await enqueueSentCopyJob(client, id);
  return id;
}

async function enqueueSentCopyJob(client: PoolClient, copyId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.MAIL_SENT_COPY,
    { copyId },
    { jobKey: mailSentCopyJobKey(copyId), maxAttempts: MAIL_SENT_COPY_MAX_ATTEMPTS },
  );
}

interface StoredSentCopy {
  id: string;
  mailboxItemId: string;
  messageId: string;
  raw: Buffer;
}

async function getSentCopy(db: Queryable, copyId: string): Promise<StoredSentCopy | null> {
  const { rows } = await db.query<{ id: string; mailbox_item_id: string; message_id: string; raw: Buffer }>(
    `SELECT id, mailbox_item_id, message_id, raw FROM mail_sent_copies
      WHERE tenant_id = app_tenant_default() AND id = $1`,
    [copyId],
  );
  const row = rows[0];
  return row ? { id: row.id, mailboxItemId: row.mailbox_item_id, messageId: row.message_id, raw: row.raw } : null;
}

/** `false` when the row is gone already: a mailbox purged since the read took the copy with it. */
async function deleteSentCopy(client: PoolClient, copyId: string): Promise<boolean> {
  const result = await client.query("DELETE FROM mail_sent_copies WHERE tenant_id = app_tenant_default() AND id = $1", [
    copyId,
  ]);
  return result.rowCount === 1;
}

/** `null` when no sync has discovered a Sent folder for this mailbox. */
async function sentFolderPathOf(
  client: PoolClient,
  moduleIds: MailModuleIds,
  mailboxItemId: string,
): Promise<string | null> {
  const mailboxRelation = await getPropertyByKey(client, moduleIds.foldersDatabaseId, "mailbox");
  if (!mailboxRelation) throw new Error("Email module schema is missing the Folders.mailbox relation property");
  const folderId = await findFolderBySpecialPurpose(client, {
    foldersDatabaseId: moduleIds.foldersDatabaseId,
    mailboxRelationPropertyId: mailboxRelation.id,
    mailboxItemId,
    specialPurpose: "sent",
  });
  if (folderId === null) return null;
  const folder = await getItemById(client, moduleIds.foldersDatabaseId, folderId);
  const providerId = folder?.properties.providerId;
  if (typeof providerId !== "string") throw new Error("The Sent folder has no provider path");
  return providerId;
}

export interface MailSentCopyTaskOptions {
  /** graphile-worker's attempt id; the problem's occurrence key, so a redelivery adds none. */
  jobId: string;
  isFinalAttempt: boolean;
  openImap?: SentCopyImapOpener;
  limiter?: ImapConnectionLimiter;
}

/**
 * Appends one recorded copy to the mailbox's Sent folder with `\Seen` and deletes the row. Before the APPEND it
 * searches the folder for the copy's Message-ID and skips the APPEND when the message is there, so a run repeated
 * after an APPEND whose deletion did not commit appends nothing twice. The connection holds the account's IMAP
 * connection slot, as a sync pass does.
 *
 * The copy ends without an APPEND only when the mailbox is gone, in the trash or has Mail switched off: then every
 * copy of the mailbox is dropped and its problem resolved (`dropSentCopiesOfMailbox`), which is logged. Every other failure (no IMAP settings or credential, no Sent folder yet, a refused or failed command)
 * rethrows for graphile-worker's retry with backoff and keeps the row. The final attempt also marks the row failed
 * and raises the mailbox's `mailSentCopyFailed` problem. The next copy of the mailbox that is appended, or its next
 * completed sync pass, gives every failed copy a new job; the problem is resolved once an appended copy leaves no
 * failed one.
 */
export async function handleMailSentCopyTask(
  pool: Pool,
  payload: { copyId: string },
  options: MailSentCopyTaskOptions,
): Promise<void> {
  const copy = await withTransaction(pool, (client) => getSentCopy(client, payload.copyId));
  // Appended by an earlier run, or gone with its mailbox.
  if (copy === null) return;
  try {
    await appendSentCopy(pool, copy, options);
  } catch (error) {
    logger.warn(
      {
        mailboxItemId: copy.mailboxItemId,
        stage: "sent_copy",
        errorName: error instanceof Error ? error.name : typeof error,
        finalAttempt: options.isFinalAttempt,
      },
      "The Sent copy of an accepted message could not be appended",
    );
    // The copy stays for a retry or for the user to see; the original failure is what the queue records.
    if (options.isFinalAttempt) await recordFailedSentCopy(pool, copy, options.jobId);
    throw error;
  }
}

async function appendSentCopy(pool: Pool, copy: StoredSentCopy, options: MailSentCopyTaskOptions): Promise<void> {
  const target = await withTransaction(pool, async (client) => {
    const moduleIds = await resolveMailModuleIds(client);
    const mailbox = await getItemById(client, moduleIds.mailboxesDatabaseId, copy.mailboxItemId);
    const state = await getMailAccountSyncState(client, copy.mailboxItemId);
    if (!mailbox || mailbox.deletedAt || state?.syncPausedAt) return null;
    const provider = typeof mailbox.properties.provider === "string" ? mailbox.properties.provider : undefined;
    return {
      sentPath: await sentFolderPathOf(client, moduleIds, copy.mailboxItemId),
      connectionLimit: imapConnectionLimitForProvider(provider, mailbox.properties.connectionLimit),
    };
  });
  if (target === null) {
    await withTransaction(pool, (client) => dropSentCopiesOfMailbox(client, copy.mailboxItemId));
    return;
  }
  const { sentPath, connectionLimit } = target;
  if (sentPath === null) throw new Error("The mailbox has no Sent folder yet");
  const stored = await getMailServerSettings(pool, copy.mailboxItemId);
  if (!stored?.imap) throw new Error("The mailbox has no IMAP server settings");
  const password = await getDecryptedCredential(pool, {
    itemId: copy.mailboxItemId,
    actorType: "smtp_send",
    purpose: "smtp_sent_copy",
  });
  if (password === null) throw new Error("The mailbox has no stored credential");
  const settings: MailServerConnectionSettings = { endpoint: stored.imap, username: stored.username };
  const openImap = options.openImap ?? openImapConnection;

  await (options.limiter ?? sharedImapConnectionLimiter).run(copy.mailboxItemId, connectionLimit, async () => {
    const imap = await openImap(settings, { password });
    try {
      if (!(await imap.hasMessageWithId(sentPath, copy.messageId))) {
        await imap.appendMessage(sentPath, copy.raw, [IMAP_SEEN_FLAG]);
      }
    } finally {
      await imap.close();
    }
  });

  await withTransaction(pool, async (client) => {
    await deleteSentCopy(client, copy.id);
    // The server takes copies again: the copies that gave up get a new job, and the problem stays until they are in.
    if ((await requeueFailedSentCopies(client, copy.mailboxItemId)) === 0) {
      await resolveProblem(client, {
        dedupeKey: mailSentCopyProblemKey(copy.mailboxItemId),
        resolutionKind: "recovered",
      });
    }
  });
}

/**
 * Gives every copy of the mailbox that gave up a runnable job again (a job that used up its attempts is replaced with
 * a fresh one) and returns how many there were. Called once the account's server answered again: after an appended
 * copy and after a completed sync pass.
 */
export async function requeueFailedSentCopies(client: PoolClient, mailboxItemId: string): Promise<number> {
  // Zero rows is the common case: no copy of the mailbox had given up.
  const requeued = await client.query<{ id: string }>(
    `UPDATE mail_sent_copies SET failed_at = NULL
      WHERE tenant_id = app_tenant_default() AND mailbox_item_id = $1 AND failed_at IS NOT NULL RETURNING id`,
    [mailboxItemId],
  );
  for (const { id } of requeued.rows) {
    // `add_job` keeps a permanently failed job under its key; it is removed so the new one starts at attempt 0.
    await cancelJob(client, mailSentCopyJobKey(id));
    await enqueueSentCopyJob(client, id);
  }
  return requeued.rowCount ?? 0;
}

/**
 * Removes every pending copy of a mailbox that will never be appended (it is gone, in the trash or has Mail switched
 * off) and resolves its Sent-copy problem. Their queued jobs find no row and end.
 */
export async function dropSentCopiesOfMailbox(client: PoolClient, mailboxItemId: string): Promise<void> {
  // Zero rows is the common case: nothing was waiting.
  const dropped = await client.query(
    "DELETE FROM mail_sent_copies WHERE tenant_id = app_tenant_default() AND mailbox_item_id = $1",
    [mailboxItemId],
  );
  if (dropped.rowCount !== 0) {
    logger.info(
      { mailboxItemId, reason: "mailbox_inactive", count: dropped.rowCount },
      "Sent copies are not appended: the mailbox is gone, in the trash or has Mail switched off",
    );
  }
  await resolveProblem(client, { dedupeKey: mailSentCopyProblemKey(mailboxItemId), resolutionKind: "sourceDeleted" });
}

/** The row is kept, marked failed; the mailbox's problem counts this copy once however often the job is redelivered. */
async function recordFailedSentCopy(pool: Pool, copy: StoredSentCopy, jobId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    const marked = await client.query(
      "UPDATE mail_sent_copies SET failed_at = now() WHERE tenant_id = app_tenant_default() AND id = $1",
      [copy.id],
    );
    // A mailbox purged since the read took the copy with it: there is nothing left to report.
    if (marked.rowCount === 0) return;
    const userId = await getTenantUserId(client);
    if (!userId) return;
    await raiseProblem(client, {
      userId,
      category: "mail",
      kind: "mailSentCopyFailed",
      severity: "warning",
      sourceTable: "mail_account_sync_state",
      sourceId: copy.mailboxItemId,
      dedupeKey: mailSentCopyProblemKey(copy.mailboxItemId),
      since: new Date(),
      occurrenceKey: jobId,
    });
  }).catch((recordError: unknown) => {
    // The append's own failure is what the job reports; this one is logged so it is not lost.
    logger.error(
      {
        mailboxItemId: copy.mailboxItemId,
        errorName: recordError instanceof Error ? recordError.name : typeof recordError,
      },
      "Recording a failed Sent copy failed",
    );
  });
}

const RECORD_RETRY_DELAYS_MS = [500, 2_000];

/**
 * For a sender whose send is recorded nowhere else (a queue job sending an invitation): records the copy in its own
 * transaction right after the acceptance, retrying a failed write. It never throws, because a throw would make the
 * queue send the message again; a copy that still could not be recorded is logged as an error.
 */
export async function recordPendingSentCopyAfterSend(
  pool: Pool,
  copy: PendingSentCopy,
  delaysMs: readonly number[] = RECORD_RETRY_DELAYS_MS,
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await withTransaction(pool, (client) => recordPendingSentCopy(client, copy));
      return true;
    } catch (error) {
      const willRetry = attempt < delaysMs.length;
      logger.error(
        {
          mailboxItemId: copy.mailboxItemId,
          errorName: error instanceof Error ? error.name : typeof error,
          attempt: attempt + 1,
          willRetry,
        },
        "A message was sent but its Sent copy could not be recorded",
      );
      if (!willRetry) return false;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}
