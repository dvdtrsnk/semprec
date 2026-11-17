import type { PoolClient } from "pg";
import { z } from "zod";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createItemWithClient, prepareUserItemPatch, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { readProposalTimezone } from "./proposalComputedUpdates.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { ChokePointError, ConflictError, NotFoundError, ValidationError } from "../errors.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { removeBlobBytesAfterCommit } from "../blobs/blobBytesRelease.js";
import { lockBlobById } from "../blobs/blobsStore.js";
import { filesTypeForMimeType } from "../blobs/fileTypeDetection.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { parseFileFromAttachmentProperties } from "./fileAttachmentStep.js";
import { deleteInboxAttachment, getInboxAttachment } from "./inboxAttachmentsStore.js";
import { lockInboxSource } from "./inboxSourceGuard.js";
import type { ProposalStep } from "./inboxTickAction.js";
import { effectiveStepRelations, selectActiveSteps } from "./proposalStepGraph.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { isDeepStrictEqual } from "node:util";
import { assertUpdateStepShape, withStepRef } from "./proposalEnvelopeValidation.js";
import {
  createEdgeRecorder,
  deleteRecordedEdge,
  writeRecordedEdge,
  type EdgeRecorder,
} from "./proposalEdgeRecording.js";

/** A `fileFromAttachment` step's Files item, the attachment it moved, and whether the step created the item. */
export interface FileFromAttachmentResult {
  ref: string;
  fileItemId: string;
  movedAttachmentId: string;
  created: boolean;
}

export interface ExecutedProposalSteps {
  primaryItemId: string;
  primaryDatabaseId: string;
  /** Items `create` steps and new Files items wrote, in execution order; patched and linked items are not listed. */
  createdItemIds: string[];
  fileFromAttachments: FileFromAttachmentResult[];
  executedSteps: Array<{ ref: string; itemId: string; databaseId: string }>;
  /** Edges written or deleted on pre-existing items, for the undo. */
  recordedEdges: EdgeRecorder;
}

interface StepWriteContext {
  writer: WriterIdentity;
  actingUserId: string | undefined;
  /** `null` for a transcript card; `fileFromAttachment` takes its attachment from here. */
  sourceInboxItemId: string | null;
  itemIdsByRef: Map<string, string>;
  /** Edges `link` and `update` steps write and delete; a new item's edges stay with it and are not recorded. */
  recorder: EdgeRecorder;
}

interface StepOutcome {
  itemId: string;
  databaseId: string;
  created: boolean;
  movedAttachmentId?: string;
}

function guardedRelationKeys(step: ProposalStep): string[] {
  return [
    ...new Set([...Object.keys(effectiveStepRelations(step)), ...Object.keys(step.before?.relations ?? {})]),
  ].sort();
}

async function lockUpdatePreconditions(client: PoolClient, steps: ProposalStep[]): Promise<void> {
  const updates = steps.filter((step) => step.op === "update" && step.itemId !== undefined);
  const itemIds = [...new Set(updates.flatMap((step) => (step.itemId ? [step.itemId] : [])))].sort();
  const items = await itemsStore.getItemsByIds(client, itemIds);
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const id of itemIds) {
    const item = byId.get(id);
    if (!item || !(await itemsStore.lockItemById(client, item.databaseId, id))) {
      const step = updates.find((candidate) => candidate.itemId === id)!;
      throw new ValidationError(`Proposal step '${step.ref}': its item does not exist`, {
        ref: step.ref,
        field: "itemId",
      });
    }
  }
  const definitionIds = new Set<string>();
  for (const step of updates) {
    const item = step.itemId ? byId.get(step.itemId) : undefined;
    if (!item) continue;
    for (const key of guardedRelationKeys(step)) {
      const propertyId = await requireRelationPropertyId(client, step, item.databaseId, key);
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, propertyId);
      if (!definition) throw new ValidationError(`Relation '${key}' has no definition`, { ref: step.ref, field: key });
      definitionIds.add(definition.id);
    }
  }
  const sortedDefinitions = [...definitionIds].sort();
  for (const id of sortedDefinitions) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [id]);
  }
  if (sortedDefinitions.length > 0 && itemIds.length > 0) {
    await client.query(
      `SELECT id FROM item_relations WHERE relation_definition_id = ANY($1::uuid[])
       AND (item_a = ANY($2::uuid[]) OR item_b = ANY($2::uuid[])) ORDER BY id FOR UPDATE`,
      [sortedDefinitions, itemIds],
    );
  }
}

