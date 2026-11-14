import {
  withStepRef,
  existingItemRelations,
  assertStepDatabaseWritable,
  assertUpdateStepShape,
} from "./proposalEnvelopeValidation.js";
import { inboxFingerprintInput, getRelationDefinitionByKey, resolveRecognizedType } from "./inboxSourceFingerprint.js";
import { prepareComputedUpdates, readProposalTimezone } from "./proposalComputedUpdates.js";
import {
  buildProposalEnvelope,
  resolveModelPagePlacement,
  type TickSnapshot,
  type ProposalComputationResult,
  type ComputeSemprecProposalFn,
} from "./inboxTickSnapshot.js";
export type {
  ProposalComputationInput,
  ProposalComputationResult,
  ComputeSemprecProposalFn,
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
import { semprecTickActionConfigSchema, type SemprecTickActionConfig } from "./proposalEnvelope.js";
export { semprecTickActionConfigSchema, type SemprecTickActionConfig } from "./proposalEnvelope.js";
import {
  assertValidEnvelopeRelations,
  assertValidV2PageContent,
  assertValidEnvelopeProperties,
  assertValidStepProperties,
  requireProposalPageTarget,
} from "./proposalEnvelopeValidation.js";
import {
  proposalEnvelopeSchema,
  type ComputedProposalEntityKind,
  type ProposalStep,
  type ProposalEnvelope,
} from "./proposalEnvelope.js";
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
import { AiGatewayFailedError, createLogger, type AiGatewayFailureReason, type Logger } from "@semprec/shared";
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
import { SEMPREC_READ_ONLY_MODULE_IDS } from "../seed/inboxPipelineKeys.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { assertValidMcpServerProposalProperties } from "../mcp/mcpServerProposal.js";
import { parseFileFromAttachmentProperties } from "./fileAttachmentStep.js";
import { assertNoRefCycle, selectActiveSteps, stepError } from "./proposalStepGraph.js";
import { appendHistoryEntry } from "./proposalHistory.js";
import { linkSourceInboxRelation } from "./inboxCardSourceLink.js";
import { publishInboxCardChange } from "./inboxCardsRealtime.js";
import { isSerializationFailure, isTickWriteTransaction } from "./tickTransaction.js";
import { withTickTransaction, withTickWriteTransaction } from "./tickTransaction.js";
import { tryLockInboxType, resolveBoundRecognition } from "./inboxSourceGuard.js";
import { CardinalityViolationError, ValidationError } from "../errors.js";
import { getTenantUserLocale } from "../auth/usersStore.js";
import type { DatabaseRow, ItemRow } from "../types.js";

export { selectActiveSteps } from "./proposalStepGraph.js";

const logger: Logger = createLogger("inbox-tick");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { SEMPREC_TICK_ACTION_ID, SEMPREC_TICK_QUEUE_NAME } from "./inboxTickKeys.js";

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
async function findExistingProposal(
  client: PoolClient,
  config: SemprecTickActionConfig,
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
    if (proposal && !proposal.deletedAt) return proposal;
  }
  return null;
}

/**
 * Re-reads `snapshot` (a proposal this tick read earlier, unlocked) under `FOR UPDATE`, in the
 * transaction that is about to write it, and returns the locked row only if it is still the
 * row the tick decided on: present, not soft-deleted, not `confirmed`/`rejected`, and with the
 * same `fingerprint` and `aiVersion` (`assistantSideChanged`). Anything else — a confirm/reject
 * or an assistant write that committed since the snapshot — is logged with its reason and returns
 * `null`, and the caller skips its write. A manual edit that moved only `updatedAt` does not make
 * the row `changed`; the caller passes the locked row's `updatedAt` as `ifVersion`.
 *
 * The initial repeatable-read phase skips a serialization conflict as changed. The post-model
 * phase uses a nonblocking lock so a confirmation holding the card cannot wait on the source
 * while this transaction waits on that card. The savepoint keeps either skip transaction usable.
 */
