import type { PoolClient } from "pg";
import { deleteRelationWithClient } from "../chokePoint/chokePoint.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { ValidationError } from "../errors.js";
import { ensureFolderItem } from "./folderDiscovery.js";
import { ingestEmailMessage } from "./ingest.js";
import { getMailMessageMetaByProviderMessageId } from "./mailMessageMetaStore.js";
import { ensureMailAccountSyncState, invalidateGraphDeltaLink, recordGraphActivity } from "./mailAccountSyncStateStore.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import type { FetchedMessage } from "./providerTypes.js";

export interface GraphFolderRef {
  id: string;
  displayName: string;
  wellKnownName?: string;
}

export interface GraphChangedMessage {
  id: string;
  /** Absent when `removed` is true. */
  parentFolderId?: string;
  removed: boolean;
  message?: FetchedMessage;
}

export interface GraphDeltaResult {
  /** true = the stored `deltaLink` came back `410 Gone`/`resyncRequired` — caller must run a full resync. */
  invalidated: boolean;
  newDeltaLink: string;
  changes: GraphChangedMessage[];
}

export interface GraphMailClient {
  listFolders(): Promise<GraphFolderRef[]>;
  /** `deltaLink: null` = initial/full-resync fetch (mailbox-wide `/me/messages/delta`, not per-folder — see the migration's `graph_delta_link` note). */
  fetchDelta(deltaLink: string | null): Promise<GraphDeltaResult>;
}

function specialPurposeForGraphFolder(folder: GraphFolderRef): string {
  const known: Record<string, string> = {
    inbox: "inbox",
    sentitems: "sent",
    junkemail: "junk",
    deleteditems: "trash",
    drafts: "drafts",
    archive: "archive",
  };
  return (folder.wellKnownName && known[folder.wellKnownName.toLowerCase()]) ?? "none";
}

export interface ReconcileGraphAccountParams {
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
 * Graph mail folders are a tree, one message per folder (like IMAP, unlike Gmail's labels) —
 * `/messages/delta`'s `deltaLink` replaces IMAP's UIDVALIDITY/CONDSTORE dance the same way
 * `historyId` does for Gmail. A message reappearing under a different `parentFolderId` is a
 * move: this drops the stale folder edge the same way the vanished/label-diff handling does
 * for the other two adapters.
 */
/**
 * Deliberately does not catch-and-record its own failures: this whole pass runs inside one
 * caller-owned transaction (mailSyncJob.ts), so an error-recording write here would itself be
 * undone by the same rollback that the re-thrown error triggers. See
 * mailSyncJob.ts's `handleSyncMailAccountTask` for where sync failures actually get recorded.
 */
export async function reconcileGraphAccount(dbClient: PoolClient, graph: GraphMailClient, params: ReconcileGraphAccountParams): Promise<void> {
  const relationDefinition = await getRelationDefinitionByPropertyId(dbClient, params.folderRelationPropertyId);
  if (!relationDefinition) throw new ValidationError(`Folder relation property ${params.folderRelationPropertyId} has no relation definition`);

  const state = await ensureMailAccountSyncState(dbClient, { itemId: params.mailboxItemId, syncMode: "graph_api" });

  const folders = await graph.listFolders();
  const folderItemIdByGraphId = new Map<string, string>();
  for (const folder of folders) {
    const folderItemId = await ensureFolderItem(dbClient, {
      foldersDatabaseId: params.foldersDatabaseId,
      mailboxItemId: params.mailboxItemId,
      mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
      providerId: folder.id,
      name: folder.displayName,
      behavior: "folder",
      specialPurpose: specialPurposeForGraphFolder(folder),
    });
    folderItemIdByGraphId.set(folder.id, folderItemId);
  }

  let delta = await graph.fetchDelta(state.graphDeltaLink);
  if (delta.invalidated) {
    await invalidateGraphDeltaLink(dbClient, params.mailboxItemId, "delta 410 Gone / resyncRequired, running full resync");
    delta = await graph.fetchDelta(null);
  }

  for (const change of delta.changes) {
    if (change.removed) {
      const meta = await getMailMessageMetaByProviderMessageId(dbClient, change.id);
      if (!meta) continue;
      const edges = await listRelationsForItem(dbClient, relationDefinition.id, meta.itemId);
      for (const edge of edges) {
        const folderItemId = otherSide(edge, meta.itemId);
        await deleteRelationWithClient(dbClient, { relationPropertyId: params.folderRelationPropertyId, itemId: meta.itemId, targetItemId: folderItemId });
      }
      continue;
    }

    const folderItemId = change.parentFolderId ? folderItemIdByGraphId.get(change.parentFolderId) : undefined;
    if (!folderItemId || !change.message) continue;

    const result = await ingestEmailMessage(dbClient, {
      emailsDatabaseId: params.emailsDatabaseId,
      filesDatabaseId: params.filesDatabaseId,
      folderRelationPropertyId: params.folderRelationPropertyId,
      attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
      folderItemId,
      providerMessageId: change.id,
      storage: params.storage,
      storageKeyPrefix: params.storageKeyPrefix,
      ...change.message,
    });

    const edges = await listRelationsForItem(dbClient, relationDefinition.id, result.itemId);
    for (const edge of edges) {
      const otherFolderId = otherSide(edge, result.itemId);
      if (otherFolderId !== folderItemId) {
        await deleteRelationWithClient(dbClient, { relationPropertyId: params.folderRelationPropertyId, itemId: result.itemId, targetItemId: otherFolderId });
      }
    }
  }

  await recordGraphActivity(dbClient, {
    itemId: params.mailboxItemId,
    deltaLink: delta.newDeltaLink,
    nextExpectedActivityAt: new Date(Date.now() + 15 * 60 * 1000),
  });
}
