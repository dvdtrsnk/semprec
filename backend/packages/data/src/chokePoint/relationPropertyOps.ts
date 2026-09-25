// Owns the schema side of relations: creating a paired relation property (source side, optional
// inverse side, their shared relation definition and per-side lock state) together with the owner
// and system-context guards that creation runs, and the public `createRelationProperty` facade.
// Relation edges (relationOps.ts), relation-edge context loading and guards (relationEdgeContext.ts)
// and deleting a relation property (propertyOps.ts) do not belong here.
// Constrained by: docs/adr/2026-09-10-choke-point-api-for-state-writes.md
import type { PoolClient } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
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
import type { ChokePointDeps } from "./chokePointDeps.js";
export interface RelationPropertySideInput {
  key: string;
  /** Nullable for a built-in relation property of a system database (issue #235). */
  name: string | null;
  owner?: PropertyOwner;
  /** Required and non-empty exactly when `owner` is `'system'`; must be omitted otherwise. */
  ownerProcess?: string;
  /** This side's own lock state — never inherited from the source side's `locked` (see `CreateRelationPropertyInput.locked`). Defaults to `false`. */
  locked?: boolean;
}

export interface CreateRelationPropertyInput {
  sourceDatabaseId: string;
  key: string;
  /** Nullable for a built-in relation property of a system database (issue #235). */
  name: string | null;
  targetDatabaseId: string;
  cardinality?: "one_to_one" | "one_to_many" | "many_to_many";
  owner?: PropertyOwner;
  /** Required and non-empty exactly when `owner` is `'system'`; must be omitted otherwise. */
  ownerProcess?: string;
  /**
   * Locks only the source side (`property_id_a`). Each side's lock is independent — set
   * `inverse.locked` too if the paired property must also be locked. Before this issue,
   * a single top-level `locked: true` locked both sides of a pair; a caller migrating onto
   * this shape must now set `inverse.locked: true` explicitly, or the inverse property is
   * created unlocked.
   */
  locked?: boolean;
  inverse?: RelationPropertySideInput;
}

/** `ownerProcess` is required and non-empty exactly when `owner` is `'system'`, and must be absent otherwise — enforced per side, independently. */
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

/** A public caller (no context) may only create `owner: 'user'` sides; a protected system caller may create an `owner: 'system'` side only when its context matches that side's declared `ownerProcess`. */
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
 * The relation-property creation logic, factored out so a caller already holding an open
 * transaction (namely the ten-hardcoded-databases seed, see seed/seedTenDatabases.ts) can
 * run it against that same `client` instead of going through `createChokePoint(...)`'s
 * `withTransaction`, which would open a second, separate connection — one that cannot see
 * this transaction's not-yet-committed `databases`/`properties` rows under read-committed
 * isolation. `createChokePoint`'s `createRelationProperty` below is a thin wrapper over this
 * for the normal, already-committed-schema case, always called with no `context` — so a
 * public caller can never create an `owner: 'system'` side (see `assertRelationSideCreatable`).
 * The computed-key-collision check lives here (not only in the public wrapper) so every
 * caller of this exported function gets it, not just the ones that happen to go through
 * `createChokePoint`; `computedKeyRegistry` defaults to a fresh empty registry, matching
 * `createChokePoint`'s own default.
 *
 * Both sides' schema (property + config) are created before either side's `locked` is
 * applied, so a `locked: true` request never has an externally visible intermediate state —
 * a concurrent reader in another transaction sees either the whole thing committed, unlocked
 * schema and all, or nothing at all.
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

export function createRelationPropertyOps(deps: Pick<ChokePointDeps, "pool" | "computedKeyRegistry">) {
  const { pool, computedKeyRegistry } = deps;
  return {
    /** Public facade: never passes a `SystemRelationWriteContext`, so an `owner: 'system'` side is always rejected (`owner_violation`). */
    async createRelationProperty(
      input: CreateRelationPropertyInput,
    ): Promise<{ property: PropertyRow; inverseProperty: PropertyRow | null }> {
      return withTransaction(pool, async (client) => {
        const result = await createRelationPropertyWithClient(client, input, undefined, computedKeyRegistry);
        const invalidatedDatabaseIds = new Set([result.property.databaseId]);
        if (result.inverseProperty) invalidatedDatabaseIds.add(result.inverseProperty.databaseId);
        runAfterCommit(client, () => {
          for (const databaseId of invalidatedDatabaseIds) notifyInvalidation({ scope: "schema", databaseId });
        });
        return result;
      });
    },
  };
}
