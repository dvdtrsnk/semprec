import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { writeComputed } from "../chokePoint/itemsStore.js";
import { notifyInvalidation } from "../realtimeHook.js";
import {
  INBOX_MODULE_ID,
  INBOX_ITEM_TYPES_MODULE_ID,
  PROCESSING_PROPOSALS_MODULE_ID,
} from "../seed/inboxPipelineKeys.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { DatabaseRow } from "../types.js";

/**
 * `items.computed` key (issue #106) each Journal day item caches its rendered-ready list of
 * related Inbox items under — declared into the seed's `ComputedKeyRegistry` (see
 * seed/seedInboxPipeline.ts) so a colliding regular property key on Journal is refused.
 */
export const JOURNAL_INBOX_COMPUTED_KEY = "inboxItems";

/** One Inbox item's derived, display-ready shape — canonical keys/enum values only (issue #106's "keep canonical stored keys English"); locale labels are resolved client-side. */
export interface JournalInboxItemSummary {
  id: string;
  date: string | null;
  time: string | null;
  text: string | null;
  type: { id: string; name: string; emoji: string } | null;
  /** The item's current processing-proposal status (see inbox/inboxTypesStore.ts), or null before a proposal exists. */
  status: string | null;
}

interface InboxPipelineDatabases {
  inbox: DatabaseRow;
  inboxItemTypes: DatabaseRow;
  processingProposals: DatabaseRow;
  journal: DatabaseRow;
}

async function resolveInboxPipelineDatabases(client: PoolClient): Promise<InboxPipelineDatabases | null> {
  const [inbox, inboxItemTypes, processingProposals, journal] = await Promise.all([
    databasesStore.getDatabaseByModuleId(client, INBOX_MODULE_ID),
    databasesStore.getDatabaseByModuleId(client, INBOX_ITEM_TYPES_MODULE_ID),
    databasesStore.getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID),
    databasesStore.getDatabaseByModuleId(client, JOURNAL_MODULE_ID),
  ]);
  if (!inbox || !inboxItemTypes || !processingProposals || !journal) return null;
  return { inbox, inboxItemTypes, processingProposals, journal };
}

/** The Journal day item id a given Inbox item's `journalDay` relation edge points at, or null if unresolved. */
async function resolveJournalDayItemId(
  client: PoolClient,
  inboxDatabaseId: string,
  inboxItemId: string,
): Promise<string | null> {
  const journalDayProperty = await propertiesStore.getPropertyByKey(client, inboxDatabaseId, "journalDay");
  if (!journalDayProperty) return null;
  const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, journalDayProperty.id);
  if (!relationDefinition) return null;
  const edges = await relationsStore.listRelationsForItem(client, relationDefinition.id, inboxItemId);
  const edge = edges[0];
  return edge ? relationsStore.otherSide(edge, inboxItemId) : null;
}

/** The Inbox item id a given Processing proposal's `sourceInbox` relation edge points at, or null (e.g. a `kind: 'transcript'` proposal has none). */
async function resolveSourceInboxItemId(
  client: PoolClient,
  processingProposalsDatabaseId: string,
  proposalId: string,
): Promise<string | null> {
  const sourceInboxProperty = await propertiesStore.getPropertyByKey(
    client,
    processingProposalsDatabaseId,
    "sourceInbox",
  );
  if (!sourceInboxProperty) return null;
  const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, sourceInboxProperty.id);
  if (!relationDefinition) return null;
  const edges = await relationsStore.listRelationsForItem(client, relationDefinition.id, proposalId);
  const edge = edges[0];
  return edge ? relationsStore.otherSide(edge, proposalId) : null;
}

