// Owns the databases domain of the choke point: creating, archiving, restoring, renaming, reading and
// listing databases, plus the transaction-scoped `databaseArchiveWithClient` the approved-operation
// executor calls. Item, property, relation and view writes do not belong here, and neither does any
// other domain module's code — this module talks only to `databasesStore` and the realtime hook.
// Constrained by:
// - docs/adr/2026-09-12-thin-user-scoped-realtime-invalidations.md
// - docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md
import type { PoolClient } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import type { DatabaseRow } from "../types.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import * as databasesStore from "./databasesStore.js";

/**
 * Transaction-scoped counterpart to `chokePoint.archiveDatabase` (issue #89): `databasesStore.archiveDatabase`
 * already takes a `client` rather than opening its own transaction, so this is a thin named alias —
 * kept alongside the other four `*WithClient` exports so `ApprovedOperationExecutor` has one uniform
 * naming convention to call the destructive half of each of the five approval-gated operations.
 */
export async function databaseArchiveWithClient(
  client: PoolClient,
  id: string,
  actingUserId?: string,
): Promise<DatabaseRow> {
  const database = await databasesStore.archiveDatabase(client, id);
  runAfterCommit(client, () => notifyInvalidation({ scope: "schema", databaseId: database.id, userId: actingUserId }));
  return database;
}

export function createDatabaseOps(deps: Pick<ChokePointDeps, "pool">) {
  const { pool } = deps;
  return {
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
        const database = await databasesStore.restoreDatabase(client, id);
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
    async getDatabase(id: string): Promise<DatabaseRow | null> {
      return withTransaction(pool, (client) => databasesStore.getDatabase(client, id));
    },
    /** Every non-archived database system-wide (issue #240's `GET /api/databases`) — see `databasesStore.listAllDatabases` for why this includes the ten system databases. */
    async listDatabases(): Promise<DatabaseRow[]> {
      return withTransaction(pool, (client) => databasesStore.listAllDatabases(client));
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
