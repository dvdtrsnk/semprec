import type { GmailMoveResult } from "./mailMoveProviderAdapters.js";
import { hasUnsettledMailMove, protectedMailMovesForPass, type MailMoveBaseline } from "./mailMessageMoveSyncStore.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";
import type { PoolClient } from "pg";
import { currentTenantScope, TenantScopeMissingError } from "@semprec/shared";
import { deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { ValidationError } from "../errors.js";
import { ensureFolderItem, type ProviderFolder } from "./folderDiscovery.js";
import { ingestEmailMessage } from "./ingest.js";
import { createGmailMailFlagWritebackAdapter } from "./mailFlagWriteback.js";
import { listPendingProviderFlagWrites, recordConfirmedMailMessageFlag } from "./mailMessageFlagSyncStore.js";
import { getMailMessageMetaByProviderMessageId } from "./mailMessageMetaStore.js";
import {
  anchorMailAccountConnection,
  ensureMailAccountSyncState,
  invalidateGmailHistory,
  recordGmailActivity,
} from "./mailAccountSyncStateStore.js";
import { mailArrivalOf } from "./mailArrival.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import type { FetchedMessage } from "./providerTypes.js";

export interface GmailLabelRef {
  id: string;
  name: string;
  /** Gmail `type` field: 'system' labels (INBOX/SENT/...) map to a stable `specialPurpose`; 'user' labels don't. */
  type: "system" | "user";
}

export interface GmailFetchedMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  message: FetchedMessage;
}

export interface GmailHistoryResult {
  /** true = the stored `historyId` is older than what the API retains (`history.list` 404) — caller must run a full resync. */
  invalidated: boolean;
  newHistoryId: string;
  /** Deduplicated by message id; only the latest state matters. */
  changedMessageIds: string[];
  removedMessageIds: string[];
}

