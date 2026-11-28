// The properties domain of the choke point: list, read, resolve, create, rename, reconfigure, retype
// and delete properties, add and change select options, and the transaction-scoped
// `propertyDeleteWithClient` for the approved-operation executor. Relation-definition writes are not
// here.
import type { PoolClient } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import type { DatabaseRow, PropertyRow, PropertyType } from "../types.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import * as propertiesStore from "./propertiesStore.js";
import * as relationsStore from "./relationsStore.js";
import * as databasesStore from "./databasesStore.js";
import { assertNoComputedKeyCollision } from "./computedKeyRegistry.js";
import { applyRollupConfig } from "../rollup/config.js";
import { enqueueRollupBackfill } from "../rollup/recompute.js";
import { assertRelationDeletable, assertSourceDeletable, assertSourceRetypeAllowed } from "../rollup/mirror.js";
import { enqueuePropertyTypeMigration, isConversionSupported } from "../migrationJob/propertyTypeMigration.js";
import { currentTenantScope } from "@semprec/shared";
import { enqueueItemSearchBackfill } from "../search/itemSearchBackfill.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import {
  assertReaderDatabaseAccess,
  type DatabaseReader,
  type RequiredAgentDatabaseAccess,
} from "../agentGrants/agentDatabaseAccess.js";
import { assertReaderPropertyAccess } from "./readerObjectAccess.js";
import {
  createCatalogResolver,
  resolveProperty,
  toManifestLocale,
  type CatalogResolver,
  type ResolvedOption,
} from "../manifest/catalogResolution.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";

/**
 * After a property changes, its database's search documents are rebuilt by the backfill queued in
 * this transaction, so existing values become searchable or stop being. The job key names the
 * database, so repeated writes collapse. Emails are not reindexed (mail owns their rows). Outside a tenant scope the job cannot be keyed, so nothing is queued.
 */
export async function enqueuePropertySearchReindex(client: PoolClient, databaseIds: Iterable<string>): Promise<void> {
  if (currentTenantScope()?.kind !== "tenant") return;
  for (const databaseId of new Set(databaseIds)) {
    const database = await databasesStore.getDatabase(client, databaseId);
    if (!database || database.ownerModuleId === EMAILS_MODULE_ID) continue;
    await enqueueItemSearchBackfill(client, { databaseId });
  }
}

let optionCatalogResolverPromise: Promise<CatalogResolver> | undefined;

/**
 * Built once per process from `loadFullModuleRegistry`, since the choke point is constructed from a
 * pool alone. A failed load is not cached, so the next call retries.
 */
function getOptionCatalogResolver(): Promise<CatalogResolver> {
  optionCatalogResolverPromise ??= loadFullModuleRegistry()
    .then((registry) => createCatalogResolver(registry))
    .catch((error: unknown) => {
      optionCatalogResolverPromise = undefined;
      throw error;
    });
  return optionCatalogResolverPromise;
}

/**
 * In the option write's transaction: queue the search reindex, register the schema invalidation for
 * after commit, and return the option as `resolveProperty` projects it, labelled in `locale`.
 */
async function finishOptionWrite(
  client: PoolClient,
  written: propertiesStore.PropertyOptionWrite,
  catalogResolver: CatalogResolver,
  locale: string,
  actingUserId: string | undefined,
): Promise<ResolvedOption> {
  const { property, database, optionKey } = written;
  const catalogs = await catalogResolver.getCatalogsForDbKey(database.key);
  const option = resolveProperty(property, database.key, catalogs, toManifestLocale(locale)).options?.find(
    (candidate) => candidate.key === optionKey,
  );
  if (!option) {
    // An invariant breach, not a domain NotFoundError: the option was written in this transaction.
    throw new Error(`Option written to property ${property.id} in this transaction is missing from its projection`);
  }
  await enqueuePropertySearchReindex(client, [property.databaseId]);
  runAfterCommit(client, () =>
    notifyInvalidation({ scope: "schema", databaseId: property.databaseId, userId: actingUserId }),
  );
  return option;
}

