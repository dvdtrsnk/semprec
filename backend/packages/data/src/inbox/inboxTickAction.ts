import {
  withStepRef,
  existingItemRelations,
  assertStepDatabaseWritable,
  assertUpdateStepShape,
} from "./proposalEnvelopeValidation.js";
import { lockEnvelopeBlobReferences } from "./proposalBlobReferences.js";
import { assertValidEnvelopeNewOptions, assertValidEnvelopeNewOptionsPlacement } from "./proposalNewOptions.js";
import { inboxFingerprintInput, getRelationDefinitionByKey, resolveRecognizedType } from "./inboxSourceFingerprint.js";
import { prepareComputedUpdates, readProposalTimezone } from "./proposalComputedUpdates.js";
import {
  buildProposalEnvelope,
  resolveModelPagePlacement,
  tickComputationInput,
  buildTickEnvelope,
  type TickSnapshot,
  type ProposalComputationResult,
  type ComputeAlldotsProposalFn,
} from "./inboxTickSnapshot.js";
export type {
  ProposalComputationInput,
  ProposalComputationResult,
  ComputeAlldotsProposalFn,
} from "./inboxTickSnapshot.js";
import { listActiveInboxTypes } from "./inboxTypesStore.js";
import {
  validRecognitionTypes,
  recognitionClarificationPatch,
  recognitionChangedReason,
  RECOGNITION_CONFIDENCE_THRESHOLD,
  RECOGNITION_CARD_KEYS,
} from "./inboxRecognition.js";
import { aiProposalPatch } from "./proposalEnvelope.js";
import { assistantSideChanged, mergeRecomputeWithManualValues } from "./tickRecompute.js";
export { aiProposalPatch, readAiProposal } from "./proposalEnvelope.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { z } from "zod";
import { alldotsTickActionConfigSchema, type AlldotsTickActionConfig } from "./proposalEnvelope.js";
import { invalidReasonLabel } from "./invalidReason.js";
import { referencedItemIdsOf } from "./proposalReferences.js";
export { alldotsTickActionConfigSchema, type AlldotsTickActionConfig } from "./proposalEnvelope.js";
export { MAX_PROPOSAL_NEW_OPTIONS } from "./proposalEnvelope.js";
import {
  assertValidEnvelopePageSections,
  assertValidEnvelopeRelations,
  assertValidV2PageContent,
  assertValidEnvelopeProperties,
  assertValidStepProperties,
  requireProposalPageTarget,
} from "./proposalEnvelopeValidation.js";
import { proposalEnvelopeSchema, type ProposalStep, type ProposalEnvelope } from "./proposalEnvelope.js";
export {
  proposalEnvelopeSchema,
  unknownStoredEntityKind,
  parseStoredProposalEnvelope,
  type ProposalEntityKind,
  type ProposalStep,
  type ProposalEnvelope,
  type UnknownKindProposalEnvelope,
} from "./proposalEnvelope.js";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { AiGatewayFailedError, createLogger, type AiGatewayFailureReason, type Logger } from "@alldots/shared";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { assertValidOccurrenceTarget } from "../calendar/eventOccurrenceTarget.js";
import { prepareUserItemPatch, createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { LOCKED_PROPOSAL_STATUSES } from "./inboxTypesStore.js";
import { computeInboxFingerprintV2, isFingerprintCurrent } from "./fingerprint.js";
import { enqueueJournalInboxRecomputeForInboxItem } from "./journalInboxCompute.js";
import { ALLDOTS_READ_ONLY_MODULE_IDS } from "../seed/inboxPipelineKeys.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { assertValidMcpServerProposalProperties } from "../mcp/mcpServerProposal.js";
import { assertValidFileFromAttachmentStep } from "./fileAttachmentStep.js";
import { assertValidRecordingEnvelope } from "./recordingCardValidation.js";
import { assertValidJournalEntryEnvelope } from "./journalEntryEnvelope.js";
import { resolveTickTarget } from "./inboxTickTarget.js";
import { assertNoDerivedRelations } from "./proposalDerivedRelations.js";
import { buildRecordingCard } from "./recordingCardProducer.js";
import { routeInboxAttachments } from "./attachmentRouting.js";
import { hasAttachmentAwaitingMetadata, listInboxAttachments } from "./inboxAttachmentsStore.js";
import { assertNoRefCycle, selectActiveSteps, stepError } from "./proposalStepGraph.js";
import { appendHistoryEntry } from "./proposalHistory.js";
import { linkSourceInboxRelation } from "./inboxCardSourceLink.js";
import { publishInboxCardChange } from "./inboxCardsRealtime.js";
import { isSerializationFailure, isTickWriteTransaction } from "./tickTransaction.js";
import { withTickTransaction, withTickWriteTransaction } from "./tickTransaction.js";
import { tryLockInboxType, resolveBoundRecognition } from "./inboxSourceGuard.js";
import { CardinalityViolationError, OptionLabelExistsError, ValidationError } from "../errors.js";
import { getTenantUserLocale } from "../auth/usersStore.js";
import type { DatabaseRow, ItemRow } from "../types.js";

export { selectActiveSteps } from "./proposalStepGraph.js";
// Re-exported here because the barrel `index.ts` is at its `max-lines` cap and exports this module whole.
export { lookupLiveCompanyIdByIco } from "./companyIcoLookup.js";
export { readPastEventDurations, type PastEventDuration } from "./pastEventDurations.js";
export { lookupPersonIdByEmail, normalizeEmailAddress } from "../mail/personEmailIndexStore.js";

const logger: Logger = createLogger("inbox-tick");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { ALLDOTS_TICK_ACTION_ID, ALLDOTS_TICK_QUEUE_NAME } from "./inboxTickKeys.js";

/**
 * A soft-deleted proposal counts as none, so the tick creates instead of revising a deleted row (which would throw
 * `NotFoundError`). Every edge is scanned rather than trusting `edges[0]`: a deleted proposal's edge can sit next to
 * its live replacement's in unspecified heap order, and picking the deleted one would create a fresh proposal on every
 * tick. Split siblings (`splitFromProposalId`) are skipped, so a source edit never recomputes a sibling.
 */
async function findExistingProposal(
  client: PoolClient,
  config: AlldotsTickActionConfig,
  sourceItemId: string,
): Promise<ItemRow | null> {
  const sourceInboxRelationDefinition = await getRelationDefinitionByKey(
    client,
    config.processingProposalsDatabaseId,
    "sourceInbox",
  );
  if (!sourceInboxRelationDefinition) return null;

  const edges = await relationsStore.listRelationsForItem(client, sourceInboxRelationDefinition.id, sourceItemId);
  for (const edge of edges) {
    const proposalItemId = relationsStore.otherSide(edge, sourceItemId);
    const proposal = await itemsStore.getItemById(client, config.processingProposalsDatabaseId, proposalItemId);
    if (proposal && !proposal.deletedAt && typeof proposal.properties.splitFromProposalId !== "string") return proposal;
  }
  return null;
}

/**
 * Re-reads the unlocked `snapshot` under `FOR NO KEY UPDATE` and returns it only if it is still the row the tick decided on:
 * live, not `confirmed`/`rejected`, same `fingerprint` and `aiVersion`. Otherwise logs why and returns `null`, and the
 * caller skips its write. A manual edit that moved only `updatedAt` and `version` does not count; the caller passes
 * the locked `version` as `ifVersion`.
 *
 * The repeatable-read phase treats a serialization conflict as changed. The post-model phase uses a nonblocking lock so
 * a confirmation holding the card cannot wait on the source while this transaction waits on the card. The savepoint
 * keeps the transaction usable after either skip.
 */
async function lockUnlockedProposal(
  client: PoolClient,
  config: AlldotsTickActionConfig,
  snapshot: ItemRow,
): Promise<ItemRow | null> {
  await client.query("SAVEPOINT lock_unlocked_proposal");
  let locked: ItemRow | null;
  try {
    locked = isTickWriteTransaction(client)
      ? await itemsStore.lockItemByIdNowait(client, config.processingProposalsDatabaseId, snapshot.id)
      : await itemsStore.lockItemById(client, config.processingProposalsDatabaseId, snapshot.id);
    await client.query("RELEASE SAVEPOINT lock_unlocked_proposal");
  } catch (err) {
    const busy = typeof err === "object" && err !== null && "code" in err && err.code === "55P03";
    if (!isSerializationFailure(err) && !busy) throw err;
    await client.query("ROLLBACK TO SAVEPOINT lock_unlocked_proposal");
    await client.query("RELEASE SAVEPOINT lock_unlocked_proposal");
    logger.info({ proposalId: snapshot.id, reason: busy ? "busy" : "changed" }, "Skipping proposal write");
    return null;
  }
  let reason: "gone" | "deleted" | "locked" | "changed" | null = null;
  if (!locked) reason = "gone";
  else if (locked.deletedAt !== null) reason = "deleted";
  else if (typeof locked.properties.status === "string" && LOCKED_PROPOSAL_STATUSES.has(locked.properties.status))
    reason = "locked";
  else if (assistantSideChanged(locked, snapshot)) reason = "changed";

  if (reason !== null) {
    logger.info({ proposalId: snapshot.id, reason }, "Skipping proposal write");
    return null;
  }
  return locked;
}

export { appendHistoryEntry, type ProposalHistoryEntry, type ProposalHistoryKind } from "./proposalHistory.js";

async function assertValidStep(client: PoolClient, step: ProposalStep): Promise<DatabaseRow> {
  const properties = step.properties ?? {};
  if (step.op === "fileFromAttachment") return assertValidFileFromAttachmentStep(client, step);
  if (step.op === "create") {
    if (step.itemId !== undefined) throw stepError(step, "a create step cannot name an itemId", "itemId");
    if (step.databaseKey === undefined) throw stepError(step, "a create step needs a databaseKey", "databaseKey");
    const database = assertStepDatabaseWritable(
      step,
      await databasesStore.getDatabaseByKey(client, step.databaseKey),
      "databaseKey",
    );
    await withStepRef(step.ref, async () => {
      if (database.ownerModuleId === MCP_SERVERS_MODULE_ID) assertValidMcpServerProposalProperties(properties);
      const byKey = new Map(
        (await propertiesStore.listPropertiesByDatabase(client, database.id)).map((property) => [
          property.key,
          property,
        ]),
      );
      assertValidStepProperties(properties, byKey, database.id, null);
      await assertValidEnvelopeRelations(client, database.id, byKey, existingItemRelations(step));
    });
    return database;
  }

  if (step.databaseKey !== undefined)
    throw stepError(step, `an ${step.op} step cannot name a databaseKey`, "databaseKey");
  if (step.itemId === undefined || !UUID_RE.test(step.itemId)) {
    throw stepError(step, `an ${step.op} step needs an itemId`, "itemId");
  }
  const [item] = await itemsStore.getItemsByIds(client, [step.itemId]);
  if (!item) throw stepError(step, `item '${step.itemId}' does not exist`, "itemId");
  const database = assertStepDatabaseWritable(
    step,
    await databasesStore.getDatabase(client, item.databaseId),
    "itemId",
  );
  if (step.op === "link" && Object.keys(properties).length > 0) {
    throw stepError(step, "a link step cannot write properties", "properties");
  }
  await withStepRef(step.ref, async () => {
    const databaseProperties = await propertiesStore.listPropertiesByDatabase(client, database.id);
    const byKey = new Map(databaseProperties.map((property) => [property.key, property]));
    assertValidStepProperties(properties, byKey, database.id, item.properties);
    if (step.op === "update") {
      // An invalid stored zone propagates instead of refusing the proposal.
      const zone = Object.keys(properties).length > 0 ? await readProposalTimezone(client) : null;
      const prepared = zone
        ? await prepareUserItemPatch(databaseProperties, properties, database, item, zone)
        : { patch: {}, deferredKeys: [] };
      assertUpdateStepShape(step, prepared, item, byKey);
    }
    await assertValidEnvelopeRelations(client, database.id, byKey, existingItemRelations(step), item.id);
  });
  return database;
}

/**
 * Refs unique, one primary that mirrors the top level, acyclic refs, every active step valid on its own (disabled and
 * unreferenced optional steps are skipped). Failures carry `details: { ref, field }`.
 */
async function assertValidEnvelopeOperations(
  client: PoolClient,
  envelope: ProposalEnvelope,
  steps: ProposalStep[],
): Promise<void> {
  if (envelope.entityKind !== "database") {
    throw new ValidationError("Proposal envelope operations are only valid for entityKind 'database'", {
      field: "operations",
    });
  }
  if (steps.length === 0)
    throw new ValidationError("Proposal envelope operations must not be empty", { field: "operations" });

  const activeSteps = selectActiveSteps(steps);
  assertNoRefCycle(activeSteps);
  for (const step of activeSteps) {
    const database = await assertValidStep(client, step);
    if (step.role !== "primary") continue;
    if (step.op === "link") throw stepError(step, "the primary step cannot be a link step", "op");
    // A file step's `attachmentId` is not a property of the target database.
    if (step.op === "fileFromAttachment")
      throw stepError(step, "the primary step cannot be a fileFromAttachment step", "op");
    if (database.id !== envelope.target) {
      throw stepError(
        step,
        "its database differs from the envelope target",
        step.op === "create" ? "databaseKey" : "itemId",
      );
    }
    if (!isDeepStrictEqual(step.properties ?? {}, envelope.properties)) {
      throw stepError(step, "its properties differ from the envelope properties", "properties");
    }
  }
}

/**
 * Checks against the destination's own requirements, not the choke-point write path, because a proposal is never
 * itself written to the destination. Throws `ValidationError` for a wrong `entityKind`, a malformed target,
 * unacceptable properties or a derived project relation set next to its project. A `newOptions` label an option already
 * has throws `OptionLabelExistsError`, which callers treat as a refusal like a `ValidationError`. Resolves to the target
 * database row for a `'database'` envelope so callers can reuse it, `null` otherwise.
 */
export async function assertValidProposalEnvelope(
  client: PoolClient,
  envelope: ProposalEnvelope,
): Promise<DatabaseRow | null> {
  assertValidEnvelopePageSections(envelope);
  assertValidEnvelopeNewOptionsPlacement(envelope);
  if (envelope.entityKind === "transcription") {
    await assertValidRecordingEnvelope(client, envelope);
    return null;
  }
  if (envelope.entityKind === "journalEntry") return assertValidJournalEntryEnvelope(client, envelope);
  if (
    envelope.entityKind !== "pageContent" &&
    envelope.entityKind !== "database" &&
    envelope.entityKind !== "relation"
  ) {
    throw new ValidationError(`Proposal envelope has unknown entityKind '${String(envelope.entityKind)}'`, {
      field: "entityKind",
    });
  }

  if (envelope.operations !== undefined) {
    await assertValidEnvelopeOperations(client, envelope, envelope.operations);
  }

  if (envelope.entityKind === "database") {
    if (!UUID_RE.test(envelope.target)) {
      throw new ValidationError(`Proposal envelope target '${envelope.target}' is not a database id`, {
        field: "target",
      });
    }
    const targetDatabase = await databasesStore.getDatabase(client, envelope.target);
    if (!targetDatabase || targetDatabase.archivedAt) {
      throw new ValidationError(`Proposal envelope target '${envelope.target}' is not an existing target database`, {
        field: "target",
      });
    }
    // Grant separation enforced here, not only declared in the manifest: a user `revise` builds its envelope from raw
    // input and could otherwise name Inbox/Inbox item types as `target`, and confirm's generic create would bypass
    // their `writable: false` because nothing upstream reads the manifest.
    if (targetDatabase.ownerModuleId && ALLDOTS_READ_ONLY_MODULE_IDS.includes(targetDatabase.ownerModuleId)) {
      throw new ValidationError(`Proposal envelope target '${envelope.target}' is not a writable target database`, {
        field: "target",
      });
    }
    // An MCP server's credential never travels through a proposal envelope; a human supplies it at confirm time.
    if (targetDatabase.ownerModuleId === MCP_SERVERS_MODULE_ID) {
      assertValidMcpServerProposalProperties(envelope.properties);
    }

    const targetProperties = await propertiesStore.listPropertiesByDatabase(client, targetDatabase.id);
    const byKey = new Map(targetProperties.map((property) => [property.key, property]));
    // A `{ newOption }` value is no option key yet, so the key check reads the properties without it.
    const properties = await assertValidEnvelopeNewOptions(envelope, targetDatabase, byKey);
    assertValidEnvelopeProperties({ ...envelope, properties }, byKey, targetDatabase.id);
    await lockEnvelopeBlobReferences(client, envelope.properties, byKey);
    if (envelope.relations !== undefined) {
      await assertValidEnvelopeRelations(client, targetDatabase.id, byKey, envelope.relations);
      assertNoDerivedRelations(targetDatabase, envelope);
    }
    return targetDatabase;
  }

  if (envelope.relations !== undefined) {
    throw new ValidationError(`Proposal envelope relations are only valid for entityKind 'database'`, {
      field: "relations",
    });
  }

  if (envelope.entityKind === "relation") {
    // Only the envelope's shape is checked here; whether the edge may be written depends on the card's source, which
    // proposalActions.ts checks. A synthetic `<seriesId>@<date>` names an occurrence with no item yet.
    if (!UUID_RE.test(envelope.target) && (await assertValidOccurrenceTarget(client, envelope.target)) === null) {
      throw new ValidationError(`Proposal envelope target '${envelope.target}' is not an item id`, { field: "target" });
    }
    const { propertyKey, metadata, ...rest } = envelope.properties;
    const metadataValid =
      metadata === undefined || (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata));
    if (Object.keys(rest).length > 0 || typeof propertyKey !== "string" || propertyKey.length === 0 || !metadataValid) {
      throw new ValidationError(
        "Proposal properties for entityKind 'relation' must be { propertyKey } plus an optional metadata object",
        { field: "properties" },
      );
    }
    return null;
  }

  const targetPage = await requireProposalPageTarget(client, envelope.target);
  if (Object.hasOwn(envelope.properties, "markdown")) {
    await assertValidV2PageContent(client, targetPage, envelope.properties);
    return null;
  }
  if (typeof envelope.properties.flavour !== "string" || envelope.properties.flavour.length === 0) {
    throw new ValidationError("Proposal properties for entityKind 'pageContent' must carry a 'flavour' block field", {
      field: "properties",
    });
  }
  // Confirm casts `fields`/`children` back out of storage, so they are validated at the one point every pageContent
  // envelope passes through.
  const { fields, children } = envelope.properties;
  if (fields !== undefined && (typeof fields !== "object" || fields === null || Array.isArray(fields))) {
    throw new ValidationError("Proposal properties 'fields', if present, must be a plain object", {
      field: "properties",
    });
  }
  if (children !== undefined && (!Array.isArray(children) || !children.every((child) => typeof child === "string"))) {
    throw new ValidationError("Proposal properties 'children', if present, must be an array of strings", {
      field: "properties",
    });
  }
  return null;
}

