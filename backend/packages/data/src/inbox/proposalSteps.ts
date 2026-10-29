import type { PoolClient } from "pg";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { ChokePointError, NotFoundError, ValidationError } from "../errors.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { selectActiveSteps, type ProposalStep } from "./inboxTickAction.js";

/** The item the primary step wrote or changed. */
export interface ExecutedProposalSteps {
  primaryItemId: string;
  primaryDatabaseId: string;
  /** Ids of the items `create` steps wrote, in execution order; patched and linked items are not listed. */
  createdItemIds: string[];
}

interface StepWriteContext {
  writer: WriterIdentity;
  actingUserId: string | undefined;
  /** `ref` of every step executed so far -> the id of the item it created or changed. */
  itemIdsByRef: Map<string, string>;
}

type StepRelationTargets = Record<string, Array<string | { ref: string }>>;

function refsOf(relations: StepRelationTargets | undefined): string[] {
  return Object.values(relations ?? {}).flatMap((targets) =>
    targets.flatMap((target) => (typeof target === "string" ? [] : [target.ref])),
  );
}

/** Orders active steps so that a step comes after every step whose `ref` it names; ties keep envelope order. */
function orderByRefDependencies(steps: ProposalStep[]): ProposalStep[] {
  const byRef = new Map(steps.map((step) => [step.ref, step]));
  const ordered: ProposalStep[] = [];
  const placed = new Set<string>();
  const place = (step: ProposalStep): void => {
    if (placed.has(step.ref)) return;
    placed.add(step.ref);
    for (const ref of [...refsOf(step.relations), ...refsOf(step.after?.relations)]) {
      const dependency = byRef.get(ref);
      if (dependency) place(dependency);
    }
    ordered.push(step);
  };
  for (const step of steps) place(step);
  return ordered;
}

/** Re-raises a canonical write failure with the step `ref` and the offending `field` in `details`; any other error propagates untouched. */
async function withStepDetails<T>(step: ProposalStep, field: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ChokePointError)) throw error;
    const details = typeof error.details === "object" && error.details !== null ? error.details : {};
    throw new ChokePointError(error.status, error.code, error.message, { ...details, ref: step.ref, field });
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
): Promise<void> {
  for (const [key, targets] of Object.entries(relations)) {
    const relationPropertyId = await requireRelationPropertyId(client, step, databaseId, key);
    for (const target of targets) {
      const targetItemId = resolveTargetId(step, key, target, ctx);
      await withStepDetails(step, key, () =>
        createRelationWithClient(
          client,
          { relationPropertyId, callerItemId: itemId, targetItemId },
          undefined,
          ctx.writer,
        ),
      );
    }
  }
}

/** Moves an item's relations: deletes the `before` edges that are gone from `after`, then creates the new ones. */
async function moveEdges(
  client: PoolClient,
  step: ProposalStep,
  databaseId: string,
  itemId: string,
  ctx: StepWriteContext,
): Promise<void> {
  const nextRelations: StepRelationTargets = { ...step.relations, ...step.after?.relations };
  for (const [key, nextTargets] of Object.entries(nextRelations)) {
    const relationPropertyId = await requireRelationPropertyId(client, step, databaseId, key);
    const next = nextTargets.map((target) => resolveTargetId(step, key, target, ctx));
    const previous = step.before?.relations?.[key] ?? [];
    for (const targetItemId of previous.filter((id) => !next.includes(id))) {
      await withStepDetails(step, key, () =>
        deleteRelationWithClient(
          client,
          { relationPropertyId, callerItemId: itemId, targetItemId },
          undefined,
          ctx.writer,
        ),
      );
    }
    for (const targetItemId of next.filter((id) => !previous.includes(id))) {
      await withStepDetails(step, key, () =>
        createRelationWithClient(
          client,
          { relationPropertyId, callerItemId: itemId, targetItemId },
          undefined,
          ctx.writer,
        ),
      );
    }
  }
}

async function executeStep(
  client: PoolClient,
  step: ProposalStep,
  ctx: StepWriteContext,
): Promise<{ itemId: string; databaseId: string; created: boolean }> {
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
    await createEdges(client, step, database.id, created.id, step.relations ?? {}, ctx);
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
    await createEdges(client, step, item.databaseId, item.id, step.relations ?? {}, ctx);
    return { itemId: item.id, databaseId: item.databaseId, created: false };
  }
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
 * Executes the active steps of a multi-step envelope in the caller's transaction, each after every
 * step whose `ref` it names. Disabled steps and unreferenced optional steps are not written. A failing
 * write is re-raised with `details: { ref, field }`; the caller's transaction rolls back. Resolves to
 * the primary step's item.
 */
export async function executeProposalSteps(
  client: PoolClient,
  steps: ProposalStep[],
  options: { writer: WriterIdentity; actingUserId?: string },
): Promise<ExecutedProposalSteps> {
  const ctx: StepWriteContext = {
    writer: options.writer,
    actingUserId: options.actingUserId,
    itemIdsByRef: new Map(),
  };
  let primary: Pick<ExecutedProposalSteps, "primaryItemId" | "primaryDatabaseId"> | null = null;
  const createdItemIds: string[] = [];
  for (const step of orderByRefDependencies(selectActiveSteps(steps))) {
    const { itemId, databaseId, created } = await executeStep(client, step, ctx);
    if (created) createdItemIds.push(itemId);
    ctx.itemIdsByRef.set(step.ref, itemId);
    if (step.role === "primary") primary = { primaryItemId: itemId, primaryDatabaseId: databaseId };
  }
  if (!primary) throw new ValidationError("Proposal has no primary step to write", { field: "operations" });
  return { ...primary, createdItemIds };
}