async function lockUnlockedProposal(
  client: PoolClient,
  config: SemprecTickActionConfig,
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

// The proposal history block (kinds, entry schema, `appendHistoryEntry`) lives in `proposalHistory.ts`;
// re-exported here so existing importers keep their path (issue #1485 size cap, no behaviour change).
export { appendHistoryEntry, type ProposalHistoryEntry, type ProposalHistoryKind } from "./proposalHistory.js";

/**
 * Validates a `fileFromAttachment` step (issue #1703): it names neither a `databaseKey` nor an `itemId`,
 * its properties are exactly the allowed fields, and its relations are checked as a create step's are.
 * The attachment itself is checked at confirm, where the proposal's source Inbox item is known.
 */
async function assertValidFileFromAttachmentStep(client: PoolClient, step: ProposalStep): Promise<DatabaseRow> {
  if (step.databaseKey !== undefined)
    throw stepError(step, "a fileFromAttachment step cannot name a databaseKey", "databaseKey");
  if (step.itemId !== undefined) throw stepError(step, "a fileFromAttachment step cannot name an itemId", "itemId");
  parseFileFromAttachmentProperties(step.ref, step.properties ?? {});
  const database = assertStepDatabaseWritable(
    step,
    await databasesStore.getDatabaseByModuleId(client, FILES_MODULE_ID),
    "properties",
  );
  await withStepRef(step.ref, async () => {
    const byKey = new Map(
      (await propertiesStore.listPropertiesByDatabase(client, database.id)).map((property) => [property.key, property]),
    );
    await assertValidEnvelopeRelations(client, database.id, byKey, existingItemRelations(step));
  });
  return database;
}

/** Validates one active step as a single-step envelope would be; resolves to the database the step writes to. */
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
      // The tenant zone the preparation needs, read and validated in this transaction; an invalid stored zone
      // propagates instead of refusing the proposal (readProposalTimezone).
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
 * Validates the `operations` of a multi-step envelope: refs unique, one primary that mirrors the
 * top level, same-proposal acyclic refs, and every active step valid on its own (disabled and
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
    // The envelope's top-level `properties` mirror the primary step and are checked against the target
    // database's own properties; a file step's `attachmentId` is not one of them.
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
 * Validates a computed envelope against its destination's own requirements (issue #104) —
 * never against the generic choke-point schema engine's write path, since a proposal is
 * never itself written to the destination (`computeProposal`'s "no target write" guarantee,
 * carried over from issue #223). Throws `ValidationError` for a wrong `entityKind`, an
 * unknown/malformed target, or properties the destination could not accept. Resolves to the
 * target database row for a valid `'database'` envelope (issue #735: so a caller checking
 * `ownerModuleId` afterward reuses this fetch instead of re-querying it), `null` otherwise.
 */
export async function assertValidProposalEnvelope(
  client: PoolClient,
  envelope: ProposalEnvelope,
): Promise<DatabaseRow | null> {
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
    // Issue #105's grant separation, enforced here rather than only declared in the
    // manifest: a user-supplied `revise` builds its envelope from raw request input, so
    // without this check it could name Inbox/Inbox item types as `target` and have a
    // later `confirm` write to them via the generic create-item choke point — bypassing
    // `permissionManifest.ts`'s `writable: false` for those two databases, since nothing
    // upstream of that choke-point call reads the manifest at all.
    if (targetDatabase.ownerModuleId && SEMPREC_READ_ONLY_MODULE_IDS.includes(targetDatabase.ownerModuleId)) {
      throw new ValidationError(`Proposal envelope target '${envelope.target}' is not a writable target database`, {
        field: "target",
      });
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
    assertValidEnvelopeProperties(envelope, byKey, targetDatabase.id);
    if (envelope.relations !== undefined) {
      await assertValidEnvelopeRelations(client, targetDatabase.id, byKey, envelope.relations);
    }
    return targetDatabase;
  }

  if (envelope.relations !== undefined) {
    throw new ValidationError(`Proposal envelope relations are only valid for entityKind 'database'`, {
      field: "relations",
    });
  }

  if (envelope.entityKind === "relation") {
    // Only the envelope's own shape is checked here: whether the edge may be written depends on
    // the card's source item, which proposalActions.ts resolves and checks against the relation.
    // A synthetic occurrence id `<seriesId>@<date>` names an occurrence that has no item yet (issue gh-1850).
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
  // `fields`/`children` are read back out of storage and cast at confirm time (issue #105's
  // proposalActions.ts) to build the block-append call — validated here, at the one point
  // every pageContent envelope (freshly computed or user-revised) passes through, so that
  // cast is never the first thing to notice a malformed stored value.
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
 * Puts a source Inbox item's proposal into `needsClarification` (issue #104): the shared path
 * for "no usable type" (missing or deleted-type reference, per the epic's "no special case for
 * deleted references") and for a computed `proposed` envelope that failed destination
 * validation — both are "the AI/tick could not produce a usable proposal", so both land here
 * with no pre-filled `proposal` rather than ever going silent. Creates the row if none exists,
 * revises it if unlocked, and is a no-op if the row is already locked or already
 * `needsClarification` with the same `fingerprint` (so a repeatedly-untyped or
 * repeatedly-invalid item doesn't spam its history on every tick). A card's `userOverrides` and
 * `userEditedKeys` are not written here: they stay stored and apply again to the next valid envelope
 * (`reviseProposal`).
 */
async function writeNeedsClarification(
  client: PoolClient,
  config: SemprecTickActionConfig,
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
    // A card that leaves `invalid` here drops its reason in the same write, as a revise does (issue #1604).
    const clearedReason = locked.properties.status === "invalid" ? { invalidReason: null } : {};
    await updateItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        itemId: locked.id,
        ifVersion: locked.updatedAt,
        propertiesPatch: {
          fingerprint,
          proposal: null,
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
 * Why a Processing proposal is `invalid` (issue #1482), stored in its `invalidReason` system
 * property. `sourceDeleted` is final for revise: the card can only be discarded, or reopened when
 * its source is restored from the trash (issue #1604). `targetArchived` and `targetDeleted` are
 * fixable: revising the card to a valid target returns it to `proposed`.
 * `field` is the editor field concerned (empty for the source), `itemId` the item that caused
 * it, and `label` that item's name when the reason was written. The warning sentence is not
 * stored; `renderInvalidReason` renders it from the code and the label.
 */
export const invalidReasonSchema = z.object({
  code: z.enum(["sourceDeleted", "targetArchived", "targetDeleted"]),
  field: z.string(),
  itemId: z.string().min(1),
  label: z.string(),
});

export type InvalidReason = z.infer<typeof invalidReasonSchema>;

/**
 * True when a Processing proposal is `invalid` for a reason no revise can repair: its source Inbox
 * item was deleted (issue #1482). A legacy `invalid` card with no `invalidReason` is not final, so
 * it stays revisable.
 */
export function isFinalInvalid(properties: Record<string, unknown>): boolean {
  if (properties.status !== "invalid") return false;
  const parsed = invalidReasonSchema.safeParse(properties.invalidReason);
  return parsed.success && parsed.data.code === "sourceDeleted";
}

/** The most characters (code points, not UTF-16 units) an `invalidReason` label keeps, ellipsis included. */
const INVALID_REASON_LABEL_MAX = 80;

/**
 * The source Inbox item's text as an `invalidReason` label (issue #1482): its first line, trimmed,
 * and at most `INVALID_REASON_LABEL_MAX` characters, a longer one ending with an ellipsis. Cut by
 * code point, so an emoji is never split. An item with no text, or none at all (a hard-deleted
 * source), gives the empty label.
 */
function invalidReasonLabel(item: ItemRow | null): string {
  const text = typeof item?.properties.text === "string" ? item.properties.text : "";
  const characters = Array.from((text.split("\n")[0] ?? "").trim());
  return characters.length > INVALID_REASON_LABEL_MAX
    ? `${characters.slice(0, INVALID_REASON_LABEL_MAX - 1).join("")}…`
    : characters.join("");
}

/**
 * Puts an unlocked proposal into `invalid` (issue #104) when its source Inbox item no longer
 * exists, and stores why as the `sourceDeleted` `invalidReason` (issue #1482). A locked
 * (`confirmed`/`rejected`) proposal, or one with no proposal row at all, is left untouched — per
 * the epic's "a locked card is never recomputed again" rule and because there is nothing to
 * invalidate. A card already invalid for this deleted source is left untouched, so repeated delete
 * events do not add history; other invalid reasons are superseded by the deleted source.
 */
async function invalidateProposalForDeletedSource(
  client: PoolClient,
  config: SemprecTickActionConfig,
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
      ifVersion: locked.updatedAt,
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

/**
 * True when a card's stored `proposal` envelope passes the check the tick applies to a computed
 * envelope before storing it (`assertValidProposalEnvelope`). A card with no envelope, or one
 * that no longer parses or violates relation cardinality, does not pass. Other errors propagate.
 */
async function storedEnvelopeStillValid(client: PoolClient, proposal: ItemRow): Promise<boolean> {
  const parsed = proposalEnvelopeSchema.safeParse(proposal.properties.proposal);
  if (!parsed.success) return false;
  try {
    await assertValidProposalEnvelope(client, parsed.data);
    return true;
  } catch (err) {
    if (err instanceof ValidationError || err instanceof CardinalityViolationError) return false;
    throw err;
  }
}

/**
 * Brings a `sourceDeleted` card back once its source Inbox item has been restored from the trash
 * (issue #1604), inside the read transaction and before the fingerprint gate. A card whose stored
 * envelope still validates goes to `proposed`. One whose envelope no longer validates goes to
 * `needsClarification` as `writeNeedsClarification` writes it, keeping the stored fingerprint. In
 * both cases `invalidReason` is cleared. Returns the card as it now stands, or `null` when the
 * lock refuses it because it changed since the tick read it, which ends the tick.
 */
async function reopenRestoredSourceProposal(
  client: PoolClient,
  config: SemprecTickActionConfig,
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
      ifVersion: locked.updatedAt,
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
 * The tick's read phase: everything up to and including the fingerprint gate, run in one
 * transaction. The outcomes that need no LLM call (deleted or empty source, a locked
 * or unchanged-fingerprint existing proposal) are written here and end the tick (`null`
 * return). A `sourceDeleted` card whose source is live again is first returned to `proposed` or
 * `needsClarification` (issue #1604), and the gate then applies to the card as it now stands.
 * Otherwise enters recognition for an untyped source, or resolves the `processingMethod: 'database'` target database here too — so it never
 * needs to be re-derived — and returns a snapshot for the external call and the write
 * transaction that follows it.
 */
async function readTickSnapshot(
  client: PoolClient,
  config: SemprecTickActionConfig,
  sourceItemId: string,
): Promise<TickSnapshot | null> {
  const item = await itemsStore.getItemById(client, config.inboxDatabaseId, sourceItemId);
  let existingProposal = await findExistingProposal(client, config, sourceItemId);

  // Issue #106: this fires on every create/update/delete tick (issue #103's onItemEvent
  // heartbeats), so it is the one trigger point that covers a property edit (text/date/
  // time) on an existing Inbox item — the create hook (inboxCreateHook.ts) already enqueues
  // its own recompute, so this is redundant-but-harmless there. It also covers deletion:
  // the item's `journalDay` edge (set once at capture) still resolves after a soft
  // delete, since deleting an item never removes its relation edges, and the deleted
  // item is then excluded from the recomputed list by `getItemsByIds`'s deleted_at filter.
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
  const emoji = typeof type?.properties.emoji === "string" ? type.properties.emoji : "";
  const v2Input = await inboxFingerprintInput(client, item, type);
  const fingerprint = computeInboxFingerprintV2(v2Input);

  // The source was restored: the card leaves `invalid` before the fingerprint gate, so an unchanged
  // fingerprint does not hide the change of state (issue #1604).
  if (existingProposal && isFinalInvalid(existingProposal.properties)) {
    existingProposal = await reopenRestoredSourceProposal(client, config, existingProposal, item.id);
    if (!existingProposal) return null;
  }

  if (existingProposal) {
    const status = existingProposal.properties.status;
    if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) return null;
    if (
      isFingerprintCurrent(existingProposal.properties.fingerprint, {
        v2Input,
        legacyEmoji: emoji,
        legacyText: v2Input.text,
      })
    )
      return null;
  }

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
  const entityKind: ComputedProposalEntityKind = processingMethod === "database" ? "database" : "pageContent";
  let targetDatabaseId: string | undefined;
  let targetModuleId: string | undefined;
  if (entityKind === "database") {
    const typeTarget = type.properties.targetDatabase;
    if (typeof typeTarget !== "string") {
      throw new Error(`Inbox item type ${type.id} has processingMethod 'database' but no 'targetDatabase'`);
    }
    const targetDatabase = await databasesStore.getDatabaseByModuleId(client, typeTarget);
    if (!targetDatabase) throw new Error(`No database seeded for owner_module_id '${typeTarget}'`);
    targetDatabaseId = targetDatabase.id;
    targetModuleId = typeTarget;
  }

  // `cs` is the `users.locale` column default, used when the tenant has no bound user.
  const locale = (await getTenantUserLocale(client)) ?? "cs";

  return {
    item,
    type,
    sourceTypeId,
    processingMethod,
    entityKind,
    targetDatabaseId,
    targetModuleId,
    existingProposal,
    fingerprint,
    locale,
  };
}

/**
 * Revises `existing` with `envelope`, through the locked re-check — a no-op if it lost the race. Under the lock it
 * writes the assistant's parts from `envelope` (`aiProposal` with its `aiVersion`, `fingerprint`, the history entry)
 * and keeps the manual values of the locked row that still apply: `proposal` is the effective envelope and
 * `userOverrides` and `userEditedKeys` follow it (`mergeRecomputeWithManualValues`).
 */
async function reviseProposal(
  client: PoolClient,
  config: SemprecTickActionConfig,
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
      ifVersion: locked.updatedAt,
      propertiesPatch: {
        fingerprint,
        proposal: merged.effective,
        reason,
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
        "userOverrides",
        "userEditedKeys",
        "status",
        "history",
      ],
    },
  );
  publishInboxCardChange(client, locked.id, "updated");
  await enqueueJournalInboxRecomputeForInboxItem(client, sourceItemId);
}

/**
 * The source-item re-checks a write transaction runs before it writes anything for `snapshot`:
 * the item must still exist, undeleted, with the same source type edge and the same fingerprint.
 * Returns the item and its current fingerprint, or `null` after logging why the write is stale.
 * Shared by `writeTickResult` and `writeComputeFailure` (issue #1485).
 */
async function currentSourceFingerprint(
  client: PoolClient,
  config: SemprecTickActionConfig,
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
  // Both sides are version 2: the snapshot's fingerprint was computed by `readTickSnapshot` the same way.
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
 * The tick's write phase, run in its own transaction after the non-transactional
 * `computeProposal` call has returned. Re-validates every field `snapshot` was staked on before
 * writing anything: the source item must still exist, undeleted, with the same source type edge
 * and the same fingerprint. A mismatch skips the stale result; dispatch ownership is unchanged.
 */
async function writeTickResult(
  client: PoolClient,
  config: SemprecTickActionConfig,
  snapshot: TickSnapshot,
  envelope: ProposalEnvelope | null,
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
    if (invalidProposal) throw new ValidationError("Proposal needs clarification");
    envelope = await resolveModelPagePlacement(client, envelope);
    envelope = await prepareComputedUpdates(client, envelope, snapshot.item.properties.date);
    await assertValidProposalEnvelope(client, envelope);
  } catch (err) {
    if (!(err instanceof ValidationError) && !(err instanceof CardinalityViolationError)) throw err;
    // Same race as below: another tick may have created a proposal for this source while this
    // one waited on the AI call, so a null `snapshot.existingProposal` doesn't mean there is
    // still nothing to revise — re-check before falling through to `writeNeedsClarification`'s
    // own create path, or this would create a second proposal row for the same source item.
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

  // Another tick may have created a proposal for this source while this one waited on the AI
  // call — revise that one through the guarded path instead of creating a duplicate.
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
 * The write phase of a failed `computeProposal` call (issue #1485), run in its own transaction
 * after the call has thrown an `AiGatewayFailedError`. It applies the same source re-checks as
 * `writeTickResult`, so an edit or deletion during the call writes nothing. It then stores the
 * card as `computeFailed` with a cleared fingerprint, so
 * the next tick computes again instead of skipping on an unchanged fingerprint. An existing
 * `proposal` stays stored as it was; a locked card is never touched; a card is created only when
 * none exists, with the `sourceInbox` edge to the source item.
 */
async function writeComputeFailure(
  client: PoolClient,
  config: SemprecTickActionConfig,
  snapshot: TickSnapshot,
  reason: AiGatewayFailureReason,
): Promise<void> {
  const current = await currentSourceFingerprint(client, config, snapshot);
  if (!current) return;
  const { item } = current;
  // The message carries the reason code only: the provider's own text never reaches the card.
  const message = `Computing the proposal failed: ${reason}.`;

  // Another tick may have created a proposal for this source while this one waited on the AI call,
  // so a null `snapshot.existingProposal` does not mean there is nothing to update.
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
        ifVersion: locked.updatedAt,
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
 * The Inbox `onItemEvent` heartbeat re-reads the item by id, including when rapid edits coalesce.
 *
 * Runs in three phases, per `docs/adr/2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions.md`:
 * a read transaction resolves no-call cases or returns a snapshot; the model call runs outside a
 * transaction; the write transaction revalidates the source and preserves locked cards. A changed
 * source causes a nonwrite. Invalid envelopes become `needsClarification`; card changes append AI history.
 *
 * A gateway failure (`AiGatewayFailedError`) from `computeProposal` is recorded on the card as
 * `computeFailed` (issue #1485) when its reason is `budget_exceeded` or the call is the final queue
 * attempt (`context.isFinalAttempt === true`), unless the source changed during the call or the card
 * is locked, in which case nothing is written. Any other gateway failure is rethrown, so the queue
 * retries the job. Every other error from `computeProposal` propagates unchanged.
 */
export function createSemprecTickAction(pool: Pool, computeProposal: ComputeSemprecProposalFn): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return;
    // Throws (surfacing as a recorded heartbeat failure + notification, see sweep.ts's
    // createHeartbeatFireCoreTask) rather than silently no-op'ing on a misconfigured heartbeat.
    const config = semprecTickActionConfigSchema.parse(actionConfig);
    const sourceItemId = context.itemId;

    const snapshot = await withTickTransaction(pool, (client) => readTickSnapshot(client, config, sourceItemId));
    if (!snapshot) return;

    let result: ProposalComputationResult;
    try {
      result = await computeProposal({
        recognition: snapshot.recognition,
        activeTypes: snapshot.activeTypes,
        sourceItem: snapshot.item,
        type: snapshot.type,
        entityKind: snapshot.entityKind,
        targetDatabaseId: snapshot.targetDatabaseId,
        targetModuleId: snapshot.targetModuleId,
        locale: snapshot.locale,
        projectItemId: context.projectItemId,
      });
    } catch (err) {
      if (!(err instanceof AiGatewayFailedError)) throw err;
      const reason = err.reason;
      // A budget rejection is not worth retrying, and the final queue attempt has no retry left: both
      // are recorded on the card. Any other gateway failure on a non-final attempt is rethrown, so the
      // queue retries the job.
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
      snapshot.entityKind === "pageContent" && !result.target ? null : buildProposalEnvelope(snapshot, result);

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
