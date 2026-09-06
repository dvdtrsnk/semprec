import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createItemWithClient, createRelationWithClient, updateItemWithClient } from "../chokePoint/chokePoint.js";
import { PROCESSING_METHODS, LOCKED_PROPOSAL_STATUSES, type ProcessingMethod } from "./inboxTypesStore.js";
import { computeInboxFingerprint } from "./fingerprint.js";
import type { ItemRow } from "../types.js";

export const SEMPREC_TICK_ACTION_ID = "semprec.tick";

/** Graphile-worker queue affinity for `semprec.tick`: all Inbox ticks serialize against each other. */
export const SEMPREC_TICK_QUEUE_NAME = "semprec-tick";

/** `action_config` is a raw JSONB column (a module boundary) — validated, not just cast. */
const semprecTickActionConfigSchema = z.object({
  inboxDatabaseId: z.string().uuid(),
  inboxItemTypesDatabaseId: z.string().uuid(),
  processingProposalsDatabaseId: z.string().uuid(),
});

export type SemprecTickActionConfig = z.infer<typeof semprecTickActionConfigSchema>;

/** The generic proposal envelope (issue #100/#223): exactly `entityKind`, `target`, `properties`. */
export type ProposalEntityKind = "pageContent" | "database";

export interface ProposalEnvelope {
  entityKind: ProposalEntityKind;
  target: string;
  properties: Record<string, unknown>;
}

export interface ProposalComputationInput {
  /** The Inbox item the proposal is for. */
  sourceItem: ItemRow;
  /** The Inbox item's resolved, recognized type. */
  type: ItemRow;
  entityKind: ProposalEntityKind;
  /** Resolved target database id for `entityKind: 'database'`; absent for `'pageContent'`, where the target page is itself part of the content decision. */
  targetDatabaseId?: string;
}

export interface ProposalComputationResult {
  /** The target page id, for `entityKind: 'pageContent'` — ignored otherwise, since a `'database'` target is always the type's resolved `targetDatabase` id. */
  target?: string;
  properties: Record<string, unknown>;
}

/**
 * The content-level decision (issue #223): which project/page an Inbox source becomes,
 * or which property values fill its target database row. Backed by an LLM call — prompt
 * engineering is out of this issue's scope, so this is a pluggable/injected function, the
 * same shape as `scheduler/actions.ts`'s `RunAgentFn`/`coreAgentRunAction`. Must never
 * write to any target database or page itself (issue #223's "no target write" guarantee)
 * — it only computes values in memory; `createSemprecTickAction` is solely responsible
 * for writing the resulting envelope into `processingProposals`.
 */
export type ComputeSemprecProposalFn = (input: ProposalComputationInput) => Promise<ProposalComputationResult>;

async function getRelationDefinitionByKey(client: PoolClient, databaseId: string, key: string) {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
  if (!property) return null;
  return relationsStore.getRelationDefinitionByPropertyId(client, property.id);
}

/**
 * Resolves the Inbox item's linked, recognized type (issue #223's "recognized type" gate):
 * `null` for any of the stub cases #104 later replaces with `needsClarification` — no
 * `type` relation, a dangling/deleted target, or a type missing a valid `processingMethod`.
 */
async function resolveRecognizedType(
  client: PoolClient,
  config: SemprecTickActionConfig,
  item: ItemRow,
): Promise<{ type: ItemRow; processingMethod: ProcessingMethod } | null> {
  const typeRelationDefinition = await getRelationDefinitionByKey(client, config.inboxDatabaseId, "type");
  if (!typeRelationDefinition) return null;

  const edges = await relationsStore.listRelationsForItem(client, typeRelationDefinition.id, item.id);
  const edge = edges[0];
  if (!edge) return null;

  const typeItemId = relationsStore.otherSide(edge, item.id);
  const type = await itemsStore.getItemById(client, config.inboxItemTypesDatabaseId, typeItemId);
  if (!type || type.deletedAt) return null;

  const processingMethod = type.properties.processingMethod;
  if (!(PROCESSING_METHODS as readonly unknown[]).includes(processingMethod)) return null;

  return { type, processingMethod: processingMethod as ProcessingMethod };
}

/**
 * The existing Processing proposal row for a source Inbox item, if any (issue #223's
 * create/revise/skip gate). A soft-deleted proposal is treated the same as no proposal at
 * all — falling through to the create path — rather than being handed to the revise branch,
 * where `updateItemWithClient` would throw `NotFoundError` on a deleted item.
 *
 * Scans every edge rather than trusting `edges[0]`: once a soft-deleted proposal's edge has
 * been left behind by a prior tick (see the scenario above) alongside the edge to its live
 * replacement, `listRelationsForItem`'s heap order is not guaranteed to put the live one
 * first — picking `edges[0]` blindly could keep finding the deleted row, "creating" a fresh
 * proposal on every subsequent tick without bound.
 */