/**
 * The shared path for "no usable type" and for a computed envelope that failed destination validation: either way the
 * card lands in `needsClarification` with no pre-filled `proposal` instead of going silent. A no-op for a locked card
 * or one already `needsClarification` with the same `fingerprint`, so history is not spammed. `userOverrides` and
 * `userEditedKeys` stay stored and apply again to the next valid envelope.
 */
async function writeNeedsClarification(
  client: PoolClient,
  config: AlldotsTickActionConfig,
  sourceItemId: string,
  existingProposal: ItemRow | null,
  message: string,
  fingerprint: string | null = null,
  clarificationPatch: Record<string, unknown> = {},
): Promise<void> {
  if (existingProposal) {
    const status = existingProposal.properties.status;
    if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) return;
    if (status === "needsClarification" && existingProposal.properties.fingerprint === fingerprint) return;

    const locked = await lockUnlockedProposal(client, config, existingProposal);
    if (!locked) return;
    // Leaving `invalid` drops the reason in the same write, as a revise does.
    const clearedReason = locked.properties.status === "invalid" ? { invalidReason: null } : {};
    await updateItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        itemId: locked.id,
        ifVersion: locked.version,
        propertiesPatch: {
          fingerprint,
          proposal: null,
          referencedItemIds: [],
          reason: null,
          ...clarificationPatch,
          ...aiProposalPatch(locked.properties, null),
          status: "needsClarification",
          ...clearedReason,
          history: appendHistoryEntry(locked.properties.history, message),
        },
      },
      {
        allowedSystemKeys: [
          ...RECOGNITION_CARD_KEYS,
          "fingerprint",
          "proposal",
          "aiProposal",
          "aiVersion",
          "referencedItemIds",
          "status",
          "invalidReason",
          "history",
        ],
      },
    );
    publishInboxCardChange(client, locked.id, "updated");
    await enqueueJournalInboxRecomputeForInboxItem(client, sourceItemId);
    return;
  }

  const proposal = await createItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      properties: {
        kind: "inbox",
        fingerprint,
        proposal: null,
        referencedItemIds: [],
        reason: null,
        ...clarificationPatch,
        ...aiProposalPatch({}, null),
        history: appendHistoryEntry([], message),
        status: "needsClarification",
      },
    },
    {
      allowedSystemKeys: [
        ...RECOGNITION_CARD_KEYS,
        "kind",
        "fingerprint",
        "proposal",
        "aiProposal",
        "aiVersion",
        "referencedItemIds",
        "history",
        "status",
      ],
    },
  );
  await linkSourceInboxRelation(client, config, proposal.id, sourceItemId);
  publishInboxCardChange(client, proposal.id, "created");
  await enqueueJournalInboxRecomputeForInboxItem(client, sourceItemId);
}