async function assertUpdateBefore(
  client: PoolClient,
  step: ProposalStep,
  databaseId: string,
  itemId: string,
): Promise<void> {
  const item = await itemsStore.lockItemById(client, databaseId, itemId);
  if (!item || item.deletedAt)
    throw new ValidationError("Proposal update item no longer exists", { ref: step.ref, field: "itemId" });
  for (const key of Object.keys(step.before?.properties ?? {})) {
    if (!isDeepStrictEqual(item.properties[key] ?? null, step.before?.properties?.[key] ?? null)) {
      throw new ValidationError(`Proposal step '${step.ref}': property '${key}' changed`, {
        ref: step.ref,
        field: key,
      });
    }
  }
  const database = await databasesStore.getDatabase(client, databaseId);
  if (!database)
    throw new ValidationError("Proposal update database no longer exists", { ref: step.ref, field: "itemId" });
  const properties = await propertiesStore.listPropertiesByDatabase(client, databaseId);
  await withStepRef(step.ref, async () => {
    const patch = step.properties ?? {};
    // Re-read under the item lock this confirmation holds; an invalid stored zone propagates instead of refusing.
    const prepared =
      Object.keys(patch).length > 0
        ? await prepareUserItemPatch(properties, patch, database, item, await readProposalTimezone(client))
        : { patch: {}, deferredKeys: [] };
    assertUpdateStepShape(step, prepared, item, new Map(properties.map((property) => [property.key, property])));
  });
  for (const key of guardedRelationKeys(step)) {
    const propertyId = await requireRelationPropertyId(client, step, databaseId, key);
    const definition = await relationsStore.getRelationDefinitionByPropertyId(client, propertyId);
    if (!definition) throw new ValidationError(`Relation '${key}' has no definition`, { ref: step.ref, field: key });
    const edges = await relationsStore.listRelationsForItem(client, definition.id, itemId);
    const actual = edges.map((edge) => relationsStore.otherSide(edge, itemId)).sort();
    const before = [...(step.before?.relations?.[key] ?? [])].sort();
    if (!isDeepStrictEqual(actual, before)) {
      throw new ValidationError(`Proposal step '${step.ref}': relation '${key}' changed`, {
        ref: step.ref,
        field: key,
      });
    }
  }
}

type StepRelationTargets = Record<string, Array<string | { ref: string }>>;

function refsOf(relations: StepRelationTargets | undefined): string[] {
  return Object.values(relations ?? {}).flatMap((targets) =>
    targets.flatMap((target) => (typeof target === "string" ? [] : [target.ref])),
  );
}

/** Orders active steps after every step whose `ref` they name; ties keep envelope order. */
function orderByRefDependencies(steps: ProposalStep[]): ProposalStep[] {
  const byRef = new Map(steps.map((step) => [step.ref, step]));
  const ordered: ProposalStep[] = [];
  const placed = new Set<string>();
  const place = (step: ProposalStep): void => {
    if (placed.has(step.ref)) return;
    placed.add(step.ref);
    for (const ref of refsOf(effectiveStepRelations(step))) {
      const dependency = byRef.get(ref);
      if (dependency) place(dependency);
    }
    ordered.push(step);
  };
  for (const step of steps) place(step);
  return ordered;
}

/** Re-raises a canonical write failure with the step `ref` and `field` in `details`; other errors propagate. */
async function withStepDetails<T>(step: ProposalStep, field: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ChokePointError)) throw error;
    const details = typeof error.details === "object" && error.details !== null ? error.details : {};
    throw new ChokePointError(error.status, error.code, error.message, {
      ...details,
      ref: step.ref,
      field: field === "properties" && "field" in details && typeof details.field === "string" ? details.field : field,
    });
  }
}

