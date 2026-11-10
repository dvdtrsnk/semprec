import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { writeComputed } from "../chokePoint/itemsStore.js";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import {
  INBOX_MODULE_ID,
  INBOX_ITEM_TYPES_MODULE_ID,
  PROCESSING_PROPOSALS_MODULE_ID,
} from "../seed/inboxPipelineKeys.js";
import { AREAS_MODULE_ID, JOURNAL_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { indexItem } from "../search/itemSearchIndexer.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import { parseStoredProposalEnvelope, selectActiveSteps, type ProposalEntityKind } from "./inboxTickAction.js";

/**
 * `items.computed` key (issue #106) each Journal day item caches its rendered-ready list of
 * related Inbox items under — declared into the seed's `ComputedKeyRegistry` (see
 * seed/seedInboxPipeline.ts) so a colliding regular property key on Journal is refused.
 */
export const JOURNAL_INBOX_COMPUTED_KEY = "inboxItems";

/** One follow-up step of a multi-step proposal (issue #1489): canonical keys and user data only. */
export interface JournalInboxFollowUp {
  databaseKey: string | null;
  name: string | null;
  amount: number | null;
  currency: string | null;
}

/** What a `proposed` card suggests (issue #1489), read from its stored envelope; null for an unknown part. */
export interface JournalInboxProposalSummary {
  entityKind: ProposalEntityKind | null;
  documentKind: string | null;
  targetDatabaseKey: string | null;
  targetItemId: string | null;
  targetItemName: string | null;
  projectItemId: string | null;
  projectName: string | null;
  areaItemId: string | null;
  areaName: string | null;
  followUps: JournalInboxFollowUp[];
}

/** One Inbox item's derived, display-ready shape — canonical keys/enum values only (issue #106's "keep canonical stored keys English"); locale labels are resolved client-side. */
export interface JournalInboxItemSummary {
  id: string;
  date: string | null;
  time: string | null;
  text: string | null;
  type: { id: string; name: string; emoji: string } | null;
  /** The item's current processing-proposal status (see inbox/inboxTypesStore.ts), or null before a proposal exists. */
  status: string | null;
  /**
   * What the day shows for the item (issue #1489): `pending` while no card exists or the card is
   * `computing`, `failed` for `computeFailed`, otherwise the card's status (null if the card has none).
   */
  processing: string | null;
  /** The summary of a `proposed` card (issue #1489); null for every other card state. */
  proposalSummary: JournalInboxProposalSummary | null;
}

interface InboxPipelineDatabases {
  inbox: DatabaseRow;
  inboxItemTypes: DatabaseRow;
  processingProposals: DatabaseRow;
  journal: DatabaseRow;
  projects: DatabaseRow;
  areas: DatabaseRow;
}

async function resolveInboxPipelineDatabases(client: PoolClient): Promise<InboxPipelineDatabases | null> {
  const [inbox, inboxItemTypes, processingProposals, journal, projects, areas] = await Promise.all([
    databasesStore.getDatabaseByModuleId(client, INBOX_MODULE_ID),
    databasesStore.getDatabaseByModuleId(client, INBOX_ITEM_TYPES_MODULE_ID),
    databasesStore.getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID),
    databasesStore.getDatabaseByModuleId(client, JOURNAL_MODULE_ID),
    databasesStore.getDatabaseByModuleId(client, PROJECTS_MODULE_ID),
    databasesStore.getDatabaseByModuleId(client, AREAS_MODULE_ID),
  ]);
  if (!inbox || !inboxItemTypes || !processingProposals || !journal || !projects || !areas) return null;
  return { inbox, inboxItemTypes, processingProposals, journal, projects, areas };
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

/** `processing` (issue #1489): no card or a `computing` card is `pending`, `computeFailed` is `failed`, otherwise the card's status. */
function processingOf(card: ItemRow | null, status: string | null): string | null {
  if (!card) return "pending";
  if (status === "computing") return "pending";
  if (status === "computeFailed") return "failed";
  return status;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function emptyProposalSummary(): JournalInboxProposalSummary {
  return {
    entityKind: null,
    documentKind: null,
    targetDatabaseKey: null,
    targetItemId: null,
    targetItemName: null,
    projectItemId: null,
    projectName: null,
    areaItemId: null,
    areaName: null,
    followUps: [],
  };
}

async function databaseKeyOf(client: PoolClient, databaseId: string): Promise<string | null> {
  const database = await databasesStore.getDatabase(client, databaseId);
  return database?.key ?? null;
}

/**
 * The summary of a `proposed` card (issue #1489), read from its stored `proposal` envelope. The target is the
 * envelope's database for `database` cards and its item for the other kinds; a multi-step envelope's existing
 * item is its primary step's `itemId` when that step updates or links. Project and area are the relation
 * targets of the primary step (or of a single-step envelope) that belong to the Projects or Areas database,
 * whichever relation key carries them. Follow-ups are the active non-primary steps. The items are read in one
 * batch; a deleted item is unknown. No persisted document recognition contract currently exists;
 * integration is tracked with future attachment extraction and summary delivery.
 */
async function buildProposalSummary(
  client: PoolClient,
  databases: InboxPipelineDatabases,
  card: ItemRow,
): Promise<JournalInboxProposalSummary> {
  const envelope = parseStoredProposalEnvelope(card.properties.proposal, card.id);
  if (!envelope || "unknownKind" in envelope) return emptyProposalSummary();

  const steps = envelope.operations ? selectActiveSteps(envelope.operations) : [];
  const primary = steps.find((step) => step.role === "primary");
  const targetIsItem = envelope.entityKind !== "database";
  const existingItemId =
    primary && (primary.op === "update" || primary.op === "link") ? (primary.itemId ?? null) : null;
  const targetItemId = targetIsItem ? envelope.target : existingItemId;

  const relationValues: Array<Array<string | { ref: string }>> = Object.values(
    primary?.relations ?? envelope.relations ?? {},
  );
  const relatedIds = relationValues.flat().filter((target): target is string => typeof target === "string");

  const itemIds = new Set<string>(relatedIds);
  if (targetIsItem) itemIds.add(envelope.target);
  if (existingItemId) itemIds.add(existingItemId);
  const itemsById = new Map<string, ItemRow>(
    (await itemsStore.getItemsByIds(client, [...itemIds])).map((item): [string, ItemRow] => [item.id, item]),
  );

  const related = relatedIds.flatMap((id) => {
    const item = itemsById.get(id);
    return item ? [item] : [];
  });
  const project = related.find((item) => item.databaseId === databases.projects.id) ?? null;
  const area = related.find((item) => item.databaseId === databases.areas.id) ?? null;

  const targetItem = targetItemId ? (itemsById.get(targetItemId) ?? null) : null;
  const [targetLabel] = targetItem ? await databasesStore.listDatabaseLabelsByIds(client, [targetItem.databaseId]) : [];
  const targetTitle = targetLabel?.titlePropertyKey ? targetItem?.properties[targetLabel.titlePropertyKey] : undefined;
  let targetDatabaseKey: string | null = null;
  if (envelope.entityKind === "database") {
    targetDatabaseKey = await databaseKeyOf(client, envelope.target);
  } else if (targetItem) {
    targetDatabaseKey = await databaseKeyOf(client, targetItem.databaseId);
  }

  const followUps: JournalInboxFollowUp[] = steps
    .filter((step) => step.role !== "primary")
    .map((step) => ({
      databaseKey: step.databaseKey ?? null,
      name: stringOrNull(step.properties?.name),
      amount: numberOrNull(step.properties?.amount),
      currency: stringOrNull(step.properties?.currency),
    }));

  return {
    entityKind: envelope.entityKind,
    documentKind: null,
    targetDatabaseKey,
    targetItemId,
    targetItemName: targetItem ? (stringOrNull(targetTitle) ?? stringOrNull(targetItem.properties.name)) : null,
    projectItemId: project?.id ?? null,
    projectName: project ? stringOrNull(project.properties.name) : null,
    areaItemId: area?.id ?? null,
    areaName: area ? stringOrNull(area.properties.name) : null,
    followUps,
  };
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

    let card: ItemRow | null = null;
    if (sourceInboxRelationDefinition) {
      const edges = await relationsStore.listRelationsForItem(client, sourceInboxRelationDefinition.id, item.id);
      for (const edge of edges) {
        const proposal = await itemsStore.getItemById(
          client,
          databases.processingProposals.id,
          relationsStore.otherSide(edge, item.id),
        );
        if (proposal && !proposal.deletedAt) {
          card = proposal;
          break;
        }
      }
    }
    const status = card && typeof card.properties.status === "string" ? card.properties.status : null;

    summaries.push({
      id: item.id,
      date: typeof item.properties.date === "string" ? item.properties.date : null,
      time: typeof item.properties.time === "string" ? item.properties.time : null,
      text: typeof item.properties.text === "string" ? item.properties.text : null,
      type,
      status,
      processing: processingOf(card, status),
      proposalSummary: card && status === "proposed" ? await buildProposalSummary(client, databases, card) : null,
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

/**
 * The actual recompute: one query for the day's Inbox items, written to `items.computed` (issue #106), always a full recompute of one day's cell. Mirrors rollup/recompute.ts's `recomputeRollupCell`: one transaction holding `FOR UPDATE` on the day item so overlapping recomputes serialise and the list written is computed from the latest committed state, with the invalidation announced only after the commit.
 */
export async function recomputeJournalInboxDay(pool: Pool, journalDayItemId: string): Promise<void> {
  await withTransaction(pool, (client) => recomputeJournalInboxDayWithClient(client, journalDayItemId));
}

/**
 * `recomputeJournalInboxDay`'s body on the caller's managed transaction: the search job of a Journal
 * day (`search/itemSearchFanout.ts`) runs it in its own transaction, so the day's cache and its
 * document are rewritten by this one owner. It re-resolves the pipeline and locks the day itself.
 */
export async function recomputeJournalInboxDayWithClient(client: PoolClient, journalDayItemId: string): Promise<void> {
  const databases = await resolveInboxPipelineDatabases(client);
  if (!databases) return;
  const day = await itemsStore.lockItemById(client, databases.journal.id, journalDayItemId);
  if (!day) return; // day item was purged since the job was enqueued
  const items = await computeJournalInboxItems(client, databases, journalDayItemId);
  const updatedAt = await writeComputed(
    client,
    databases.journal.id,
    journalDayItemId,
    JOURNAL_INBOX_COMPUTED_KEY,
    items,
  );
  // The day's search `body` quotes these Inbox entries (issue #1658). Same transaction as the computed write, so
  // the index never quotes a list that did not commit; the stored page text is kept, so the page is not reconverted.
  await indexItem(client, journalDayItemId);
  runAfterCommit(client, () =>
    notifyInvalidation({
      scope: "item",
      databaseId: databases.journal.id,
      itemId: journalDayItemId,
      op: "update",
      updatedAt,
    }),
  );
}

/**
 * Whether `itemId` is a live item of this tenant's Journal while the Inbox pipeline resolves, the
 * case in which `recomputeJournalInboxDayWithClient` indexes it. A plain read: it decides which owner
 * runs, and that owner locks and re-reads the day itself.
 */
export async function isLiveJournalDay(client: PoolClient, itemId: string): Promise<boolean> {
  const databases = await resolveInboxPipelineDatabases(client);
  if (!databases) return false;
  const item = await itemsStore.getItemById(client, databases.journal.id, itemId);
  return item !== null && item.deletedAt === null;
}

export async function handleJournalInboxRecomputeTask(
  pool: Pool,
  payload: { journalDayItemId: string },
): Promise<void> {
  await recomputeJournalInboxDay(pool, payload.journalDayItemId);
}
