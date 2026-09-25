// Owns loading a relation edge's context (the caller-side relation property and its relation
// definition) and the guards every relation-edge mutation runs against it: side normalization,
// system-owner writability and the archived-database check on both sides. Nothing that performs
// a write, and no relation-property creation or destructive-operation projection logic, belongs here.
// Constrained by: docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md,
// docs/adr/2026-09-10-choke-point-api-for-state-writes.md
import type { PoolClient } from "pg";
import { ForbiddenError, ValidationError } from "../errors.js";
import type { PropertyRow, RelationDefinitionRow } from "../types.js";
import * as propertiesStore from "./propertiesStore.js";
import * as relationsStore from "./relationsStore.js";
import { assertDatabaseNotArchived } from "./databaseGuards.js";

/** Shared by every relation-edge mutation: both the caller's own database and the edge's target database must be unarchived, since an edge write touches an item on each side. */
export async function assertRelationDatabasesNotArchived(
  client: PoolClient,
  context: RelationEdgeContext,
): Promise<void> {
  await assertDatabaseNotArchived(client, context.property.databaseId);
  await assertDatabaseNotArchived(client, context.targetDatabaseId);
}

/** Proves the caller's process identity for a protected system relation write — see `assertRelationSideCreatable`/`assertRelationPropertyWritable` below. Never accepted on the public facade. */
export interface SystemRelationWriteContext {
  ownerProcess: string;
}

export interface RelationEdgeContext {
  reldef: RelationDefinitionRow;
  property: PropertyRow;
  targetDatabaseId: string;
}

/**
 * Loads the relation property named by an edge input and normalizes it against its relation
 * definition. `relationPropertyId` always identifies the caller's own side of the definition;
 * its `config.relationDefinitionId`/`config.targetDatabaseId` are the only source of truth for
 * which definition and target database an edge call resolves against — a property whose config
 * lacks either is a data inconsistency (a relation property is never usable before
 * `createRelationPropertyWithClient` fills in both), not a case to infer around.
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
 * Authorizes an edge write against the exact property named by `relationPropertyId` — a
 * paired definition's two sides may have different owners, and only the side the caller
 * named governs this particular call. A public caller (no context) is rejected outright when
 * that side is `owner: 'system'`; a protected system caller is rejected unless its
 * `context.ownerProcess` matches the property's declared `owner_process` exactly.
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
