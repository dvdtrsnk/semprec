// A transcript's company link ends together with its Event. The company is inherited from the
// transcript's project, and that project edge stays when the Event goes, so link rules alone would
// keep it. These hooks end the link in the transaction that removes the `event` edge or trashes the
// Event; the company edge stays and reads as the transcript's own value. Restoring relinks nothing.
// The edge hook also detaches the Event from the `project` and `people` links: the link engine does
// that only for an `on` link, and a broken link would otherwise keep naming an Event with no edge.
// The trash path needs no such step: the source detach covers links of any state.
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import type { ItemDeleteHook, RelationEdgeChangedHook } from "../chokePoint/hooks.js";
import { getItemsByIds, getItemsByIdsInDatabaseIncludingDeleted } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import {
  deleteEmptyValueLink,
  listValueLinkSourcesByLinkIds,
  lockValueLink,
  removeValueLinkItemSource,
} from "../chokePoint/valueLinksStore.js";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { EVENTS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

const COMPANY_PROPERTY_KEY = "company";
const EVENT_SOURCED_PROPERTY_KEYS = ["project", "people"] as const;

interface TranscriptEventRelation {
  transcriptsDatabaseId: string;
  definitionId: string;
}

async function loadTranscriptEventRelation(client: PoolClient): Promise<TranscriptEventRelation | null> {
  const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  const property = transcripts && (await getPropertyByKey(client, transcripts.id, "event"));
  const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
  if (!transcripts || !property || !definition) return null;
  return { transcriptsDatabaseId: transcripts.id, definitionId: definition.id };
}

/**
 * Locks each link row first, in transcript id order (transcript rows are not locked). The final
 * delete succeeds only when no source row is left, so a link that keeps a source fails the caller's
 * transaction. Returns the ids whose link was deleted.
 */
async function releaseCompanyLinks(client: PoolClient, transcriptIds: string[]): Promise<string[]> {
  const released: string[] = [];
  for (const transcriptId of [...new Set(transcriptIds)].sort()) {
    const link = await lockValueLink(client, transcriptId, COMPANY_PROPERTY_KEY);
    if (!link) continue;
    for (const source of await listValueLinkSourcesByLinkIds(client, [link.id])) {
      if (source.kind === "item")
        await removeValueLinkItemSource(client, link.id, source.sourceItemId, source.sourcePropertyKey);
    }
    if (!(await deleteEmptyValueLink(client, link.id)))
      throw new Error("Transcript company link kept a source during its release");
    released.push(transcriptId);
  }
  return released;
}

/**
 * Whatever the links' state; a link left without a source is deleted, one another source feeds stays.
 * Each link row is locked first. Values are not touched, so they read as the transcript's own.
 */
async function detachEventFromLinks(client: PoolClient, transcriptId: string, eventId: string): Promise<boolean> {
  let detached = false;
  for (const propertyKey of EVENT_SOURCED_PROPERTY_KEYS) {
    const link = await lockValueLink(client, transcriptId, propertyKey);
    if (!link) continue;
    let removed = false;
    for (const source of await listValueLinkSourcesByLinkIds(client, [link.id])) {
      if (source.kind !== "item" || source.sourceItemId !== eventId) continue;
      removed = (await removeValueLinkItemSource(client, link.id, eventId, source.sourcePropertyKey)) || removed;
    }
    if (!removed) continue;
    await deleteEmptyValueLink(client, link.id);
    detached = true;
  }
  return detached;
}

/** After the commit, each live transcript once; with a `userId` only to that user's sockets. */
async function announceLinkChanges(client: PoolClient, transcriptIds: string[], userId?: string): Promise<void> {
  for (const transcript of await getItemsByIds(client, [...new Set(transcriptIds)])) {
    runAfterCommit(client, () =>
      notifyInvalidation({
        scope: "item",
        databaseId: transcript.databaseId,
        itemId: transcript.id,
        op: "update",
        updatedAt: transcript.updatedAt,
        userId,
      }),
    );
  }
}

export const transcriptCompanyLinkReleaseEdgeChangedHook: RelationEdgeChangedHook = async (context) => {
  if (context.op !== "delete") return;
  const relation = await loadTranscriptEventRelation(context.client);
  if (!relation || relation.definitionId !== context.relationDefinitionId) return;
  const transcripts = await getItemsByIdsInDatabaseIncludingDeleted(context.client, relation.transcriptsDatabaseId, [
    context.itemA,
    context.itemB,
  ]);
  const changed: string[] = [];
  for (const transcript of transcripts) {
    const eventId = transcript.id === context.itemA ? context.itemB : context.itemA;
    if (await detachEventFromLinks(context.client, transcript.id, eventId)) changed.push(transcript.id);
  }
  changed.push(
    ...(await releaseCompanyLinks(
      context.client,
      transcripts.map((transcript) => transcript.id),
    )),
  );
  await announceLinkChanges(context.client, changed);
};

/** Only for an Event the cascade actually trashed; the `event` edges stay, as the cascade leaves them. */
export const transcriptCompanyLinkReleaseItemDeleteHook: ItemDeleteHook = async (context) => {
  if (!context.database.system || context.database.ownerModuleId !== EVENTS_MODULE_ID) return;
  const relation = await loadTranscriptEventRelation(context.client);
  if (!relation) return;
  const edges = await listRelationsForItem(context.client, relation.definitionId, context.item.id);
  const released = await releaseCompanyLinks(
    context.client,
    edges.map((edge) => otherSide(edge, context.item.id)),
  );
  await announceLinkChanges(context.client, released, context.actingUserId);
};