/**
 * `sourceDeleted` is final for revise: the card can only be discarded, or reopened when the source is restored.
 * `targetArchived`/`targetDeleted` are fixable by revising to a valid target. `label` is the item's name when the
 * reason was written; the sentence is rendered by `renderInvalidReason`, not stored.
 */
export const invalidReasonSchema = z.object({
  code: z.enum(["sourceDeleted", "targetArchived", "targetDeleted"]),
  field: z.string(),
  itemId: z.string().min(1),
  label: z.string(),
});

export type InvalidReason = z.infer<typeof invalidReasonSchema>;

export function isFinalInvalid(properties: Record<string, unknown>): boolean {
  if (properties.status !== "invalid") return false;
  const parsed = invalidReasonSchema.safeParse(properties.invalidReason);
  return parsed.success && parsed.data.code === "sourceDeleted";
}

/**
 * Locked cards and missing proposals are left untouched: a locked card is never recomputed. A card already invalid
 * for this deleted source is untouched too, so repeated delete events add no history; other invalid reasons are
 * superseded.
 */
async function invalidateProposalForDeletedSource(
  client: PoolClient,
  config: AlldotsTickActionConfig,
  existingProposal: ItemRow | null,
  sourceItemId: string,
  sourceItem: ItemRow | null,
): Promise<void> {
  if (!existingProposal) return;
  const locked = await lockUnlockedProposal(client, config, existingProposal);
  if (!locked) return;
  const existingReason = invalidReasonSchema.safeParse(locked.properties.invalidReason);
  if (isFinalInvalid(locked.properties) && existingReason.success && existingReason.data.itemId === sourceItemId)
    return;
  const invalidReason: InvalidReason = {
    code: "sourceDeleted",
    field: "",
    itemId: sourceItemId,
    label: invalidReasonLabel(sourceItem),
  };
  await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: locked.id,
      ifVersion: locked.version,
      propertiesPatch: {
        status: "invalid",
        reason: null,
        invalidReason,
        history: appendHistoryEntry(locked.properties.history, "Source Inbox item was deleted.", "ai", {
          kind: "invalidated",
        }),
      },
    },
    { allowedSystemKeys: [...RECOGNITION_CARD_KEYS, "status", "invalidReason", "history"] },
  );
  publishInboxCardChange(client, locked.id, "updated");
}

