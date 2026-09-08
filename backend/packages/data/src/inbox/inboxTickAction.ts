import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createItemWithClient, createRelationWithClient, updateItemWithClient, type SystemRelationWriteContext } from "../chokePoint/chokePoint.js";
import { PROCESSING_METHODS, LOCKED_PROPOSAL_STATUSES, type ProcessingMethod } from "./inboxTypesStore.js";
import { computeInboxFingerprint } from "./fingerprint.js";
import { enqueueJournalInboxRecomputeForInboxItem } from "./journalInboxCompute.js";
import { SEMPREC_READ_ONLY_MODULE_IDS, PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { assertValidMcpServerProposalProperties } from "../mcp/mcpServerProposal.js";
import { ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";

const PROCESSING_PROPOSALS_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: PROCESSING_PROPOSALS_MODULE_ID };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SEMPREC_TICK_ACTION_ID = "semprec.tick";

/** Graphile-worker queue affinity for `semprec.tick`: all Inbox ticks serialize against each other. */
export const SEMPREC_TICK_QUEUE_NAME = "semprec-tick";

/** `action_config` is a raw JSONB column (a module boundary) — validated, not just cast. */
export const semprecTickActionConfigSchema = z.object({
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
 * `null` for any case `createSemprecTickAction` below turns into `needsClarification`
 * (issue #104) — no `type` relation, a dangling/deleted target, or a type missing a valid
 * `processingMethod`.
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

/** A Processing proposal's chat + decision log entry (issue #104). */
export interface ProposalHistoryEntry {
  author: "ai" | "user";
  message: string;
  at: string;
}

/**
 * Appends one history entry to a proposal's `history`, tolerating a missing/malformed
 * stored value as empty. Defaults to `author: 'ai'` for this module's own tick-driven
 * entries; inbox/proposalActions.ts (issue #105) reuses this with `author: 'user'` for
 * confirm/reject/revise's own log entries.
 */
export function appendHistoryEntry(history: unknown, message: string, author: "ai" | "user" = "ai"): ProposalHistoryEntry[] {
  const existing = Array.isArray(history) ? (history as ProposalHistoryEntry[]) : [];
  return [...existing, { author, message, at: new Date().toISOString() }];
}

/**
 * Validates a computed envelope against its destination's own requirements (issue #104) —
 * never against the generic choke-point schema engine's write path, since a proposal is
 * never itself written to the destination (`computeProposal`'s "no target write" guarantee,
 * carried over from issue #223). Throws `ValidationError` for a wrong `entityKind`, an
 * unknown/malformed target, or properties the destination could not accept.
 */
export async function assertValidProposalEnvelope(client: PoolClient, envelope: ProposalEnvelope): Promise<void> {
  if (envelope.entityKind !== "pageContent" && envelope.entityKind !== "database") {
    throw new ValidationError(`Proposal envelope has unknown entityKind '${String(envelope.entityKind)}'`, { field: "entityKind" });
  }

  if (envelope.entityKind === "database") {
    if (!UUID_RE.test(envelope.target)) {
      throw new ValidationError(`Proposal envelope target '${envelope.target}' is not a database id`, { field: "target" });
    }
    const targetDatabase = await databasesStore.getDatabase(client, envelope.target);
    if (!targetDatabase || targetDatabase.archivedAt) {
      throw new ValidationError(`Proposal envelope target '${envelope.target}' is not an existing target database`, { field: "target" });
    }
    // Issue #105's grant separation, enforced here rather than only declared in the
    // manifest: a user-supplied `revise` builds its envelope from raw request input, so
    // without this check it could name Inbox/Inbox item types as `target` and have a
    // later `confirm` write to them via the generic create-item choke point — bypassing
    // `permissionManifest.ts`'s `writable: false` for those two databases, since nothing
    // upstream of that choke-point call reads the manifest at all.
    if (targetDatabase.ownerModuleId && SEMPREC_READ_ONLY_MODULE_IDS.includes(targetDatabase.ownerModuleId)) {
      throw new ValidationError(`Proposal envelope target '${envelope.target}' is not a writable target database`, { field: "target" });
    }
    // Issue #123: an MCP server's credential never travels through a proposal envelope at
    // all (it is supplied separately by a human at confirm time, see proposalActions.ts) —
    // enforced here, at the one point every mcpServers-targeted envelope (freshly computed
    // or user-revised) passes through, on top of the generic per-property checks below.
    if (targetDatabase.ownerModuleId === MCP_SERVERS_MODULE_ID) {
      assertValidMcpServerProposalProperties(envelope.properties);
    }

    const targetProperties = await propertiesStore.listPropertiesByDatabase(client, targetDatabase.id);
    const byKey = new Map(targetProperties.map((property) => [property.key, property]));
    for (const key of Object.keys(envelope.properties)) {
      const property = byKey.get(key);
      if (!property) {
        throw new ValidationError(`Proposal properties reference unknown property '${key}' on target database ${targetDatabase.id}`, { field: key });
      }
      if (property.type === "relation") {
        throw new ValidationError(`Proposal properties cannot set relation property '${key}' directly`, { field: key });
      }
      if (property.type === "rollup") {
        throw new ValidationError(`Proposal properties cannot set read-only rollup property '${key}'`, { field: key });
      }
      if (property.owner === "system") {
        throw new ValidationError(`Proposal properties cannot set system-owned property '${key}'`, { field: key });
      }
    }
    return;
  }

  if (!UUID_RE.test(envelope.target)) {
    throw new ValidationError(`Proposal envelope target '${envelope.target}' is not a page id`, { field: "target" });
  }
  const [targetPage] = await itemsStore.getItemsByIds(client, [envelope.target]);
  if (!targetPage) {
    throw new ValidationError(`Proposal envelope target '${envelope.target}' is not an existing page`, { field: "target" });
  }
  if (typeof envelope.properties.flavour !== "string" || envelope.properties.flavour.length === 0) {
    throw new ValidationError("Proposal properties for entityKind 'pageContent' must carry a 'flavour' block field", { field: "properties" });
  }
  // `fields`/`children` are read back out of storage and cast at confirm time (issue #105's
  // proposalActions.ts) to build the block-append call — validated here, at the one point
  // every pageContent envelope (freshly computed or user-revised) passes through, so that
  // cast is never the first thing to notice a malformed stored value.
  const { fields, children } = envelope.properties;
  if (fields !== undefined && (typeof fields !== "object" || fields === null || Array.isArray(fields))) {
    throw new ValidationError("Proposal properties 'fields', if present, must be a plain object", { field: "properties" });
  }
  if (children !== undefined && (!Array.isArray(children) || !children.every((child) => typeof child === "string"))) {
    throw new ValidationError("Proposal properties 'children', if present, must be an array of strings", { field: "properties" });
  }
}

/** Links a freshly created Processing proposal back to its source Inbox item via `sourceInbox`. */
async function linkSourceInboxRelation(client: PoolClient, config: SemprecTickActionConfig, proposalId: string, sourceItemId: string): Promise<void> {
  const sourceInboxProperty = await propertiesStore.getPropertyByKey(client, config.processingProposalsDatabaseId, "sourceInbox");
  if (!sourceInboxProperty) throw new Error(`Processing proposals database ${config.processingProposalsDatabaseId} has no 'sourceInbox' relation property`);
  await createRelationWithClient(
    client,
    { relationPropertyId: sourceInboxProperty.id, callerItemId: proposalId, targetItemId: sourceItemId },
    PROCESSING_PROPOSALS_RELATION_CONTEXT,
  );
}

/**
 * Puts a source Inbox item's proposal into `needsClarification` (issue #104): the shared path
 * for "no usable type" (missing or deleted-type reference, per the epic's "no special case for
 * deleted references") and for a computed `proposed` envelope that failed destination
 * validation — both are "the AI/tick could not produce a usable proposal", so both land here
 * with no pre-filled `proposal` rather than ever going silent. Creates the row if none exists,
 * revises it if unlocked, and is a no-op if the row is already locked or already
 * `needsClarification` with the same `fingerprint` (so a repeatedly-untyped or
 * repeatedly-invalid item doesn't spam its history on every tick).
 */
async function writeNeedsClarification(
  client: PoolClient,
  config: SemprecTickActionConfig,
  sourceItemId: string,
  existingProposal: ItemRow | null,
  message: string,
  fingerprint: string | null = null,
): Promise<void> {
  if (existingProposal) {
    const status = existingProposal.properties.status;
    if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) return;
    if (status === "needsClarification" && existingProposal.properties.fingerprint === fingerprint) return;

    await updateItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        itemId: existingProposal.id,
        propertiesPatch: {
          fingerprint,
          proposal: null,
          status: "needsClarification",
          history: appendHistoryEntry(existingProposal.properties.history, message),
        },
      },
      { allowedSystemKeys: ["fingerprint", "proposal", "status", "history"] },
    );
    return;
  }

  const proposal = await createItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      properties: { kind: "inbox", fingerprint, proposal: null, history: appendHistoryEntry([], message), status: "needsClarification" },
    },
    { allowedSystemKeys: ["kind", "fingerprint", "proposal", "history", "status"] },
  );
  await linkSourceInboxRelation(client, config, proposal.id, sourceItemId);
}