export interface GmailMailClient {
  observeMoveMessage?(messageId: string): Promise<GmailMoveResult>;
  applyMoveStep?(messageId: string, step: "trash" | "untrash" | "add_inbox" | "remove_inbox"): Promise<GmailMoveResult>;
  getCurrentHistoryId(): Promise<string>;
  listHistorySince(startHistoryId: string): Promise<GmailHistoryResult>;
  listAllMessageIds(): Promise<string[]>;
  /** null = the message was deleted after the history event. */
  fetchMessage(id: string): Promise<GmailFetchedMessage | null>;
  listLabels(): Promise<GmailLabelRef[]>;
  modifyMessageLabels(messageId: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void>;
}

/** The Gmail system labels that are real places mail lives in; every other system label (UNREAD, STARRED, IMPORTANT, CATEGORY_*, CHAT) is a flag or a tab, not a folder. */
const GMAIL_SYSTEM_FOLDER_PURPOSES: Record<string, string> = {
  INBOX: "inbox",
  SENT: "sent",
  SPAM: "junk",
  TRASH: "trash",
  DRAFT: "drafts",
};

/** The system labels a pass writes as folders; Gmail names a system label by its id. */
export const GMAIL_SYSTEM_FOLDERS: readonly ProviderFolder[] = Object.entries(GMAIL_SYSTEM_FOLDER_PURPOSES).map(
  ([id, specialPurpose]) => ({ providerId: id, name: id, behavior: "label", specialPurpose }),
);

/** Provider id of the synthetic Archive folder (Gmail has no archive label: archived mail is mail without INBOX). */
export const GMAIL_ARCHIVE_PROVIDER_ID = "semprec:archive";

/** Provider ids of the five system labels; a message carrying none of them is archived. */
export const GMAIL_PLACEMENT_LABEL_IDS: readonly string[] = Object.keys(GMAIL_SYSTEM_FOLDER_PURPOSES);

/** Serializes participating Gmail folder writers for one tenant and mailbox until transaction end. */
export async function lockGmailFolderState(client: PoolClient, mailboxItemId: string): Promise<void> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new TenantScopeMissingError("Gmail folder state requires a tenant scope");
  const key = `gmail-folder-state:v1:${scope.tenantId.toLowerCase()}:${mailboxItemId.toLowerCase()}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);
}

function specialPurposeForLabel(label: GmailLabelRef): string {
  return GMAIL_SYSTEM_FOLDER_PURPOSES[label.id] ?? "none";
}

function isFolderLabel(label: GmailLabelRef): boolean {
  return label.type === "user" || Object.hasOwn(GMAIL_SYSTEM_FOLDER_PURPOSES, label.id);
}

export interface ReconcileGmailAccountParams {
  mailboxItemId: string;
  protectedMoveMessageIds?: ReadonlySet<string>;
  moveBaseline?: MailMoveBaseline;
  emailsDatabaseId: string;
  filesDatabaseId: string;
  foldersDatabaseId: string;
  folderRelationPropertyId: string;
  mailboxFolderRelationPropertyId: string;
  attachmentsRelationPropertyId: string;
  storage: BlobStorageWriter;
  storageKeyPrefix: string;
  /** This mailbox's registered addresses, used as deliveredToAddress's alias fallback. Defaults to `[]`. */
  mailboxAliases?: string[];
}

/**
 * One Gmail message keeps one id across all its labels, so it is ingested once (deduped by
 * Message-ID) and linked to every mapped label's Folder; edges for labels it no longer carries
 * are removed. Messages reached through `history.list` from the stored history id are reported
 * as new; the full listing of a first pass or a resync after history invalidation is backfill.
 *
 * Does not record its own failures: the pass runs in the caller's transaction, so such a write
 * would be rolled back with it. mailSyncJob.ts records sync failures.
 */
export async function reconcileGmailAccount(
  dbClient: PoolClient,
  gmail: GmailMailClient,
  params: ReconcileGmailAccountParams,
): Promise<void> {
  await lockMailThreadMutation(dbClient);
  const protectedMoveMessageIds = await protectedMailMovesForPass(
    dbClient,
    params.mailboxItemId,
    params.moveBaseline,
    params.protectedMoveMessageIds,
  );
  await lockGmailFolderState(dbClient, params.mailboxItemId);
  const relationDefinition = await getRelationDefinitionByPropertyId(dbClient, params.folderRelationPropertyId);
  if (!relationDefinition)
    throw new ValidationError(`Folder relation property ${params.folderRelationPropertyId} has no relation definition`);

  const state = await ensureMailAccountSyncState(dbClient, { itemId: params.mailboxItemId, syncMode: "gmail_api" });
  const connectedAt = await anchorMailAccountConnection(dbClient, params.mailboxItemId);

  const labels = await gmail.listLabels();
  const folderItemIdByLabel = new Map<string, string>();
  for (const label of labels) {
    if (!isFolderLabel(label)) continue;
    const folderItemId = await ensureFolderItem(dbClient, {
      foldersDatabaseId: params.foldersDatabaseId,
      mailboxItemId: params.mailboxItemId,
      mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
      providerId: label.id,
      name: label.name,
      behavior: "label",
      specialPurpose: specialPurposeForLabel(label),
    });
    folderItemIdByLabel.set(label.id, folderItemId);
  }
  const archiveFolderItemId = await ensureFolderItem(dbClient, {
    foldersDatabaseId: params.foldersDatabaseId,
    mailboxItemId: params.mailboxItemId,
    mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
    providerId: GMAIL_ARCHIVE_PROVIDER_ID,
    name: "Archive",
    behavior: "label",
    specialPurpose: "archive",
  });

  let changedIds: string[];
  let removedIds: string[] = [];
  let newHistoryId: string;
  let reportedNew = false;

  if (!state.gmailHistoryId) {
    // Capture the cursor before listing: a message arriving in between is then re-observed
    // next pass (deduped by Message-ID) instead of being skipped forever.
    newHistoryId = await gmail.getCurrentHistoryId();
    changedIds = await gmail.listAllMessageIds();
  } else {
    const history = await gmail.listHistorySince(state.gmailHistoryId);
    if (history.invalidated) {
      await invalidateGmailHistory(
        dbClient,
        params.mailboxItemId,
        "history.list: historyId too old, running full resync",
      );
      newHistoryId = await gmail.getCurrentHistoryId();
      changedIds = await gmail.listAllMessageIds();
    } else {
      changedIds = history.changedMessageIds;
      removedIds = history.removedMessageIds;
      newHistoryId = history.newHistoryId;
      reportedNew = true;
    }
  }

  for (const id of changedIds) {
    const fetched = await gmail.fetchMessage(id);
    if (!fetched) continue;

    const mappedFolderIds = fetched.labelIds
      .map((labelId) => folderItemIdByLabel.get(labelId))
      .filter((v): v is string => Boolean(v));
    // No INBOX/SPAM/TRASH/SENT/DRAFT label = archived (also a message with no labels at all).
    if (!fetched.labelIds.some((labelId) => GMAIL_PLACEMENT_LABEL_IDS.includes(labelId)))
      mappedFolderIds.push(archiveFolderItemId);
    let itemId: string | null = null;
    const arrival = mailArrivalOf({ reportedNew, date: fetched.message.date, connectedAt });
    for (const folderItemId of mappedFolderIds) {
      const result = await ingestEmailMessage(dbClient, {
        arrival,
        emailsDatabaseId: params.emailsDatabaseId,
        filesDatabaseId: params.filesDatabaseId,
        folderRelationPropertyId: params.folderRelationPropertyId,
        attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
        folderItemId,
        mailboxItemId: params.mailboxItemId,
        protectedMoveMessageIds: protectedMoveMessageIds,
        providerMessageId: fetched.id,
        providerThreadId: fetched.threadId,
        storage: params.storage,
        storageKeyPrefix: params.storageKeyPrefix,
        mailboxAliases: params.mailboxAliases,
        ...fetched.message,
      });
      itemId = result.itemId;
    }

    // A message mapping to no known Folder is not ingested above, but if already known its
    // stale folder edges still need dropping.
    if (!itemId) {
      const existing = await getMailMessageMetaByProviderMessageId(dbClient, fetched.id);
      itemId = existing?.itemId ?? null;
    }

    if (itemId && !protectedMoveMessageIds?.has(itemId) && !(await hasUnsettledMailMove(dbClient, itemId))) {
      const currentEdges = await listRelationsForItem(dbClient, relationDefinition.id, itemId);
      const mappedSet = new Set(mappedFolderIds);
      for (const edge of currentEdges) {
        const folderItemId = otherSide(edge, itemId);
        if (!mappedSet.has(folderItemId)) {
          await deleteRelationWithClient(
            dbClient,
            { relationPropertyId: params.folderRelationPropertyId, callerItemId: itemId, targetItemId: folderItemId },
            EMAILS_RELATION_CONTEXT,
          );
        }
      }
    }
  }

  for (const id of removedIds) {
    const meta = await getMailMessageMetaByProviderMessageId(dbClient, id);
    if (!meta || protectedMoveMessageIds?.has(meta.itemId) || (await hasUnsettledMailMove(dbClient, meta.itemId)))
      continue;
    const currentEdges = await listRelationsForItem(dbClient, relationDefinition.id, meta.itemId);
    for (const edge of currentEdges) {
      const folderItemId = otherSide(edge, meta.itemId);
      await deleteRelationWithClient(
        dbClient,
        { relationPropertyId: params.folderRelationPropertyId, callerItemId: meta.itemId, targetItemId: folderItemId },
        EMAILS_RELATION_CONTEXT,
      );
    }
  }

  const [folderRelationDefinition, mailboxFolderRelationDefinition] = await Promise.all([
    getRelationDefinitionByPropertyId(dbClient, params.folderRelationPropertyId),
    getRelationDefinitionByPropertyId(dbClient, params.mailboxFolderRelationPropertyId),
  ]);
  if (!folderRelationDefinition || !mailboxFolderRelationDefinition)
    throw new ValidationError("Mail folder relation definitions are missing from the email module schema");
  const writeback = createGmailMailFlagWritebackAdapter(gmail);
  for (const pending of await listPendingProviderFlagWrites(dbClient, {
    folderRelationDefinitionId: folderRelationDefinition.id,
    mailboxFolderRelationDefinitionId: mailboxFolderRelationDefinition.id,
    mailboxItemId: params.mailboxItemId,
  })) {
    if (
      protectedMoveMessageIds?.has(pending.messageItemId) ||
      (await hasUnsettledMailMove(dbClient, pending.messageItemId))
    )
      continue;
    if ((await writeback.write(pending)) === "applied")
      await recordConfirmedMailMessageFlag(dbClient, pending.messageItemId, pending.propertyKey, pending.desiredState);
  }

  await recordGmailActivity(dbClient, {
    itemId: params.mailboxItemId,
    historyId: newHistoryId,
    // Renewed daily elsewhere (the watch-renewal job); this call only advances liveness bookkeeping.
    nextExpectedActivityAt: new Date(Date.now() + 15 * 60 * 1000),
  });
}