function resolveTargetId(
  step: ProposalStep,
  key: string,
  target: string | { ref: string },
  ctx: StepWriteContext,
): string {
  if (typeof target === "string") return target;
  const id = ctx.itemIdsByRef.get(target.ref);
  if (!id) {
    throw new ValidationError(
      `Proposal step '${step.ref}': relation '${key}' refers to '${target.ref}', which was not written`,
      { ref: step.ref, field: key },
    );
  }
  return id;
}

async function requireRelationPropertyId(
  client: PoolClient,
  step: ProposalStep,
  databaseId: string,
  key: string,
): Promise<string> {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
  if (!property) {
    throw new NotFoundError(`Property '${key}' not found on database ${databaseId}`, { ref: step.ref, field: key });
  }
  return property.id;
}

async function createEdges(
  client: PoolClient,
  step: ProposalStep,
  databaseId: string,
  itemId: string,
  relations: StepRelationTargets,
  ctx: StepWriteContext,
  record: boolean,
): Promise<void> {
  for (const [key, targets] of Object.entries(relations)) {
    const relationPropertyId = await requireRelationPropertyId(client, step, databaseId, key);
    for (const target of targets) {
      const targetItemId = resolveTargetId(step, key, target, ctx);
      await withStepDetails(step, key, () =>
        writeEdge(client, ctx, { relationPropertyId, callerItemId: itemId, targetItemId }, record),
      );
    }
  }
}

/** Writes one edge; `record` marks an edge on an existing item, whose prior state the undo needs. */
async function writeEdge(
  client: PoolClient,
  ctx: StepWriteContext,
  input: { relationPropertyId: string; callerItemId: string; targetItemId: string },
  record: boolean,
): Promise<void> {
  if (record) await writeRecordedEdge(client, ctx.recorder, input, ctx.writer, ctx.actingUserId);
  else await createRelationWithClient(client, input, undefined, ctx.writer, ctx.actingUserId);
}

async function moveEdges(
  client: PoolClient,
  step: ProposalStep,
  databaseId: string,
  itemId: string,
  ctx: StepWriteContext,
): Promise<void> {
  const nextRelations = effectiveStepRelations(step);
  for (const [key, nextTargets] of Object.entries(nextRelations)) {
    const relationPropertyId = await requireRelationPropertyId(client, step, databaseId, key);
    const next = nextTargets.map((target) => resolveTargetId(step, key, target, ctx));
    const previous = step.before?.relations?.[key] ?? [];
    for (const targetItemId of previous.filter((id) => !next.includes(id))) {
      await withStepDetails(step, key, () =>
        deleteRecordedEdge(
          client,
          ctx.recorder,
          { relationPropertyId, callerItemId: itemId, targetItemId },
          ctx.writer,
          ctx.actingUserId,
        ),
      );
    }
    for (const targetItemId of next.filter((id) => !previous.includes(id))) {
      await withStepDetails(step, key, () =>
        writeEdge(client, ctx, { relationPropertyId, callerItemId: itemId, targetItemId }, true),
      );
    }
  }
}

/** The Files `type` option for the blob's mime type, or none when the select does not offer it. */
async function filesTypeOptionFor(
  client: PoolClient,
  filesDatabaseId: string,
  mimeType: string,
): Promise<string | null> {
  const candidate = filesTypeForMimeType(mimeType);
  if (candidate === null) return null;
  const typeProperty = await propertiesStore.getPropertyByKey(client, filesDatabaseId, "type");
  const config = z.object({ options: z.array(z.object({ key: z.string() })) }).safeParse(typeProperty?.config);
  if (!config.success) return null;
  return config.data.options.some((option) => option.key === candidate) ? candidate : null;
}

/**
 * Moves an attachment of the source Inbox item into Files: reuses a live Files item that names the blob (unchanged),
 * else creates one. The attachment row is deleted in this transaction; the blob stays, its derived images are
 * released and their bytes removed after commit. The blob row lock makes a concurrent confirm of the same bytes wait,
 * then find this item or create its own. A delete that finds no row (another confirm moved it first) is a conflict.
 */