/**
 * Puts an unlocked proposal into `invalid` (issue #104) when its source Inbox item no longer
 * exists. A locked (`confirmed`/`rejected`) proposal, or one with no proposal row at all, is
 * left untouched — per the epic's "a locked card is never recomputed again" rule and because
 * there is nothing to invalidate. A no-op if already `invalid`, so a source deleted more than
 * once (e.g. soft-deleted, then its delete event re-fires) doesn't spam history.
 */
async function invalidateProposalForDeletedSource(client: PoolClient, config: SemprecTickActionConfig, existingProposal: ItemRow | null): Promise<void> {
  if (!existingProposal) return;
  const status = existingProposal.properties.status;
  if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) return;
  if (status === "invalid") return;

  await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: existingProposal.id,
      propertiesPatch: {
        status: "invalid",
        history: appendHistoryEntry(existingProposal.properties.history, "Source Inbox item was deleted."),
      },
    },
    { allowedSystemKeys: ["status", "history"] },
  );
}

/**
 * Registered as an `onItemEvent` ('create'/'update'/'delete') heartbeat action on the Inbox
 * database (issue #103): re-reads the item by id at run time — never trusting anything about
 * its content from the job payload — so when several rapid edits collapse onto one pending
 * job (the heartbeat-fire job key's replace semantics), the single tick that eventually runs
 * reflects whatever state is current at that moment, not a stale snapshot from whichever edit
 * enqueued it.
 *
 * Issue #223's fingerprinting and create/revise/skip gate, plus issue #104's closure of the
 * state space: a deleted (or since-deleted) source item transitions its unlocked proposal (if
 * any) to `invalid`; a source with no usable type (missing, or referencing a deleted Inbox item
 * type) transitions to `needsClarification`. Otherwise this fingerprints the source (SHA-256 of
 * its type's canonical emoji and text), and only calls `computeProposal` — the injected,
 * LLM-backed content decision — when there is no existing proposal row, or an existing
 * unlocked one whose stored fingerprint has changed; a `confirmed`/`rejected` (locked) row is
 * never recomputed, and an unchanged fingerprint makes no AI call and no proposal write. A
 * computed envelope that fails destination validation also lands in `needsClarification`
 * rather than being stored as `proposed`. Every create, revise, or status change appends one
 * `{ author: 'ai', message, at }` history entry (issue #104).
 */
