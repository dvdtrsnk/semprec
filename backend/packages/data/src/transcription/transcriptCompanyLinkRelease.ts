// Issue #1697: a transcript's company link ends together with its Event. The company is inherited
// from the transcript's project (rule `transcriptCompanyFromProject`), and that project edge stays
// when the Event goes, so the link rules alone would keep the company following the project. The
// two hooks below end the link in the transaction that removes the Transcripts `event` edge or
// trashes the Event; the company edge is not touched and reads as the transcript's own value from
// then on. No restore hook exists: restoring the Event relinks nothing.
// The edge hook also detaches the removed Event from the transcript's `project` and `people` links.
// The link engine does that only for a link that is `on`; a link the user or Semp had broken would
// keep naming the Event, and a relink would make the transcript follow an Event it has no edge to.
// The trash path needs no such step: the source detach of issue #1656 covers links of any state.
// Registered in `../domainWriteHooks.ts`. Constrained by:
// docs/adr/2026-11-10-transcript-values-are-inherited-by-link-rules-whichever-process-writes-the-edge.md,
// docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md,
// docs/adr/2026-11-07-item-delete-and-restore-domain-hooks.md
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
/** The Transcripts properties whose value link names the Event itself as its source. */
const EVENT_SOURCED_PROPERTY_KEYS = ["project", "people"] as const;

interface TranscriptEventRelation {
  transcriptsDatabaseId: string;
  definitionId: string;
}

/** The Transcripts `event` relation of the caller's tenant, or `null` in a tenant without it. */
async function loadTranscriptEventRelation(client: PoolClient): Promise<TranscriptEventRelation | null> {
  const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  const property = transcripts && (await getPropertyByKey(client, transcripts.id, "event"));
  const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
  if (!transcripts || !property || !definition) return null;
  return { transcriptsDatabaseId: transcripts.id, definitionId: definition.id };
}

/**
 * Deletes the `company` value link of each transcript, with its source rows, through the value-link
 * store. Each link row is locked first, in the order of the transcripts' ids; the transcript rows are
 * not locked here. A transcript without a company link is left alone. The final delete succeeds only
 * when no source row is left, so a link that keeps a source fails the caller's transaction. Returns
 * the ids of the transcripts whose link was deleted.
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
 * Removes `eventId` from the sources of the transcript's `project` and `people` value links, whatever
 * their state, and deletes a link that is left without a source; a link another source still feeds
 * stays. Each link row is locked first. The values are not touched, so they read as the transcript's
 * own once the link is gone. Returns whether a link lost a source.
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
    // Deletes nothing when another source is left: that link stays, with the sources it still has.
    await deleteEmptyValueLink(client, link.id);
    detached = true;
  }
  return detached;
}

/**
 * Tells clients, after the commit, that the live transcripts among `transcriptIds` changed their links,
 * so they refetch them; each transcript is announced once. With a `userId` the announcement goes to that
 * user's sockets only, as other item invalidations do.
 */
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

/**
 * After a Transcripts `event` edge was removed (issue #1530's hook), for the edge's transcript, the one
 * of its two items that is a row of the Transcripts database: detaches the Event, the edge's other
 * item, from the `project` and `people` links, and ends the company link. A transcript whose links
 * changed is announced after the commit.
 */
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

/**
 * For an Event the trash cascade actually trashed (issue #1601's hook): ends the company link of every
 * transcript whose `event` edge points to it, and announces each of those transcripts to the acting user
 * after the commit. The edges themselves stay, as the cascade leaves them.
 */
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