async function executeFileFromAttachment(
  client: PoolClient,
  step: ProposalStep,
  ctx: StepWriteContext,
): Promise<StepOutcome> {
  const { attachmentId, name, date } = parseFileFromAttachmentProperties(step.ref, step.properties ?? {});
  const initial = await client.query<{ inbox_item_id: string }>(
    "SELECT inbox_item_id FROM inbox_attachments WHERE attachment_id = $1",
    [attachmentId],
  );
  if (!initial.rows[0] || initial.rows[0].inbox_item_id !== ctx.sourceInboxItemId) {
    throw new ValidationError(
      `Proposal step '${step.ref}': attachment '${attachmentId}' is not an attachment of the proposal's source Inbox item`,
      { ref: step.ref, field: "attachmentId" },
    );
  }
  await lockInboxSource(client, initial.rows[0].inbox_item_id, true);
  const attachment = await getInboxAttachment(client, attachmentId);
  if (!attachment) {
    throw new ConflictError(`Proposal step '${step.ref}': attachment '${attachmentId}' was already moved`, {
      ref: step.ref,
      field: "attachmentId",
    });
  }
  const filesDatabase = await databasesStore.getDatabaseByModuleId(client, FILES_MODULE_ID);
  if (!filesDatabase) {
    throw new NotFoundError(`Database for module '${FILES_MODULE_ID}' not found`, {
      ref: step.ref,
      field: "properties",
    });
  }

  await lockBlobById(client, attachment.blobId);
  const existing = await itemsStore.findFileItemByBlobId(client, filesDatabase.id, attachment.blobId);
  let fileItemId: string;
  let created: boolean;
  if (existing) {
    fileItemId = existing.id;
    created = false;
  } else {
    const type = await filesTypeOptionFor(client, filesDatabase.id, attachment.mimeType);
    const fileItem = await withStepDetails(step, "properties", () =>
      createItemWithClient(
        client,
        {
          databaseId: filesDatabase.id,
          properties: {
            name,
            ...(date === undefined ? {} : { date }),
            file: { blobId: attachment.blobId },
            ...(type === null ? {} : { type }),
          },
        },
        { writer: ctx.writer, actingUserId: ctx.actingUserId },
      ),
    );
    await createEdges(client, step, filesDatabase.id, fileItem.id, step.relations ?? {}, ctx, false);
    fileItemId = fileItem.id;
    created = true;
  }

  const removed = await deleteInboxAttachment(client, attachmentId);
  if (!removed.deleted) {
    throw new ConflictError(`Proposal step '${step.ref}': attachment '${attachmentId}' was already moved`, {
      ref: step.ref,
      field: "attachmentId",
    });
  }
  // The attachment's derived images are not those of the Files item.
  removeBlobBytesAfterCommit(client, removed.releasedStorageKeys);
  return { itemId: fileItemId, databaseId: filesDatabase.id, created, movedAttachmentId: attachmentId };
}

/**
 * Moves an attachment of `sourceInboxItemId` into Files like a `fileFromAttachment` step, for callers without steps
 * (the recording card confirm). `name` is used when the Files item is created. Runs in the caller's transaction.
 */
export async function moveAttachmentIntoFiles(
  client: PoolClient,
  input: { attachmentId: string; name: string },
  options: { writer: WriterIdentity; actingUserId?: string; sourceInboxItemId: string },
): Promise<{ fileItemId: string; created: boolean }> {
  const step: ProposalStep = {
    ref: "file",
    op: "fileFromAttachment",
    role: "secondary",
    properties: { ...input },
  };
  const outcome = await executeFileFromAttachment(client, step, {
    writer: options.writer,
    actingUserId: options.actingUserId,
    sourceInboxItemId: options.sourceInboxItemId,
    itemIdsByRef: new Map(),
    recorder: createEdgeRecorder(),
  });
  return { fileItemId: outcome.itemId, created: outcome.created };
}

