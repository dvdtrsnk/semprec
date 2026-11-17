// The databases domain of the choke point: create, archive, restore, rename, read and list, plus the
// transaction-scoped `databaseArchiveWithClient`/`databaseRestoreWithClient` for the approved-operation
// executor.
import type { PoolClient } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import type { DatabaseRow, PropertyType } from "../types.js";
import type { CollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { assertNoComputedKeyCollision } from "./computedKeyRegistry.js";
import * as propertiesStore from "./propertiesStore.js";
import { createRelationPropertyWithClient } from "./relationPropertyWrites.js";
import { findDependenciesBySourceDatabase } from "../rollup/dependencies.js";
import { enqueueRollupBackfill } from "../rollup/recompute.js";
import * as databasesStore from "./databasesStore.js";
import { requireRollupCoordinationTransaction } from "./databaseRowLocks.js";
import {
  assertReaderDatabaseAccess,
  listUnreadableDatabaseIds,
  type DatabaseReader,
} from "../agentGrants/agentDatabaseAccess.js";
import { assertReaderItemPathAccess } from "./readerObjectAccess.js";

/** Archive and restore change what rollups over this database count; recount each in the same transaction. */
async function enqueueDependentRollupRecomputes(client: PoolClient, sourceDatabaseId: string): Promise<void> {
  for (const dependency of await findDependenciesBySourceDatabase(client, sourceDatabaseId)) {
    await enqueueRollupBackfill(client, dependency.rollupPropertyId);
  }
}

/**
 * Transaction-scoped counterpart to `chokePoint.archiveDatabase` that also enqueues the dependent
 * rollup full jobs in the same transaction. One of the approval-gated destructive `*WithClient`
 * exports `ApprovedOperationExecutor` calls.
 */
export async function databaseArchiveWithClient(
  client: PoolClient,
  id: string,
  actingUserId?: string,
): Promise<DatabaseRow> {
  await requireRollupCoordinationTransaction(client);
  const database = await databasesStore.archiveDatabase(client, id);
  await enqueueDependentRollupRecomputes(client, database.id);
  runAfterCommit(client, () => notifyInvalidation({ scope: "schema", databaseId: database.id, userId: actingUserId }));
  return database;
}

/**
 * Transaction-scoped counterpart to `chokePoint.restoreDatabase`: clears `archived_at`/`purge_at`,
 * enqueues the dependent rollup jobs and invalidates the schema after commit. The caller checks reader
 * access. A database that is not archived is returned unchanged but still announced.
 */
export async function databaseRestoreWithClient(
  client: PoolClient,
  id: string,
  actingUserId?: string,
): Promise<DatabaseRow> {
  await requireRollupCoordinationTransaction(client);
  const database = await databasesStore.restoreDatabase(client, id);
  await enqueueDependentRollupRecomputes(client, database.id);
  runAfterCommit(client, () => notifyInvalidation({ scope: "schema", databaseId: database.id, userId: actingUserId }));
  return database;
}

/** One non-title property of `createDatabaseWithProperties`; a relation is created unlocked and without an inverse side. */
export type DatabaseCreatePropertyInput =
  | { key: string; name: string; type: Exclude<PropertyType, "relation">; config?: Record<string, unknown> }
  | {
      key: string;
      name: string;
      type: "relation";
      targetDatabaseId: string;
      cardinality: "one_to_one" | "one_to_many" | "many_to_many";
    };

const TITLE_PROPERTY_KEY = "name";

export function createDatabaseOps(deps: Pick<ChokePointDeps, "pool" | "computedKeyRegistry">) {
  const { pool, computedKeyRegistry } = deps;
  return {
    /** One transaction: any failure rolls back the database, its partition and every property. */
    async createDatabaseWithProperties(
      input: databasesStore.CreateDatabaseInput,
      titlePropertyName: string,
      properties: DatabaseCreatePropertyInput[],
      actingUserId?: string,
    ): Promise<DatabaseRow> {
      return withTransaction(pool, async (client) => {
        const database = await databasesStore.createDatabase(client, input);
        for (const key of [TITLE_PROPERTY_KEY, ...properties.map((property) => property.key)]) {
          assertNoComputedKeyCollision(computedKeyRegistry, key);
        }
        const title = await propertiesStore.createProperty(client, {
          databaseId: database.id,
          key: TITLE_PROPERTY_KEY,
          name: titlePropertyName,
          type: "title",
          locked: false,
          owner: "user",
        });
        await propertiesStore.setInitialPosition(client, database.id, title.id, 0);
        for (const [index, property] of properties.entries()) {
          if (property.type === "relation") {
            const created = await createRelationPropertyWithClient(
              client,
              {
                sourceDatabaseId: database.id,
                key: property.key,
                name: property.name,
                targetDatabaseId: property.targetDatabaseId,
                cardinality: property.cardinality,
                owner: "user",
                locked: false,
              },
              undefined,
              computedKeyRegistry,
            );
            await propertiesStore.setInitialPosition(client, database.id, created.property.id, index + 1);
          } else {
            const created = await propertiesStore.createProperty(client, {
              databaseId: database.id,
              key: property.key,
              name: property.name,
              type: property.type,
              config: property.config,
              locked: false,
              owner: "user",
            });
            await propertiesStore.setInitialPosition(client, database.id, created.id, index + 1);
          }
        }
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: database.id, userId: actingUserId }),
        );
        return database;
      });
    },

    /** A `reader` is refused `forbidden` when `parentItemId` lies in a sensitive database, checked before creating. */
    async createDatabase(
      input: databasesStore.CreateDatabaseInput,
      actingUserId?: string,
      reader?: DatabaseReader,
    ): Promise<DatabaseRow> {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined && input.parentItemId) {
          await assertReaderItemPathAccess(client, reader, input.parentItemId, "write");
        }
        const database = await databasesStore.createDatabase(client, input);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: database.id, userId: actingUserId }),
        );
        return database;
      });
    },
    /** A `reader` needs `write` on the database, checked first in this transaction. */
    async archiveDatabase(id: string, actingUserId?: string, reader?: DatabaseReader): Promise<DatabaseRow> {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) await assertReaderDatabaseAccess(client, reader, id, "write");
        return databaseArchiveWithClient(client, id, actingUserId);
      });
    },
    async restoreDatabase(id: string, actingUserId?: string, reader?: DatabaseReader): Promise<DatabaseRow> {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) await assertReaderDatabaseAccess(client, reader, id, "write");
        return databaseRestoreWithClient(client, id, actingUserId);
      });
    },
    /**
     * `resolver` decides whether `patch.overviewHidden` is accepted. A `reader` needs `write` on the
     * database, checked first. One schema invalidation follows the commit.
     */
    async patchDatabase(
      id: string,
      patch: databasesStore.DatabasePatch,
      actingUserId?: string,
      resolver?: Pick<CollectionMetadataResolver, "overviewHideable">,
      reader?: DatabaseReader,
    ): Promise<DatabaseRow> {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) await assertReaderDatabaseAccess(client, reader, id, "write");
        const database = await databasesStore.patchDatabase(client, id, patch, resolver);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: database.id, userId: actingUserId }),
        );
        return database;
      });
    },
    async renameDatabase(id: string, name: string, actingUserId?: string): Promise<DatabaseRow> {
      return withTransaction(pool, async (client) => {
        const database = await databasesStore.renameDatabase(client, id, name);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: database.id, userId: actingUserId }),
        );
        return database;
      });
    },
    /** `forbidden` for a database the agent's project may not read, or a sensitive one for an external client. */
    async getDatabase(id: string, reader?: DatabaseReader): Promise<DatabaseRow | null> {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) await assertReaderDatabaseAccess(client, reader, id, "read");
        return databasesStore.getDatabase(client, id);
      });
    },
    /** Every non-archived database, system ones included; for a `reader` without the databases it may not read. */
    async listDatabases(reader?: DatabaseReader): Promise<DatabaseRow[]> {
      return withTransaction(pool, async (client) => {
        const databases = await databasesStore.listAllDatabases(client);
        if (reader === undefined) return databases;
        const unreadable = await listUnreadableDatabaseIds(client, reader);
        return databases.filter((database) => !unreadable.has(database.id));
      });
    },

    /** A new, independent database owned by a page; always `system: false`. */
    async createInlineDatabase(
      input: {
        name: string;
        parentItemId: string;
        ownerProjectItemId?: string;
        ownerModuleId?: string;
      },
      actingUserId?: string,
    ): Promise<DatabaseRow> {
      return withTransaction(pool, async (client) => {
        const database = await databasesStore.createDatabase(client, { ...input, system: false });
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: database.id, userId: actingUserId }),
        );
        return database;
      });
    },
  };
}
