import { isDeepStrictEqual } from "node:util";
import { CardinalityViolationError, ForbiddenError } from "../errors.js";
import type { ProposalStep } from "./proposalEnvelope.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import { SEMPREC_READ_ONLY_MODULE_IDS } from "../seed/inboxPipelineKeys.js";
import { effectiveStepRelations, stepError } from "./proposalStepGraph.js";
import type { PoolClient } from "pg";
import type { PropertyRow } from "../types.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { ValidationError } from "../errors.js";
import { assertRelationTargetLinkableWithClient } from "../chokePoint/relationOps.js";

/** Checks a `'database'` envelope's `relations`: each key a relation property of the target database, unique target ids, every target linkable. */
export async function assertValidEnvelopeRelations(
  client: PoolClient,
  targetDatabaseId: string,
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
  relations: NonNullable<ProposalEnvelope["relations"]>,
  callerItemId?: string,
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
      await assertRelationTargetLinkableWithClient(client, {
        relationPropertyId: property.id,
        targetItemId,
        callerItemId,
      });
    }
  }
}

/** Checks that every key of `properties` is a writable, user-owned, non-relation, non-rollup property of the database. */
export function assertWritableProposalPropertyKeys(
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
export async function withStepRef<T>(ref: string, run: () => Promise<T>): Promise<T> {
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
export function existingItemRelations(step: ProposalStep): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(effectiveStepRelations(step)).map(([key, list]) => [
      key,
      list.filter((target): target is string => typeof target === "string"),
    ]),
  );
}

/** The database a step writes to must exist, be unarchived, and not be one of the read-only modules'. */
export function assertStepDatabaseWritable(
  step: ProposalStep,
  database: DatabaseRow | null,
  field: string,
): DatabaseRow {
  if (!database || database.archivedAt) throw stepError(step, "its database does not exist or is archived", field);
  if (database.ownerModuleId && SEMPREC_READ_ONLY_MODULE_IDS.includes(database.ownerModuleId)) {
    throw stepError(step, "its database is not a writable target database", field);
  }
  return database;
}

/** Checks that update representations and their before/after keys agree. */
export function assertUpdateStepShape(
  step: ProposalStep,
  prepared: { patch: Record<string, unknown>; deferredKeys: string[] },
  stored: ItemRow,
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
): void {
  const properties = step.properties ?? {};
  const required = new Set(Object.keys(properties));
  for (const [key, value] of Object.entries(prepared.patch)) {
    if (
      propertiesByKey.get(key)?.owner === "user" &&
      !isDeepStrictEqual(stored.properties[key] ?? null, value ?? null)
    ) {
      required.add(key);
    }
  }
  for (const key of prepared.deferredKeys) required.add(key);
  for (const key of required) {
    if (!Object.hasOwn(step.before?.properties ?? {}, key)) {
      throw stepError(step, `before does not hold the current value of property '${key}'`, key);
    }
    if (prepared.deferredKeys.includes(key) && !Object.hasOwn(properties, key)) continue;
    if (!Object.hasOwn(step.after?.properties ?? {}, key)) {
      throw stepError(step, `after does not hold the new value of property '${key}'`, key);
    }
    if (!isDeepStrictEqual(prepared.patch[key] ?? null, step.after?.properties?.[key] ?? null)) {
      throw stepError(step, `after differs from property '${key}'`, key);
    }
  }
  for (const key of Object.keys(step.after?.properties ?? {})) {
    if (!Object.hasOwn(step.before?.properties ?? {}, key) || propertiesByKey.get(key)?.owner !== "user") {
      throw stepError(step, `after contains unsupported property '${key}'`, key);
    }
    if (prepared.deferredKeys.includes(key) && !Object.hasOwn(properties, key)) {
      throw stepError(step, `after cannot predict allocated property '${key}'`, key);
    }
    if (
      Object.hasOwn(prepared.patch, key) &&
      !isDeepStrictEqual(prepared.patch[key] ?? null, step.after?.properties?.[key] ?? null)
    ) {
      throw stepError(step, `after differs from property '${key}'`, key);
    }
    if (
      !Object.hasOwn(prepared.patch, key) &&
      isDeepStrictEqual(step.before?.properties?.[key] ?? null, stored.properties[key] ?? null)
    ) {
      throw stepError(step, `after contains unwritten property '${key}'`, key);
    }
  }
  for (const key of Object.keys(step.before?.properties ?? {})) {
    if (propertiesByKey.get(key)?.owner !== "user")
      throw stepError(step, `before contains unsupported property '${key}'`, key);
  }
  const relations = effectiveStepRelations(step);
  for (const [key, before] of Object.entries(step.before?.relations ?? {})) {
    if (propertiesByKey.get(key)?.type !== "relation") {
      throw stepError(step, `before contains unsupported relation '${key}'`, key);
    }
    if (new Set(before).size !== before.length) {
      throw stepError(step, `relation '${key}' contains duplicate targets`, key);
    }
  }
  for (const [key, targets] of Object.entries(relations)) {
    if (!Object.hasOwn(step.before?.relations ?? {}, key)) {
      throw stepError(step, `before does not hold the current targets of relation '${key}'`, key);
    }
    if (!Object.hasOwn(step.after?.relations ?? {}, key)) {
      throw stepError(step, `after does not hold the new targets of relation '${key}'`, key);
    }
    if (step.relations?.[key] && !isDeepStrictEqual(step.relations[key], targets)) {
      throw stepError(step, `after differs from relation '${key}'`, key);
    }
    const keys = targets.map((target) => (typeof target === "string" ? `id:${target}` : `ref:${target.ref}`));
    const before = step.before?.relations?.[key] ?? [];
    if (new Set(keys).size !== keys.length || new Set(before).size !== before.length) {
      throw stepError(step, `relation '${key}' contains duplicate targets`, key);
    }
  }
}