/** Distinguishes an envelope refusal from a fault that must propagate. */
function refusesEnvelope(err: unknown): err is ValidationError | CardinalityViolationError | OptionLabelExistsError {
  return (
    err instanceof ValidationError || err instanceof CardinalityViolationError || err instanceof OptionLabelExistsError
  );
}

/** A missing or unparseable envelope, a cardinality violation or a taken new-option label fails; other errors propagate. */
export async function storedEnvelopeStillValid(client: PoolClient, proposal: ItemRow): Promise<boolean> {
  const parsed = proposalEnvelopeSchema.safeParse(proposal.properties.proposal);
  if (!parsed.success) return false;
  try {
    await assertValidProposalEnvelope(client, parsed.data);
    return true;
  } catch (err) {
    if (refusesEnvelope(err)) return false;
    throw err;
  }
}

/**
 * Runs in the read transaction before the fingerprint gate. A still-valid envelope goes to `proposed`, otherwise to
 * `needsClarification` keeping the stored fingerprint; `invalidReason` is cleared either way. `null` when the lock
 * refuses a card that changed since the read, which ends the tick.
 */
async function reopenRestoredSourceProposal(
  client: PoolClient,
  config: AlldotsTickActionConfig,
  invalidCard: ItemRow,
  sourceItemId: string,
): Promise<ItemRow | null> {
  const locked = await lockUnlockedProposal(client, config, invalidCard);
  if (!locked) return null;

  if (!(await storedEnvelopeStillValid(client, locked))) {
    const fingerprint = typeof locked.properties.fingerprint === "string" ? locked.properties.fingerprint : null;
    await writeNeedsClarification(
      client,
      config,
      sourceItemId,
      locked,
      "Source item was restored, but its stored proposal no longer validates; needs clarification.",
      fingerprint,
    );
    return findExistingProposal(client, config, sourceItemId);
  }

  const reopened = await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: locked.id,
      ifVersion: locked.version,
      propertiesPatch: {
        status: "proposed",
        invalidReason: null,
        history: appendHistoryEntry(
          locked.properties.history,
          "Source item was restored; the proposal is proposed again.",
          "ai",
          { kind: "reopened" },
        ),
      },
    },
    { allowedSystemKeys: [...RECOGNITION_CARD_KEYS, "status", "invalidReason", "history"] },
  );
  publishInboxCardChange(client, reopened.id, "updated");
  return reopened;
}

