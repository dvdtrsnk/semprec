// Owns the database-level write guards the choke point runs before mutating a database's items or
// relations. Nothing that performs a write, and no domain-specific guard (view ownership, item
// creation's idempotent-replay carve-out), belongs here.
// Constrained by: docs/adr/2026-09-10-choke-point-api-for-state-writes.md
import type { PoolClient } from "pg";
import { ForbiddenError, NotFoundError } from "../errors.js";
import * as databasesStore from "./databasesStore.js";

/**
 * The one reusable archived-database guard: blocks every item/relation mutation against an
 * archived database with a canonical 403 `database_archived`, while reads (and restoring the
 * database itself) remain unaffected. Used directly by every mutation below except item
 * creation, which needs the idempotent-replay carve-out in `assertDatabaseWritableForCreate`.
 */
export async function assertDatabaseNotArchived(client: PoolClient, databaseId: string): Promise<void> {
  const database = await databasesStore.getDatabase(client, databaseId);
  if (!database) throw new NotFoundError(`Database ${databaseId} not found`);
  if (database.archivedAt) {
    throw new ForbiddenError(
      `Database ${databaseId} is archived and cannot be written to`,
      { field: "databaseId" },
      "database_archived",
    );
  }
}
