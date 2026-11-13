// Owns the databases domain of the choke point: creating, archiving, restoring, renaming, reading and
// listing databases, plus the transaction-scoped `databaseArchiveWithClient` the approved-operation
// executor calls. Item, property, relation and view writes do not belong here, and neither does any
// other domain module's code — this module talks only to `databasesStore` and the realtime hook, plus
// `propertiesStore` and the relation-property creation for `createDatabaseWithProperties`.
// Constrained by:
// - docs/adr/2026-09-12-thin-user-scoped-realtime-invalidations.md
// - docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md
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
import { assertAgentDatabaseAccess, listUnreadableDatabaseIds } from "../agentGrants/agentDatabaseAccess.js";

/** Archive and restore change which items the rollups over this database count; recount each in the same transaction via its idempotent full job. */
async function enqueueDependentRollupRecomputes(client: PoolClient, sourceDatabaseId: string): Promise<void> {
  for (const dependency of await findDependenciesBySourceDatabase(client, sourceDatabaseId)) {
    await enqueueRollupBackfill(client, dependency.rollupPropertyId);
  }
}

/**
 * Transaction-scoped counterpart to `chokePoint.archiveDatabase` (issue #89): `databasesStore.archiveDatabase`
 * already takes a `client` rather than opening its own transaction, so this is a named wrapper that also
 * enqueues the dependent rollup full jobs in the same transaction (via `enqueueDependentRollupRecomputes`) —
 * one of the five approval-gated destructive `*WithClient` exports, one per operation, each exported from
 * its own operation module (`databaseOps.ts`, `viewOps.ts`, `propertyOps.ts`, `itemTrash.ts`,
 * `relationOps.ts`), so `ApprovedOperationExecutor` has one uniform naming convention to call the
 * destructive half of each operation.
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
    /**
     * Creates a custom database, its title property (`name`) and `properties` in order in one transaction:
     * any failure rolls back the database, its partition and every property. One schema invalidation follows the commit.
     */
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

    async createDatabase(input: databasesStore.CreateDatabaseInput, actingUserId?: string): Promise<DatabaseRow> {
      return withTransaction(pool, async (client) => {
        const database = await databasesStore.createDatabase(client, input);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: database.id, userId: actingUserId }),
        );
        return database;
      });
    },
    async archiveDatabase(id: string, actingUserId?: string): Promise<DatabaseRow> {
      return withTransaction(pool, (client) => databaseArchiveWithClient(client, id, actingUserId));
    },
    async restoreDatabase(id: string, actingUserId?: string): Promise<DatabaseRow> {
      return withTransaction(pool, async (client) => {
        await requireRollupCoordinationTransaction(client);
        const database = await databasesStore.restoreDatabase(client, id);
        await enqueueDependentRollupRecomputes(client, database.id);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: database.id, userId: actingUserId }),
        );
        return database;
      });
    },
    /**
     * Patches a database in one transaction and publishes one schema invalidation after the commit.
     * `resolver` decides whether `patch.overviewHidden` is accepted (issue #2002); see `databasesStore.patchDatabase`.
     */
    async patchDatabase(
      id: string,
      patch: databasesStore.DatabasePatch,
      actingUserId?: string,
      resolver?: Pick<CollectionMetadataResolver, "overviewHideable">,
    ): Promise<DatabaseRow> {
      return withTransaction(pool, async (client) => {
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
    /** An agent (`agentProjectItemId`, issue #1810) is refused with `forbidden` for a database its project may not read. */
    async getDatabase(id: string, agentProjectItemId?: string): Promise<DatabaseRow | null> {
      return withTransaction(pool, async (client) => {
        if (agentProjectItemId !== undefined) {
          await assertAgentDatabaseAccess(client, { agentProjectItemId, databaseId: id, access: "read" });
        }
        return databasesStore.getDatabase(client, id);
      });
    },
    /**
     * Every non-archived database system-wide (issue #240's `GET /api/databases`) — see `databasesStore.listAllDatabases` for why this includes the ten system databases.
     * For an agent (`agentProjectItemId`, issue #1810) the databases its project may not read are left out.
     */
    async listDatabases(agentProjectItemId?: string): Promise<DatabaseRow[]> {
      return withTransaction(pool, async (client) => {
        const databases = await databasesStore.listAllDatabases(client);
        if (agentProjectItemId === undefined) return databases;
        const unreadable = await listUnreadableDatabaseIds(client, agentProjectItemId);
        return databases.filter((database) => !unreadable.has(database.id));
      });
    },

    /** Inline database creation (issue #22, point 7): a new, independent database owned by a page. Always `system: false` — mechanically, since the input type carries no `system` field to override it. */
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
