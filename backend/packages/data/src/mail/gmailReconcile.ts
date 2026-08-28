import type { PoolClient } from "pg";
import { deleteRelationWithClient } from "../chokePoint/chokePoint.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { ValidationError } from "../errors.js";
import { ensureFolderItem } from "./folderDiscovery.js";
import { ingestEmailMessage } from "./ingest.js";
import { getMailMessageMetaByProviderMessageId } from "./mailMessageMetaStore.js";
import { listKnownProviderMessagesForFolders } from "./folderMembershipStore.js";
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
  let isFullResync = false;

  if (!state.gmailHistoryId) {
    // historyId captured BEFORE listing, not after: a message arriving in the gap between the
    // two calls would otherwise fall into a permanent blind spot — too new for the full list
    // (which already returned) and, since its historyId is > this captured value, exactly the
    // kind of change listHistorySince(newHistoryId) picks up on the very next incremental pass.
    // The reverse order can only ever double-report a message (harmless — ingestEmailMessage
    // dedups), never lose one.
    newHistoryId = await gmail.getCurrentHistoryId();
    changedIds = await gmail.listAllMessageIds();
    isFullResync = true;
  } else {
    const history = await gmail.listHistorySince(state.gmailHistoryId);
    if (history.invalidated) {
      await invalidateGmailHistory(dbClient, params.mailboxItemId, "history.list: historyId too old, running full resync");
      newHistoryId = await gmail.getCurrentHistoryId();
      changedIds = await gmail.listAllMessageIds();
      isFullResync = true;
    } else {
      changedIds = history.changedMessageIds;
      removedIds = history.removedMessageIds;
      newHistoryId = history.newHistoryId;
    }
  }

  // A full resync (`listAllMessageIds`) only returns what *currently* exists — a message
  // permanently deleted from Gmail since the last known position would otherwise never be
  // visited by the changedIds loop below, leaving its DB item and folder edges dangling
  // forever (the same gap the IMAP adapter closes via `fetchAllUids` vs `listKnownFolderUids`
  // on a server without CONDSTORE).
  if (isFullResync) {
    const known = await listKnownProviderMessagesForFolders(dbClient, relationDefinition.id, [...folderItemIdByLabel.values()]);
    const currentSet = new Set(changedIds);
    const staleIds = known.filter((k) => !currentSet.has(k.providerMessageId)).map((k) => k.providerMessageId);
    removedIds = [...removedIds, ...staleIds];
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
    // "derived from its own liveness semantics" (issue #26): a live watch() renews daily
    // against a 7-day validity, so a wide margin below its expiry is the deadline by which
    // that daily renewal should already have happened; no watch established yet (push setup
    // is a later addition, see PR notes) falls back to this reconcile pass's own cadence.
    nextExpectedActivityAt: state.gmailWatchExpiresAt
      ? new Date(new Date(state.gmailWatchExpiresAt).getTime() - 24 * 60 * 60 * 1000)
      : new Date(Date.now() + 15 * 60 * 1000),
  });
}
