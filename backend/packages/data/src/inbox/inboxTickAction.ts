import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { createLogger, type Logger } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { assertRelationTargetLinkableWithClient, createRelationWithClient } from "../chokePoint/relationOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import { PROCESSING_METHODS, LOCKED_PROPOSAL_STATUSES, type ProcessingMethod } from "./inboxTypesStore.js";
import { computeInboxFingerprintV2, isFingerprintCurrent, type InboxFingerprintV2Input } from "./fingerprint.js";
import { enqueueJournalInboxRecomputeForInboxItem } from "./journalInboxCompute.js";
import { SEMPREC_READ_ONLY_MODULE_IDS, PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import {
  MAX_PROPOSAL_OPERATIONS,
  buildProposalSteps,
  type ProposalComputationOperation,
} from "./proposalOperations.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { assertValidMcpServerProposalProperties } from "../mcp/mcpServerProposal.js";
import { parseFileFromAttachmentProperties } from "./fileAttachmentStep.js";
import { assertNoRefCycle, selectActiveSteps, stepError } from "./proposalStepGraph.js";
import { CardinalityViolationError, ForbiddenError, ValidationError } from "../errors.js";
import { getTenantUserLocale } from "../auth/usersStore.js";
import type { DatabaseRow, ItemRow, PropertyRow } from "../types.js";

export { selectActiveSteps } from "./proposalStepGraph.js";

const PROCESSING_PROPOSALS_RELATION_CONTEXT: SystemRelationWriteContext = {
  ownerProcess: PROCESSING_PROPOSALS_MODULE_ID,
};

const logger: Logger = createLogger("inbox-tick");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { SEMPREC_TICK_ACTION_ID, SEMPREC_TICK_QUEUE_NAME } from "./inboxTickKeys.js";

/** `action_config` is a raw JSONB column (a module boundary) — validated, not just cast. */
export const semprecTickActionConfigSchema = z.object({
  inboxDatabaseId: z.string().uuid(),
  inboxItemTypesDatabaseId: z.string().uuid(),
  processingProposalsDatabaseId: z.string().uuid(),
});

export type SemprecTickActionConfig = z.infer<typeof semprecTickActionConfigSchema>;

/**
 * The generic proposal envelope (issue #100/#223): `entityKind`, `target`, `properties` and, for
 * `'database'` only, optional `relations`.
 * `'relation'` (issue #184) links the card's source item to the existing item `target` through the
 * relation property named by `properties.propertyKey`, with `properties.metadata` (optional) as
 * the edge's metadata — never computed by the Inbox tick. A transcript card reaches the
 * Event-link shape only through a human `revise`; its speaker-mapping shape (issue #185) is
 * proposed by the transcription pipeline.
 */
export type ProposalEntityKind = "pageContent" | "database" | "relation";

/** The entity kinds the Inbox tick itself computes, one per `processingMethod`. */
type ComputedProposalEntityKind = Exclude<ProposalEntityKind, "relation">;

/** A relation target inside a step: an existing item id, or the `ref` of another step of the same proposal. */
const stepRelationTargetSchema = z.union([z.string().min(1), z.object({ ref: z.string().min(1) })]);

const stepRelationsSchema = z.record(z.string(), z.array(stepRelationTargetSchema));

/**
 * One step of a multi-step envelope (`docs/adr/2026-10-25-multi-step-proposal-envelope.md`).
 * `create` names its database by `databaseKey`; `update` and `link` name an existing item by `itemId`.
 * `fileFromAttachment` names neither: it writes the system Files database, and its `properties` are
 * the attachment to move and the Files item's name and date. It is never the primary step
 * (`docs/adr/2026-10-29-file-from-attachment-proposal-step.md`).
 * `enabled` defaults to true and `optional` to false when absent. `before` holds the current values
 * of the properties and relations an `update` step changes, `after` the values it writes.
 */
const proposalStepSchema = z.object({
  ref: z.string().min(1),
  op: z.enum(["create", "update", "link", "fileFromAttachment"]),
  databaseKey: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  relations: stepRelationsSchema.optional(),
  role: z.enum(["primary", "secondary"]),
  optional: z.boolean().optional(),
  enabled: z.boolean().optional(),
  before: z
    .object({
      properties: z.record(z.string(), z.unknown()).optional(),
      relations: z.record(z.string(), z.array(z.string().min(1))).optional(),
    })
    .optional(),
  after: z
    .object({
      properties: z.record(z.string(), z.unknown()).optional(),
      relations: stepRelationsSchema.optional(),
    })
    .optional(),
});

export type ProposalStep = z.infer<typeof proposalStepSchema>;

export const proposalEnvelopeSchema = z.object({
  entityKind: z.enum(["pageContent", "database", "relation"]),
  target: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
  /**
   * `'database'` envelopes only: item ids of the targets per relation property key on the target
   * database. An empty array means no edge. Written on confirm, not by this module.
   */
  relations: z.record(z.string(), z.array(z.string().min(1))).optional(),
  /**
   * Every step of a multi-step proposal, the primary one included; the top-level `entityKind`,
   * `target` and `properties` mirror the primary step. Absent for a single-step envelope.
   */
  operations: z.array(proposalStepSchema).optional(),
});

export type ProposalEnvelope = z.infer<typeof proposalEnvelopeSchema>;

/**
 * A stored envelope that is well-formed but whose `entityKind` this release does not know (a kind
 * written by a newer release, kept readable for one-release rollback). It is displayed, never
 * executed: confirm and revise refuse it. `proposalEnvelopeSchema` stays strict for writing.
 */
export interface UnknownKindProposalEnvelope {
  unknownKind: true;
  entityKind: string;
  target: string;
  properties: Record<string, unknown>;
}

const storedEnvelopeShapeSchema = z.object({
  entityKind: z.string(),
  target: z.string(),
  properties: z.record(z.string(), z.unknown()),
});

/** The `entityKind` of a stored envelope that is well-formed but of a kind this release does not know; `null` for a known kind or a malformed value. */
export function unknownStoredEntityKind(value: unknown): string | null {
  if (proposalEnvelopeSchema.safeParse(value).success) return null;
  const shape = storedEnvelopeShapeSchema.safeParse(value);
  if (!shape.success) return null;
  return (proposalEnvelopeSchema.shape.entityKind.options as readonly string[]).includes(shape.data.entityKind)
    ? null
    : shape.data.entityKind;
}

/**
 * Parses a Processing proposal's stored `proposal` JSONB property: `null`/`undefined` (no
 * envelope computed yet) → `null`; a well-formed envelope of an unknown `entityKind` → the
 * `UnknownKindProposalEnvelope` shape; anything else that is not a well-formed envelope throws.
 */
export function parseStoredProposalEnvelope(
  value: unknown,
  proposalId: string,
): ProposalEnvelope | UnknownKindProposalEnvelope | null {
  if (value === null || value === undefined) return null;
  const parsed = proposalEnvelopeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (unknownStoredEntityKind(value) !== null) return { unknownKind: true, ...storedEnvelopeShapeSchema.parse(value) };
  throw new Error(`Malformed proposal envelope on proposal ${proposalId}`);
}

/**
 * The `aiProposal` and `aiVersion` an automated writer stores with a Processing proposal: the
 * assistant's output `envelope` (`null` for `needsClarification`) and the version counter, one above
 * the row's previous `aiVersion`. A row without a counter counts as 0, so a legacy card gets 1 on its
 * next automated write. `existingProperties` is the row as read under its row lock in the write's own
 * transaction; a row being created passes `{}`.
 */
export function aiProposalPatch(
  existingProperties: Record<string, unknown>,
  envelope: ProposalEnvelope | null,
): { aiProposal: ProposalEnvelope | null; aiVersion: number } {
  const previousVersion = existingProperties.aiVersion;
  return { aiProposal: envelope, aiVersion: (typeof previousVersion === "number" ? previousVersion : 0) + 1 };
}

/**
 * The assistant's last proposal of a Processing proposal row: its `aiProposal` when that is set, else its
 * stored `proposal`. A row written before `aiProposal` existed has none, and its `proposal` is the
 * assistant's output because no user override could exist yet. `null` when neither holds an envelope.
 */
export function readAiProposal(
  properties: Record<string, unknown>,
  proposalId: string,
): ProposalEnvelope | UnknownKindProposalEnvelope | null {
  return (
    parseStoredProposalEnvelope(properties.aiProposal, proposalId) ??
    parseStoredProposalEnvelope(properties.proposal, proposalId)
  );
}

export interface ProposalComputationInput {
  /** The Inbox item the proposal is for. */
  sourceItem: ItemRow;
  /** The Inbox item's resolved, recognized type. */
  type: ItemRow;
  entityKind: ComputedProposalEntityKind;
  /** Resolved target database id for `entityKind: 'database'`; absent for `'pageContent'`, where the target page is itself part of the content decision. */
  targetDatabaseId?: string;
  /** The module id of the target database, for `entityKind: 'database'`; the primary operation of a multi-step answer must write to it. */
  targetModuleId?: string;
  /** The language (the person's `users.locale`, e.g. `cs`) the proposal's person-facing texts must be written in. */
  locale: string;
  /** The project the heartbeat belongs to (`ActionContext.projectItemId`); the model call is attributed to it. */
  projectItemId: string;
}

export interface ProposalComputationResult {
  /** The target page id, for `entityKind: 'pageContent'` — ignored otherwise, since a `'database'` target is always the type's resolved `targetDatabase` id. */
  target?: string;
  properties: Record<string, unknown>;
  /**
   * Present only when the answer has more than one operation (at most `MAX_PROPOSAL_OPERATIONS`); then
   * `buildProposalEnvelope` stores a multi-step envelope. A single operation is returned as `properties`.
   */
  operations?: ProposalComputationOperation[];
  /** The model's explanation of the proposal. Not read by the tick until issue #1495. */
  reason?: string;
  /** The model's confidence in the proposal. Not read by the tick until issue #1495. */
  confidence?: number;
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
 * same `updatedAt`. Anything else — a confirm/reject or any other write that committed since
 * the snapshot — is logged with its reason and returns `null`, and the caller skips its write.
 *
 * Both of the tick's transactions run at `repeatable read`, where `FOR UPDATE` on a row another
 * transaction wrote after this one's snapshot fails with a serialization error rather than
 * returning the newer row. That is the same "a write committed since the snapshot" outcome, so
 * it is skipped as `changed` too; the savepoint keeps the rest of the transaction usable after
 * the failed statement. Any other error from the lock propagates.
 */
async function lockUnlockedProposal(
  client: PoolClient,
  config: SemprecTickActionConfig,
  snapshot: ItemRow,
): Promise<ItemRow | null> {
  await client.query("SAVEPOINT lock_unlocked_proposal");
  let locked: ItemRow | null;
  try {
    locked = await itemsStore.lockItemById(client, config.processingProposalsDatabaseId, snapshot.id);
    await client.query("RELEASE SAVEPOINT lock_unlocked_proposal");
  } catch (err) {
    if (!isSerializationFailure(err)) throw err;
    await client.query("ROLLBACK TO SAVEPOINT lock_unlocked_proposal");
    await client.query("RELEASE SAVEPOINT lock_unlocked_proposal");
    logger.info({ proposalId: snapshot.id, reason: "changed" }, "Skipping proposal write");
    return null;
  }
  let reason: "gone" | "deleted" | "locked" | "changed" | null = null;
  if (!locked) reason = "gone";
  else if (locked.deletedAt !== null) reason = "deleted";
  else if (typeof locked.properties.status === "string" && LOCKED_PROPOSAL_STATUSES.has(locked.properties.status))
    reason = "locked";
  else if (locked.updatedAt !== snapshot.updatedAt) reason = "changed";

  if (reason !== null) {
    logger.info({ proposalId: snapshot.id, reason }, "Skipping proposal write");
    return null;
  }
  return locked;
}

/** True when `err` is Postgres' `serialization_failure` (SQLSTATE 40001). */
function isSerializationFailure(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "40001";
}

/**
 * Everything the tick's non-transactional `computeProposal` call and its post-call write need,
 * captured by the read transaction (`docs/adr/2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions.md`).
 * `targetDatabaseId` is resolved here — not re-derived after the call — so the write transaction's
 * staleness check is exactly "does the source item still match", not "does the target database
 * still exist"; a `processingMethod: 'database'` type's target is part of the type, not the source.
 */
interface TickSnapshot {
  item: ItemRow;
  type: ItemRow;
  processingMethod: ProcessingMethod;
  entityKind: ComputedProposalEntityKind;
  targetDatabaseId?: string;
  targetModuleId?: string;
  existingProposal: ItemRow | null;
  fingerprint: string;
  locale: string;
}

/** Combines the external call's result with the snapshot into a stored envelope — no I/O. */
function buildProposalEnvelope(snapshot: TickSnapshot, result: ProposalComputationResult): ProposalEnvelope {
  if (snapshot.entityKind === "database") {
    if (!snapshot.targetDatabaseId)
      throw new Error(`Snapshot for Inbox item ${snapshot.item.id} (entityKind 'database') has no targetDatabaseId`);
    const operations = result.operations?.slice(0, MAX_PROPOSAL_OPERATIONS);
    if (operations && operations.length > 1) {
      const steps = buildProposalSteps(operations, snapshot.targetModuleId);
      const primary = steps.find((step) => step.role === "primary")!;
      return {
        entityKind: "database",
        target: snapshot.targetDatabaseId,
        properties: primary.properties ?? {},
        operations: steps,
      };
    }
    return { entityKind: "database", target: snapshot.targetDatabaseId, properties: result.properties };
  }
  if (!result.target)
    throw new Error(
      `Proposal computation for Inbox item ${snapshot.item.id} (entityKind 'pageContent') did not return a 'target'`,
    );
  return { entityKind: "pageContent", target: result.target, properties: result.properties };
}

/** A Processing proposal's chat + decision log entry (issue #104). */
const PROPOSAL_HISTORY_KINDS = [
  "computed",
  "userEdit",
  "reset",
  "typeChosen",
  "threadRevision",
  "recompute",
  "confirmed",
  "rejected",
  "reopened",
  "invalidated",
] as const;

export type ProposalHistoryKind = (typeof PROPOSAL_HISTORY_KINDS)[number];

const proposalHistoryEntrySchema = z.object({
  author: z.enum(["ai", "user"]),
  message: z.string(),
  at: z.string(),
  kind: z.enum(PROPOSAL_HISTORY_KINDS).optional(),
  /** `ref.key` strings a `userEdit` entry touched. */
  keys: z.array(z.string()).optional(),
  threadId: z.string().optional(),
  messageId: z.string().optional(),
});

export type ProposalHistoryEntry = z.infer<typeof proposalHistoryEntrySchema>;

/**
 * Appends one history entry to a proposal's `history`, tolerating a missing/malformed
 * stored value as empty. Defaults to `author: 'ai'` for this module's own tick-driven
 * entries; inbox/proposalActions.ts (issue #105) reuses this with `author: 'user'` for
 * confirm/reject/revise's own log entries.
 */
export function appendHistoryEntry(
  history: unknown,
  message: string,
  author: "ai" | "user" = "ai",
  extra?: Pick<ProposalHistoryEntry, "kind" | "keys" | "threadId" | "messageId">,
): ProposalHistoryEntry[] {
  const parsed = z.array(proposalHistoryEntrySchema).safeParse(history);
  const existing = parsed.success ? parsed.data : [];
  return [...existing, { author, message, at: new Date().toISOString(), ...extra }];
}

/** Checks a `'database'` envelope's `relations`: each key a relation property of the target database, unique target ids, every target linkable. */
async function assertValidEnvelopeRelations(
  client: PoolClient,
  targetDatabaseId: string,
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
  relations: NonNullable<ProposalEnvelope["relations"]>,
): Promise<void> {
  for (const [key, targetItemIds] of Object.entries(relations)) {
    const property = propertiesByKey.get(key);
    if (!property || property.type !== "relation") {
      throw new ValidationError(
        `Proposal relations reference '${key}', which is not a relation property of target database ${targetDatabaseId}`,
        { field: key },
      );
    }
    if (new Set(targetItemIds).size !== targetItemIds.length) {
      throw new ValidationError(`Proposal relations for '${key}' list the same target more than once`, { field: key });
    }
    for (const targetItemId of targetItemIds) {
      await assertRelationTargetLinkableWithClient(client, { relationPropertyId: property.id, targetItemId });
    }
  }
}

/** Checks that every key of `properties` is a writable, user-owned, non-relation, non-rollup property of the database. */
function assertWritableProposalPropertyKeys(
  properties: Record<string, unknown>,
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
  databaseId: string,
): void {
  for (const key of Object.keys(properties)) {
    const property = propertiesByKey.get(key);
    if (!property) {
      throw new ValidationError(
        `Proposal properties reference unknown property '${key}' on target database ${databaseId}`,
        { field: key },
      );
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
}

function errorDetails(err: { details?: unknown }): Record<string, unknown> {
  return typeof err.details === "object" && err.details !== null ? { ...err.details } : {};
}

/**
 * Runs a check that was written for one item and re-raises its validation, permission and
 * cardinality failures with the step's `ref` added to their `details`; any other error propagates untouched.
 */
async function withStepRef<T>(ref: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ValidationError) throw new ValidationError(err.message, { ...errorDetails(err), ref });
    if (err instanceof CardinalityViolationError) {
      throw new CardinalityViolationError(err.message, { ...errorDetails(err), ref });
    }
    if (err instanceof ForbiddenError) throw new ForbiddenError(err.message, { ...errorDetails(err), ref }, err.code);
    throw err;
  }
}

/** A step's relations with the `{ ref }` targets dropped (they name items that do not exist yet); a key holding only refs stays, as an empty list. */
function existingItemRelations(
  step: ProposalStep,
  alreadyLinked: Record<string, string[]> = {},
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(step.relations ?? {}).map(([key, list]) => [
      key,
      list.filter((target): target is string => typeof target === "string" && !alreadyLinked[key]?.includes(target)),
    ]),
  );
}

/** The database a step writes to must exist, be unarchived, and not be one of the read-only modules'. */
function assertStepDatabaseWritable(step: ProposalStep, database: DatabaseRow | null, field: string): DatabaseRow {
  if (!database || database.archivedAt) throw stepError(step, "its database does not exist or is archived", field);
  if (database.ownerModuleId && SEMPREC_READ_ONLY_MODULE_IDS.includes(database.ownerModuleId)) {
    throw stepError(step, "its database is not a writable target database", field);
  }
  return database;
}

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
      assertWritableProposalPropertyKeys(properties, byKey, database.id);
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
    const byKey = new Map(
      (await propertiesStore.listPropertiesByDatabase(client, database.id)).map((property) => [property.key, property]),
    );
    assertWritableProposalPropertyKeys(properties, byKey, database.id);
    // A target the item already holds is not re-linked, so the cardinality check skips it.
    await assertValidEnvelopeRelations(client, database.id, byKey, existingItemRelations(step, step.before?.relations));
  });
  if (step.op === "update") {
    for (const key of Object.keys(properties)) {
      if (!Object.hasOwn(step.before?.properties ?? {}, key)) {
        throw stepError(step, `before does not hold the current value of property '${key}'`, key);
      }
      if (!Object.hasOwn(step.after?.properties ?? {}, key)) {
        throw stepError(step, `after does not hold the new value of property '${key}'`, key);
      }
    }
    for (const key of Object.keys(step.relations ?? {})) {
      if (!Object.hasOwn(step.before?.relations ?? {}, key)) {
        throw stepError(step, `before does not hold the current targets of relation '${key}'`, key);
      }
      if (!Object.hasOwn(step.after?.relations ?? {}, key)) {
        throw stepError(step, `after does not hold the new targets of relation '${key}'`, key);
      }
    }
  }
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
    assertWritableProposalPropertyKeys(envelope.properties, byKey, targetDatabase.id);
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
    if (!UUID_RE.test(envelope.target)) {
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

  if (!UUID_RE.test(envelope.target)) {
    throw new ValidationError(`Proposal envelope target '${envelope.target}' is not a page id`, { field: "target" });
  }
  const [targetPage] = await itemsStore.getItemsByIds(client, [envelope.target]);
  if (!targetPage) {
    throw new ValidationError(`Proposal envelope target '${envelope.target}' is not an existing page`, {
      field: "target",
    });
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

/** Links a freshly created Processing proposal back to its source Inbox item via `sourceInbox`. */
async function linkSourceInboxRelation(
  client: PoolClient,
  config: SemprecTickActionConfig,
  proposalId: string,
  sourceItemId: string,
): Promise<void> {
  const sourceInboxProperty = await propertiesStore.getPropertyByKey(
    client,
    config.processingProposalsDatabaseId,
    "sourceInbox",
  );
  if (!sourceInboxProperty)
    throw new Error(
      `Processing proposals database ${config.processingProposalsDatabaseId} has no 'sourceInbox' relation property`,
    );
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

    const locked = await lockUnlockedProposal(client, config, existingProposal);
    if (!locked) return;
    await updateItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        itemId: locked.id,
        ifVersion: locked.updatedAt,
        propertiesPatch: {
          fingerprint,
          proposal: null,
          ...aiProposalPatch(locked.properties, null),
          status: "needsClarification",
          history: appendHistoryEntry(locked.properties.history, message),
        },
      },
      { allowedSystemKeys: ["fingerprint", "proposal", "aiProposal", "aiVersion", "status", "history"] },
    );
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
        ...aiProposalPatch({}, null),
        history: appendHistoryEntry([], message),
        status: "needsClarification",
      },
    },
    { allowedSystemKeys: ["kind", "fingerprint", "proposal", "aiProposal", "aiVersion", "history", "status"] },
  );
  await linkSourceInboxRelation(client, config, proposal.id, sourceItemId);
  await enqueueJournalInboxRecomputeForInboxItem(client, sourceItemId);
}