/** Builds the display-ready Inbox-item list for one Journal day, querying Inbox purely through its `journalDay` relation (issue #106). */
async function computeJournalInboxItems(
  client: PoolClient,
  databases: InboxPipelineDatabases,
  journalDayItemId: string,
): Promise<JournalInboxItemSummary[]> {
  const journalDayProperty = await propertiesStore.getPropertyByKey(client, databases.inbox.id, "journalDay");
  if (!journalDayProperty) return [];
  const journalDayRelationDefinition = await relationsStore.getRelationDefinitionByPropertyId(
    client,
    journalDayProperty.id,
  );
  if (!journalDayRelationDefinition) return [];

  const dayEdges = await relationsStore.listRelationsForItem(client, journalDayRelationDefinition.id, journalDayItemId);
  const inboxItemIds = dayEdges.map((edge) => relationsStore.otherSide(edge, journalDayItemId));
  if (inboxItemIds.length === 0) return [];

  // Excludes soft-deleted Inbox items (issue #106's "cached state updates after ... deletion") — getItemsByIds filters deleted_at.
  const items = await itemsStore.getItemsByIds(client, inboxItemIds);

  const typeProperty = await propertiesStore.getPropertyByKey(client, databases.inbox.id, "type");
  const typeRelationDefinition = typeProperty
    ? await relationsStore.getRelationDefinitionByPropertyId(client, typeProperty.id)
    : null;

  const sourceInboxProperty = await propertiesStore.getPropertyByKey(
    client,
    databases.processingProposals.id,
    "sourceInbox",
  );
  const sourceInboxRelationDefinition = sourceInboxProperty
    ? await relationsStore.getRelationDefinitionByPropertyId(client, sourceInboxProperty.id)
    : null;

  const summaries: JournalInboxItemSummary[] = [];
  for (const item of items) {
    let type: JournalInboxItemSummary["type"] = null;
    if (typeRelationDefinition) {
      const edges = await relationsStore.listRelationsForItem(client, typeRelationDefinition.id, item.id);
      const edge = edges[0];
      if (edge) {
        const typeItem = await itemsStore.getItemById(
          client,
          databases.inboxItemTypes.id,
          relationsStore.otherSide(edge, item.id),
        );
        if (typeItem && !typeItem.deletedAt) {
          type = {
            id: typeItem.id,
            name: typeof typeItem.properties.name === "string" ? typeItem.properties.name : "",
            emoji: typeof typeItem.properties.emoji === "string" ? typeItem.properties.emoji : "",
          };
        }
      }
    }

    let status: string | null = null;
    if (sourceInboxRelationDefinition) {
      const edges = await relationsStore.listRelationsForItem(client, sourceInboxRelationDefinition.id, item.id);
      for (const edge of edges) {
        const proposal = await itemsStore.getItemById(
          client,
          databases.processingProposals.id,
          relationsStore.otherSide(edge, item.id),
        );
        if (proposal && !proposal.deletedAt) {
          status = typeof proposal.properties.status === "string" ? proposal.properties.status : null;
          break;
        }
      }
    }

    summaries.push({
      id: item.id,
      date: typeof item.properties.date === "string" ? item.properties.date : null,
      time: typeof item.properties.time === "string" ? item.properties.time : null,
      text: typeof item.properties.text === "string" ? item.properties.text : null,
      type,
      status,
    });
  }

  summaries.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  return summaries;
}

export function journalInboxRecomputeJobKey(journalDayItemId: string): string {
  return `journal-inbox-recompute:${journalDayItemId}`;
}

/** Enqueues a recompute of one Journal day's cached Inbox-item list; must be called in the same transaction as the triggering write (mirrors rollup/recompute.ts's `enqueueRollupRecompute`). */
export async function enqueueJournalInboxRecompute(client: PoolClient, journalDayItemId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE,
    { journalDayItemId },
    { jobKey: journalInboxRecomputeJobKey(journalDayItemId), maxAttempts: 3 },
  );
}

/** Resolves `inboxItemId`'s Journal day and enqueues its recompute; a no-op if the pipeline databases or the day edge aren't resolvable. */
export async function enqueueJournalInboxRecomputeForInboxItem(client: PoolClient, inboxItemId: string): Promise<void> {
  const databases = await resolveInboxPipelineDatabases(client);
  if (!databases) return;
  const journalDayItemId = await resolveJournalDayItemId(client, databases.inbox.id, inboxItemId);
  if (!journalDayItemId) return;
  await enqueueJournalInboxRecompute(client, journalDayItemId);
}

/** Resolves `proposalId`'s source Inbox item (via `sourceInbox`) and its Journal day, then enqueues that day's recompute — for confirm/reject/revise (issue #105), which touch the proposal, not the Inbox item itself. */
export async function enqueueJournalInboxRecomputeForProposal(client: PoolClient, proposalId: string): Promise<void> {
  const databases = await resolveInboxPipelineDatabases(client);
  if (!databases) return;
  const inboxItemId = await resolveSourceInboxItemId(client, databases.processingProposals.id, proposalId);
  if (!inboxItemId) return;
  const journalDayItemId = await resolveJournalDayItemId(client, databases.inbox.id, inboxItemId);
  if (!journalDayItemId) return;
  await enqueueJournalInboxRecompute(client, journalDayItemId);
}

/** The actual recompute: one query for the day's Inbox items, written to `items.computed` (issue #106), always a full recompute of one day's cell — mirrors rollup/recompute.ts's `recomputeRollupCell`. */
export async function recomputeJournalInboxDay(pool: Pool, journalDayItemId: string): Promise<void> {
  const client = await pool.connect();
  try {
    const databases = await resolveInboxPipelineDatabases(client);
    if (!databases) return;
    const items = await computeJournalInboxItems(client, databases, journalDayItemId);
    await writeComputed(client, databases.journal.id, journalDayItemId, JOURNAL_INBOX_COMPUTED_KEY, items);
    // No `withTransaction`/`runAfterCommit` here (mirrors rollup/recompute.ts's
    // `recomputeRollupCell`) — each statement above auto-commits on its own plain-connection
    // client, so reading `updatedAt` back after the write above is already safe to announce.
    const item = await itemsStore.getItemById(client, databases.journal.id, journalDayItemId);
    if (item) {
      notifyInvalidation({
        scope: "item",
        databaseId: databases.journal.id,
        itemId: journalDayItemId,
        op: "update",
        updatedAt: item.updatedAt,
      });
    }
  } finally {
    client.release();
  }
}

export async function handleJournalInboxRecomputeTask(
  pool: Pool,
  payload: { journalDayItemId: string },
): Promise<void> {
  await recomputeJournalInboxDay(pool, payload.journalDayItemId);
}
