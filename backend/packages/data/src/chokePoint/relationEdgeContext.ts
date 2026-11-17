// Loads a relation edge's context (caller-side property and its definition) and the guards every
// edge mutation runs against it: side normalization, system-owner writability and the
// archived-database check on both sides. Nothing here writes.
import type { PoolClient } from "pg";
import { ForbiddenError, ValidationError } from "../errors.js";
import type { PropertyRow, RelationDefinitionRow } from "../types.js";
import * as propertiesStore from "./propertiesStore.js";
import * as relationsStore from "./relationsStore.js";
import { assertDatabaseNotArchived } from "./databaseGuards.js";
import { assertValueLinkHandoff, VALUE_LINKS_OWNER_PROCESS } from "./valueLinkWrites.js";

/** An edge write touches an item on each side, so both databases must be unarchived. */
export async function assertRelationDatabasesNotArchived(
  client: PoolClient,
  context: RelationEdgeContext,
): Promise<void> {
  await assertDatabaseNotArchived(client, context.property.databaseId);
  await assertDatabaseNotArchived(client, context.targetDatabaseId);
}

/** Proves the caller's process identity for a protected system relation write. Never accepted on the public facade. */
export interface SystemRelationWriteContext {
  ownerProcess: string;
}

export interface RelationEdgeContext {
  reldef: RelationDefinitionRow;
  property: PropertyRow;
  targetDatabaseId: string;
}

/**
 * `relationPropertyId` is always the caller's own side; its `config.relationDefinitionId` and
 * `config.targetDatabaseId` are the only source of truth, and a property lacking either is a data
 * inconsistency, not a case to infer around.
 */
export async function loadRelationEdgeContext(
  client: PoolClient,
  relationPropertyId: string,
): Promise<RelationEdgeContext> {
  const property = await propertiesStore.getProperty(client, relationPropertyId);
  if (!property || property.type !== "relation") {
    throw new ValidationError(`${relationPropertyId} is not a relation property`, { field: "relationPropertyId" });
  }
  const config = property.config as { relationDefinitionId?: unknown; targetDatabaseId?: unknown };
  if (typeof config.relationDefinitionId !== "string" || typeof config.targetDatabaseId !== "string") {
    throw new ValidationError(
      `Relation property ${relationPropertyId} is missing a valid relationDefinitionId/targetDatabaseId`,
      {
        field: "relationPropertyId",
      },
    );
  }
  const reldef = await relationsStore.getRelationDefinition(client, config.relationDefinitionId);
  if (!reldef || (reldef.propertyIdA !== relationPropertyId && reldef.propertyIdB !== relationPropertyId)) {
    throw new ValidationError(`Relation property ${relationPropertyId} has no matching relation definition`, {
      field: "relationPropertyId",
    });
  }
  return { reldef, property, targetDatabaseId: config.targetDatabaseId };
}

/** Normalizes a caller/target pair to the stored item A / item B tuple for the definition's own side. */
export function normalizeRelationSides(
  reldef: RelationDefinitionRow,
  relationPropertyId: string,
  callerItemId: string,
  targetItemId: string,
): { itemA: string; itemB: string } {
  const isSideA = reldef.propertyIdA === relationPropertyId;
  return isSideA ? { itemA: callerItemId, itemB: targetItemId } : { itemA: targetItemId, itemB: callerItemId };
}

/**
 * Authorizes against the exact property named, since the two sides may have different owners. A
 * public caller is rejected for an `owner: 'system'` side; a system caller unless
 * `context.ownerProcess` matches the property's `owner_process` exactly.
 */
export function assertRelationPropertyWritable(
  property: PropertyRow,
  context: SystemRelationWriteContext | undefined,
): void {
  if (property.owner !== "system") return;
  if (!context || context.ownerProcess !== property.ownerProcess) {
    throw new ForbiddenError(
      `Relation property ${property.id} is owned by 'system' and cannot be written by this caller`,
      { field: "relationPropertyId" },
      "owner_violation",
    );
  }
}

/**
 * The `valueLinks` process may write a user-owned relation property only while an `on` link exists
 * for the caller item and that key. Other properties and callers are unaffected.
 */
export async function assertRelationValueLinkHandoff(
  client: PoolClient,
  property: PropertyRow,
  context: SystemRelationWriteContext | undefined,
  callerItemId: string,
): Promise<void> {
  if (property.owner !== "user" || context?.ownerProcess !== VALUE_LINKS_OWNER_PROCESS) return;
  await assertValueLinkHandoff(client, { itemId: callerItemId, propertyKey: property.key, lockMode: "none" });
}
