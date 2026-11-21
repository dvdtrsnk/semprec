import type { GraphMoveResult } from "./mailMoveProviderAdapters.js";
import { hasUnsettledMailMove, protectedMailMovesForPass, type MailMoveBaseline } from "./mailMessageMoveSyncStore.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";
import type { PoolClient } from "pg";
import { deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { ValidationError } from "../errors.js";
import { ensureFolderItem, type ProviderFolder } from "./folderDiscovery.js";
import { ingestEmailMessage } from "./ingest.js";
import { createGraphMailFlagWritebackAdapter } from "./mailFlagWriteback.js";
import { listPendingProviderFlagWrites, recordConfirmedMailMessageFlag } from "./mailMessageFlagSyncStore.js";
import { getMailMessageMetaByProviderMessageId } from "./mailMessageMetaStore.js";
import {
  anchorMailAccountConnection,
  ensureMailAccountSyncState,
  invalidateGraphDeltaLink,
  recordGraphActivity,
} from "./mailAccountSyncStateStore.js";
import { mailArrivalOf } from "./mailArrival.js";
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
  /** true = `410 Gone`/`resyncRequired`; the caller must run a full resync. */
  invalidated: boolean;
  newDeltaLink: string;
  changes: GraphChangedMessage[];
}

export interface GraphMailClient {
  observeMoveMessage?(messageId: string): Promise<GraphMoveResult>;
  moveMessage?(
    messageId: string,
    destination: "archive" | "deleteditems" | "inbox" | "sentitems",
  ): Promise<GraphMoveResult>;
  listFolders(): Promise<GraphFolderRef[]>;
  /** `deltaLink: null` = full mailbox-wide fetch. */
  fetchDelta(deltaLink: string | null): Promise<GraphDeltaResult>;
  patchMessage(
    messageId: string,
    patch: { isRead: boolean } | { flag: { flagStatus: "flagged" | "notFlagged" } },
  ): Promise<void>;
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

/** A Graph mail folder as its Folder item. */
export function graphProviderFolder(folder: GraphFolderRef): ProviderFolder {
  return {
    providerId: folder.id,
    name: folder.displayName,
    behavior: "folder",
    specialPurpose: specialPurposeForGraphFolder(folder),
  };
}

export interface ReconcileGraphAccountParams {
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
 * Graph messages live in exactly one folder; one reappearing under a different `parentFolderId`
 * is a move, so its stale folder edge is dropped. Messages of a delta round started from the stored
 * delta link are reported as new; a delta from scratch (first pass, or after a 410) is backfill.
 *
 * Does not record its own failures: the pass runs in the caller's transaction, so such a write
 * would be rolled back with it. mailSyncJob.ts records sync failures.
 */
export async function reconcileGraphAccount(
  dbClient: PoolClient,
  graph: GraphMailClient,
  params: ReconcileGraphAccountParams,
): Promise<void> {
  await lockMailThreadMutation(dbClient);
  const protectedMoveMessageIds = await protectedMailMovesForPass(
    dbClient,
    params.mailboxItemId,
    params.moveBaseline,
    params.protectedMoveMessageIds,
  );
  const relationDefinition = await getRelationDefinitionByPropertyId(dbClient, params.folderRelationPropertyId);
  if (!relationDefinition)
    throw new ValidationError(`Folder relation property ${params.folderRelationPropertyId} has no relation definition`);

  const state = await ensureMailAccountSyncState(dbClient, { itemId: params.mailboxItemId, syncMode: "graph_api" });
  const connectedAt = await anchorMailAccountConnection(dbClient, params.mailboxItemId);

  const folders = await graph.listFolders();
  const folderItemIdByGraphId = new Map<string, string>();
  for (const folder of folders) {
    const folderItemId = await ensureFolderItem(dbClient, {
      foldersDatabaseId: params.foldersDatabaseId,
      mailboxItemId: params.mailboxItemId,
      mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
      ...graphProviderFolder(folder),
    });
    folderItemIdByGraphId.set(folder.id, folderItemId);
  }

  let delta = await graph.fetchDelta(state.graphDeltaLink);
  let reportedNew = state.graphDeltaLink !== null;
  if (delta.invalidated) {
    reportedNew = false;
    await invalidateGraphDeltaLink(
      dbClient,
      params.mailboxItemId,
      "delta 410 Gone / resyncRequired, running full resync",
    );
    delta = await graph.fetchDelta(null);
  }

  for (const change of delta.changes) {
    if (change.removed) {
      const meta = await getMailMessageMetaByProviderMessageId(dbClient, change.id);
      if (!meta || protectedMoveMessageIds?.has(meta.itemId) || (await hasUnsettledMailMove(dbClient, meta.itemId)))
        continue;
      const edges = await listRelationsForItem(dbClient, relationDefinition.id, meta.itemId);
      for (const edge of edges) {
        const folderItemId = otherSide(edge, meta.itemId);
        await deleteRelationWithClient(
          dbClient,
          {
            relationPropertyId: params.folderRelationPropertyId,
            callerItemId: meta.itemId,
            targetItemId: folderItemId,
          },
          EMAILS_RELATION_CONTEXT,
        );
      }
      continue;
    }

    const folderItemId = change.parentFolderId ? folderItemIdByGraphId.get(change.parentFolderId) : undefined;
    if (!folderItemId || !change.message) continue;

    const result = await ingestEmailMessage(dbClient, {
      arrival: mailArrivalOf({ reportedNew, date: change.message.date, connectedAt }),
      emailsDatabaseId: params.emailsDatabaseId,
      filesDatabaseId: params.filesDatabaseId,
      folderRelationPropertyId: params.folderRelationPropertyId,
      attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
      folderItemId,
      mailboxItemId: params.mailboxItemId,
      protectedMoveMessageIds: protectedMoveMessageIds,
      providerMessageId: change.id,
      storage: params.storage,
      storageKeyPrefix: params.storageKeyPrefix,
      mailboxAliases: params.mailboxAliases,
      ...change.message,
    });

    if (protectedMoveMessageIds?.has(result.itemId) || (await hasUnsettledMailMove(dbClient, result.itemId))) continue;
    const edges = await listRelationsForItem(dbClient, relationDefinition.id, result.itemId);
    for (const edge of edges) {
      const otherFolderId = otherSide(edge, result.itemId);
      if (otherFolderId !== folderItemId) {
        await deleteRelationWithClient(
          dbClient,
          {
            relationPropertyId: params.folderRelationPropertyId,
            callerItemId: result.itemId,
            targetItemId: otherFolderId,
          },
          EMAILS_RELATION_CONTEXT,
        );
      }
    }
  }

  const [folderRelationDefinition, mailboxFolderRelationDefinition] = await Promise.all([
    getRelationDefinitionByPropertyId(dbClient, params.folderRelationPropertyId),
    getRelationDefinitionByPropertyId(dbClient, params.mailboxFolderRelationPropertyId),
  ]);
  if (!folderRelationDefinition || !mailboxFolderRelationDefinition)
    throw new ValidationError("Mail folder relation definitions are missing from the email module schema");
  const writeback = createGraphMailFlagWritebackAdapter(graph);
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

  await recordGraphActivity(dbClient, {
    itemId: params.mailboxItemId,
    deltaLink: delta.newDeltaLink,
    nextExpectedActivityAt: new Date(Date.now() + 15 * 60 * 1000),
  });
}
