import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@alldots/queue";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { writeComputed } from "../chokePoint/itemsStore.js";
import { runAfterCommit, withTransaction, type Queryable } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import {
  INBOX_MODULE_ID,
  INBOX_ITEM_TYPES_MODULE_ID,
  PROCESSING_PROPOSALS_MODULE_ID,
} from "../seed/inboxPipelineKeys.js";
import { JOURNAL_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { indexItem } from "../search/itemSearchIndexer.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import { listInboxAttachments, type InboxAttachmentSource } from "./inboxAttachmentsStore.js";
import { parseStoredProposalEnvelope, selectActiveSteps, type ProposalEntityKind } from "./inboxTickAction.js";

/** Declared into the seed's `ComputedKeyRegistry` so a colliding regular property key on Journal is refused. */
export const JOURNAL_INBOX_COMPUTED_KEY = "inboxItems";

/** Canonical keys and user data only. */
export interface JournalInboxFollowUp {
  databaseKey: string | null;
  name: string | null;
  amount: number | null;
  currency: string | null;
}

/** Null for an unknown part. */
export interface JournalInboxProposalSummary {
  entityKind: ProposalEntityKind | null;
  documentKind: string | null;
  targetDatabaseKey: string | null;
  targetItemId: string | null;
  targetItemName: string | null;
  projectItemId: string | null;
  projectName: string | null;
  followUps: JournalInboxFollowUp[];
}

/**
 * Ids and facts, never bytes. `thumbnailBlobId` is never the original file. `name` is `null` for captured attachments
 * (bare uuid keys). `pageCount` is currently always `null`: PDFs record `pages: null`.
 */
export interface JournalInboxAttachmentSummary {
  attachmentId: string;
  blobId: string;
  name: string | null;
  mimeType: string;
  byteSize: number;
  pageCount: number | null;
  thumbnailBlobId: string | null;
  source: InboxAttachmentSource;
}

/** One read for all `inboxItemIds`; each item's attachments in position order, an item without any is absent. */
export async function listInboxAttachmentSummaries(
  client: Queryable,
  inboxItemIds: string[],
): Promise<Map<string, JournalInboxAttachmentSummary[]>> {
  const byItem = new Map<string, JournalInboxAttachmentSummary[]>();
  for (const attachment of await listInboxAttachments(client, inboxItemIds)) {
    const forItem = byItem.get(attachment.inboxItemId) ?? [];
    forItem.push({
      attachmentId: attachment.attachmentId,
      blobId: attachment.blobId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      byteSize: Number(attachment.byteSize),
      pageCount: attachment.metadata?.pages ?? null,
      thumbnailBlobId: attachment.thumbnailBlobId,
      source: attachment.source,
    });
    byItem.set(attachment.inboxItemId, forItem);
  }
  return byItem;
}

/** Canonical keys and enum values only; locale labels are resolved client-side. */
export interface JournalInboxItemSummary {
  id: string;
  date: string | null;
  time: string | null;
  text: string | null;
  type: { id: string; name: string; emoji: string } | null;
  /** Null before a proposal exists. */
  status: string | null;
  processing: string | null;
  /** Null for every card state except `proposed`. */
  proposalSummary: JournalInboxProposalSummary | null;
  attachments: JournalInboxAttachmentSummary[];
}

interface InboxPipelineDatabases {
  inbox: DatabaseRow;
  inboxItemTypes: DatabaseRow;
  processingProposals: DatabaseRow;
  journal: DatabaseRow;
  projects: DatabaseRow;
}

async function resolveInboxPipelineDatabases(client: PoolClient): Promise<InboxPipelineDatabases | null> {
  const [inbox, inboxItemTypes, processingProposals, journal, projects] = await Promise.all([
    databasesStore.getDatabaseByModuleId(client, INBOX_MODULE_ID),
    databasesStore.getDatabaseByModuleId(client, INBOX_ITEM_TYPES_MODULE_ID),
    databasesStore.getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID),
    databasesStore.getDatabaseByModuleId(client, JOURNAL_MODULE_ID),
    databasesStore.getDatabaseByModuleId(client, PROJECTS_MODULE_ID),
  ]);
  if (!inbox || !inboxItemTypes || !processingProposals || !journal || !projects) return null;
  return { inbox, inboxItemTypes, processingProposals, journal, projects };
}

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

/** Null when there is no edge, e.g. for a `transcript` proposal. */
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

/** No card or a `computing` card is `pending`, `computeFailed` is `failed`, otherwise the card's status. */
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
    followUps: [],
  };
}

async function databaseKeyOf(client: PoolClient, databaseId: string): Promise<string | null> {
  const database = await databasesStore.getDatabase(client, databaseId);
  return database?.key ?? null;
}

/**
 * A multi-step envelope's existing item is its primary step's `itemId` when that step updates or links. The project
 * is the primary step's relation target in the Projects database, whichever relation key carries it.
 * Items are read in one batch; a deleted item is unknown.
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
    followUps,
  };
}

/** Reads Inbox purely through the `journalDay` relation. */
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

  // getItemsByIds filters soft-deleted items.
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

  const attachmentsByItem = await listInboxAttachmentSummaries(
    client,
    items.map((item) => item.id),
  );

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
      attachments: attachmentsByItem.get(item.id) ?? [],
    });
  }

  summaries.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  return summaries;
}

export function journalInboxRecomputeJobKey(journalDayItemId: string): string {
  return `journal-inbox-recompute:${journalDayItemId}`;
}

/** Must be called in the same transaction as the triggering write. */
export async function enqueueJournalInboxRecompute(client: PoolClient, journalDayItemId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE,
    { journalDayItemId },
    { jobKey: journalInboxRecomputeJobKey(journalDayItemId), maxAttempts: 3 },
  );
}

/** A no-op when the pipeline databases or the day edge are not resolvable. */
export async function enqueueJournalInboxRecomputeForInboxItem(client: PoolClient, inboxItemId: string): Promise<void> {
  const databases = await resolveInboxPipelineDatabases(client);
  if (!databases) return;
  const journalDayItemId = await resolveJournalDayItemId(client, databases.inbox.id, inboxItemId);
  if (!journalDayItemId) return;
  await enqueueJournalInboxRecompute(client, journalDayItemId);
}

/** For proposal actions, which touch the proposal rather than the Inbox item. */
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
 * Always a full recompute of one day, in one transaction holding `FOR NO KEY UPDATE` on the day item so overlapping
 * recomputes serialise and use the latest committed state; the invalidation is announced after the commit.
 */
export async function recomputeJournalInboxDay(pool: Pool, journalDayItemId: string): Promise<void> {
  await withTransaction(pool, (client) => recomputeJournalInboxDayWithClient(client, journalDayItemId));
}

/**
 * The search job of a Journal day runs this in its own transaction, so the day's cache and its search document have
 * one owner. Re-resolves the pipeline and locks the day itself.
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
  // Same transaction as the computed write, so the index never quotes a list that did not commit; the stored page
  // text is kept, so the page is not reconverted.
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

/** A plain read: it only decides which owner runs, and that owner locks and re-reads the day. */
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