/**
 * Puts an unlocked proposal into `invalid` (issue #104) when its source Inbox item no longer
 * exists. A locked (`confirmed`/`rejected`) proposal, or one with no proposal row at all, is
 * left untouched — per the epic's "a locked card is never recomputed again" rule and because
 * there is nothing to invalidate. A no-op if already `invalid`, so a source deleted more than
 * once (e.g. soft-deleted, then its delete event re-fires) doesn't spam history.
 */
async function invalidateProposalForDeletedSource(
  client: PoolClient,
  config: SemprecTickActionConfig,
  existingProposal: ItemRow | null,
): Promise<void> {
  if (!existingProposal) return;
  const status = existingProposal.properties.status;
  if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) return;
  if (status === "invalid") return;

  const locked = await lockUnlockedProposal(client, config, existingProposal);
  if (!locked) return;
  await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: locked.id,
      ifVersion: locked.updatedAt,
      propertiesPatch: {
        status: "invalid",
        history: appendHistoryEntry(locked.properties.history, "Source Inbox item was deleted."),
      },
    },
    { allowedSystemKeys: ["status", "history"] },
  );
}

/**
 * The attachment hashes that version 2 of the fingerprint covers (issue #1606): one per attachment
 * reference of the item, the blob's `content_hash`. A blob without a content hash is covered by its id
 * instead, so adding or removing it still changes the value; uploads always store a hash
 * (`blobs/fileUploadStore.ts`). Read on the caller's client, so it belongs to the tick's read
 * transaction, and never taken from a job payload.
 */