/**
 * The read phase, through the fingerprint gate, in one transaction. Outcomes needing no model call (deleted or empty
 * source, locked or unchanged card, a long recording) are written here and return `null`. A `sourceDeleted` card with
 * a live source is reopened first, and the gate applies to it as it now stands. Otherwise returns a snapshot with the
 * resolved target for the external call and the write transaction.
 */
async function readTickSnapshot(
  client: PoolClient,
  config: AlldotsTickActionConfig,
  sourceItemId: string,
): Promise<TickSnapshot | null> {
  const item = await itemsStore.getItemById(client, config.inboxDatabaseId, sourceItemId);
  let existingProposal = await findExistingProposal(client, config, sourceItemId);

  // Fires on every create/update/delete, so it covers property edits and deletions (the `journalDay` edge survives a
  // soft delete and the recompute filters deleted items). Redundant but harmless after the create hook's own enqueue.
  if (item) await enqueueJournalInboxRecomputeForInboxItem(client, item.id);

  if (!item || item.deletedAt) {
    await invalidateProposalForDeletedSource(client, config, existingProposal, sourceItemId, item);
    return null;
  }

  const recognized = await resolveRecognizedType(client, config, item);
  const type = recognized?.type ?? null;
  const processingMethod = recognized?.processingMethod ?? "pageContent";
  const definition = await getRelationDefinitionByKey(client, config.inboxDatabaseId, "type");
  const edges = definition ? await relationsStore.listRelationsForItem(client, definition.id, item.id) : [];
  const sourceTypeId = edges[0] ? relationsStore.otherSide(edges[0], item.id) : null;
  const v2Input = await inboxFingerprintInput(client, item, type);
  const fingerprint = computeInboxFingerprintV2(v2Input);

  // Leave `invalid` before the fingerprint gate, so an unchanged fingerprint does not hide the change of state.
  if (existingProposal && isFinalInvalid(existingProposal.properties)) {
    existingProposal = await reopenRestoredSourceProposal(client, config, existingProposal, item.id);
    if (!existingProposal) return null;
  }

  if (existingProposal) {
    const status = existingProposal.properties.status;
    if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) return null;
    // A `computing` card was sent back for recomputation; its fingerprint says what the last run saw, not whether
    // another is wanted, so the gate does not apply.
    if (status !== "computing" && isFingerprintCurrent(existingProposal.properties.fingerprint, v2Input)) return null;
  }

  // A long recording gets the recording card without a model call; audio without metadata gets nothing until the
  // metadata job runs the tick again.
  const route = routeInboxAttachments(await listInboxAttachments(client, [item.id]));
  if (route === "notReady") return null;
  if (route !== "compute") {
    const { envelope, context } = await buildRecordingCard(client, item, route.recording);
    const snapshot = { item, type, sourceTypeId, processingMethod, entityKind: "pageContent" as const };
    const locale = (await getTenantUserLocale(client)) ?? "cs";
    await writeTickResult(client, config, { ...snapshot, existingProposal, fingerprint, locale }, envelope, null, {
      context,
    });
    return null;
  }

  // A photo without metadata has no reduced copy yet; the metadata job's `update` heartbeat restarts the tick.
  if (await hasAttachmentAwaitingMetadata(client, item.id)) return null;

  if (!type) {
    if (!v2Input.text.trim()) {
      await writeNeedsClarification(
        client,
        config,
        item.id,
        existingProposal,
        "Source item has no content to recognize.",
        fingerprint,
      );
      return null;
    }
    return {
      item,
      type: null,
      processingMethod,
      entityKind: "pageContent",
      existingProposal,
      fingerprint,
      locale: (await getTenantUserLocale(client)) ?? "cs",
      sourceTypeId,
      recognition: true,
      activeTypes: validRecognitionTypes(await listActiveInboxTypes(client, config.inboxItemTypesDatabaseId)),
    };
  }
  const target = await resolveTickTarget(client, type, processingMethod);

  const locale = (await getTenantUserLocale(client)) ?? "cs";

  return {
    item,
    type,
    sourceTypeId,
    processingMethod,
    ...target,
    existingProposal,
    fingerprint,
    locale,
  };
}

