import type { PoolClient } from "pg";
import { deleteRelationWithClient } from "../chokePoint/chokePoint.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { ValidationError } from "../errors.js";
import { ensureFolderItem } from "./folderDiscovery.js";
import { ingestEmailMessage } from "./ingest.js";
import { getMailMessageMetaByProviderMessageId } from "./mailMessageMetaStore.js";
import { ensureMailAccountSyncState, invalidateGmailHistory, recordGmailActivity } from "./mailAccountSyncStateStore.js";
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
  /** Deduplicated by message id — a message can appear more than once in one `history.list` window (added, then label-changed); only its latest known state matters here. */
  changedMessageIds: string[];
  removedMessageIds: string[];
}

export interface GmailMailClient {
  /** Used only when no `historyId` is stored yet (first sync, or right after an invalidation-triggered reset). */
  getCurrentHistoryId(): Promise<string>;
  listHistorySince(startHistoryId: string): Promise<GmailHistoryResult>;
  /** All Mail, full resync path. */
  listAllMessageIds(): Promise<string[]>;
  /** null = the message no longer exists (raced with a delete between the history event and this fetch). */
  fetchMessage(id: string): Promise<GmailFetchedMessage | null>;
  listLabels(): Promise<GmailLabelRef[]>;
}

function specialPurposeForLabel(label: GmailLabelRef): string {
  const known: Record<string, string> = { INBOX: "inbox", SENT: "sent", SPAM: "junk", TRASH: "trash", DRAFT: "drafts" };
  return known[label.id] ?? "none";
}

export interface ReconcileGmailAccountParams {
  mailboxItemId: string;
  emailsDatabaseId: string;
  filesDatabaseId: string;
  foldersDatabaseId: string;
  folderRelationPropertyId: string;
  mailboxFolderRelationPropertyId: string;
  attachmentsRelationPropertyId: string;
  storage: BlobStorageWriter;
  storageKeyPrefix: string;
}

/**
 * Gmail's history/labelIds model (issue #26): `historyId` + `history.list` replaces IMAP's
 * UIDVALIDITY/CONDSTORE dance in one call; a message's `labelIds` replace per-folder UIDs
 * entirely — the *same* message keeps one id across every label it carries, so this ingests
 * it once (by `Message-ID`, via `ingestEmailMessage`'s own dedup) and links it to every
 * mapped label's Folder item, removing any Folder edge for a label the message no longer
 * carries — the Gmail-side equivalent of IMAP's VANISHED/UID-diff handling.
 */
/**
 * Deliberately does not catch-and-record its own failures: this whole pass runs inside one
 * caller-owned transaction (mailSyncJob.ts), so an error-recording write here would itself be
 * undone by the same rollback that the re-thrown error triggers. See
 * mailSyncJob.ts's `handleSyncMailAccountTask` for where sync failures actually get recorded.
 */
export async function reconcileGmailAccount(dbClient: PoolClient, gmail: GmailMailClient, params: ReconcileGmailAccountParams): Promise<void> {
  const relationDefinition = await getRelationDefinitionByPropertyId(dbClient, params.folderRelationPropertyId);
  if (!relationDefinition) throw new ValidationError(`Folder relation property ${params.folderRelationPropertyId} has no relation definition`);

  const state = await ensureMailAccountSyncState(dbClient, { itemId: params.mailboxItemId, syncMode: "gmail_api" });

  const labels = await gmail.listLabels();
  const folderItemIdByLabel = new Map<string, string>();
  for (const label of labels) {
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

  let changedIds: string[];
  let removedIds: string[] = [];
  let newHistoryId: string;

  if (!state.gmailHistoryId) {
    // The cursor is captured *before* listing, not after: a message arriving in the gap
    // between the two calls would otherwise be silently skipped forever — it wouldn't be in
    // this pass's listAllMessageIds() result (already fetched), yet newHistoryId would already
    // be past it, so the next incremental history.list() would never surface it either.
    // Capturing first means the worst case is re-observing that message on the next pass
    // (harmless — ingestEmailMessage dedups by Message-ID), not losing it.
    newHistoryId = await gmail.getCurrentHistoryId();
    changedIds = await gmail.listAllMessageIds();
  } else {
    const history = await gmail.listHistorySince(state.gmailHistoryId);
    if (history.invalidated) {
      await invalidateGmailHistory(dbClient, params.mailboxItemId, "history.list: historyId too old, running full resync");
      newHistoryId = await gmail.getCurrentHistoryId();
      changedIds = await gmail.listAllMessageIds();
    } else {
      changedIds = history.changedMessageIds;
      removedIds = history.removedMessageIds;
      newHistoryId = history.newHistoryId;
    }
  }

  for (const id of changedIds) {
    const fetched = await gmail.fetchMessage(id);
    if (!fetched) continue;

    const mappedFolderIds = fetched.labelIds.map((labelId) => folderItemIdByLabel.get(labelId)).filter((v): v is string => Boolean(v));
    let itemId: string | null = null;
    for (const folderItemId of mappedFolderIds) {
      const result = await ingestEmailMessage(dbClient, {
        emailsDatabaseId: params.emailsDatabaseId,
        filesDatabaseId: params.filesDatabaseId,
        folderRelationPropertyId: params.folderRelationPropertyId,
        attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
        folderItemId,
        providerMessageId: fetched.id,
        providerThreadId: fetched.threadId,
        storage: params.storage,
        storageKeyPrefix: params.storageKeyPrefix,
        ...fetched.message,
      });
      itemId = result.itemId;
    }

    // A message whose current labelIds map to zero known Folder items (e.g. it lost every
    // label it had, or briefly carries one this pass hasn't discovered yet) is never ingested
    // fresh above — but if it was already known from a prior pass, its stale folder edges
    // still need dropping, the same as any other label removal.
    if (!itemId) {
      const existing = await getMailMessageMetaByProviderMessageId(dbClient, fetched.id);
      itemId = existing?.itemId ?? null;
    }

    // Drop any folder edge for a label this message no longer carries.
    if (itemId) {
      const currentEdges = await listRelationsForItem(dbClient, relationDefinition.id, itemId);
      const mappedSet = new Set(mappedFolderIds);
      for (const edge of currentEdges) {
        const folderItemId = otherSide(edge, itemId);
        if (!mappedSet.has(folderItemId)) {
          await deleteRelationWithClient(dbClient, { relationPropertyId: params.folderRelationPropertyId, itemId, targetItemId: folderItemId });
        }
      }
    }
  }

  for (const id of removedIds) {
    const meta = await getMailMessageMetaByProviderMessageId(dbClient, id);
    if (!meta) continue;
    const currentEdges = await listRelationsForItem(dbClient, relationDefinition.id, meta.itemId);
    for (const edge of currentEdges) {
      const folderItemId = otherSide(edge, meta.itemId);
      await deleteRelationWithClient(dbClient, { relationPropertyId: params.folderRelationPropertyId, itemId: meta.itemId, targetItemId: folderItemId });
    }
  }

  await recordGmailActivity(dbClient, {
    itemId: params.mailboxItemId,
    historyId: newHistoryId,
    // Renewed daily elsewhere (the watch-renewal job); this call only advances liveness bookkeeping.
    nextExpectedActivityAt: new Date(Date.now() + 15 * 60 * 1000),
  });
}