async function readAttachmentHashes(client: PoolClient, inboxItemId: string): Promise<string[]> {
  const { rows } = await client.query<{ attachment_hash: string }>(
    `SELECT COALESCE(b.content_hash, b.id::text) AS attachment_hash
       FROM inbox_attachments a
       JOIN blobs b ON b.tenant_id = a.tenant_id AND b.id = a.blob_id
      WHERE a.inbox_item_id = $1`,
    [inboxItemId],
  );
  return rows.map((row) => row.attachment_hash);
}

/** The version 2 fingerprint input of an Inbox item and its recognized type (issue #1606). */
async function inboxFingerprintInput(
  client: PoolClient,
  item: ItemRow,
  type: ItemRow,
): Promise<InboxFingerprintV2Input> {
  return {
    typeId: type.id,
    text: typeof item.properties.text === "string" ? item.properties.text : "",
    date: typeof item.properties.date === "string" ? item.properties.date : "",
    time: typeof item.properties.time === "string" ? item.properties.time : "",
    attachmentHashes: await readAttachmentHashes(client, item.id),
    // Inbox audio attachments are not transcribed yet, so there is no transcript text to cover.
    transcribedText: "",
  };
}

/**
 * The tick's read phase: everything up to and including the fingerprint gate, run in one
 * transaction. The outcomes that need no LLM call (deleted source, unrecognized type, a locked
 * or unchanged-fingerprint existing proposal) are written here and end the tick (`null`
 * return). Otherwise resolves the `processingMethod: 'database'` target database here too — so
 * it never needs to be re-derived — and returns a snapshot for the external call and the write
 * transaction that follows it.
 */