/**
 * A no-op if it lost the race. Writes the assistant's parts and keeps manual values that still apply
 * (`mergeRecomputeWithManualValues`). A stored `context` is dropped unless `recognitionPatch` brings a new one, so a
 * card that stops being a recording card does not keep a recording's context.
 */
async function reviseProposal(
  client: PoolClient,
  config: AlldotsTickActionConfig,
  existing: ItemRow,
  sourceItemId: string,
  fingerprint: string,
  envelope: ProposalEnvelope,
  reason: string | null,
  recognitionPatch: Record<string, unknown> = {},
): Promise<void> {
  const locked = await lockUnlockedProposal(client, config, existing);
  if (!locked) return;
  const merged = await mergeRecomputeWithManualValues(client, locked, envelope);
  await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: locked.id,
      ifVersion: locked.version,
      propertiesPatch: {
        fingerprint,
        proposal: merged.effective,
        referencedItemIds: referencedItemIdsOf(merged.effective),
        reason,
        ...(locked.properties.context ? { context: null } : {}),
        ...recognitionPatch,
        ...aiProposalPatch(locked.properties, envelope),
        userOverrides: merged.userOverrides,
        userEditedKeys: merged.userEditedKeys,
        status: "proposed",
        history: merged.history,
      },
    },
    {
      allowedSystemKeys: [
        ...RECOGNITION_CARD_KEYS,
        "fingerprint",
        "proposal",
        "aiProposal",
        "aiVersion",
        "referencedItemIds",
        "userOverrides",
        "userEditedKeys",
        "context",
        "status",
        "history",
      ],
    },
  );
  publishInboxCardChange(client, locked.id, "updated");
  await enqueueJournalInboxRecomputeForInboxItem(client, sourceItemId);
}