async function executeStep(client: PoolClient, step: ProposalStep, ctx: StepWriteContext): Promise<StepOutcome> {
  if (step.op === "fileFromAttachment") return executeFileFromAttachment(client, step, ctx);

  if (step.op === "create") {
    const database = step.databaseKey ? await databasesStore.getDatabaseByKey(client, step.databaseKey) : null;
    if (!database) {
      throw new ValidationError(`Proposal step '${step.ref}': its database does not exist`, {
        ref: step.ref,
        field: "databaseKey",
      });
    }
    const created = await withStepDetails(step, "properties", () =>
      createItemWithClient(
        client,
        { databaseId: database.id, properties: step.properties ?? {} },
        { writer: ctx.writer, actingUserId: ctx.actingUserId },
      ),
    );
    await createEdges(client, step, database.id, created.id, step.relations ?? {}, ctx, false);
    return { itemId: created.id, databaseId: database.id, created: true };
  }

  const [item] = step.itemId ? await itemsStore.getItemsByIds(client, [step.itemId]) : [];
  if (!item) {
    throw new ValidationError(`Proposal step '${step.ref}': its item does not exist`, {
      ref: step.ref,
      field: "itemId",
    });
  }
  if (step.op === "link") {
    await createEdges(client, step, item.databaseId, item.id, step.relations ?? {}, ctx, true);
    return { itemId: item.id, databaseId: item.databaseId, created: false };
  }
  await assertUpdateBefore(client, step, item.databaseId, item.id);
  const propertiesPatch = step.properties ?? {};
  if (Object.keys(propertiesPatch).length > 0) {
    // The choke point applies the same validation, approval and risk rules as to any other update.
    await withStepDetails(step, "properties", () =>
      updateItemWithClient(
        client,
        { databaseId: item.databaseId, itemId: item.id, propertiesPatch },
        { writer: ctx.writer, actingUserId: ctx.actingUserId },
      ),
    );
  }
  await moveEdges(client, step, item.databaseId, item.id, ctx);
  return { itemId: item.id, databaseId: item.databaseId, created: false };
}

/**
 * Executes the active steps in the caller's transaction, each after the steps whose `ref` it names. A failing write
 * is re-raised with `details: { ref, field }`. Resolves to the primary step's item. A `fileFromAttachment` step
 * accepts only an attachment of `sourceInboxItemId`.
 */
export async function executeProposalSteps(
  client: PoolClient,
  steps: ProposalStep[],
  options: { writer: WriterIdentity; actingUserId?: string; sourceInboxItemId: string | null },
): Promise<ExecutedProposalSteps> {
  const ctx: StepWriteContext = {
    writer: options.writer,
    actingUserId: options.actingUserId,
    sourceInboxItemId: options.sourceInboxItemId,
    itemIdsByRef: new Map(),
    recorder: createEdgeRecorder(),
  };
  let primary: Pick<ExecutedProposalSteps, "primaryItemId" | "primaryDatabaseId"> | null = null;
  const createdItemIds: string[] = [];
  const fileFromAttachments: FileFromAttachmentResult[] = [];
  const executedSteps: ExecutedProposalSteps["executedSteps"] = [];
  const activeSteps = selectActiveSteps(steps);
  await lockUpdatePreconditions(client, activeSteps);
  for (const step of orderByRefDependencies(activeSteps)) {
    const outcome = await executeStep(client, step, ctx);
    if (outcome.created) createdItemIds.push(outcome.itemId);
    if (outcome.movedAttachmentId !== undefined) {
      fileFromAttachments.push({
        ref: step.ref,
        fileItemId: outcome.itemId,
        movedAttachmentId: outcome.movedAttachmentId,
        created: outcome.created,
      });
    }
    executedSteps.push({ ref: step.ref, itemId: outcome.itemId, databaseId: outcome.databaseId });
    ctx.itemIdsByRef.set(step.ref, outcome.itemId);
    if (step.role === "primary") primary = { primaryItemId: outcome.itemId, primaryDatabaseId: outcome.databaseId };
  }
  if (!primary) throw new ValidationError("Proposal has no primary step to write", { field: "operations" });
  return { ...primary, createdItemIds, fileFromAttachments, executedSteps, recordedEdges: ctx.recorder };
}
