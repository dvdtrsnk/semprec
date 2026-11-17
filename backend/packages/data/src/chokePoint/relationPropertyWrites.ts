// The transaction-scoped creation of a paired relation property (source side, optional inverse, the
// shared definition and per-side lock state) with its owner and system-context guards. Kept separate
// so `relationPropertyOps.ts` and `databaseOps.ts` can both call it without importing each other.
import type { PoolClient } from "pg";
import { ForbiddenError, ValidationError } from "../errors.js";
import type { PropertyOwner, PropertyRow } from "../types.js";
import * as databasesStore from "./databasesStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as relationsStore from "./relationsStore.js";
import {
  assertNoComputedKeyCollision,
  createComputedKeyRegistry,
  type ComputedKeyRegistry,
} from "./computedKeyRegistry.js";
import type { SystemRelationWriteContext } from "./relationEdgeContext.js";

export interface RelationPropertySideInput {
  key: string;
  /** Nullable for a built-in relation property of a system database. */
  name: string | null;
  owner?: PropertyOwner;
  /** Required and non-empty exactly when `owner` is `'system'`. */
  ownerProcess?: string;
  /** This side's own lock state, never inherited from the source side. Defaults to `false`. */
  locked?: boolean;
}

export interface CreateRelationPropertyInput {
  sourceDatabaseId: string;
  key: string;
  /** Nullable for a built-in relation property of a system database. */
  name: string | null;
  targetDatabaseId: string;
  cardinality?: "one_to_one" | "one_to_many" | "many_to_many";
  owner?: PropertyOwner;
  /** Required and non-empty exactly when `owner` is `'system'`. */
  ownerProcess?: string;
  /** Locks only the source side; set `inverse.locked` too to lock the paired property. */
  locked?: boolean;
  inverse?: RelationPropertySideInput;
}

/** Enforced per side, independently. */
function assertValidOwnerSide(owner: PropertyOwner, ownerProcess: string | undefined, field: string): void {
  if (owner === "system") {
    if (!ownerProcess) {
      throw new ValidationError(`${field}.ownerProcess is required and non-empty when ${field}.owner is 'system'`, {
        field: `${field}.ownerProcess`,
      });
    }
  } else if (ownerProcess !== undefined) {
    throw new ValidationError(`${field}.ownerProcess must be omitted unless ${field}.owner is 'system'`, {
      field: `${field}.ownerProcess`,
    });
  }
}

/** A public caller (no context) may only create `owner: 'user'` sides; a system caller only an `owner: 'system'` side whose `ownerProcess` matches its context. */
function assertRelationSideCreatable(
  owner: PropertyOwner,
  ownerProcess: string | undefined,
  context: SystemRelationWriteContext | undefined,
  field: string,
): void {
  if (owner !== "system") return;
  if (!context || context.ownerProcess !== ownerProcess) {
    throw new ForbiddenError(
      `Creating ${field} as owner:'system' requires a matching SystemRelationWriteContext`,
      { field },
      "owner_violation",
    );
  }
}

/**
 * Exported so a caller already in a transaction (the system-database seed) can create relation
 * properties against rows it has not committed yet. The public wrapper always passes no `context`,
 * so a public caller can never create an `owner: 'system'` side. The computed-key collision check
 * lives here so every caller gets it.
 *
 * Both sides' schema is created before either side's `locked` is applied, so a `locked: true`
 * request has no externally visible intermediate state.
 */
export async function createRelationPropertyWithClient(
  client: PoolClient,
  input: CreateRelationPropertyInput,
  context?: SystemRelationWriteContext,
  computedKeyRegistry: ComputedKeyRegistry = createComputedKeyRegistry(),
): Promise<{ property: PropertyRow; inverseProperty: PropertyRow | null }> {
  assertNoComputedKeyCollision(computedKeyRegistry, input.key);
  if (input.inverse) assertNoComputedKeyCollision(computedKeyRegistry, input.inverse.key);

  const sourceOwner: PropertyOwner = input.owner ?? "user";
  assertValidOwnerSide(sourceOwner, input.ownerProcess, "source");
  assertRelationSideCreatable(sourceOwner, input.ownerProcess, context, "source");

  const inverseOwner: PropertyOwner | undefined = input.inverse ? (input.inverse.owner ?? "user") : undefined;
  if (input.inverse) {
    assertValidOwnerSide(inverseOwner!, input.inverse.ownerProcess, "inverse");
    assertRelationSideCreatable(inverseOwner!, input.inverse.ownerProcess, context, "inverse");
  }

  const targetDatabase = await databasesStore.getDatabase(client, input.targetDatabaseId);
  if (!targetDatabase) {
    throw new ValidationError(`Target database ${input.targetDatabaseId} does not exist`, {
      field: "targetDatabaseId",
    });
  }

  const property = await propertiesStore.createProperty(client, {
    databaseId: input.sourceDatabaseId,
    key: input.key,
    name: input.name,
    type: "relation",
    owner: sourceOwner,
    ownerProcess: input.ownerProcess,
  });

  let inverseProperty: PropertyRow | null = null;
  if (input.inverse) {
    inverseProperty = await propertiesStore.createProperty(client, {
      databaseId: input.targetDatabaseId,
      key: input.inverse.key,
      name: input.inverse.name,
      type: "relation",
      owner: inverseOwner,
      ownerProcess: input.inverse.ownerProcess,
    });
  }

  const reldef = await relationsStore.createRelationDefinition(client, {
    propertyIdA: property.id,
    propertyIdB: inverseProperty?.id,
    cardinality: input.cardinality,
  });

  let finalProperty = await propertiesStore.updatePropertyConfig(client, property.id, {
    relationDefinitionId: reldef.id,
    targetDatabaseId: input.targetDatabaseId,
  });
  if (inverseProperty) {
    inverseProperty = await propertiesStore.updatePropertyConfig(client, inverseProperty.id, {
      relationDefinitionId: reldef.id,
      targetDatabaseId: input.sourceDatabaseId,
    });
  }
  if (input.locked) {
    await propertiesStore.setPropertyLocked(client, finalProperty.id, true);
    finalProperty = { ...finalProperty, locked: true };
  }
  if (inverseProperty && input.inverse?.locked) {
    await propertiesStore.setPropertyLocked(client, inverseProperty.id, true);
    inverseProperty = { ...inverseProperty, locked: true };
  }
  return { property: finalProperty, inverseProperty };
}