/** The source must still exist, undeleted, with the same type edge and fingerprint; `null` after logging otherwise. */
async function currentSourceFingerprint(
  client: PoolClient,
  config: AlldotsTickActionConfig,
  snapshot: TickSnapshot,
): Promise<{ item: ItemRow; fingerprint: string } | null> {
  const item = await itemsStore.lockItemById(client, config.inboxDatabaseId, snapshot.item.id);
  if (!item || item.deletedAt) {
    logger.info({ sourceItemId: snapshot.item.id, reason: "sourceDeleted" }, "Skipping stale tick write");
    return null;
  }

  const definition = await getRelationDefinitionByKey(client, config.inboxDatabaseId, "type");
  const edges = definition ? await relationsStore.listRelationsForItem(client, definition.id, item.id) : [];
  const sourceTypeId = edges[0] ? relationsStore.otherSide(edges[0], item.id) : null;
  if (sourceTypeId && !(await tryLockInboxType(client, config.inboxItemTypesDatabaseId, sourceTypeId))) return null;
  const recognized = await resolveRecognizedType(client, config, item);
  if (sourceTypeId !== snapshot.sourceTypeId || (!snapshot.recognition && recognized?.type.id !== snapshot.type?.id))
    return null;
  const fingerprint = computeInboxFingerprintV2(
    await inboxFingerprintInput(client, item, snapshot.recognition ? null : (recognized?.type ?? null)),
  );
  if (fingerprint !== snapshot.fingerprint) {
    logger.info({ sourceItemId: snapshot.item.id, reason: "fingerprintChanged" }, "Skipping stale tick write");
    return null;
  }
  return { item, fingerprint };
}

/**
 * Runs in its own transaction after the non-transactional `computeProposal` call, re-validating the source first; a
 * mismatch skips the stale result.
 */
async function writeTickResult(
  client: PoolClient,
  config: AlldotsTickActionConfig,
  snapshot: TickSnapshot,
  envelope: ProposalEnvelope | ValidationError | null,
  reason: string | null,
  recognitionPatch: Record<string, unknown> = {},
  invalidProposal = false,
): Promise<void> {
  const current = await currentSourceFingerprint(client, config, snapshot);
  if (!current) return;
  const { item, fingerprint } = current;
  const missingTarget = envelope === null;

  try {
    if (!envelope) throw new ValidationError("Page target needs clarification");
    if (envelope instanceof ValidationError) throw envelope;
    if (invalidProposal) throw new ValidationError("Proposal needs clarification");
    envelope = await resolveModelPagePlacement(client, envelope);
    envelope = await prepareComputedUpdates(client, envelope, snapshot.item.properties.date);
    await assertValidProposalEnvelope(client, envelope);
  } catch (err) {
    if (!refusesEnvelope(err)) throw err;
    // Another tick may have created a proposal while this one waited on the model; re-check so
    // `writeNeedsClarification` does not create a second row for the same source.
    const existingForClarification = snapshot.existingProposal ?? (await findExistingProposal(client, config, item.id));
    await writeNeedsClarification(
      client,
      config,
      item.id,
      existingForClarification,
      `Computed proposal failed validation: ${err.message}`,
      fingerprint,
      missingTarget ? { reason: await recognitionChangedReason(toManifestLocale(snapshot.locale)) } : {},
    );
    return;
  }

  // Another tick may have created a proposal while this one waited on the model.
  const existing = snapshot.existingProposal ?? (await findExistingProposal(client, config, item.id));
  if (existing) {
    await reviseProposal(client, config, existing, item.id, fingerprint, envelope, reason, recognitionPatch);
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
        referencedItemIds: referencedItemIdsOf(envelope),
        reason,
        ...recognitionPatch,
        ...aiProposalPatch({}, envelope),
        history: appendHistoryEntry([], "Created a proposal for the source item."),
        status: "proposed",
      },
    },
    {
      allowedSystemKeys: [
        ...RECOGNITION_CARD_KEYS,
        "kind",
        "fingerprint",
        "proposal",
        "aiProposal",
        "aiVersion",
        "referencedItemIds",
        "context",
        "history",
        "status",
      ],
    },
  );

  await linkSourceInboxRelation(client, config, proposal.id, item.id);
  publishInboxCardChange(client, proposal.id, "created");
  await enqueueJournalInboxRecomputeForInboxItem(client, item.id);
}