export function createSemprecTickAction(pool: Pool, computeProposal: ComputeSemprecProposalFn): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return;
    // Throws (surfacing as a recorded heartbeat failure + notification, see sweep.ts's
    // createHeartbeatFireTask) rather than silently no-op'ing on a misconfigured heartbeat.
    const config = semprecTickActionConfigSchema.parse(actionConfig);
    const sourceItemId = context.itemId as string;
    await withTransaction(pool, async (client) => {
      const item = await itemsStore.getItemById(client, config.inboxDatabaseId, sourceItemId);
      const existingProposal = await findExistingProposal(client, config, sourceItemId);

      // Issue #106: this fires on every create/update/delete tick (issue #103's onItemEvent
      // heartbeats), so it is the one trigger point that covers a property edit (text/date/
      // time) on an existing Inbox item — capture already enqueues its own recompute
      // (inboxStore.ts), so this is redundant-but-harmless there. It also covers deletion:
      // the item's `journalDay` edge (set once at capture) still resolves after a soft
      // delete, since deleting an item never removes its relation edges, and the deleted
      // item is then excluded from the recomputed list by `getItemsByIds`'s deleted_at filter.
      if (item) await enqueueJournalInboxRecomputeForInboxItem(client, item.id);

      if (!item || item.deletedAt) {
        await invalidateProposalForDeletedSource(client, config, existingProposal);
        return;
      }

      const recognized = await resolveRecognizedType(client, config, item);
      if (!recognized) {
        await writeNeedsClarification(client, config, item.id, existingProposal, "Source item has no recognized type; needs clarification.");
        return;
      }
      const { type, processingMethod } = recognized;

      const emoji = typeof type.properties.emoji === "string" ? type.properties.emoji : "";
      const text = typeof item.properties.text === "string" ? item.properties.text : "";
      const fingerprint = computeInboxFingerprint(emoji, text);

      if (existingProposal) {
        const status = existingProposal.properties.status;
        if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) return;
        if (existingProposal.properties.fingerprint === fingerprint) return;

        const envelope = await computeProposalEnvelope(client, computeProposal, item, type, processingMethod);
        try {
          await assertValidProposalEnvelope(client, envelope);
        } catch (err) {
          if (!(err instanceof ValidationError)) throw err;
          await writeNeedsClarification(client, config, item.id, existingProposal, `Computed proposal failed validation: ${err.message}`, fingerprint);
          return;
        }

        await updateItemWithClient(
          client,
          {
            databaseId: config.processingProposalsDatabaseId,
            itemId: existingProposal.id,
            propertiesPatch: {
              fingerprint,
              proposal: envelope,
              status: "proposed",
              history: appendHistoryEntry(existingProposal.properties.history, "Revised the proposal after the source item changed."),
            },
          },
          { allowedSystemKeys: ["fingerprint", "proposal", "status", "history"] },
        );
        return;
      }

      const envelope = await computeProposalEnvelope(client, computeProposal, item, type, processingMethod);
      try {
        await assertValidProposalEnvelope(client, envelope);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        await writeNeedsClarification(client, config, item.id, null, `Computed proposal failed validation: ${err.message}`, fingerprint);
        return;
      }

      const proposal = await createItemWithClient(
        client,
        {
          databaseId: config.processingProposalsDatabaseId,
          properties: {
            kind: "inbox",
            fingerprint,
            proposal: envelope,
            history: appendHistoryEntry([], "Created a proposal for the source item."),
            status: "proposed",
          },
        },
        { allowedSystemKeys: ["kind", "fingerprint", "proposal", "history", "status"] },
      );

      await linkSourceInboxRelation(client, config, proposal.id, item.id);
    });
  };
}
