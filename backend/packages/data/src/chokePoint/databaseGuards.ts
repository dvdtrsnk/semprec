// Database-level write guards the choke point runs before mutating a database's items or relations.
import type { PoolClient } from "pg";
import { ForbiddenError, NotFoundError } from "../errors.js";
import type { DatabaseRow } from "../types.js";
import * as databasesStore from "./databasesStore.js";

/**
 * Blocks every item/relation mutation against an archived database with 403 `database_archived`;
 * reads and restoring the database are unaffected. Item creation uses
 * `assertDatabaseWritableForCreate` instead for its idempotent-replay carve-out.
 */
export async function assertDatabaseNotArchived(client: PoolClient, databaseId: string): Promise<DatabaseRow> {
  const database = await databasesStore.getDatabase(client, databaseId);
  if (!database) throw new NotFoundError(`Database ${databaseId} not found`);
  if (database.archivedAt) {
    throw new ForbiddenError(
      `Database ${databaseId} is archived and cannot be written to`,
      { field: "databaseId" },
      "database_archived",
    );
  }
  return database;
}