/**
 * Same source re-checks as `writeTickResult`. Stores `computeFailed` with a cleared fingerprint so the next tick
 * computes again. An existing `proposal` stays; a locked card is never touched; a card is created only when none exists.
 */
async function writeComputeFailure(
  client: PoolClient,
  config: AlldotsTickActionConfig,
  snapshot: TickSnapshot,
  reason: AiGatewayFailureReason,
): Promise<void> {
  const current = await currentSourceFingerprint(client, config, snapshot);
  if (!current) return;
  const { item } = current;
  // Reason code only: the provider's own text never reaches the card.
  const message = `Computing the proposal failed: ${reason}.`;

  // Another tick may have created a proposal while this one waited on the model.
  const existing = snapshot.existingProposal ?? (await findExistingProposal(client, config, item.id));
  if (existing) {
    const locked = await lockUnlockedProposal(client, config, existing);
    if (!locked) return;
    const history = appendHistoryEntry(locked.properties.history, message);
    await updateItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        itemId: locked.id,
        ifVersion: locked.version,
        propertiesPatch: { fingerprint: null, status: "computeFailed", history },
      },
      { allowedSystemKeys: ["fingerprint", "status", "history"] },
    );
    publishInboxCardChange(client, locked.id, "updated");
  } else {
    const history = appendHistoryEntry([], message);
    const proposal = await createItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        properties: { kind: "inbox", fingerprint: null, history, status: "computeFailed" },
      },
      { allowedSystemKeys: ["kind", "fingerprint", "history", "status"] },
    );
    await linkSourceInboxRelation(client, config, proposal.id, item.id);
    publishInboxCardChange(client, proposal.id, "created");
  }
  await enqueueJournalInboxRecomputeForInboxItem(client, item.id);
}

/**
 * Three phases (staleness-checked bracket): a read transaction resolves no-call cases or returns a snapshot; the model
 * call runs outside a transaction; the write transaction revalidates the source and preserves locked cards.
 *
 * An `AiGatewayFailedError` is recorded as `computeFailed` when the reason is `budget_exceeded` or this is the final
 * queue attempt (unless the source changed or the card is locked); otherwise it is rethrown so the queue retries.
 * Other errors propagate unchanged.
 */
export function createAlldotsTickAction(pool: Pool, computeProposal: ComputeAlldotsProposalFn): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return;
    // Throws, surfacing as a recorded heartbeat failure, rather than silently no-op'ing on a misconfigured heartbeat.
    const config = alldotsTickActionConfigSchema.parse(actionConfig);
    const sourceItemId = context.itemId;

    const snapshot = await withTickTransaction(pool, (client) => readTickSnapshot(client, config, sourceItemId));
    if (!snapshot) return;

    let result: ProposalComputationResult;
    try {
      result = await computeProposal(tickComputationInput(snapshot, context.projectItemId));
    } catch (err) {
      if (!(err instanceof AiGatewayFailedError)) throw err;
      const reason = err.reason;
      if (reason !== "budget_exceeded" && context.isFinalAttempt !== true) throw err;
      logger.warn({ sourceItemId, reason }, "Recording a failed proposal computation on the card");
      try {
        await withTickWriteTransaction(pool, (client) => writeComputeFailure(client, config, snapshot, reason));
      } catch (writeError) {
        // Both caught errors are preserved in the aggregate; its cause identifies the failed write.
        throw new AggregateError([err, writeError], "Proposal computation and failure recording both failed", {
          cause: writeError,
        });
      }
      return;
    }
    if (snapshot.recognition) {
      await withTickWriteTransaction(pool, async (client) => {
        if (!(await currentSourceFingerprint(client, config, snapshot))) return;
        const selection = await resolveBoundRecognition(client, config.inboxItemTypesDatabaseId, snapshot, result);
        if (!selection) return;
        const { best, choices, selected, database, targetModule, changed } = selection;
        if (!best || best.confidence < RECOGNITION_CONFIDENCE_THRESHOLD || changed) {
          const existing = snapshot.existingProposal ?? (await findExistingProposal(client, config, snapshot.item.id));
          const patch = await recognitionClarificationPatch(
            toManifestLocale(snapshot.locale),
            choices,
            changed,
            result.reason,
          );
          await writeNeedsClarification(
            client,
            config,
            snapshot.item.id,
            existing,
            "Recognition needs clarification.",
            snapshot.fingerprint,
            patch,
          );
          return;
        }
        const resolved = {
          ...snapshot,
          entityKind: selected?.processingMethod === "pageContent" ? ("pageContent" as const) : ("database" as const),
          targetDatabaseId: database?.id,
          targetModuleId: targetModule ?? undefined,
        };
        await writeTickResult(
          client,
          config,
          resolved,
          buildProposalEnvelope(resolved, result),
          result.reason?.trim().slice(0, 500) || null,
          { recognizedTypeId: selected?.id ?? null, typeCandidates: [] },
          result.invalidProposal !== undefined,
        );
      });
      return;
    }
    const envelope =
      snapshot.entityKind === "pageContent" && !result.target ? null : buildTickEnvelope(snapshot, result);

    await withTickWriteTransaction(pool, (client) =>
      writeTickResult(
        client,
        config,
        snapshot,
        envelope,
        result.reason?.trim().slice(0, 500) || null,
        {},
        result.invalidProposal !== undefined,
      ),
    );
  };
}