async function readTickSnapshot(
  client: PoolClient,
  config: SemprecTickActionConfig,
  sourceItemId: string,
): Promise<TickSnapshot | null> {
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
    return null;
  }

  const recognized = await resolveRecognizedType(client, config, item);
  if (!recognized) {
    await writeNeedsClarification(
      client,
      config,
      item.id,
      existingProposal,
      "Source item has no recognized type; needs clarification.",
    );
    return null;
  }
  const { type, processingMethod } = recognized;

  const emoji = typeof type.properties.emoji === "string" ? type.properties.emoji : "";
  const v2Input = await inboxFingerprintInput(client, item, type);
  const fingerprint = computeInboxFingerprintV2(v2Input);

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
    processingMethod,
    entityKind,
    targetDatabaseId,
    targetModuleId,
    existingProposal,
    fingerprint,
    locale,
  };
}

/** Revises `existing` with `envelope`, through the locked re-check — a no-op if it lost the race. */
async function reviseProposal(
  client: PoolClient,
  config: SemprecTickActionConfig,
  existing: ItemRow,
  sourceItemId: string,
  fingerprint: string,
  envelope: ProposalEnvelope,
): Promise<void> {
  const locked = await lockUnlockedProposal(client, config, existing);
  if (!locked) return;
  await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: locked.id,
      ifVersion: locked.updatedAt,
      propertiesPatch: {
        fingerprint,
        proposal: envelope,
        ...aiProposalPatch(locked.properties, envelope),
        status: "proposed",
        history: appendHistoryEntry(locked.properties.history, "Revised the proposal after the source item changed."),
      },
    },
    { allowedSystemKeys: ["fingerprint", "proposal", "aiProposal", "aiVersion", "status", "history"] },
  );
  await enqueueJournalInboxRecomputeForInboxItem(client, sourceItemId);
}