async function findExistingProposal(client: PoolClient, config: SemprecTickActionConfig, sourceItemId: string): Promise<ItemRow | null> {
  const sourceInboxRelationDefinition = await getRelationDefinitionByKey(client, config.processingProposalsDatabaseId, "sourceInbox");
  if (!sourceInboxRelationDefinition) return null;

  const edges = await relationsStore.listRelationsForItem(client, sourceInboxRelationDefinition.id, sourceItemId);
  for (const edge of edges) {
    const proposalItemId = relationsStore.otherSide(edge, sourceItemId);
    const proposal = await itemsStore.getItemById(client, config.processingProposalsDatabaseId, proposalItemId);
    if (proposal && !proposal.deletedAt) return proposal;
  }
  return null;
}

async function computeProposalEnvelope(
  client: PoolClient,
  computeProposal: ComputeSemprecProposalFn,
  sourceItem: ItemRow,
  type: ItemRow,
  processingMethod: ProcessingMethod,
): Promise<ProposalEnvelope> {
  const entityKind: ProposalEntityKind = processingMethod === "database" ? "database" : "pageContent";

  if (entityKind === "database") {
    const targetModuleId = type.properties.targetDatabase;
    if (typeof targetModuleId !== "string") {
      throw new Error(`Inbox item type ${type.id} has processingMethod 'database' but no 'targetDatabase'`);
    }
    const targetDatabase = await databasesStore.getDatabaseByModuleId(client, targetModuleId);
    if (!targetDatabase) throw new Error(`No database seeded for owner_module_id '${targetModuleId}'`);

    const result = await computeProposal({ sourceItem, type, entityKind, targetDatabaseId: targetDatabase.id });
    return { entityKind, target: targetDatabase.id, properties: result.properties };
  }

  const result = await computeProposal({ sourceItem, type, entityKind });
  if (!result.target) throw new Error(`Proposal computation for Inbox item ${sourceItem.id} (entityKind 'pageContent') did not return a 'target'`);
  return { entityKind, target: result.target, properties: result.properties };
}

/**
 * Registered as an `onItemEvent` ('create'/'update'/'delete') heartbeat action on the Inbox
 * database (issue #103): re-reads the item by id at run time — never trusting anything about
 * its content from the job payload — so when several rapid edits collapse onto one pending
 * job (the heartbeat-fire job key's replace semantics), the single tick that eventually runs
 * reflects whatever state is current at that moment, not a stale snapshot from whichever edit
 * enqueued it.
 *
 * Issue #223's fingerprinting and create/revise/skip gate: a deleted (or since-deleted) item,
 * or one whose `type` is missing/unresolved (issue #104's `needsClarification`, out of this
 * issue's scope), is a legitimate no-op. Otherwise this fingerprints the source (SHA-256 of
 * its type's canonical emoji and text), and only calls `computeProposal` — the injected,
 * LLM-backed content decision — when there is no existing proposal row, or an existing
 * unlocked one whose stored fingerprint has changed; a `confirmed`/`rejected` (locked) row is
 * never recomputed, and an unchanged fingerprint makes no AI call and no proposal write.
 */
export function createSemprecTickAction(pool: Pool, computeProposal: ComputeSemprecProposalFn): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return;
    // Throws (surfacing as a recorded heartbeat failure + notification, see sweep.ts's
    // createHeartbeatFireTask) rather than silently no-op'ing on a misconfigured heartbeat.
    const config = semprecTickActionConfigSchema.parse(actionConfig);
    await withTransaction(pool, async (client) => {
      const item = await itemsStore.getItemById(client, config.inboxDatabaseId, context.itemId as string);
      if (!item || item.deletedAt) return;

      const recognized = await resolveRecognizedType(client, config, item);
      if (!recognized) return;
      const { type, processingMethod } = recognized;

      const emoji = typeof type.properties.emoji === "string" ? type.properties.emoji : "";
      const text = typeof item.properties.text === "string" ? item.properties.text : "";
      const fingerprint = computeInboxFingerprint(emoji, text);

      const existingProposal = await findExistingProposal(client, config, item.id);

      if (existingProposal) {
        const status = existingProposal.properties.status;
        if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) return;
        if (existingProposal.properties.fingerprint === fingerprint) return;

        const envelope = await computeProposalEnvelope(client, computeProposal, item, type, processingMethod);
        await updateItemWithClient(
          client,
          {
            databaseId: config.processingProposalsDatabaseId,
            itemId: existingProposal.id,
            propertiesPatch: { fingerprint, proposal: envelope, status: "proposed" },
          },
          { allowedSystemKeys: ["fingerprint", "proposal", "status"] },
        );
        return;
      }

      const envelope = await computeProposalEnvelope(client, computeProposal, item, type, processingMethod);
      const proposal = await createItemWithClient(
        client,
        {
          databaseId: config.processingProposalsDatabaseId,
          properties: { kind: "inbox", fingerprint, proposal: envelope, history: [], status: "proposed" },
        },
        { allowedSystemKeys: ["kind", "fingerprint", "proposal", "history", "status"] },
      );

      const sourceInboxProperty = await propertiesStore.getPropertyByKey(client, config.processingProposalsDatabaseId, "sourceInbox");
      if (!sourceInboxProperty) throw new Error(`Processing proposals database ${config.processingProposalsDatabaseId} has no 'sourceInbox' relation property`);
      await createRelationWithClient(client, { relationPropertyId: sourceInboxProperty.id, itemId: proposal.id, targetItemId: item.id });
    });
  };
}