/** Transaction-scoped counterpart to `chokePoint.deleteProperty`, for `ApprovedOperationExecutor`'s locked transaction. */
export async function propertyDeleteWithClient(
  client: PoolClient,
  id: string,
  actingUserId?: string,
): Promise<PropertyRow> {
  const property = await propertiesStore.getProperty(client, id);
  if (!property) throw new NotFoundError(`Property ${id} not found`);

  const invalidatedDatabaseIds = new Set([property.databaseId]);
  if (property.type === "relation") {
    const reldef = await relationsStore.getRelationDefinitionByPropertyId(client, id);
    if (reldef) {
      await assertRelationDeletable(client, reldef.id);
      const otherPropertyId = reldef.propertyIdA === id ? reldef.propertyIdB : reldef.propertyIdA;
      if (otherPropertyId) {
        const otherProperty = await propertiesStore.getProperty(client, otherPropertyId);
        if (otherProperty?.locked) {
          throw new ForbiddenError(`Cannot delete: the paired relation property ${otherPropertyId} is locked`);
        }
        if (otherProperty) invalidatedDatabaseIds.add(otherProperty.databaseId);
        await propertiesStore.deleteProperty(client, otherPropertyId);
      }
    }
  } else {
    await assertSourceDeletable(client, property.databaseId, property.key);
  }
  await propertiesStore.deleteProperty(client, id);
  await enqueuePropertySearchReindex(client, invalidatedDatabaseIds);
  runAfterCommit(client, () => {
    for (const databaseId of invalidatedDatabaseIds)
      notifyInvalidation({ scope: "schema", databaseId, userId: actingUserId });
  });
  return property;
}

/** Shared by `updatePropertyConfig` and `updateProperty`, so the latter runs it in one transaction with a rename/retype. */
async function updatePropertyConfigWithClient(
  client: PoolClient,
  id: string,
  config: Record<string, unknown>,
): Promise<PropertyRow> {
  const property = await propertiesStore.updatePropertyConfig(client, id, config);
  if (property.type === "rollup") {
    await applyRollupConfig(client, property);
    await enqueueRollupBackfill(client, property.id);
  }
  return property;
}

/** Shared by `changePropertyType` and `updateProperty`, as `updatePropertyConfigWithClient`. */
async function changePropertyTypeWithClient(
  client: PoolClient,
  id: string,
  newType: PropertyType,
  config?: Record<string, unknown>,
): Promise<PropertyRow> {
  const property = await propertiesStore.getPropertyForUpdate(client, id);
  if (!property) throw new ValidationError(`Property ${id} not found`);
  const oldType = property.type;
  if (oldType === newType) return property;

  if ([oldType, newType].includes("relation") || [oldType, newType].includes("rollup")) {
    throw new ValidationError("Retyping into or out of 'relation'/'rollup' is not supported via changePropertyType", {
      field: "type",
    });
  }
  await assertSourceRetypeAllowed(client, property.databaseId, property.key, newType);
  if (!isConversionSupported(oldType, newType)) {
    throw new ValidationError(`No conversion path from '${oldType}' to '${newType}'; create a new property instead`, {
      field: "type",
    });
  }

  const updated = await propertiesStore.changePropertyType(client, id, newType, "pending", config);
  await enqueuePropertyTypeMigration(client, id, oldType);
  return updated;
}

/** Lets `updatePropertyWithDatabase` read the owning database in the same transaction as the patch. */
async function updatePropertyWithClient(
  client: PoolClient,
  id: string,
  input: { name?: string; config?: Record<string, unknown>; type?: PropertyType },
): Promise<{ property: PropertyRow; typeChanged: boolean }> {
  let property = await propertiesStore.getPropertyForUpdate(client, id);
  if (!property) throw new NotFoundError(`Property ${id} not found`);

  // Checked inside the transaction after the existence check, so an unknown id is always 404
  // whatever the patch shape.
  if (input.name === undefined && input.config === undefined && input.type === undefined) {
    throw new ValidationError("Patch must include at least one field", { reason: "empty_patch" });
  }

  // Re-checked against the row this transaction fetched, so a concurrent type change cannot slip a
  // patch past a relation property.
  if (property.type === "relation" && (input.type !== undefined || input.config !== undefined)) {
    const field = input.type !== undefined ? "type" : "config";
    throw new ValidationError(`Property ${id} is a relation; ${field} is changed only via its relation definition`, {
      field,
      reason: "relation_definition_required",
    });
  }

  if (input.name !== undefined) {
    property = await propertiesStore.renameProperty(client, id, input.name);
  }
  let typeChanged = false;
  if (input.type !== undefined && input.type !== property.type) {
    property = await changePropertyTypeWithClient(client, id, input.type, input.config);
    typeChanged = true;
  } else if (input.config !== undefined) {
    property = await updatePropertyConfigWithClient(client, id, input.config);
  }
  return { property, typeChanged };
}