/**
 * The tick's write phase, run in its own transaction after the non-transactional
 * `computeProposal` call has returned. Re-validates every field `snapshot` was staked on before
 * writing anything: the source item must still exist, undeleted, with the same recognized type
 * and the same fingerprint. A mismatch means the edit that changed it has already enqueued a
 * newer tick (the heartbeat-fire job key's replace semantics), so this one logs why it is
 * skipping and writes nothing rather than persisting a result computed against a state that has
 * moved on.
 */
async function writeTickResult(
  client: PoolClient,
  config: SemprecTickActionConfig,
  snapshot: TickSnapshot,
  envelope: ProposalEnvelope,
): Promise<void> {
  const item = await itemsStore.getItemById(client, config.inboxDatabaseId, snapshot.item.id);
  if (!item || item.deletedAt) {
    logger.info({ sourceItemId: snapshot.item.id, reason: "sourceDeleted" }, "Skipping stale tick write");
    return;
  }

  const recognized = await resolveRecognizedType(client, config, item);
  if (!recognized) {
    logger.info({ sourceItemId: snapshot.item.id, reason: "unrecognizedType" }, "Skipping stale tick write");
    return;
  }

  // Both sides are version 2: the snapshot's fingerprint was computed by `readTickSnapshot` the same way.
  const fingerprint = computeInboxFingerprintV2(await inboxFingerprintInput(client, item, recognized.type));
  if (fingerprint !== snapshot.fingerprint) {
    logger.info({ sourceItemId: snapshot.item.id, reason: "fingerprintChanged" }, "Skipping stale tick write");
    return;
  }

  try {
    await assertValidProposalEnvelope(client, envelope);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
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
    );
    return;
  }

  if (snapshot.existingProposal) {
    await reviseProposal(client, config, snapshot.existingProposal, item.id, fingerprint, envelope);
    return;
  }

  // Another tick may have created a proposal for this source while this one waited on the AI
  // call — revise that one through the guarded path instead of creating a duplicate.
  const raceProposal = await findExistingProposal(client, config, item.id);
  if (raceProposal) {
    await reviseProposal(client, config, raceProposal, item.id, fingerprint, envelope);
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
        ...aiProposalPatch({}, envelope),
        history: appendHistoryEntry([], "Created a proposal for the source item."),
        status: "proposed",
      },
    },
    { allowedSystemKeys: ["kind", "fingerprint", "proposal", "aiProposal", "aiVersion", "history", "status"] },
  );

  await linkSourceInboxRelation(client, config, proposal.id, item.id);
  await enqueueJournalInboxRecomputeForInboxItem(client, item.id);
}

/**
 * Registered as an `onItemEvent` ('create'/'update'/'delete') heartbeat action on the Inbox
 * database (issue #103): re-reads the item by id at run time — never trusting anything about
 * its content from the job payload — so when several rapid edits collapse onto one pending
 * job (the heartbeat-fire job key's replace semantics), the single tick that eventually runs
 * reflects whatever state is current at that moment, not a stale snapshot from whichever edit
 * enqueued it.
 *
 * Runs in three phases, per `docs/adr/2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions.md`:
 * a read transaction (`readTickSnapshot`) that either resolves the tick with no AI call (deleted
 * source → `invalid`, unrecognized type → `needsClarification`, a locked or unchanged-fingerprint
 * existing proposal → no-op) or returns a snapshot; the injected, LLM-backed `computeProposal`
 * call outside any transaction; and a write transaction (`writeTickResult`) that re-validates the
 * snapshot against the source item's current state before writing — a `confirmed`/`rejected`
 * (locked) proposal is never recomputed, and a source that changed while the call was in flight
 * makes this tick write nothing (the next tick, already enqueued, produces the up-to-date card).
 * A computed envelope that fails destination validation lands in `needsClarification` rather
 * than being stored as `proposed`. Every create, revise, or status change appends one
 * `{ author: 'ai', message, at }` history entry (issue #104).
 */
export function createSemprecTickAction(pool: Pool, computeProposal: ComputeSemprecProposalFn): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return;
    // Throws (surfacing as a recorded heartbeat failure + notification, see sweep.ts's
    // createHeartbeatFireCoreTask) rather than silently no-op'ing on a misconfigured heartbeat.
    const config = semprecTickActionConfigSchema.parse(actionConfig);
    const sourceItemId = context.itemId;

    const snapshot = await withTransaction(pool, (client) => readTickSnapshot(client, config, sourceItemId), {
      isolation: "repeatable_read",
    });
    if (!snapshot) return;

    const result = await computeProposal({
      sourceItem: snapshot.item,
      type: snapshot.type,
      entityKind: snapshot.entityKind,
      targetDatabaseId: snapshot.targetDatabaseId,
      targetModuleId: snapshot.targetModuleId,
      locale: snapshot.locale,
      projectItemId: context.projectItemId,
    });
    const envelope = buildProposalEnvelope(snapshot, result);

    await withTransaction(pool, (client) => writeTickResult(client, config, snapshot, envelope), {
      isolation: "repeatable_read",
    });
  };
}