/**
 * An external client's check: the property's database and, for a relation property, the paired
 * side's database, which a change or delete of this side also reaches.
 */
async function assertReaderPropertyPairAccess(
  client: PoolClient,
  reader: DatabaseReader,
  propertyId: string,
  access: RequiredAgentDatabaseAccess,
): Promise<void> {
  await assertReaderPropertyAccess(client, reader, propertyId, access);
  const definition = await relationsStore.getRelationDefinitionByPropertyId(client, propertyId);
  const pairedPropertyId = definition?.propertyIdA === propertyId ? definition.propertyIdB : definition?.propertyIdA;
  if (pairedPropertyId) await assertReaderPropertyAccess(client, reader, pairedPropertyId, access);
}

export function createPropertyOps(deps: Pick<ChokePointDeps, "pool" | "computedKeyRegistry">) {
  const { pool, computedKeyRegistry } = deps;
  return {
    /**
     * Operations below that take a `reader` need `read` (reads) or `write` (writes) on the property's
     * database, checked first in the operation's transaction.
     */
    async listProperties(databaseId: string, reader?: DatabaseReader): Promise<PropertyRow[]> {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) await assertReaderDatabaseAccess(client, reader, databaseId, "read");
        return propertiesStore.listPropertiesByDatabase(client, databaseId);
      });
    },
    async getProperty(id: string, reader?: DatabaseReader): Promise<PropertyRow | null> {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) await assertReaderPropertyAccess(client, reader, id, "read");
        return propertiesStore.getProperty(client, id);
      });
    },

    /** Resolves a relation route's `:propertyKey`; edge calls take a property id, never a key. */
    async getPropertyByKey(databaseId: string, key: string): Promise<PropertyRow | null> {
      return withTransaction(pool, (client) => propertiesStore.getPropertyByKey(client, databaseId, key));
    },

    /** See `propertiesStore.findPropertiesByKey`. */
    async findPropertiesByKey(
      databaseId: string,
      key: string,
      type?: PropertyType,
      reader?: DatabaseReader,
    ): Promise<PropertyRow[]> {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) await assertReaderDatabaseAccess(client, reader, databaseId, "read");
        return propertiesStore.findPropertiesByKey(client, databaseId, key, type);
      });
    },

    async createProperty(
      input: propertiesStore.CreatePropertyInput,
      actingUserId?: string,
      reader?: DatabaseReader,
    ): Promise<PropertyRow> {
      assertNoComputedKeyCollision(computedKeyRegistry, input.key);
      if (input.type === "rollup") {
        return withTransaction(pool, async (client) => {
          if (reader !== undefined) await assertReaderDatabaseAccess(client, reader, input.databaseId, "write");
          const property = await propertiesStore.createProperty(client, input);
          await applyRollupConfig(client, property);
          await enqueueRollupBackfill(client, property.id);
          const finalProperty = await propertiesStore.getProperty(client, property.id);
          if (!finalProperty) {
            // An invariant breach, not a domain NotFoundError: the row was created in this transaction.
            throw new Error(`Rollup property ${property.id} created in this transaction could not be read back`);
          }
          await enqueuePropertySearchReindex(client, [finalProperty.databaseId]);
          runAfterCommit(client, () =>
            notifyInvalidation({ scope: "schema", databaseId: finalProperty.databaseId, userId: actingUserId }),
          );
          return finalProperty;
        });
      }
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) await assertReaderDatabaseAccess(client, reader, input.databaseId, "write");
        const property = await propertiesStore.createProperty(client, input);
        await enqueuePropertySearchReindex(client, [property.databaseId]);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: property.databaseId, userId: actingUserId }),
        );
        return property;
      });
    },

    async renameProperty(id: string, name: string, actingUserId?: string): Promise<PropertyRow> {
      return withTransaction(pool, async (client) => {
        const property = await propertiesStore.renameProperty(client, id, name);
        await enqueuePropertySearchReindex(client, [property.databaseId]);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: property.databaseId, userId: actingUserId }),
        );
        return property;
      });
    },

    async updatePropertyConfig(
      id: string,
      config: Record<string, unknown>,
      actingUserId?: string,
    ): Promise<PropertyRow> {
      return withTransaction(pool, async (client) => {
        const property = await updatePropertyConfigWithClient(client, id, config);
        await enqueuePropertySearchReindex(client, [property.databaseId]);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: property.databaseId, userId: actingUserId }),
        );
        return property;
      });
    },

    async changePropertyType(id: string, newType: PropertyType, actingUserId?: string): Promise<PropertyRow> {
      return withTransaction(pool, async (client) => {
        const property = await changePropertyTypeWithClient(client, id, newType);
        await enqueuePropertySearchReindex(client, [property.databaseId]);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: property.databaseId, userId: actingUserId }),
        );
        return property;
      });
    },

    /**
     * `PATCH /api/properties/:id`: applies `name`/`config`/`type` in one transaction, so a 403 from the
     * locked-schema checks also rolls back a rename in the same call.
     */
    async updateProperty(
      id: string,
      input: { name?: string; config?: Record<string, unknown>; type?: PropertyType },
      actingUserId?: string,
      reader?: DatabaseReader,
    ): Promise<{ property: PropertyRow; typeChanged: boolean }> {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) await assertReaderPropertyPairAccess(client, reader, id, "write");
        const result = await updatePropertyWithClient(client, id, input);
        await enqueuePropertySearchReindex(client, [result.property.databaseId]);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: result.property.databaseId, userId: actingUserId }),
        );
        return result;
      });
    },

    /**
     * `updateProperty` that also reads the owning database in the same transaction, for the REST
     * response's catalog/locale resolution, so a concurrently deleted database cannot fail an update that
     * already succeeded.
     */
    async updatePropertyWithDatabase(
      id: string,
      input: { name?: string; config?: Record<string, unknown>; type?: PropertyType },
      actingUserId?: string,
    ): Promise<{ property: PropertyRow; typeChanged: boolean; database: DatabaseRow }> {
      return withTransaction(pool, async (client) => {
        const result = await updatePropertyWithClient(client, id, input);
        await enqueuePropertySearchReindex(client, [result.property.databaseId]);
        const database = await databasesStore.getDatabase(client, result.property.databaseId);
        if (!database) throw new NotFoundError(`Database ${result.property.databaseId} not found`);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: result.property.databaseId, userId: actingUserId }),
        );
        return { ...result, database };
      });
    },

    /**
     * Appends an option to a select or multi_select property, also on a schema-locked database, and
     * returns it with its generated key. The stored label makes the locale irrelevant. The catalog
     * resolver is obtained before the transaction so it never waits on manifest loading.
     */
    async addPropertyOption(
      propertyId: string,
      input: { label: string; color?: string },
      actingUserId?: string,
    ): Promise<ResolvedOption> {
      const catalogResolver = await getOptionCatalogResolver();
      return withTransaction(pool, async (client) => {
        const written = await propertiesStore.addPropertyOption(client, propertyId, input, catalogResolver);
        return finishOptionWrite(client, written, catalogResolver, "en", actingUserId);
      });
    },

    /**
     * Writes the label, color or both of one option, also on a schema-locked database; the key never
     * changes. `locale` picks the catalog language when the option stores no label.
     */
    async updatePropertyOption(
      propertyId: string,
      optionKey: string,
      patch: { label?: string; color?: string },
      locale: string,
      actingUserId?: string,
    ): Promise<ResolvedOption> {
      const catalogResolver = await getOptionCatalogResolver();
      return withTransaction(pool, async (client) => {
        const written = await propertiesStore.updatePropertyOption(
          client,
          propertyId,
          optionKey,
          patch,
          catalogResolver,
        );
        return finishOptionWrite(client, written, catalogResolver, locale, actingUserId);
      });
    },

    /**
     * Returns the row as this transaction read it immediately before deletion, so a concurrent rename
     * cannot make the response describe a state the deleted row never had.
     */
    async deleteProperty(id: string, actingUserId?: string, reader?: DatabaseReader): Promise<PropertyRow> {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) await assertReaderPropertyPairAccess(client, reader, id, "write");
        return propertyDeleteWithClient(client, id, actingUserId);
      });
    },
  };
}
